"""Hourly cycle for the futures paper account.

Every cycle: liquidation check against the worst prices since the last cycle, funding at 00/08/16 UTC,
drawdown brake and stop. Once per new daily close: compute trend-ensemble targets, apply the brake and the
optional overseer, and rebalance with a band and a minimum order size.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

from .config import Config
from .futures import FuturesPaperBroker, MarginError
from .models import Candle, Decision, Fill
from .strategies.trend_ensemble import TrendEnsemble

log = logging.getLogger(__name__)
FUNDING_PERIOD = 8 * 3600


@dataclass
class FuturesCycle:
    ts: int
    equity: float
    drawdown_pct: float
    fills: list[Fill] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    rebalanced: bool = False
    decision: Decision | None = None
    skipped: str | None = None


def brake_multiplier(dd: float, start: float, stop: float) -> float:
    if dd <= start:
        return 1.0
    return max(0.0, min(1.0, (stop - dd) / (stop - start)))


class FuturesEngine:
    def __init__(self, cfg: Config, broker: FuturesPaperBroker, strategy: TrendEnsemble | None = None,
                 overseer=None, kill_switch_path: Path | None = None):
        self.cfg = cfg
        self.f = cfg.futures
        self.broker = broker
        self.strategy = strategy or TrendEnsemble(self.f.vol_target_pct, self.f.max_gross_leverage)
        self.overseer = overseer
        self.kill_switch_path = kill_switch_path

    def _halt(self, reason: str) -> None:
        if self.kill_switch_path:
            self.kill_switch_path.parent.mkdir(parents=True, exist_ok=True)
            self.kill_switch_path.write_text(reason + "\n")

    def run_cycle(self, hourly: dict[str, list[Candle]], daily: dict[str, list[Candle]],
                  ts: int | None = None) -> FuturesCycle:
        ts = int(ts if ts is not None else time.time())
        b = self.broker
        prices = {s: c[-1].close for s, c in hourly.items() if c}
        missing = [s for s in self.cfg.market.symbols if s not in prices]
        if missing:
            return FuturesCycle(ts, b.equity(b.last_prices()), 0.0, skipped=f"no prices for {missing}")
        if self.kill_switch_path and self.kill_switch_path.exists():
            eq = b.record_equity(ts, prices)
            return FuturesCycle(ts, eq, 0.0, skipped=f"kill switch on: {self.kill_switch_path.read_text().strip()}")

        notes: list[str] = []
        fills: list[Fill] = []
        last = int(b.get_meta("last_cycle_ts", 0))

        # 1. liquidation, using each position's worst price in candles that closed since the last cycle
        positions = b.positions()
        if positions:
            worst = {}
            for s, p in positions.items():
                recent = [c for c in hourly[s] if c.ts + 3600 > last] or hourly[s][-1:]
                worst[s] = min(c.low for c in recent) if p.qty > 0 else max(c.high for c in recent)
            if b.liquidation_check(worst):
                fills = b.close_all(worst, ts, "LIQUIDATION", slippage=False)
                self._halt(f"liquidated at {time.ctime(ts)}")
                eq = b.record_equity(ts, prices)
                b.set_meta("last_cycle_ts", ts)
                return FuturesCycle(ts, eq, 100.0, fills, ["account liquidated; trading halted"])

        # 2. funding for each 00/08/16 UTC boundary passed since the last cycle
        if last:
            k = last // FUNDING_PERIOD + 1
            while k * FUNDING_PERIOD <= ts:
                paid = b.apply_funding(self.f.funding_rate_8h_pct / 100, prices, k * FUNDING_PERIOD)
                if paid:
                    notes.append(f"funding {'paid' if paid > 0 else 'received'} {abs(paid):.2f}")
                k += 1

        # 3. drawdown
        eq = b.equity(prices)
        peak = max(float(b.get_meta("peak_equity", eq)), eq)
        b.set_meta("peak_equity", peak)
        dd = 1 - eq / peak if peak > 0 else 0.0
        start, stop = self.f.drawdown_brake_start_pct / 100, self.f.drawdown_stop_pct / 100
        if dd >= stop:
            if b.positions():
                fills += b.close_all(prices, ts, f"drawdown stop {self.f.drawdown_stop_pct}%")
            self._halt(f"drawdown stop {dd * 100:.1f}% at {time.ctime(ts)}; review, then `resume`")
            eq = b.record_equity(ts, prices)
            b.set_meta("last_cycle_ts", ts)
            return FuturesCycle(ts, eq, dd * 100, fills, notes + [f"drawdown {dd * 100:.1f}% hit the stop, all closed"])

        # 4. daily rebalance when a new daily candle has closed for every coin
        result = FuturesCycle(ts, eq, dd * 100, fills, notes)
        day = min(c[-1].ts for c in daily.values() if c) if all(daily.get(s) for s in prices) else 0
        if day and day > int(b.get_meta("last_rebalance_day", 0)):
            self._rebalance(daily, prices, eq, dd, ts, result)
            b.set_meta("last_rebalance_day", day)

        result.equity = b.record_equity(ts, prices)
        b.set_meta("last_cycle_ts", ts)
        return result

    def _rebalance(self, daily, prices, eq, dd, ts, result: FuturesCycle) -> None:
        b, f = self.broker, self.f
        targets, signals = self.strategy.targets(daily)
        m = brake_multiplier(dd, f.drawdown_brake_start_pct / 100, f.drawdown_stop_pct / 100)
        if m < 1:
            result.notes.append(f"drawdown {dd * 100:.1f}%: positions scaled to {m:.0%}")
        final = {s: w * m for s, w in targets.items()}
        info: dict = {}
        if self.overseer is not None:
            account = {"equity": round(eq, 2), "starting_equity": b.starting_cash, "drawdown_pct": round(dd * 100, 2),
                       "drawdown_stop_pct": f.drawdown_stop_pct}
            mult, info = self.overseer.review(final, signals, daily, account)
            final = {s: w * min(1.0, max(0.0, mult.get(s, 1.0))) for s, w in final.items()}  # reduce-only

        positions = b.positions()
        for s, w in final.items():
            want = w * eq
            have = positions[s].qty * prices[s] if s in positions else 0.0
            diff = want - have
            if abs(diff) < f.min_order:
                continue
            same_side = want != 0 and have != 0 and (want > 0) == (have > 0)
            if same_side and abs(diff) < f.rebalance_band_pct / 100 * abs(want):
                continue
            side = "long" if want > 0 else "short" if want < 0 else "flat"
            try:
                result.fills.append(b.trade(s, diff, prices[s], ts, f"trend: target {side} {abs(w):.2f}x", prices))
            except MarginError as e:
                result.notes.append(f"{s}: order rejected, {e}")
        reasoning = {s: f"score {x.score:+.2f} ({sum(v > 0 for v in x.votes.values())}/6 bullish), "
                        f"vol {x.vol * 100:.0f}%, target {final[s]:+.2f}x equity" if x.vol else "not enough history"
                     for s, x in signals.items()}
        if info.get("overseer_reasons"):
            reasoning = {s: r + f" | overseer {info['overseer_reasons'].get(s, 'x1.00')}" for s, r in reasoning.items()}
        decision = Decision(targets={s: round(w * 100, 2) for s, w in final.items()}, reasoning=reasoning,
                            summary=info.get("overseer", "trend ensemble rebalance"), meta=info)
        b.record_decision(ts, "trend_ensemble", decision, extra={
            "votes": {s: x.votes for s, x in signals.items()}, "brake_multiplier": m, "risk_notes": result.notes,
            "fills": [f"{x.side} {x.qty:.8g} {x.symbol} @ {x.price:.6g}" for x in result.fills]})
        result.rebalanced = True
        result.decision = decision
