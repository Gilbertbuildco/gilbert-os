from __future__ import annotations

from dataclasses import dataclass, field

from ..config import RiskConfig
from ..models import Candle, Decision, Position


@dataclass
class StrategyContext:
    ts: int
    interval_minutes: int
    candles: dict[str, list[Candle]]
    prices: dict[str, float]
    cash: float
    equity: float
    starting_cash: float
    positions: dict[str, Position]
    allocations: dict[str, float]  # current % of equity per symbol
    risk: RiskConfig
    halted: bool = False
    recent_trades: list[dict] = field(default_factory=list)
    recent_decisions: list[dict] = field(default_factory=list)


class Strategy:
    name = "base"

    def decide(self, ctx: StrategyContext) -> Decision:  # pragma: no cover - interface
        raise NotImplementedError
