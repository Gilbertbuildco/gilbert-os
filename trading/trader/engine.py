"""One trading cycle: decide -> apply hard risk limits -> rebalance on the paper broker -> journal."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

from .broker import DUST_USD, PaperBroker
from .config import Config
from .models import Candle, Decision, Fill
from .risk import RiskManager
from .strategies.base import Strategy, StrategyContext

log = logging.getLogger(__name__)


def day_start(ts: int) -> int:
    return ts - ts % 86_400


@dataclass
class CycleResult:
    ts: int
    equity: float
    decision: Decision | None = None
    fills: list[Fill] = field(default_factory=list)
    risk_notes: list[str] = field(default_factory=list)
    skipped: str | None = None


class Engine:
    def __init__(self, cfg: Config, broker: PaperBroker, strategy: Strategy,
                 kill_switch_path: Path | None = None, recent_trades: int = 10):
        self.cfg = cfg
        self.broker = broker
        self.strategy = strategy
        self.risk = RiskManager(cfg.risk)
        self.kill_switch_path = kill_switch_path
        self.recent_trades = recent_trades

    def run_cycle(self, candles: dict[str, list[Candle]], ts: int | None = None) -> CycleResult:
        ts = int(ts if ts is not None else time.time())
        prices = {s: c[-1].close for s, c in candles.items() if c}
        if not prices:
            return CycleResult(ts, self.broker.equity({}), skipped="no market data")
        if self.kill_switch_path and self.kill_switch_path.exists():
            eq = self.broker.record_equity(ts, prices)
            return CycleResult(ts, eq, skipped=f"kill switch present ({self.kill_switch_path})")

        positions = self.broker.positions()
        equity = self.broker.equity(prices)
        start_eq = self.broker.first_equity_since(day_start(ts)) or equity
        halted = self.risk.daily_loss_breached(equity, start_eq)
        allocations = {
            s: (positions[s].qty * prices[s] / equity * 100 if s in positions and equity > 0 else 0.0)
            for s in prices
        }
        ctx = StrategyContext(
            ts=ts, interval_minutes=self.cfg.market.interval_minutes,
            candles={s: c for s, c in candles.items() if c}, prices=prices, cash=self.broker.cash,
            equity=equity, starting_cash=self.broker.starting_cash, positions=positions,
            allocations=allocations, risk=self.cfg.risk, halted=halted,
            recent_trades=self.broker.trades(limit=self.recent_trades),
            recent_decisions=self.broker.recent_decisions(self._history()),
        )
        try:
            decision = self.strategy.decide(ctx)
        except Exception as e:  # a strategy bug must never take the account down
            log.exception("Strategy failed, holding")
            decision = Decision.hold(prices, summary=f"strategy error, holding: {e}")

        targets = dict(allocations)  # default: keep everything where it is
        for s, t in decision.targets.items():
            if t is not None and s in targets:
                targets[s] = t
        result = self.risk.apply(targets, allocations, halted)
        stops = self.risk.stop_loss_exits(positions, prices)
        final = dict(result.targets)
        for s in stops:
            final[s] = 0.0
            result.notes.append(f"{s}: stop-loss, price {prices[s]:.6g} is {self.cfg.risk.stop_loss_pct}% "
                                f"below average cost {positions[s].avg_price:.6g}")
        if halted:
            result.notes.insert(0, f"daily loss limit {self.cfg.risk.max_daily_loss_pct}% reached, buys blocked")

        fills = self._rebalance(final, positions, prices, equity, ts, set(stops), result.notes)
        self.broker.record_decision(ts, self.strategy.name, decision, extra={
            "final_targets": {s: round(v, 2) for s, v in final.items()},
            "risk_notes": result.notes,
            "fills": [f"{f.side} {f.qty:.8g} {f.symbol} @ {f.price:.6g}" for f in fills],
        })
        eq = self.broker.record_equity(ts, prices)
        return CycleResult(ts, eq, decision, fills, result.notes)

    def _history(self) -> int:
        return getattr(self.cfg.strategy.claude, "history_decisions", 6) if self.strategy.name == "claude" else 0

    def _rebalance(self, final, positions, prices, equity, ts, stops, notes) -> list[Fill]:
        ex = self.cfg.execution
        threshold = max(ex.min_trade_usd, ex.rebalance_threshold_pct / 100 * equity)
        stop_orders, sells, buys = [], [], []
        for s, target in final.items():
            px = prices[s]
            pos = positions.get(s)
            cur = pos.qty * px if pos else 0.0
            delta = target / 100 * equity - cur
            if s in stops and pos:
                stop_orders.append((s, pos.qty, f"stop-loss at {self.cfg.risk.stop_loss_pct}%"))
            elif target <= 0 and pos and cur >= DUST_USD:
                sells.append((s, pos.qty, f"{self.strategy.name}: exit"))
            elif abs(delta) < threshold:
                continue
            elif delta < 0 and pos:
                sells.append((s, min(pos.qty, -delta / px), f"{self.strategy.name}: reduce to {target:.1f}%"))
            elif delta > 0:
                buys.append((s, delta, f"{self.strategy.name}: increase to {target:.1f}%"))

        left = self.cfg.risk.max_trades_per_day - self.broker.count_trades_since(day_start(ts))
        fills: list[Fill] = []
        for s, qty, why in stop_orders:
            fills.append(self.broker.sell(s, qty, prices[s], ts, why))
        for s, qty, why in sells:
            if left <= 0:
                notes.append(f"{s}: sell skipped, max_trades_per_day reached")
                continue
            fills.append(self.broker.sell(s, qty, prices[s], ts, why))
            left -= 1
        for s, usd, why in buys:
            usd = min(usd, self.broker.cash)
            if usd < ex.min_trade_usd:
                continue
            if left <= 0:
                notes.append(f"{s}: buy skipped, max_trades_per_day reached")
                continue
            fills.append(self.broker.buy(s, usd, prices[s], ts, why))
            left -= 1
        return fills
