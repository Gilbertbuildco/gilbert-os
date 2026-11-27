"""Small, dependency-free technical indicators. All return None when there is too little data."""
from __future__ import annotations

import math
from statistics import pstdev

from .models import Candle


def sma(values: list[float], n: int) -> float | None:
    if n <= 0 or len(values) < n:
        return None
    return sum(values[-n:]) / n


def ema(values: list[float], n: int) -> float | None:
    if n <= 0 or len(values) < n:
        return None
    k = 2 / (n + 1)
    e = sum(values[:n]) / n
    for v in values[n:]:
        e = v * k + e * (1 - k)
    return e


def rsi(values: list[float], n: int = 14) -> float | None:
    """Wilder's RSI."""
    if len(values) < n + 1:
        return None
    gains, losses = [], []
    for a, b in zip(values[:-1], values[1:]):
        d = b - a
        gains.append(max(d, 0.0))
        losses.append(max(-d, 0.0))
    avg_g = sum(gains[:n]) / n
    avg_l = sum(losses[:n]) / n
    for g, l in zip(gains[n:], losses[n:]):
        avg_g = (avg_g * (n - 1) + g) / n
        avg_l = (avg_l * (n - 1) + l) / n
    if avg_l == 0:
        return 100.0 if avg_g > 0 else 50.0
    rs = avg_g / avg_l
    return 100 - 100 / (1 + rs)


def atr(candles: list[Candle], n: int = 14) -> float | None:
    if len(candles) < n + 1:
        return None
    trs = []
    for prev, cur in zip(candles[:-1], candles[1:]):
        trs.append(max(cur.high - cur.low, abs(cur.high - prev.close), abs(cur.low - prev.close)))
    a = sum(trs[:n]) / n
    for tr in trs[n:]:
        a = (a * (n - 1) + tr) / n
    return a


def pct_change(values: list[float], n: int) -> float | None:
    if len(values) < n + 1 or values[-n - 1] == 0:
        return None
    return (values[-1] / values[-n - 1] - 1) * 100


def volatility(values: list[float], n: int = 24) -> float | None:
    """Standard deviation of per-candle log returns over n candles, in %."""
    if len(values) < n + 1:
        return None
    window = values[-n - 1 :]
    rets = [math.log(b / a) for a, b in zip(window[:-1], window[1:]) if a > 0 and b > 0]
    return pstdev(rets) * 100 if len(rets) > 1 else None


def snapshot(candles: list[Candle]) -> dict:
    """A compact indicator summary for one symbol, used in prompts and logs."""
    closes = [c.close for c in candles]

    def r(x, d=2):
        return None if x is None else round(x, d)

    last = closes[-1] if closes else None
    a = atr(candles)
    window = candles[-24:]
    return {
        "last_price": last,
        "change_pct": {f"{n}_candles": r(pct_change(closes, n)) for n in (1, 6, 24, 72)},
        "sma": {str(n): r(sma(closes, n), 4) for n in (20, 50, 200)},
        "ema_12": r(ema(closes, 12), 4),
        "ema_26": r(ema(closes, 26), 4),
        "rsi_14": r(rsi(closes, 14)),
        "atr_14_pct": r(a / last * 100 if a and last else None),
        "volatility_24_pct": r(volatility(closes, 24), 3),
        "high_24": max((c.high for c in window), default=None),
        "low_24": min((c.low for c in window), default=None),
        "recent_closes": [round(c, 6) for c in closes[-24:]],
    }
