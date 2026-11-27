"""A simulated (paper) broker. Market orders fill at the last price plus slippage and fees.

All state lives in SQLite so the account survives restarts and every trade and decision is auditable.
"""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from .models import Decision, Fill, Position

SCHEMA = """
CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK (id = 1), cash REAL NOT NULL,
    starting_cash REAL NOT NULL, created_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS positions (symbol TEXT PRIMARY KEY, qty REAL NOT NULL, avg_price REAL NOT NULL);
CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, symbol TEXT NOT NULL,
    side TEXT NOT NULL, qty REAL NOT NULL, price REAL NOT NULL, fee REAL NOT NULL, realized_pnl REAL NOT NULL,
    reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS equity (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, equity REAL NOT NULL,
    cash REAL NOT NULL, prices TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, strategy TEXT NOT NULL,
    summary TEXT NOT NULL, notes TEXT NOT NULL, payload TEXT NOT NULL);
"""

DUST_USD = 0.01


class InsufficientFunds(Exception):
    pass


class PaperBroker:
    def __init__(self, db_path: str | Path, starting_cash: float, fee_bps: float = 26.0, slippage_bps: float = 5.0):
        if str(db_path) != ":memory:":
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(db_path))
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.fee = fee_bps / 10_000
        self.slip = slippage_bps / 10_000
        if self.db.execute("SELECT 1 FROM account").fetchone() is None:
            self.db.execute("INSERT INTO account VALUES (1, ?, ?, ?)", (starting_cash, starting_cash, int(time.time())))
            self.db.commit()

    # ---- account state -------------------------------------------------
    @property
    def cash(self) -> float:
        return self.db.execute("SELECT cash FROM account").fetchone()["cash"]

    @property
    def starting_cash(self) -> float:
        return self.db.execute("SELECT starting_cash FROM account").fetchone()["starting_cash"]

    def positions(self) -> dict[str, Position]:
        rows = self.db.execute("SELECT symbol, qty, avg_price FROM positions").fetchall()
        return {r["symbol"]: Position(r["symbol"], r["qty"], r["avg_price"]) for r in rows}

    def equity(self, prices: dict[str, float]) -> float:
        total = self.cash
        for s, p in self.positions().items():
            total += p.qty * prices.get(s, p.avg_price)
        return total

    # ---- orders --------------------------------------------------------
    def buy(self, symbol: str, usd: float, price: float, ts: int, reason: str) -> Fill:
        cash = self.cash
        if usd > cash + 1e-9:
            raise InsufficientFunds(f"Buy {symbol} for {usd:.2f} but only {cash:.2f} cash")
        usd = min(usd, cash)
        fill_px = price * (1 + self.slip)
        fee = usd * self.fee
        qty = (usd - fee) / fill_px
        pos = self.positions().get(symbol)
        if pos:
            new_qty = pos.qty + qty
            new_avg = (pos.qty * pos.avg_price + usd) / new_qty
        else:
            new_qty, new_avg = qty, usd / qty
        with self.db:
            self.db.execute("UPDATE account SET cash = cash - ?", (usd,))
            self.db.execute(
                "INSERT INTO positions VALUES (?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET qty = excluded.qty, "
                "avg_price = excluded.avg_price", (symbol, new_qty, new_avg))
            self._log(Fill(ts, symbol, "buy", qty, fill_px, fee, reason))
        return Fill(ts, symbol, "buy", qty, fill_px, fee, reason)

    def sell(self, symbol: str, qty: float, price: float, ts: int, reason: str) -> Fill:
        pos = self.positions().get(symbol)
        if not pos:
            raise ValueError(f"No {symbol} position to sell")
        qty = min(qty, pos.qty)
        fill_px = price * (1 - self.slip)
        proceeds = qty * fill_px
        fee = proceeds * self.fee
        pnl = proceeds - fee - qty * pos.avg_price
        remaining = pos.qty - qty
        with self.db:
            self.db.execute("UPDATE account SET cash = cash + ?", (proceeds - fee,))
            if remaining * fill_px < DUST_USD:
                self.db.execute("DELETE FROM positions WHERE symbol = ?", (symbol,))
            else:
                self.db.execute("UPDATE positions SET qty = ? WHERE symbol = ?", (remaining, symbol))
            fill = Fill(ts, symbol, "sell", qty, fill_px, fee, reason, pnl)
            self._log(fill)
        return fill

    def _log(self, f: Fill) -> None:
        self.db.execute(
            "INSERT INTO trades (ts, symbol, side, qty, price, fee, realized_pnl, reason) VALUES (?,?,?,?,?,?,?,?)",
            (f.ts, f.symbol, f.side, f.qty, f.price, f.fee, f.realized_pnl, f.reason))

    # ---- journal -------------------------------------------------------
    def record_equity(self, ts: int, prices: dict[str, float]) -> float:
        eq = self.equity(prices)
        with self.db:
            self.db.execute("INSERT INTO equity (ts, equity, cash, prices) VALUES (?,?,?,?)",
                            (ts, eq, self.cash, json.dumps(prices)))
        return eq

    def record_decision(self, ts: int, strategy: str, decision: Decision, extra: dict | None = None) -> None:
        payload = {"targets": decision.targets, "reasoning": decision.reasoning, "meta": decision.meta,
                   **(extra or {})}
        with self.db:
            self.db.execute("INSERT INTO decisions (ts, strategy, summary, notes, payload) VALUES (?,?,?,?,?)",
                            (ts, strategy, decision.summary, decision.notes, json.dumps(payload, default=str)))

    def trades(self, since_ts: int | None = None, limit: int | None = None) -> list[dict]:
        q = "SELECT * FROM trades"
        args: list = []
        if since_ts is not None:
            q += " WHERE ts >= ?"
            args.append(since_ts)
        q += " ORDER BY id DESC"
        if limit:
            q += f" LIMIT {int(limit)}"
        return [dict(r) for r in self.db.execute(q, args).fetchall()][::-1]

    def count_trades_since(self, ts: int, exclude_reason_prefix: str = "stop-loss") -> int:
        return self.db.execute("SELECT COUNT(*) FROM trades WHERE ts >= ? AND reason NOT LIKE ?",
                               (ts, exclude_reason_prefix + "%")).fetchone()[0]

    def equity_history(self) -> list[dict]:
        return [dict(r) for r in self.db.execute("SELECT ts, equity, cash, prices FROM equity ORDER BY id")]

    def first_equity_since(self, ts: int) -> float | None:
        row = self.db.execute("SELECT equity FROM equity WHERE ts >= ? ORDER BY id LIMIT 1", (ts,)).fetchone()
        return row["equity"] if row else None

    def last_prices(self) -> dict[str, float]:
        row = self.db.execute("SELECT prices FROM equity ORDER BY id DESC LIMIT 1").fetchone()
        return json.loads(row["prices"]) if row else {}

    def recent_decisions(self, n: int) -> list[dict]:
        rows = self.db.execute("SELECT ts, strategy, summary, notes, payload FROM decisions ORDER BY id DESC LIMIT ?",
                               (n,)).fetchall()
        out = []
        for r in rows[::-1]:
            d = dict(r)
            d["payload"] = json.loads(d["payload"])
            out.append(d)
        return out

    def reset(self, starting_cash: float) -> None:
        with self.db:
            for t in ("positions", "trades", "equity", "decisions", "account"):
                self.db.execute(f"DELETE FROM {t}")
            self.db.execute("INSERT INTO account VALUES (1, ?, ?, ?)", (starting_cash, starting_cash, int(time.time())))
