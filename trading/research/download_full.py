"""Full Binance USDT-M perpetual history: hourly klines and funding, from each contract's listing to Nov 2026.
Writes data/full/{SYM}USDT_1h.csv and {SYM}USDT_funding.csv (same format as data/clean)."""
import csv, hashlib, io, sys, zipfile, urllib.request
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW, OUT = HERE / "data" / "raw", HERE / "data" / "full"
RAW.mkdir(parents=True, exist_ok=True); OUT.mkdir(parents=True, exist_ok=True)
BASE = "https://data.binance.vision/data/futures/um"
SYMS = sys.argv[1:] or ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
months, (y, m) = [], (2019, 9)
while (y, m) <= (2026, 10):
    months.append(f"{y}-{m:02d}"); m += 1
    if m == 13: y, m = y + 1, 1
days = [(date(2026, 11, 1) + timedelta(d)).isoformat() for d in range(25)]

def get(url):
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            return r.read()
    except Exception:
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
    k, fr, missing = {}, {}, []
    for mo in months:
        t = fetch(f"{BASE}/monthly/klines/{s}/1h/{s}-1h-{mo}.zip")
        if t is None: missing.append(mo); continue
        for r in rows(t): k[int(r[0])] = r
        t = fetch(f"{BASE}/monthly/fundingRate/{s}/{s}-fundingRate-{mo}.zip")
        if t is not None:
            for r in rows(t): fr[int(r[0])] = r
    for d in days:
        t = fetch(f"{BASE}/daily/klines/{s}/1h/{s}-1h-{d}.zip")
        if t is not None:
            for r in rows(t): k[int(r[0])] = r
    with open(OUT / f"{s}_1h.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["ts", "open", "high", "low", "close", "volume", "quote_volume", "taker_buy_quote"])
        for key in sorted(k):
            r = k[key]; ts = key // 1000 if key > 10**14 else key
            w.writerow([ts // 1000, r[1], r[2], r[3], r[4], r[5], r[7], r[10]])
    with open(OUT / f"{s}_funding.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["ts", "interval_hours", "rate"])
        for key in sorted(fr):
            w.writerow([key // 1000, fr[key][1], fr[key][2]])
    first = date.fromtimestamp(min(k) // 1000)
    print(f"{s}: {len(k):,} hourly candles from {first}, {len(fr):,} funding prints"
          f"{', first funding ' + str(date.fromtimestamp(min(fr) // 1000)) if fr else ''}; months with no candles: "
          f"{missing[0] + ' to ' + missing[-1] if missing else 'none'} ({len(missing)})", flush=True)
