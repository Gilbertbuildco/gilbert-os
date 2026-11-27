from __future__ import annotations

from .base import Strategy, StrategyContext


def make_strategy(cfg, client=None) -> Strategy:
    name = cfg.strategy.name
    if name == "sma_cross":
        from .sma_cross import SmaCross

        return SmaCross(cfg.strategy.sma_cross)
    if name == "claude":
        from .claude_trader import ClaudeTrader

        return ClaudeTrader(cfg, client=client)
    raise ValueError(f"Unknown strategy {name!r}")


__all__ = ["Strategy", "StrategyContext", "make_strategy"]
