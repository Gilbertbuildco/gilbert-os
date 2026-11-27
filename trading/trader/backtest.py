"""Replay a strategy over historical candles on an in-memory paper account."""
from __future__ import annotations

from .broker import PaperBroker
from .config import Config
from .engine import Engine
from .models import Candle
from .report import max_drawdown, summarize
from .strategies.base import Strategy


def run_backtest(cfg: Config, history: dict[str, list[Candle]], strategy: Strategy,
                 warmup: int | None = None, progress=None) -> dict:
    broker = PaperBroker(":memory:", cfg.account.starting_cash, cfg.execution.fee_bps, cfg.execution.slippage_bps)
    engine = Engine(cfg, broker, strategy)
    step = cfg.market.interval_minutes * 60
    lookback = cfg.market.lookback

    common = set.intersection(*(set(c.ts for c in hist) for hist in history.values()))
    timeline = sorted(common)
    index = {s: {c.ts: i for i, c in enumerate(hist)} for s, hist in history.items()}
    warmup = min(lookback, len(timeline) // 4) if warmup is None else warmup
    if len(timeline) <= warmup + 1:
        raise ValueError(f"Need more than {warmup + 1} aligned candles, have {len(timeline)}")

    first_prices = None
    last_prices = None
    for n, ts in enumerate(timeline[warmup:]):
        window = {}
        for s, hist in history.items():
            i = index[s][ts]
            window[s] = hist[max(0, i + 1 - lookback): i + 1]
        engine.run_cycle(window, ts=ts + step)  # act when the candle closes
        last_prices = {s: w[-1].close for s, w in window.items()}
        first_prices = first_prices or last_prices
        if progress:
            progress(n + 1, len(timeline) - warmup)

    stats = summarize(broker)
    # Benchmark: put the same maximum exposure into an equal-weight buy-and-hold at the first cycle.
    exposure = cfg.risk.max_total_exposure_pct / 100
    bh_curve = []
    for ts in timeline[warmup:]:
        rel = sum(history[s][index[s][ts]].close / first_prices[s] for s in history) / len(history)
        bh_curve.append(1 - exposure + exposure * rel)
    stats["buy_and_hold_return_pct"] = round((bh_curve[-1] - 1) * 100, 2)
    stats["buy_and_hold_max_drawdown_pct"] = round(max_drawdown(bh_curve), 2)
    stats["period_candles"] = len(timeline) - warmup
    return stats
