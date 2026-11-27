import pytest

from trader.broker import PaperBroker
from trader.engine import Engine
from helpers import Boom, Fixed, candles, config

TS = 1_800_000_000


def setup(strategy, **risk):
    cfg = config(**risk)
    b = PaperBroker(":memory:", 10_000, 0, 0)
    return cfg, b, Engine(cfg, b, strategy)


def test_buys_to_target_and_holds_steady():
    cfg, b, e = setup(Fixed({"BTC/USD": 30, "ETH/USD": 20}))
    data = {"BTC/USD": candles(100), "ETH/USD": candles(10)}
    r = e.run_cycle(data, ts=TS)
    assert len(r.fills) == 2
    pos = b.positions()
    assert pos["BTC/USD"].qty * 100 == pytest.approx(3_000)
    assert pos["ETH/USD"].qty * 10 == pytest.approx(2_000)
    # Same targets next cycle: nothing to do.
    assert e.run_cycle(data, ts=TS + 3600).fills == []


def test_hold_keeps_position_and_zero_exits():
    cfg, b, e = setup(Fixed({"BTC/USD": 30, "ETH/USD": 30}))
    data = {"BTC/USD": candles(100), "ETH/USD": candles(10)}
    e.run_cycle(data, ts=TS)
    e.strategy.targets = {"BTC/USD": None, "ETH/USD": 0}
    e.run_cycle(data, ts=TS + 3600)
    assert "ETH/USD" not in b.positions()
    assert b.positions()["BTC/USD"].qty == pytest.approx(30)


def test_risk_caps_strategy():
    cfg, b, e = setup(Fixed({"BTC/USD": 100, "ETH/USD": 100}), max_position_pct=40, max_total_exposure_pct=60)
    e.run_cycle({"BTC/USD": candles(100), "ETH/USD": candles(10)}, ts=TS)
    invested = 10_000 - b.cash
    assert invested == pytest.approx(6_000)


def test_stop_loss_overrides_strategy():
    cfg, b, e = setup(Fixed({"BTC/USD": 30}), stop_loss_pct=10)
    e.run_cycle({"BTC/USD": candles(100)}, ts=TS)
    r = e.run_cycle({"BTC/USD": candles(85)}, ts=TS + 3600)
    assert "BTC/USD" not in b.positions()
    assert any(f.reason.startswith("stop-loss") for f in r.fills)


def test_daily_loss_blocks_buys():
    cfg, b, e = setup(Fixed({"BTC/USD": 40}), max_daily_loss_pct=5, stop_loss_pct=50)
    e.run_cycle({"BTC/USD": candles(100)}, ts=TS)
    # -15% on the position = -6% on the account: halted, the strategy wants to top back up to 40%.
    r = e.run_cycle({"BTC/USD": candles(85)}, ts=TS + 3600)
    assert r.fills == []
    assert any("daily loss" in n for n in r.risk_notes)


def test_max_trades_per_day():
    cfg, b, e = setup(Fixed({"BTC/USD": 30, "ETH/USD": 30}), max_trades_per_day=1)
    r = e.run_cycle({"BTC/USD": candles(100), "ETH/USD": candles(10)}, ts=TS)
    assert len(r.fills) == 1
    assert any("max_trades_per_day" in n for n in r.risk_notes)


def test_strategy_crash_holds(tmp_path):
    cfg, b, e = setup(Boom())
    r = e.run_cycle({"BTC/USD": candles(100)}, ts=TS)
    assert r.fills == [] and "strategy error" in r.decision.summary


def test_kill_switch(tmp_path):
    cfg, b, _ = setup(Fixed({"BTC/USD": 30}))
    stop = tmp_path / "STOP"
    stop.write_text("x")
    e = Engine(cfg, b, Fixed({"BTC/USD": 30}), kill_switch_path=stop)
    r = e.run_cycle({"BTC/USD": candles(100)}, ts=TS)
    assert r.skipped and not b.positions()


def test_journal_records_decisions():
    cfg, b, e = setup(Fixed({"BTC/USD": 30}))
    e.run_cycle({"BTC/USD": candles(100)}, ts=TS)
    d = b.recent_decisions(1)[0]
    assert d["payload"]["final_targets"]["BTC/USD"] == 30
    assert d["payload"]["fills"]
