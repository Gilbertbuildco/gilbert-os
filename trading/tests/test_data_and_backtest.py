import io
import json

import pytest

from trader.backtest import run_backtest
from trader.data import CSVFeed, FeedError, KrakenFeed, save_csv, synthetic_series
from trader.strategies.sma_cross import SmaCross
from helpers import config


def opener_for(payload):
    def _open(req, timeout):
        _open.url = req.full_url
        return io.BytesIO(json.dumps(payload).encode())
    return _open


def test_kraken_parses_and_drops_open_candle():
    rows = [[t, "1", "2", "0.5", str(t), "1.5", "10", 5] for t in (0, 3600, 7200)]
    op = opener_for({"error": [], "result": {"XXBTZUSD": rows, "last": 7200}})
    feed = KrakenFeed(60, opener=op, clock=lambda: 7200 + 100)  # 7200 candle still forming
    out = feed.candles("BTC/USD", 10)
    assert [c.ts for c in out] == [0, 3600]
    assert out[-1].close == 3600 and out[-1].volume == 10
    assert "pair=XBTUSD" in op.url and "interval=60" in op.url


def test_kraken_errors():
    with pytest.raises(FeedError):
        KrakenFeed(60, opener=opener_for({"error": ["EQuery:Unknown asset pair"]})).candles("FOO/USD", 5)
    with pytest.raises(ValueError):
        KrakenFeed(7)


def test_csv_round_trip(tmp_path):
    series = synthetic_series("BTC/USD", 50)
    save_csv(series, tmp_path / "BTC-USD.csv")
    assert CSVFeed(tmp_path).load("BTC/USD") == series


def test_synthetic_is_reproducible():
    assert synthetic_series("ETH/USD", 30, end_ts=10**9) == synthetic_series("ETH/USD", 30, end_ts=10**9)


def test_sma_backtest_runs_end_to_end():
    cfg = config()
    cfg.execution.fee_bps = 26
    cfg.strategy.name = "sma_cross"
    hist = {s: synthetic_series(s, 1500, end_ts=1_800_000_000) for s in cfg.market.symbols}
    stats = run_backtest(cfg, hist, SmaCross(cfg.strategy.sma_cross))
    assert stats["trades"] > 0
    assert stats["cycles"] == stats["period_candles"]
    assert stats["max_drawdown_pct"] >= 0
    assert "buy_and_hold_return_pct" in stats
