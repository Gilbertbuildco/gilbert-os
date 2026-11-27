import math

import pytest

from trader.config import Config
from trader.futures import FuturesPaperBroker, MarginError
from trader.futures_engine import FuturesEngine, brake_multiplier
from trader.models import Candle
from trader.strategies.overseer import ClaudeOverseer
from trader.strategies.trend_ensemble import TrendEnsemble, coin_signal
from helpers import FakeClient, fake_response

DAY = 86_400
T0 = 1_800_000_000 - 1_800_000_000 % DAY


def broker(fee=0, slip=0, lev=100):
    return FuturesPaperBroker(":memory:", 1000, fee, slip, lev, 0.5)


def test_long_and_short_pnl_and_equity():
    b = broker()
    b.trade("BTC/USD", 500, 100.0, 1, "t")       # long 5
    b.trade("ETH/USD", -300, 10.0, 1, "t")       # short 30
    assert b.equity({"BTC/USD": 100.0, "ETH/USD": 10.0}) == pytest.approx(1000)
    assert b.equity({"BTC/USD": 110.0, "ETH/USD": 9.0}) == pytest.approx(1000 + 50 + 30)
    f = b.trade("ETH/USD", 270, 9.0, 2, "t")     # cover the short at 9
    assert f.realized_pnl == pytest.approx(30)
    assert "ETH/USD" not in b.positions()


def test_flip_and_fees():
    b = broker(fee=10)  # 0.1%
    b.trade("BTC/USD", 1000, 100.0, 1, "t")      # long 10, fee 1
    f = b.trade("BTC/USD", -2000, 110.0, 2, "t")  # sell 2000 notional: close 10 long (wait: q = 2000/110)
    p = b.positions()["BTC/USD"]
    assert p.qty < 0 and p.avg_price == pytest.approx(110.0)
    closed = 10
    assert f.realized_pnl == pytest.approx(closed * 10 - 2.0)
    assert b.cash + p.qty * 110 == pytest.approx(1000 - 1 + 100 - 2)


def test_funding_direction():
    b = broker()
    b.trade("BTC/USD", 1000, 100.0, 1, "t")
    b.trade("ETH/USD", -1000, 10.0, 1, "t")
    paid = b.apply_funding(0.001, {"BTC/USD": 100.0, "ETH/USD": 10.0}, 2)
    assert paid == pytest.approx(0)  # long pays 1, short receives 1
    assert b.funding_paid() == pytest.approx(0)
    b.trade("ETH/USD", 1000, 10.0, 3, "t")
    b.apply_funding(0.001, {"BTC/USD": 100.0}, 4)
    assert b.equity({"BTC/USD": 100.0}) == pytest.approx(999)


def test_margin_and_liquidation():
    b = broker(lev=10)
    with pytest.raises(MarginError):
        b.trade("BTC/USD", 20_000, 100.0, 1, "t", prices={"BTC/USD": 100.0})
    b.trade("BTC/USD", 9_000, 100.0, 1, "t", prices={"BTC/USD": 100.0})  # 9x
    assert not b.liquidation_check({"BTC/USD": 95.0})
    assert b.liquidation_check({"BTC/USD": 89.0})  # equity ~10 < maintenance ~40


def daily_series(prices, start=T0):
    return [Candle(start + i * DAY, p, p * 1.01, p * 0.99, p, 1) for i, p in enumerate(prices)]


def test_trend_votes_and_sizing():
    up = [100 * math.exp(0.01 * i + 0.02 * ((-1) ** i)) for i in range(120)]
    s = coin_signal("BTC/USD", daily_series(up), 0.30, 3)
    assert s.score == 1.0 and all(v == 1 for v in s.votes.values())
    assert s.weight == pytest.approx(0.30 / 3 / 0.93 / s.vol)
    down = list(reversed(up))
    assert coin_signal("BTC/USD", daily_series(down), 0.30, 3).score == -1.0
    assert coin_signal("BTC/USD", daily_series(up[:50]), 0.30, 3).weight == 0.0  # not enough history
    w, _ = TrendEnsemble(300, 1.0).targets({"A": daily_series(up), "B": daily_series(down)})
    assert sum(abs(x) for x in w.values()) == pytest.approx(1.0)  # gross cap


def test_brake_multiplier():
    assert brake_multiplier(0.50, 0.75, 0.75) == 1   # stop only, no shrinking
    assert brake_multiplier(0.75, 0.75, 0.75) == 0
    assert brake_multiplier(0.10, 0.20, 0.25) == 1
    assert brake_multiplier(0.225, 0.20, 0.25) == pytest.approx(0.5)
    assert brake_multiplier(0.30, 0.20, 0.25) == 0


def make_engine(tmp_path, overseer=None, **fut):
    cfg = Config(); cfg.mode = "futures"; cfg.market.symbols = ["BTC/USD", "ETH/USD"]
    cfg.futures.fee_bps = 0; cfg.futures.slippage_bps = 0; cfg.futures.funding_rate_8h_pct = 0
    for k, v in fut.items():
        setattr(cfg.futures, k, v)
    b = FuturesPaperBroker(":memory:", 1000, 0, 0, cfg.futures.leverage, 0.5)
    return cfg, b, FuturesEngine(cfg, b, overseer=overseer(cfg) if overseer else None, kill_switch_path=tmp_path / "STOP")


def market(day_index, up_price=None, down_price=None):
    up = [100 * math.exp(0.01 * i + 0.02 * ((-1) ** i)) for i in range(120 + day_index)]
    down = [50 * math.exp(-0.01 * i + 0.02 * ((-1) ** i)) for i in range(120 + day_index)]
    d = {"BTC/USD": daily_series(up), "ETH/USD": daily_series(down)}
    ts = d["BTC/USD"][-1].ts + DAY
    bp, ep = up_price or up[-1], down_price or down[-1]
    h = {"BTC/USD": [Candle(ts - 3600, bp, bp, bp, bp, 1)], "ETH/USD": [Candle(ts - 3600, ep, ep, ep, ep, 1)]}
    return h, d, ts


def test_engine_goes_long_uptrend_short_downtrend_once_per_day(tmp_path):
    cfg, b, e = make_engine(tmp_path)
    h, d, ts = market(0)
    r = e.run_cycle(h, d, ts)
    assert r.rebalanced and len(r.fills) == 2
    pos = b.positions()
    assert pos["BTC/USD"].qty > 0 and pos["ETH/USD"].qty < 0
    r2 = e.run_cycle(h, d, ts + 3600)  # same daily candles: hourly check only
    assert not r2.rebalanced and not r2.fills


def test_drawdown_stop_closes_and_halts(tmp_path):
    cfg, b, e = make_engine(tmp_path, vol_target_pct=300, max_gross_leverage=3)
    h, d, ts = market(0)
    e.run_cycle(h, d, ts)
    long_px = h["BTC/USD"][-1].close
    h2, _, _ = market(0, up_price=long_px * 0.80, down_price=h["ETH/USD"][-1].close * 1.2)
    r = e.run_cycle(h2, d, ts + 3600)
    assert not b.positions()
    assert (tmp_path / "STOP").exists()
    assert "stop" in " ".join(r.notes)


def test_liquidation_halts(tmp_path):
    cfg, b, e = make_engine(tmp_path, leverage=100, drawdown_stop_pct=100, drawdown_brake_start_pct=99)
    b.trade("BTC/USD", 50_000, 100.0, 1, "test: 50x long")
    h, d, ts = market(0)
    h["BTC/USD"] = [Candle(ts - 3600, 100, 100, 97.5, 99, 1)]
    r = e.run_cycle(h, d, ts)
    assert any(f.reason == "LIQUIDATION" for f in r.fills)
    assert (tmp_path / "STOP").exists()


def overseer_with(answer=None, error=None):
    def make(cfg):
        return ClaudeOverseer(cfg, client=FakeClient(fake_response(answer) if answer else None, error=error))
    return make


def test_overseer_can_only_reduce(tmp_path):
    ans = {"summary": "ETH stretched", "reviews": [
        {"symbol": "BTC/USD", "multiplier": 3.0, "reason": "tries to grow"},
        {"symbol": "ETH/USD", "multiplier": 0.0, "reason": "close it"}]}
    cfg, b, e = make_engine(tmp_path, overseer=overseer_with(ans))
    cfg2, b2, e2 = make_engine(tmp_path / "x")
    h, d, ts = market(0)
    e.run_cycle(h, d, ts); e2.run_cycle(h, d, ts)
    assert b.positions()["BTC/USD"].qty == pytest.approx(b2.positions()["BTC/USD"].qty)  # clamped to 1
    assert "ETH/USD" not in b.positions()
    call = e.overseer.client.calls[0]
    assert call["fallbacks"] == "default"


def test_overseer_failure_keeps_rules(tmp_path):
    import anthropic, httpx2
    err = anthropic.APIConnectionError(request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))
    cfg, b, e = make_engine(tmp_path, overseer=overseer_with(error=err))
    h, d, ts = market(0)
    r = e.run_cycle(h, d, ts)
    assert len(b.positions()) == 2 and "API error" in r.decision.summary
