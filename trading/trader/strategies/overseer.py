"""Optional Claude risk overseer for the futures strategy. It can shrink or close a position, never open,
grow or flip one: the engine clamps its answer to a multiplier between 0 and 1 on the rule-based target.
If the call fails or the answer is unusable, the rule-based targets stand."""
from __future__ import annotations

import json
import logging

from pydantic import BaseModel, ValidationError

from ..indicators import snapshot
from .claude_trader import PRICES

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You are the risk overseer for a paper-trading crypto perpetual-futures account. A tested, rule-based trend \
strategy has already set today's target position for each coin: its direction comes from six trend votes \
and its size from volatility targeting. Your job is narrow. For each coin return a multiplier from 0 to 1 \
on that target: 1 keeps it, 0.5 halves it, 0 closes it. You cannot open, increase or reverse a position.

Reduce only when you see a concrete reason the rules can't: for example a trend that is extremely \
stretched, a position fighting the other coins, an account near its drawdown limit, or choppy price action \
where the votes are split. Most days the right answer is 1 for every coin, because second-guessing a \
trend system usually costs money. Give one sentence of reasoning per coin."""


class Review(BaseModel):
    symbol: str
    multiplier: float
    reason: str


class OverseerAnswer(BaseModel):
    summary: str
    reviews: list[Review]


def schema(symbols):
    return {
        "type": "object",
        "properties": {
            "summary": {"type": "string"},
            "reviews": {"type": "array", "items": {
                "type": "object",
                "properties": {"symbol": {"type": "string", "enum": symbols},
                               "multiplier": {"type": "number", "description": "0 to 1"},
                               "reason": {"type": "string"}},
                "required": ["symbol", "multiplier", "reason"], "additionalProperties": False}},
        },
        "required": ["summary", "reviews"], "additionalProperties": False,
    }


class ClaudeOverseer:
    def __init__(self, cfg, client=None):
        self.ccfg = cfg.strategy.claude
        self.symbols = list(cfg.market.symbols)
        self._client = client

    @property
    def client(self):
        if self._client is None:
            import anthropic

            self._client = anthropic.Anthropic()
        return self._client

    def review(self, targets: dict[str, float], signals: dict, daily: dict, account: dict) -> tuple[dict[str, float], dict]:
        """Returns (multiplier per symbol in [0, 1], info for the journal)."""
        import anthropic

        payload = {
            "account": account,
            "coins": {s: {"rule_target_weight": round(targets.get(s, 0.0), 4),
                          "direction": "long" if targets.get(s, 0) > 0 else "short" if targets.get(s, 0) < 0 else "flat",
                          "trend_votes": signals[s].votes, "trend_score": round(signals[s].score, 3),
                          "annualised_vol": round(signals[s].vol, 3) if signals[s].vol else None,
                          "daily_chart": snapshot(daily[s][-120:])}
                      for s in self.symbols if s in signals},
        }
        ones = {s: 1.0 for s in self.symbols}
        try:
            resp = self.client.beta.messages.create(
                model=self.ccfg.model, max_tokens=self.ccfg.max_tokens, system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": json.dumps(payload, separators=(",", ":"))}],
                output_config={"effort": self.ccfg.effort, "format": {"type": "json_schema", "schema": schema(self.symbols)}},
                betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            )
        except anthropic.APIError as e:
            log.error("Overseer call failed, keeping rule targets: %s", e)
            return ones, {"overseer": f"API error, rule targets kept: {e.__class__.__name__}"}
        usage = getattr(resp, "usage", None)
        tin, tout = (getattr(usage, "input_tokens", 0) or 0, getattr(usage, "output_tokens", 0) or 0) if usage else (0, 0)
        price = PRICES.get(self.ccfg.model)
        info = {"input_tokens": tin, "output_tokens": tout,
                "est_cost_usd": round((tin * price[0] + tout * price[1]) / 1e6, 4) if price else None}
        if resp.stop_reason in ("refusal", "max_tokens"):
            return ones, {**info, "overseer": f"no usable answer ({resp.stop_reason}), rule targets kept"}
        text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
        try:
            ans = OverseerAnswer.model_validate(json.loads(text))
        except (json.JSONDecodeError, ValidationError) as e:
            log.error("Overseer answer unreadable, keeping rule targets: %s", e)
            return ones, {**info, "overseer": "unreadable answer, rule targets kept"}
        mult = dict(ones)
        reasons = {}
        for r in ans.reviews:
            if r.symbol in mult:
                mult[r.symbol] = min(1.0, max(0.0, r.multiplier))
                reasons[r.symbol] = f"x{mult[r.symbol]:.2f}: {r.reason}"
        return mult, {**info, "overseer": ans.summary, "overseer_reasons": reasons}
