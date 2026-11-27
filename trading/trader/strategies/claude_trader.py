"""Claude as the portfolio manager.

Each cycle Claude gets market data, the portfolio, recent trades and its own notes from earlier cycles,
and answers with a target allocation per symbol as structured JSON. The engine then applies the hard
risk limits, so a bad or malformed answer can never exceed them; on any API error, refusal or invalid
answer the bot simply holds.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ValidationError

from ..indicators import snapshot
from ..models import Decision
from .base import Strategy, StrategyContext

log = logging.getLogger(__name__)

# $ per million tokens (input, output), for the cost estimate in the journal only.
PRICES = {
    "claude-opus-5-5": (4.0, 20.0),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-haiku-5-5": (0.10, 0.50),
    "claude-fable-5-2": (8.0, 40.0),
}

SYSTEM_PROMPT = """\
You manage a paper-trading crypto account: simulated money, real market prices. Treat it as a real test of \
your trading process. Each cycle you receive the account, the market data, recent trades and the notes you \
wrote yourself last cycle, and you set a target allocation for every symbol.

What you can do:
- For each symbol choose "hold" (keep the position exactly as it is) or "target" with target_pct, the share \
of total equity you want in that symbol after this cycle. 0 means sell all of it. Whatever is not allocated \
stays in cash.
- Long positions and cash only. No shorting, leverage or other symbols.

Things that will happen whatever you answer:
- Hard risk limits are enforced in code after you answer. Targets above them are cut back. They are listed \
in the input under risk_limits. A stop-loss sells any position that falls stop_loss_pct below its average \
cost. After a daily loss of max_daily_loss_pct, increases are blocked until the next UTC day.
- Every trade pays the fee and slippage given under costs, so small frequent adjustments lose money. Changes \
smaller than the rebalance threshold are ignored.

Work out a view of each market from the data, size positions to how confident you are and to volatility, \
and don't trade just because a cycle has come round: holding is often right. Keep each reasoning to one or \
two sentences. Use notes_for_next_time as your running journal: your current thesis, what would change your \
mind, levels to watch, and lessons from how your earlier decisions played out. You will see it next cycle."""


class SymbolDecision(BaseModel):
    symbol: str
    action: Literal["hold", "target"]
    target_pct: float
    confidence: float
    reasoning: str


class TradingPlan(BaseModel):
    market_view: str
    decisions: list[SymbolDecision]
    notes_for_next_time: str


def output_schema(symbols: list[str]) -> dict:
    return {
        "type": "object",
        "properties": {
            "market_view": {"type": "string", "description": "Two or three sentences on overall conditions."},
            "decisions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "symbol": {"type": "string", "enum": symbols},
                        "action": {"type": "string", "enum": ["hold", "target"]},
                        "target_pct": {"type": "number",
                                       "description": "Percent of total equity, 0-100. Ignored for hold."},
                        "confidence": {"type": "number", "description": "0 to 1."},
                        "reasoning": {"type": "string"},
                    },
                    "required": ["symbol", "action", "target_pct", "confidence", "reasoning"],
                    "additionalProperties": False,
                },
            },
            "notes_for_next_time": {"type": "string"},
        },
        "required": ["market_view", "decisions", "notes_for_next_time"],
        "additionalProperties": False,
    }


def build_input(ctx: StrategyContext, fee_bps: float, slippage_bps: float, rebalance_threshold_pct: float) -> dict:
    positions = []
    for s, p in ctx.positions.items():
        px = ctx.prices.get(s, p.avg_price)
        positions.append({
            "symbol": s, "qty": p.qty, "avg_cost": round(p.avg_price, 6), "price": px,
            "value": round(p.qty * px, 2), "allocation_pct": round(ctx.allocations.get(s, 0.0), 2),
            "unrealized_pnl_pct": round((px / p.avg_price - 1) * 100, 2),
        })
    previous = [
        {"time_utc": _iso(d["ts"]), "summary": d["summary"], "targets": d["payload"].get("targets"),
         "risk_notes": d["payload"].get("risk_notes", []), "notes": d["notes"]}
        for d in ctx.recent_decisions
    ]
    trades = [
        {"time_utc": _iso(t["ts"]), "symbol": t["symbol"], "side": t["side"], "qty": round(t["qty"], 8),
         "price": t["price"], "realized_pnl": round(t["realized_pnl"], 2), "reason": t["reason"]}
        for t in ctx.recent_trades
    ]
    return {
        "time_utc": _iso(ctx.ts),
        "candle_interval_minutes": ctx.interval_minutes,
        "account": {
            "cash": round(ctx.cash, 2), "equity": round(ctx.equity, 2), "starting_cash": ctx.starting_cash,
            "total_return_pct": round((ctx.equity / ctx.starting_cash - 1) * 100, 2),
            "daily_loss_limit_hit": ctx.halted,
        },
        "positions": positions,
        "market": {s: snapshot(c) for s, c in ctx.candles.items() if c},
        "risk_limits": {
            "max_position_pct": ctx.risk.max_position_pct,
            "max_total_exposure_pct": ctx.risk.max_total_exposure_pct,
            "max_daily_loss_pct": ctx.risk.max_daily_loss_pct,
            "max_trades_per_day": ctx.risk.max_trades_per_day,
            "stop_loss_pct": ctx.risk.stop_loss_pct,
        },
        "costs": {"fee_bps": fee_bps, "slippage_bps": slippage_bps,
                  "rebalance_threshold_pct_of_equity": rebalance_threshold_pct},
        "recent_trades": trades,
        "your_previous_decisions": previous,
    }


def _iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")


class ClaudeTrader(Strategy):
    name = "claude"

    def __init__(self, cfg, client=None):
        self.cfg = cfg
        self.ccfg = cfg.strategy.claude
        self.symbols = list(cfg.market.symbols)
        self._client = client

    @property
    def client(self):
        if self._client is None:
            import anthropic

            self._client = anthropic.Anthropic()
        return self._client

    def decide(self, ctx: StrategyContext) -> Decision:
        import anthropic

        ex = self.cfg.execution
        payload = build_input(ctx, ex.fee_bps, ex.slippage_bps, ex.rebalance_threshold_pct)
        try:
            response = self.client.beta.messages.create(
                model=self.ccfg.model,
                max_tokens=self.ccfg.max_tokens,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": json.dumps(payload, separators=(",", ":"))}],
                output_config={"effort": self.ccfg.effort,
                               "format": {"type": "json_schema", "schema": output_schema(self.symbols)}},
                # If a safety classifier declines, the API retries on a fallback model in the same call.
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            )
        except anthropic.APIError as e:
            log.error("Claude API call failed, holding: %s", e)
            return Decision.hold(self.symbols, summary=f"API error, holding: {e.__class__.__name__}",
                                 error=str(e))
        return self.parse(response)

    def parse(self, response) -> Decision:
        meta = self._usage(response)
        if response.stop_reason == "refusal":
            return Decision.hold(self.symbols, summary="Claude declined this cycle, holding", **meta)
        if response.stop_reason == "max_tokens":
            return Decision.hold(self.symbols, summary="Answer was cut off at max_tokens, holding", **meta)
        text = "".join(b.text for b in response.content if getattr(b, "type", None) == "text")
        try:
            plan = TradingPlan.model_validate(json.loads(text))
        except (json.JSONDecodeError, ValidationError) as e:
            log.error("Could not parse Claude's plan, holding: %s", e)
            return Decision.hold(self.symbols, summary="Unreadable answer, holding", raw=text[:2000], **meta)

        targets: dict[str, float | None] = {s: None for s in self.symbols}
        reasoning: dict[str, str] = {}
        for d in plan.decisions:
            if d.symbol not in targets:
                continue
            targets[d.symbol] = None if d.action == "hold" else max(0.0, min(100.0, d.target_pct))
            reasoning[d.symbol] = f"[{d.action}, confidence {d.confidence:.2f}] {d.reasoning}"
        return Decision(targets=targets, reasoning=reasoning, summary=plan.market_view,
                        notes=plan.notes_for_next_time, meta=meta)

    def _usage(self, response) -> dict:
        usage = getattr(response, "usage", None)
        model = getattr(response, "model", None) or self.ccfg.model
        if usage is None:
            return {"model": model}
        tin, tout = getattr(usage, "input_tokens", 0) or 0, getattr(usage, "output_tokens", 0) or 0
        price = PRICES.get(self.ccfg.model)
        cost = round((tin * price[0] + tout * price[1]) / 1e6, 4) if price else None
        return {"model": model, "input_tokens": tin, "output_tokens": tout, "est_cost_usd": cost}
