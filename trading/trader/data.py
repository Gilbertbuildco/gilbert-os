"""Market data feeds. None of these need an exchange account or API key."""
from __future__ import annotations

import csv
import json
import math
import random
import time
import urllib.parse
import urllib.request
from pathlib import Path

from .models import Candle


class FeedError(RuntimeError):
    pass


class KrakenFeed:
    """Live candles from Kraken's public OHLC endpoint (no account needed)."""

    BASE = "https://api.kraken.com/0/public/OHLC"
    INTERVALS = (1, 5, 15, 30, 60, 240, 1440, 10080, 21600)
    ALIASES = {"BTC": "XBT"}

    def __init__(self, interval_minutes: int, timeout: float = 20.0, opener=None, clock=time.time):
        if interval_minutes not in self.INTERVALS:
            raise ValueError(f"Kraken supports intervals {self.INTERVALS}, got {interval_minutes}")
        self.interval = interval_minutes
        self.timeout = timeout
        self._open = opener or urllib.request.urlopen
        self._clock = clock

    @classmethod
    def pair(cls, symbol: str) -> str:
        base, quote = symbol.upper().split("/")
        return cls.ALIASES.get(base, base) + cls.ALIASES.get(quote, quote)

    def candles(self, symbol: str, limit: int) -> list[Candle]:
        query = urllib.parse.urlencode({"pair": self.pair(symbol), "interval": self.interval})
        req = urllib.request.Request(f"{self.BASE}?{query}", headers={"User-Agent": "gilbert-paper-trader/0.1"})
        try:
            with self._open(req, timeout=self.timeout) as resp:
                payload = json.load(resp)
        except Exception as e:  # network, HTTP, JSON
            raise FeedError(f"Kraken request for {symbol} failed: {e}") from e
        if payload.get("error"):
            raise FeedError(f"Kraken error for {symbol}: {payload['error']}")
        result = payload.get("result") or {}
        rows = next((v for k, v in result.items() if k != "last"), None)
        if not rows:
            raise FeedError(f"Kraken returned no candles for {symbol}")
        candles = [
            Candle(int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[6])) for r in rows
        ]
        # Kraken's last row is the candle still forming; only act on closed candles.
        if candles and candles[-1].ts + self.interval * 60 > self._clock():
            candles = candles[:-1]
        return candles[-limit:]


class CSVFeed:
    """Historical candles from CSV files named like BTC-USD.csv with columns ts,open,high,low,close,volume."""

    def __init__(self, directory: str | Path):
        self.dir = Path(directory)

    def path(self, symbol: str) -> Path:
        return self.dir / f"{symbol.replace('/', '-')}.csv"

    def load(self, symbol: str) -> list[Candle]:
        p = self.path(symbol)
        if not p.exists():
            raise FeedError(f"No CSV for {symbol} at {p}")
        with p.open() as f:
            out = [
                Candle(int(float(r["ts"])), float(r["open"]), float(r["high"]), float(r["low"]),
                       float(r["close"]), float(r.get("volume") or 0))
                for r in csv.DictReader(f)
            ]
        return sorted(out, key=lambda c: c.ts)

    def candles(self, symbol: str, limit: int) -> list[Candle]:
        return self.load(symbol)[-limit:]


def save_csv(candles: list[Candle], path: str | Path) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["ts", "open", "high", "low", "close", "volume"])
        for c in candles:
            w.writerow([c.ts, c.open, c.high, c.low, c.close, c.volume])


def synthetic_series(symbol: str, n: int, interval_minutes: int = 60, seed: int = 7,
                     start_price: float | None = None, end_ts: int | None = None) -> list[Candle]:
    """A reproducible random walk with drifting trend regimes, for demos and tests."""
    rng = random.Random(f"{seed}:{symbol}")
    price = start_price or {"BTC": 60_000.0, "ETH": 3_000.0, "SOL": 150.0}.get(symbol.split("/")[0], 100.0)
    step = interval_minutes * 60
    end = end_ts if end_ts is not None else int(time.time()) // step * step - step
    start = end - (n - 1) * step
    vol = 0.006 * math.sqrt(interval_minutes / 60)
    drift = 0.0
    out = []
    for i in range(n):
        if i % 120 == 0:
            drift = rng.gauss(0, vol / 6)
        o = price
        c = o * math.exp(drift + rng.gauss(0, vol))
        hi = max(o, c) * (1 + abs(rng.gauss(0, vol / 2)))
        lo = min(o, c) * (1 - abs(rng.gauss(0, vol / 2)))
        out.append(Candle(start + i * step, o, hi, lo, c, abs(rng.gauss(100, 30))))
        price = c
    return out


class SyntheticFeed:
    """Serves synthetic candles ending at the last closed interval, so `run` works with no network."""

    def __init__(self, interval_minutes: int, seed: int = 7):
        self.interval = interval_minutes
        self.seed = seed

    def candles(self, symbol: str, limit: int) -> list[Candle]:
        # Anchor the walk to a fixed epoch so successive calls extend the same path.
        step = self.interval * 60
        end = int(time.time()) // step * step - step
        anchor = 1_767_225_600  # 2026-01-01T00:00Z
        n = min(max(limit, (end - anchor) // step + 1), 20_000)
        return synthetic_series(symbol, n, self.interval, self.seed, end_ts=end)[-limit:]


def make_feed(cfg):
    m = cfg.market
    if m.source == "kraken":
        return KrakenFeed(m.interval_minutes)
    if m.source == "csv":
        return CSVFeed(cfg.path(m.csv_dir))
    return SyntheticFeed(m.interval_minutes)
