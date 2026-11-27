"""Download Binance USDT-M perpetual 1-minute klines (checksum-verified) into data/clean/{SYM}_1m.npz."""
import csv, hashlib, io, sys, zipfile, urllib.request
from datetime import date, timedelta
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
OUT = HERE / "data" / "clean"; OUT.mkdir(parents=True, exist_ok=True)
BASE = "https://data.binance.vision/data/futures/um"
SYMS = sys.argv[1:] or ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
months, (y, m) = [], (2024, 11)
while (y, m) <= (2026, 10):
    months.append(f"{y}-{m:02d}"); m += 1
    if m == 13: y, m = y + 1, 1
days = [(date(2026, 11, 1) + timedelta(d)).isoformat() for d in range(25)]

def get(url):
    try:
        with urllib.request.urlopen(url, timeout=120) as r:
            return r.read()
    except Exception:
        return None

def fetch(url):
    data = get(url)
    if data is None:
        return None
    chk = get(url + ".CHECKSUM")
    if chk and chk.split()[0].decode() != hashlib.sha256(data).hexdigest():
        raise SystemExit(f"checksum mismatch {url}")
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return z.read(z.namelist()[0]).decode()

for s in SYMS:
    rows = {}
    urls = [f"{BASE}/monthly/klines/{s}/1m/{s}-1m-{mo}.zip" for mo in months] + \
           [f"{BASE}/daily/klines/{s}/1m/{s}-1m-{d}.zip" for d in days]
    for u in urls:
        t = fetch(u)
        if t is None:
            print("missing", u.split("/")[-1]); continue
        for r in csv.reader(io.StringIO(t)):
            if r and r[0][:1].isdigit():
                k = int(r[0]); k = k // 1000 if k > 10**14 else k
                rows[k // 1000] = (float(r[1]), float(r[2]), float(r[3]), float(r[4]))
    ts = np.array(sorted(rows), dtype=np.int64)
    a = np.array([rows[t] for t in ts])
    np.savez_compressed(OUT / f"{s}_1m.npz", ts=ts, o=a[:, 0], h=a[:, 1], l=a[:, 2], c=a[:, 3])
    gaps = int((np.diff(ts) != 60).sum())
    print(f"{s}: {len(ts):,} one-minute candles, {gaps} gaps, {ts[0]} -> {ts[-1]}", flush=True)
