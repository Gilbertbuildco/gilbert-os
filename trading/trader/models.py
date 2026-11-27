from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Candle:
    ts: int  # unix seconds, candle open time
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass
class Position:
    symbol: str
    qty: float
    avg_price: float  # average cost per unit, buy fees included

    def value(self, price: float) -> float:
        return self.qty * price


@dataclass
class Fill:
    ts: int
    symbol: str
    side: str  # "buy" | "sell"
    qty: float
    price: float
    fee: float
    reason: str
    realized_pnl: float = 0.0


@dataclass
class Decision:
    """What a strategy wants. targets maps symbol -> % of equity, or None to hold."""

    targets: dict[str, float | None]
    reasoning: dict[str, str] = field(default_factory=dict)
    summary: str = ""
    notes: str = ""
    meta: dict = field(default_factory=dict)

    @classmethod
    def hold(cls, symbols, summary: str = "hold", **meta) -> "Decision":
        return cls(targets={s: None for s in symbols}, summary=summary, meta=meta)
