import pytest

from trader.broker import InsufficientFunds, PaperBroker


def make():
    return PaperBroker(":memory:", 10_000, fee_bps=10, slippage_bps=0)


def test_buy_then_sell_round_trip_accounts_for_fees():
    b = make()
    f = b.buy("BTC/USD", 1_000, 100.0, 1, "test")
    assert b.cash == pytest.approx(9_000)
    assert f.qty == pytest.approx(9.99)  # 0.1% fee taken from the order
    pos = b.positions()["BTC/USD"]
    assert pos.avg_price == pytest.approx(1_000 / 9.99)  # cost basis includes the fee
    s = b.sell("BTC/USD", pos.qty, 110.0, 2, "test")
    proceeds = 9.99 * 110
    assert s.realized_pnl == pytest.approx(proceeds * 0.999 - 1_000)
    assert "BTC/USD" not in b.positions()
    assert b.cash == pytest.approx(9_000 + proceeds * 0.999)


def test_slippage_worsens_fills():
    b = PaperBroker(":memory:", 10_000, fee_bps=0, slippage_bps=100)
    assert b.buy("ETH/USD", 1_000, 100.0, 1, "t").price == pytest.approx(101.0)
    assert b.sell("ETH/USD", 1, 100.0, 2, "t").price == pytest.approx(99.0)


def test_cannot_overspend_or_sell_missing():
    b = make()
    with pytest.raises(InsufficientFunds):
        b.buy("BTC/USD", 20_000, 100.0, 1, "t")
    with pytest.raises(ValueError):
        b.sell("ETH/USD", 1, 100.0, 1, "t")


def test_partial_sell_and_journal(tmp_path):
    b = PaperBroker(tmp_path / "p.db", 10_000, fee_bps=0, slippage_bps=0)
    b.buy("BTC/USD", 1_000, 100.0, 1, "t")
    b.sell("BTC/USD", 4, 100.0, 2, "t")
    assert b.positions()["BTC/USD"].qty == pytest.approx(6)
    b.record_equity(3, {"BTC/USD": 100.0})
    # Survives a restart.
    b2 = PaperBroker(tmp_path / "p.db", 999, fee_bps=0, slippage_bps=0)
    assert b2.starting_cash == 10_000
    assert b2.positions()["BTC/USD"].qty == pytest.approx(6)
    assert b2.last_prices() == {"BTC/USD": 100.0}
    b2.reset(5_000)
    assert b2.cash == 5_000 and not b2.positions() and not b2.trades()
