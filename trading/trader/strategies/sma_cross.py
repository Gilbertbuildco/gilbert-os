"""Baseline: hold a fixed allocation while the fast moving average is above the slow one."""
from __future__ import annotations

from ..config import SmaCrossConfig
from ..indicators import sma
from ..models import Decision
from .base import Strategy, StrategyContext


class SmaCross(Strategy):
    name = "sma_cross"

    def __init__(self, cfg: SmaCrossConfig):
        if cfg.fast >= cfg.slow:
            raise ValueError("sma_cross.fast must be smaller than sma_cross.slow")
        self.cfg = cfg

    def decide(self, ctx: StrategyContext) -> Decision:
        targets: dict[str, float | None] = {}
        reasoning: dict[str, str] = {}
        for s, candles in ctx.candles.items():
            closes = [c.close for c in candles]
            fast, slow = sma(closes, self.cfg.fast), sma(closes, self.cfg.slow)
            if fast is None or slow is None:
                targets[s] = None
                reasoning[s] = "not enough candles yet"
            elif fast > slow:
                targets[s] = self.cfg.allocation_pct
                reasoning[s] = f"SMA{self.cfg.fast} {fast:.4g} above SMA{self.cfg.slow} {slow:.4g}"
            else:
                targets[s] = 0.0
                reasoning[s] = f"SMA{self.cfg.fast} {fast:.4g} below SMA{self.cfg.slow} {slow:.4g}"
        return Decision(targets=targets, reasoning=reasoning, summary="sma crossover")
