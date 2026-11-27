"""Volatility-targeted trend ensemble for perpetual futures (see research/README.md).

Per coin, six votes on daily closes: price vs its 20/50/100-day averages and the sign of the 14/28/56-day
return. The average vote (-1..+1) sets direction and conviction. Size is scaled so each coin carries an
equal share of the portfolio volatility target.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import pstdev

from ..indicators import sma
from ..models import Candle

SMA_LENGTHS = (20, 50, 100)
RETURN_LOOKBACKS = (14, 28, 56)
VOL_LOOKBACK = 20
AVG_CORRELATION_FACTOR = 0.93  # three coins correlated ~0.8 behave like ~0.93 of one position's volatility
MIN_CANDLES = max(max(SMA_LENGTHS), max(RETURN_LOOKBACKS) + 1, VOL_LOOKBACK + 1)


def _sign(x: float) -> int:
    x = float(x)
    return (x > 0) - (x < 0)


@dataclass
class CoinSignal:
    symbol: str
    votes: dict[str, int]
    score: float
    vol: float | None
    weight: float  # signed notional / equity, before portfolio caps


def coin_signal(symbol: str, candles: list[Candle], vol_target: float, n_coins: int) -> CoinSignal:
    closes = [c.close for c in candles]
    if len(closes) < MIN_CANDLES:
        return CoinSignal(symbol, {}, 0.0, None, 0.0)
    last = closes[-1]
    votes = {f"above_sma{n}": _sign(last - sma(closes, n)) for n in SMA_LENGTHS}
    votes.update({f"return_{k}d": _sign(math.log(last / closes[-1 - k])) for k in RETURN_LOOKBACKS})
    score = sum(votes.values()) / len(votes)
    rets = [math.log(b / a) for a, b in zip(closes[-VOL_LOOKBACK - 1:-1], closes[-VOL_LOOKBACK:])]
    vol = pstdev(rets) * math.sqrt(365) if len(rets) > 1 else None
    # research used the sample std (pandas); scale to match
    if vol:
        vol *= math.sqrt(len(rets) / (len(rets) - 1))
    weight = score * (vol_target / n_coins / AVG_CORRELATION_FACTOR) / vol if vol else 0.0
    return CoinSignal(symbol, votes, score, vol, weight)


class TrendEnsemble:
    name = "trend_ensemble"

    def __init__(self, vol_target_pct: float, max_gross_leverage: float):
        self.vol_target = vol_target_pct / 100
        self.max_gross = max_gross_leverage

    def signals(self, daily: dict[str, list[Candle]]) -> dict[str, CoinSignal]:
        n = len(daily)
        return {s: coin_signal(s, c, self.vol_target, n) for s, c in daily.items()}

    def targets(self, daily: dict[str, list[Candle]]) -> tuple[dict[str, float], dict[str, CoinSignal]]:
        sig = self.signals(daily)
        w = {s: x.weight for s, x in sig.items()}
        gross = sum(abs(v) for v in w.values())
        if gross > self.max_gross:
            w = {s: v * self.max_gross / gross for s, v in w.items()}
        return w, sig
