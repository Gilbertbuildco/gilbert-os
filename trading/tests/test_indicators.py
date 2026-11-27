from trader.indicators import atr, ema, pct_change, rsi, sma, snapshot, volatility
from trader.models import Candle


def test_sma_and_ema():
    v = [1, 2, 3, 4, 5]
    assert sma(v, 5) == 3
    assert sma(v, 6) is None
    assert ema([2.0] * 30, 10) == 2.0


def test_rsi_extremes():
    assert rsi([float(i) for i in range(30)]) == 100.0
    assert rsi([float(30 - i) for i in range(30)]) == 0.0
    assert rsi([1.0] * 30) == 50.0


def test_pct_change_and_volatility():
    assert abs(pct_change([100, 110], 1) - 10) < 1e-9
    assert volatility([100.0] * 30) == 0.0


def test_atr_constant_range():
    candles = [Candle(i, 10, 11, 9, 10, 1) for i in range(20)]
    assert abs(atr(candles) - 2.0) < 1e-9


def test_snapshot_shape():
    candles = [Candle(i, 10 + i, 11 + i, 9 + i, 10 + i, 1) for i in range(60)]
    s = snapshot(candles)
    assert s["last_price"] == 69
    assert s["sma"]["200"] is None and s["sma"]["20"] is not None
    assert len(s["recent_closes"]) == 24
