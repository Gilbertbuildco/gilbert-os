"""Download Binance USDT-M perpetual 1h klines and funding rates, verify checksums, write clean CSVs."""
import csv, hashlib, io, sys, zipfile, urllib.request
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW, CLEAN = HERE / "data" / "raw", HERE / "data" / "clean"
RAW.mkdir(parents=True, exist_ok=True); CLEAN.mkdir(parents=True, exist_ok=True)
BASE = "https://data.binance.vision/data/futures/um"
SYMS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
months = []
y, m = 2024, 11
while (y, m) <= (2026, 10):
    months.append(f"{y}-{m:02d}"); m += 1
    if m == 13: y, m = y + 1, 1
days = [(date(2026, 11, 1) + timedelta(d)).isoformat() for d in range(26)]

def get(url):
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            return r.read()
    except Exception as e:
        return None

def fetch(url):
    dest = RAW / url.split("/")[-1]
    if not dest.exists():
        data = get(url)
        if data is None:
            return None
        chk = get(url + ".CHECKSUM")
        if chk and chk.split()[0].decode() != hashlib.sha256(data).hexdigest():
            raise SystemExit(f"checksum mismatch {url}")
        dest.write_bytes(data)
    with zipfile.ZipFile(dest) as z:
        return z.read(z.namelist()[0]).decode()

def rows(text):
    for r in csv.reader(io.StringIO(text)):
        if r and r[0][:1].isdigit():
            yield r

for s in SYMS:
    out = {}
    for mo in months:
        t = fetch(f"{BASE}/monthly/klines/{s}/1h/{s}-1h-{mo}.zip")
        if t is None: print("missing", s, mo); continue
        for r in rows(t): out[int(r[0])] = r
    for d in days:
        t = fetch(f"{BASE}/daily/klines/{s}/1h/{s}-1h-{d}.zip")
        if t is None: print("missing", s, d); continue
        for r in rows(t): out[int(r[0])] = r
    with open(CLEAN / f"{s}_1h.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["ts", "open", "high", "low", "close", "volume", "quote_volume", "taker_buy_quote"])
        for k in sorted(out):
            r = out[k]
            ts = k // 1000 if k > 10**14 else k
            w.writerow([ts // 1000, r[1], r[2], r[3], r[4], r[5], r[7], r[10]])
    fr = {}
    for mo in months:
        t = fetch(f"{BASE}/monthly/fundingRate/{s}/{s}-fundingRate-{mo}.zip")
        if t is None: print("missing funding", s, mo); continue
        for r in rows(t): fr[int(r[0])] = r
    with open(CLEAN / f"{s}_funding.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["ts", "interval_hours", "rate"])
        for k in sorted(fr):
            w.writerow([k // 1000, fr[k][1], fr[k][2]])
    print(s, len(out), "candles", len(fr), "funding prints")
