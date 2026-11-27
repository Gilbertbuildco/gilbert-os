import pytest

from trader.config import RiskConfig
from trader.models import Position
from trader.risk import RiskManager


def rm(**kw):
    return RiskManager(RiskConfig(**kw))


def test_caps_single_position_and_negative():
    r = rm(max_position_pct=40, max_total_exposure_pct=100).apply({"A": 80, "B": -5}, {}, halted=False)
    assert r.targets == {"A": 40, "B": 0}
    assert r.notes


def test_total_exposure_scales_only_increases():
    r = rm(max_position_pct=50, max_total_exposure_pct=90).apply(
        {"A": 50, "B": 50, "C": 50}, {"A": 50}, halted=False)
    assert r.targets["A"] == pytest.approx(50)  # existing holding untouched
    assert r.targets["B"] == pytest.approx(20)
    assert r.targets["C"] == pytest.approx(20)
    assert sum(r.targets.values()) == pytest.approx(90)


def test_halt_blocks_increases_but_allows_reductions():
    r = rm().apply({"A": 30, "B": 5}, {"A": 10, "B": 20}, halted=True)
    assert r.targets == {"A": 10, "B": 5}


def test_daily_loss_and_stops():
    m = rm(max_daily_loss_pct=5, stop_loss_pct=10)
    assert m.daily_loss_breached(9_400, 10_000)
    assert not m.daily_loss_breached(9_600, 10_000)
    pos = {"A": Position("A", 1, 100), "B": Position("B", 1, 100)}
    assert m.stop_loss_exits(pos, {"A": 89.9, "B": 95}) == ["A"]
