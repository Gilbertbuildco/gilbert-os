import math

import pytest

from trader.config import Config
from trader.futures import FuturesPaperBroker
from trader.futures_engine import FuturesEngine
from trader.models import Candle
from trader.strategies.monday_breakout import DAY, monday_range, trend_direction, week_start

MONDAY = 1794787200  # Monday 16 Nov 2026 00:00 UTC
H = 3600


def test_week_start():
    assert week_start(MONDAY) == MONDAY
    assert week_start(MONDAY + 3 * DAY + 5) == MONDAY
    assert week_start(MONDAY - 1) == MONDAY - 7 * DAY


def test_monday_range_needs_full_day():
    bars = [Candle(MONDAY + i * H, 100, 101 + i % 3, 99 - i % 2, 100, 1) for i in range(24)]
    assert monday_range(bars, MONDAY) == (103, 98)
    assert monday_range(bars[:20], MONDAY) is None


def daily_trend(down=True, days=130):
    out = []
    for i in range(days):
        p = 200 * math.exp((-0.01 if down else 0.01) * i + 0.02 * ((-1) ** i))
        out.append(Candle(MONDAY - (days - 1 - i) * DAY, p, p * 1.01, p * 0.99, p, 1))
    return out


def test_trend_direction():
    assert trend_direction(daily_trend(down=True), MONDAY) == -1
    assert trend_direction(daily_trend(down=False), MONDAY) == 1


def engine(down=True):
    cfg = Config(); cfg.mode = "futures"; cfg.market.symbols = ["BTC/USD"]
    f = cfg.futures; f.fee_bps = 0; f.slippage_bps = 0; f.funding_rate_8h_pct = 0
    f.breakout_enabled = True; f.breakout_risk_pct = 2.0; f.vol_target_pct = 0.0001  # isolate the breakout leg
    b = FuturesPaperBroker(":memory:", 1000, 0, 0, 100, 0.5)
    return b, FuturesEngine(cfg, b), daily_trend(down)


def run_hours(b, e, daily, path):
    """path: list of (high, low, close) for hours after Monday; Monday itself ranges 100-110."""
    hourly = [Candle(MONDAY + i * H, 105, 110 if i == 5 else 106, 100 if i == 9 else 104, 105, 1) for i in range(24)]
    for j, (hi, lo, cl) in enumerate(path):
        hourly.append(Candle(MONDAY + DAY + j * H, hourly[-1].close, hi, lo, cl, 1))
    results = []
    for k in range(24, len(hourly) + 1):
        ts = MONDAY + k * H
        d = [c for c in daily if c.ts + DAY <= ts]
        results.append(e.run_cycle({"BTC/USD": hourly[max(0, k - 200):k]}, {"BTC/USD": d}, ts=ts))
    return results


def test_short_breakout_then_stop():
    b, e, daily = engine(down=True)
    res = run_hours(b, e, daily, [(104, 101, 102), (102, 99, 99.5), (105, 99, 104), (111, 104, 110.5)])
    fills = [f for r in res for f in r.fills if f.reason.startswith("breakout")]
    assert fills[0].side == "sell" and fills[0].price == pytest.approx(100)
    assert fills[0].qty * 10 == pytest.approx(20, rel=1e-6)  # 2% of 1000 over a 10-point stop
    assert fills[1].reason == "breakout: stop" and fills[1].price == pytest.approx(110)
    assert b.equity({"BTC/USD": 110}) == pytest.approx(980, rel=1e-3)
    assert not b.positions()


def test_trend_filter_blocks_counter_trend_and_one_trade_per_side():
    b, e, daily = engine(down=True)
    res = run_hours(b, e, daily, [(112, 104, 111), (113, 109, 112)])  # break up in a downtrend: no trade
    assert not [f for r in res for f in r.fills if f.reason.startswith("breakout")]
    b, e, daily = engine(down=True)
    res = run_hours(b, e, daily, [(104, 99, 99.5), (111, 99, 110.5), (104, 99, 99.5)])  # stopped, no re-entry
    assert len([f for r in res for f in r.fills if f.reason.startswith("breakout")]) == 2


def test_week_end_exit():
    b, e, daily = engine(down=True)
    path = [(104, 99, 98)] + [(98.5, 97, 97.5)] * (6 * 24 - 1)  # break down Tuesday, drift lower all week
    res = run_hours(b, e, daily, path)
    fills = [f for r in res for f in r.fills if f.reason.startswith("breakout")]
    assert fills[-1].reason == "breakout: week end" and not b.positions()
    assert b.equity({"BTC/USD": 97.5}) > 1000
