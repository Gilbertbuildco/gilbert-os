"""Paper perpetual-futures account: signed positions, cross margin, funding and liquidation.

Accounting: `cash` is the wallet balance after all realised flows. Opening a position moves its notional
through cash and adds qty * price back as position value, so equity = cash + sum(qty * price) holds for
longs (qty > 0) and shorts (qty < 0) alike.
"""
from __future__ import annotations

import math

from .broker import DUST_USD, PaperBroker
from .models import Fill

FUTURES_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS funding (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, symbol TEXT NOT NULL,
    rate REAL NOT NULL, amount REAL NOT NULL);
"""


class MarginError(Exception):
    pass


class FuturesPaperBroker(PaperBroker):
    def __init__(self, db_path, starting_cash: float, fee_bps: float = 5.0, slippage_bps: float = 2.0,
                 leverage: float = 100.0, maintenance_margin_pct: float = 0.5):
        super().__init__(db_path, starting_cash, fee_bps, slippage_bps)
        self.db.executescript(FUTURES_SCHEMA)
        self.leverage = leverage
        self.mmr = maintenance_margin_pct / 100

    # ---- meta ------------------------------------------------------------
    def get_meta(self, key: str, default=None):
        row = self.db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default

    def set_meta(self, key: str, value) -> None:
        with self.db:
            if value is None:
                self.db.execute("DELETE FROM meta WHERE key = ?", (key,))
            else:
                self.db.execute("INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                                (key, str(value)))

    # ---- margin ----------------------------------------------------------
    def gross_notional(self, prices: dict[str, float]) -> float:
        return sum(abs(p.qty) * prices.get(s, p.avg_price) for s, p in self.positions().items())

    def initial_margin(self, prices) -> float:
        return self.gross_notional(prices) / self.leverage

    def maintenance_margin(self, prices) -> float:
        return self.gross_notional(prices) * self.mmr

    # ---- orders ----------------------------------------------------------
    def trade(self, symbol: str, notional: float, price: float, ts: int, reason: str,
              prices: dict[str, float] | None = None, slippage: bool = True) -> Fill:
        """Buy (notional > 0) or sell (notional < 0) that much notional at market."""
        side = 1 if notional > 0 else -1
        fill_px = price * (1 + self.slip * side) if slippage else price
        q = notional / fill_px
        fee = abs(notional) * self.fee
        pos = self.positions().get(symbol)
        old_q, entry = (pos.qty, pos.avg_price) if pos else (0.0, 0.0)
        new_q = old_q + q

        if prices is not None:  # margin check on the resulting book
            after = dict(prices)
            after[symbol] = price
            gross = sum(abs(p.qty if s != symbol else new_q) * after.get(s, p.avg_price)
                        for s, p in self.positions().items())
            if symbol not in self.positions():
                gross += abs(new_q) * price
            equity_after = self.equity(after) - fee - abs(q) * abs(fill_px - price)
            if gross / self.leverage > equity_after + 1e-9:
                raise MarginError(f"{symbol}: needs {gross / self.leverage:.2f} margin, equity {equity_after:.2f}")

        realized = 0.0
        if old_q == 0 or math.copysign(1, old_q) == math.copysign(1, q):
            new_entry = (abs(old_q) * entry + abs(q) * fill_px) / abs(new_q)
        else:
            closed = min(abs(q), abs(old_q))
            realized = closed * (fill_px - entry) * math.copysign(1, old_q)
            new_entry = fill_px if abs(q) > abs(old_q) else entry
        realized -= fee
        with self.db:
            self.db.execute("UPDATE account SET cash = cash - ?", (q * fill_px + fee,))
            if abs(new_q) * fill_px < DUST_USD:
                self.db.execute("DELETE FROM positions WHERE symbol = ?", (symbol,))
            else:
                self.db.execute(
                    "INSERT INTO positions VALUES (?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET qty = excluded.qty, "
                    "avg_price = excluded.avg_price", (symbol, new_q, new_entry))
            fill = Fill(ts, symbol, "buy" if q > 0 else "sell", abs(q), fill_px, fee, reason, realized)
            self._log(fill)
        return fill

    def close_all(self, prices: dict[str, float], ts: int, reason: str, slippage: bool = True) -> list[Fill]:
        fills = []
        for s, p in self.positions().items():
            fills.append(self.trade(s, -p.qty * prices[s], prices[s], ts, reason, slippage=slippage))
        return fills

    # ---- funding and liquidation ----------------------------------------
    def apply_funding(self, rate: float, prices: dict[str, float], ts: int) -> float:
        total = 0.0
        with self.db:
            for s, p in self.positions().items():
                amount = p.qty * prices.get(s, p.avg_price) * rate  # longs pay a positive rate
                self.db.execute("UPDATE account SET cash = cash - ?", (amount,))
                self.db.execute("INSERT INTO funding (ts, symbol, rate, amount) VALUES (?,?,?,?)", (ts, s, rate, amount))
                total += amount
        return total

    def funding_paid(self) -> float:
        return self.db.execute("SELECT COALESCE(SUM(amount), 0) FROM funding").fetchone()[0]

    def liquidation_check(self, worst_prices: dict[str, float]) -> bool:
        """True if equity at each position's worst price falls to maintenance margin."""
        if not self.positions():
            return False
        return self.equity(worst_prices) <= self.maintenance_margin(worst_prices)

    def reset(self, starting_cash: float) -> None:
        super().reset(starting_cash)
        with self.db:
            self.db.execute("DELETE FROM meta")
            self.db.execute("DELETE FROM funding")
