"""Fixed £ risk per trade (not a % of equity), with tight stops, on the real path and resampled."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from stop_sizing import *

px, fund = load()
dbar = {s: resample(px[s], "1D") for s in SYMS}
for s in SYMS:
    a = pd.concat([dbar[s].high - dbar[s].low, (dbar[s].high - dbar[s].close.shift()).abs(),
                   (dbar[s].low - dbar[s].close.shift()).abs()], axis=1).max(axis=1).rolling(20).mean() / dbar[s].close
    print(f"{s} average daily range (ATR) {a.mean()*100:.1f}% of price, so a 1 ATR stop sits about {a.mean()*100:.1f}% away")

print("\n== Real path, fixed £200 risk per trade, 100x cross margin")
R = {}
for k in (0.5, 1.0, 2.0):
    cv, ex = run(px, fund, None, k, fixed=200.0)
    d = cv.resample("1D").last().dropna(); R[k] = ex["r"]
    big = sorted(ex["path"], key=lambda p: -p[5])[:1]
    print(f"stop {k} ATR: end £{d.iloc[-1]:,.0f}  lowest £{d.min():,.0f} on {d.idxmin().date()}  blown up: "
          f"{ex['blown'].strftime('%Y-%m-%d %H:%M') if ex['blown'] is not None else 'no'}  trades {ex['trades']}  win {ex['win%']}%  "
          f"avg {ex['r'].mean():+.2f}R  worst {ex['r'].min():.2f}R  largest position £{big[0][5]:,.0f}" if big else "")
    if ex["blown"] is not None:
        t0 = ex["blown"]
        print("   trades in the week before:")
        for p in ex["path"]:
            if t0 - pd.Timedelta("7D") <= p[0] <= t0:
                print(f"   {p[0]} {p[1]} {p[2]} entry {p[3]:.4g} exit {p[4]:.4g} notional £{p[5]:,.0f} pnl £{p[6]:,.0f}")

print("\n== Resampled: 20,000 two-year paths, three positions at a time, fixed £200 risk, ruin = equity gone")
rng = np.random.default_rng(3)
for k, r in R.items():
    if len(r) < 20:
        continue
    for label, rr in (("backtest edge", r), ("half the edge", r - r.mean() / 2)):
        draws = rng.choice(rr, size=(20_000, 60, 3))
        eq = 1000 + np.cumsum(200 * draws.sum(axis=2), axis=1)
        ruined = (eq <= 0).any(axis=1); below200 = (eq < 200).any(axis=1)
        print(f"stop {k} ATR, {label}: P(account wiped out) {ruined.mean()*100:.0f}%  P(ever below £200) {below200.mean()*100:.0f}%  "
              f"median end £{np.median(np.where(ruined, 0, eq[:, -1])):,.0f}")

print("\n== Alternatives, resampled the same way (wiped out = equity gone)")
def sim_paths(r, risk_fn, n=20_000, rounds=60):
    eq = np.full(n, 1000.0); ruined = np.zeros(n, bool); low = eq.copy()
    for t in range(rounds):
        risk = np.where(ruined, 0.0, risk_fn(eq))
        eq = eq + risk * rng.choice(r, size=(n, 3)).sum(axis=1)
        ruined |= eq <= 0; eq = np.where(ruined, 0.0, eq); low = np.minimum(low, eq)
    return eq, ruined, low
schemes = {
    "fixed £50": lambda e: np.full_like(e, 50.0),
    "fixed £100": lambda e: np.full_like(e, 100.0),
    "fixed £200": lambda e: np.full_like(e, 200.0),
    "5% of equity": lambda e: 0.05 * e,
    "£50, rising to £200 as the account grows (5% of equity, max £200)": lambda e: np.minimum(0.05 * e, 200.0),
}
for k in (1.0, 2.0):
    for label, rr in (("backtest edge", R[k]), ("half the edge", R[k] - R[k].mean() / 2)):
        print(f"-- stop {k} ATR, {label}")
        for name, fn in schemes.items():
            eq, ruined, low = sim_paths(rr, fn)
            print(f"   {name:<66} wiped out {ruined.mean()*100:>3.0f}%  ever below £300 {np.mean(low < 300)*100:>3.0f}%  median end £{np.median(eq):>7,.0f}")

print("\n== Step-up scheme: £100 per trade, £200 once the account reaches £2,000 (2 ATR stop)")
step = lambda e: np.where(e >= 2000, 200.0, 100.0)
for label, rr in (("backtest edge", R[2.0]), ("half the edge", R[2.0] - R[2.0].mean() / 2), ("no edge", R[2.0] - R[2.0].mean())):
    eq, ruined, low = sim_paths(rr, step)
    print(f"   {label:<14} wiped out {ruined.mean()*100:>3.0f}%  ever below £300 {np.mean(low < 300)*100:>3.0f}%  median end £{np.median(eq):>7,.0f}")
for label, rr in (("no edge", R[2.0] - R[2.0].mean()),):
    for name in ("fixed £100", "fixed £200", "5% of equity"):
        eq, ruined, low = sim_paths(rr, schemes[name])
        print(f"   {name}, {label}: wiped out {ruined.mean()*100:.0f}%  median end £{np.median(eq):,.0f}")
