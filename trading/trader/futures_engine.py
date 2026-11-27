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
import json

from .strategies.monday_breakout import DAY, WEEK, monday_range, trend_direction, week_start
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
    """1 below `start`, shrinking linearly to 0 at `stop`. With start == stop there is no shrinking, only the stop."""
    if dd < start or (dd <= start and stop > start):
        return 1.0
    if stop <= start:
        return 0.0 if dd >= stop else 1.0
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
                self._clear_breakouts()
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
            self._clear_breakouts()
            self._halt(f"drawdown stop {dd * 100:.1f}% at {time.ctime(ts)}; review, then `resume`")
            eq = b.record_equity(ts, prices)
            b.set_meta("last_cycle_ts", ts)
            return FuturesCycle(ts, eq, dd * 100, fills, notes + [f"drawdown {dd * 100:.1f}% hit the stop, all closed"])

        result = FuturesCycle(ts, eq, dd * 100, fills, notes)

        # 4. Monday range breakouts, checked against every hourly candle closed since the last cycle
        if self.f.breakout_enabled:
            self._breakouts(hourly, daily, prices, eq, dd, last, ts, result)

        # 5. daily trend rebalance when a new daily candle has closed for every coin
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
            have -= self._breakout_qty(s) * prices[s]  # the breakout leg is managed separately
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

    # ---- Monday range breakout leg ------------------------------------------
    def _bo_get(self, key: str, default=None):
        v = self.broker.get_meta(key)
        return json.loads(v) if v else default

    def _bo_set(self, key: str, value) -> None:
        self.broker.set_meta(key, json.dumps(value) if value is not None else None)

    def _breakout_qty(self, symbol: str) -> float:
        pos = self._bo_get(f"bo_pos:{symbol}")
        return pos["qty"] if pos else 0.0

    def _clear_breakouts(self) -> None:
        for s in self.cfg.market.symbols:
            self._bo_set(f"bo_pos:{s}", None)

    def _breakouts(self, hourly, daily, prices, eq, dd, last, ts, result) -> None:
        b, f = self.broker, self.f
        m = brake_multiplier(dd, f.drawdown_brake_start_pct / 100, f.drawdown_stop_pct / 100)
        for s in self.cfg.market.symbols:
            pos = self._bo_get(f"bo_pos:{s}")
            new = sorted((c for c in hourly[s] if c.ts + 3600 > last and c.ts + 3600 <= ts), key=lambda c: c.ts) \
                if last else []
            for c in new:
                monday = week_start(c.ts)
                if c.ts < monday + DAY:
                    continue  # Monday builds the range
                state = self._bo_get(f"bo_week:{s}")
                if not state or state["week"] != monday:
                    rng = monday_range(hourly[s], monday)
                    if rng is None:
                        continue
                    state = {"week": monday, "high": rng[0], "low": rng[1], "dir": trend_direction(daily[s], monday),
                             "done_long": False, "done_short": False}
                    self._bo_set(f"bo_week:{s}", state)
                if pos:
                    hit = c.low <= pos["stop"] if pos["qty"] > 0 else c.high >= pos["stop"]
                    if hit:
                        px = min(c.open, pos["stop"]) if pos["qty"] > 0 else max(c.open, pos["stop"])
                        fill = b.trade(s, -pos["qty"] * px, px, ts, "breakout: stop", prices)
                        result.fills.append(fill)
                        result.notes.append(f"{s}: breakout stopped, {self._r(pos, fill.price):+.2f}R")
                        self._bo_set(f"bo_pos:{s}", None); pos = None
                    continue
                for side, level, stop, flag in ((1, state["high"], state["low"], "done_long"),
                                                (-1, state["low"], state["high"], "done_short")):
                    if state["dir"] != side or state[flag]:
                        continue
                    crossed = c.high >= level if side > 0 else c.low <= level
                    if not crossed:
                        continue
                    px = max(c.open, level) if side > 0 else min(c.open, level)
                    risk_amt = f.breakout_risk_pct / 100 * eq * m
                    dist = abs(px - stop)
                    state[flag] = True
                    self._bo_set(f"bo_week:{s}", state)
                    if risk_amt <= 0 or dist <= 0:
                        break
                    qty = side * risk_amt / dist
                    try:
                        fill = b.trade(s, qty * px, px, ts, f"breakout: {'long above' if side > 0 else 'short below'} "
                                       f"Monday {'high' if side > 0 else 'low'}", prices)
                    except MarginError as e:
                        result.notes.append(f"{s}: breakout rejected, {e}")
                        break
                    pos = {"qty": qty, "entry": fill.price, "stop": stop, "week": monday, "risk": risk_amt}
                    self._bo_set(f"bo_pos:{s}", pos)
                    result.fills.append(fill)
                    result.notes.append(f"{s}: breakout {'long' if side > 0 else 'short'} at {fill.price:,.6g}, stop "
                                        f"{stop:,.6g}, risking {risk_amt:,.2f}")
                    break
            # a position from an earlier week closes at the first cycle of the new week (Sunday's last close)
            if pos and week_start(ts) > pos["week"]:
                fill = b.trade(s, -pos["qty"] * prices[s], prices[s], ts, "breakout: week end", prices)
                result.fills.append(fill)
                result.notes.append(f"{s}: breakout closed at week end, {self._r(pos, fill.price):+.2f}R")
                self._bo_set(f"bo_pos:{s}", None)

    @staticmethod
    def _r(pos, exit_price) -> float:
        return (exit_price - pos["entry"]) * pos["qty"] / pos["risk"] if pos["risk"] else 0.0
