"""Hard risk limits. These run after the strategy and cannot be bypassed by it."""
from __future__ import annotations

from dataclasses import dataclass, field

from .config import RiskConfig
from .models import Position


@dataclass
class RiskResult:
    targets: dict[str, float]
    notes: list[str] = field(default_factory=list)
    halted: bool = False


class RiskManager:
    def __init__(self, cfg: RiskConfig):
        self.cfg = cfg

    def daily_loss_breached(self, equity: float, day_start_equity: float) -> bool:
        if day_start_equity <= 0:
            return False
        loss_pct = (1 - equity / day_start_equity) * 100
        return loss_pct >= self.cfg.max_daily_loss_pct

    def stop_loss_exits(self, positions: dict[str, Position], prices: dict[str, float]) -> list[str]:
        out = []
        for s, p in positions.items():
            px = prices.get(s)
            if px is not None and px <= p.avg_price * (1 - self.cfg.stop_loss_pct / 100):
                out.append(s)
        return out

    def apply(self, targets: dict[str, float], current: dict[str, float], halted: bool) -> RiskResult:
        """Clamp target allocations (% of equity). current holds today's allocation per symbol."""
        notes: list[str] = []
        out: dict[str, float] = {}
        for s, t in targets.items():
            t = max(0.0, float(t))
            if t > self.cfg.max_position_pct:
                notes.append(f"{s}: target {t:.1f}% capped at max_position_pct {self.cfg.max_position_pct:.1f}%")
                t = self.cfg.max_position_pct
            if halted and t > current.get(s, 0.0):
                notes.append(f"{s}: daily loss limit hit, increase to {t:.1f}% blocked")
                t = current.get(s, 0.0)
            out[s] = t

        total = sum(out.values())
        cap = self.cfg.max_total_exposure_pct
        if total > cap + 1e-9:
            # Scale down only the positions being increased, so the cap never forces a sale by itself.
            fixed = sum(min(t, current.get(s, 0.0)) for s, t in out.items())
            growth = {s: t - min(t, current.get(s, 0.0)) for s, t in out.items()}
            room = max(0.0, cap - fixed)
            g_total = sum(growth.values())
            scale = min(1.0, room / g_total) if g_total > 0 else 0.0
            out = {s: min(t, current.get(s, 0.0)) + growth[s] * scale for s, t in out.items()}
            notes.append(f"total target {total:.1f}% above max_total_exposure_pct {cap:.1f}%, increases scaled by "
                         f"{scale:.2f}")
        return RiskResult(out, notes, halted)
