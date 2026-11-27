"""Late drawdown brake variants, and a block bootstrap of one-year outcomes."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from sim import *

px, fund = load()
print("== Late brake (shrink from start to 25%, flatten at 25%)")
curves = {}
for pv in (0.30, 0.35):
    for dds in (None, 0.18, 0.20):
        cv, ex = simulate(px, fund, port_vol=pv, dd_start=dds)
        s = summary(cv, ex); curves[(pv, dds)] = cv
        print(f"vol {int(pv*100)}% brake {dds}: end £{s['end']:.0f} ret {s['ret%']}% sharpe {s['sharpe']} maxDD {s['maxdd%']}%")

print("\n== One-year block bootstrap (20-day blocks, 20,000 paths) of daily returns, no brake")
rng = np.random.default_rng(42)
for pv in (0.25, 0.30, 0.35, 0.40):
    cv, ex = simulate(px, fund, port_vol=pv)
    r = cv.resample("1D").last().pct_change().dropna().values
    r = r[95:]  # drop the warm-up months with no positions
    n, B, N = 365, 20, 20_000
    starts = rng.integers(0, len(r) - B, size=(N, n // B + 1))
    paths = np.concatenate([r[s_:s_ + B] for s_ in starts.ravel()]).reshape(N, -1)[:, :n]
    eq = np.cumprod(1 + paths, axis=1)
    mdd = (1 - eq / np.maximum.accumulate(eq, axis=1)).max(axis=1)
    fin = eq[:, -1] - 1
    print(f"vol {int(pv*100)}%: P(drawdown > 25%) {np.mean(mdd > 0.25)*100:.1f}%  P(> 15%) {np.mean(mdd > 0.15)*100:.0f}%  "
          f"P(losing year) {np.mean(fin < 0)*100:.0f}%  median year {np.median(fin)*100:+.0f}%  "
          f"5th pct {np.percentile(fin, 5)*100:+.0f}%  95th pct {np.percentile(fin, 95)*100:+.0f}%")

print("\n== Same bootstrap with the late brake applied along each path (shrink from 20%, stop at 25%)")
for pv in (0.25, 0.30, 0.35):
    cv, ex = simulate(px, fund, port_vol=pv)
    r = cv.resample("1D").last().pct_change().dropna().values[95:]
    n, B, N = 365, 20, 20_000
    starts = rng.integers(0, len(r) - B, size=(N, n // B + 1))
    paths = np.concatenate([r[s_:s_ + B] for s_ in starts.ravel()]).reshape(N, -1)[:, :n]
    eq = np.ones(N); peak = np.ones(N); mdd = np.zeros(N); stopped = np.zeros(N, bool)
    for t in range(n):
        dd = 1 - eq / peak
        m = np.clip((0.25 - dd) / 0.05, 0, 1); m[stopped] = 0
        eq = eq * (1 + m * paths[:, t]); peak = np.maximum(peak, eq)
        dd = 1 - eq / peak; mdd = np.maximum(mdd, dd); stopped |= dd >= 0.25
    fin = eq - 1
    print(f"vol {int(pv*100)}%: P(stopped at 25%) {stopped.mean()*100:.1f}%  worst drawdown seen {mdd.max()*100:.1f}%  "
          f"P(losing year) {np.mean(fin < 0)*100:.0f}%  median year {np.median(fin)*100:+.0f}%  5th pct {np.percentile(fin, 5)*100:+.0f}%")
