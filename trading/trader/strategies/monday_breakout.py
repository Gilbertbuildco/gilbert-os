"""Monday range breakout (see research/README.md).

Monday 00:00-24:00 UTC sets the week's range. From Tuesday to Sunday, at most one long and one short per coin:
buy a break above Monday's high or sell a break below Monday's low, but only in the direction of the trend
ensemble's score at Monday's close. The stop is the opposite side of the range; the trade closes at the end of
the week. Size is set so hitting the stop loses `risk_pct` of equity.
"""
from __future__ import annotations

from ..models import Candle
from .trend_ensemble import coin_signal

WEEK = 7 * 86_400
DAY = 86_400


def week_start(ts: int) -> int:
    """Monday 00:00 UTC of the week containing ts (1970-01-01 was a Thursday)."""
    return ts - (ts - 4 * DAY) % WEEK


def monday_range(hourly: list[Candle], monday: int) -> tuple[float, float] | None:
    bars = [c for c in hourly if monday <= c.ts < monday + DAY]
    if len(bars) < 24:
        return None
    return max(c.high for c in bars), min(c.low for c in bars)


def trend_direction(daily: list[Candle], monday: int) -> int:
    """Sign of the trend-ensemble score using daily candles up to and including Monday's."""
    upto = [c for c in daily if c.ts <= monday]
    sig = coin_signal("x", upto, 1.0, 1)
    return (sig.score > 0) - (sig.score < 0) if sig.vol else 0
