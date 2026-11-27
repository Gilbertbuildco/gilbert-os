import sys; from pathlib import Path; sys.argv[1:] = sys.argv[1:] or [str(Path(__file__).resolve().parent)]; sys.path.insert(0, sys.argv[1])
from bt import *
c, hi, lo, fb = build()

def ens(d):
    parts = [np.sign(d - d.rolling(n).mean()) for n in (20, 50, 100)] + [np.sign(np.log(d).diff(k)) for k in (14, 28, 56)]
    return sum(parts) / len(parts)

def strat_weights(c, port_vol=0.30, hour=0, max_gross=3.0):
    # daily bar boundaries shifted to `hour` UTC to test decision-time sensitivity
    d = c.resample("24h", offset=f"{hour}h").last()
    E = ens(d)
    rv = np.log(d).diff().rolling(20).std() * np.sqrt(365)
    # each asset gets an equal share of risk; correlation ~0.8 means 3 equal-vol positions ~ 0.93x one position's vol
    per_asset = port_vol / 3 / 0.93 * 3 / 3
    w = E * (per_asset / rv) 
    gross = w.abs().sum(axis=1); w = w.mul((max_gross / gross).clip(upper=1.0), axis=0)
    x = w.copy(); x.index = x.index + pd.Timedelta("1D") - pd.Timedelta("4h")
    return x.reindex(c.index, method="ffill")

print("== Portfolio vol target vs outcome (ALL period)")
for pv in (0.15, 0.30, 0.45, 0.60, 0.90):
    s_ = stats(run(strat_weights(c, pv), c, fb)); is_, oos = [stats(x) for x in (run(strat_weights(c, pv), c, fb).pipe(lambda r: r[r.index < SPLIT]), run(strat_weights(c, pv), c, fb).pipe(lambda r: r[r.index >= SPLIT]))]
    print(f"target {int(pv*100)}%: ret {s_['ret%']}%  cagr {s_['cagr%']}%  vol {s_['vol%']}%  sharpe {s_['sharpe']}  maxDD {s_['maxdd%']}%  avg lev {s_['avg_lev']}x  max lev {s_['max_lev']}x | year1 {is_['ret%']}%  year2 {oos['ret%']}%")

print("\n== Cost sensitivity (30% target)")
for fee in (0.0004, 0.0007, 0.0014, 0.0021):
    s_ = stats(run(strat_weights(c), c, fb, fee=fee)); print(f"cost {fee*1e4:.0f} bps/side: ret {s_['ret%']}%  sharpe {s_['sharpe']}")

print("\n== Decision hour sensitivity (30% target)")
for h in (0, 4, 8, 12, 16, 20):
    s_ = stats(run(strat_weights(c, hour=h), c, fb)); print(f"decide at {h:02d}:00 UTC: ret {s_['ret%']}%  sharpe {s_['sharpe']}  maxDD {s_['maxdd%']}%")

print("\n== Worst moves in the data (what leverage must survive)")
for s in SYMS:
    r4 = (lo[s] / c[s].shift() - 1).min(), (hi[s] / c[s].shift() - 1).max()
    dd = c[s].resample("1D").last(); r1 = dd.pct_change()
    print(f"{s}: worst 4h low vs prior close {r4[0]*100:.1f}%, best 4h high {r4[1]*100:.1f}%, worst day {r1.min()*100:.1f}%, best day {r1.max()*100:.1f}%")

base = run(strat_weights(c), c, fb)
eq = (1 + base.net).cumprod()
print("\n== Monthly returns (30% target), %")
m = (1 + base.net).resample("ME").prod() - 1
print((m * 100).round(1).to_string())
print("\nwin months", int((m > 0).sum()), "of", len(m), " best", round(m.max()*100,1), " worst", round(m.min()*100,1))
w = strat_weights(c)
print("time long/short/flat by asset (%):")
for s in SYMS:
    x = w[s].dropna(); print(s, round((x > 0.01).mean()*100), round((x < -0.01).mean()*100), round((x.abs() <= 0.01).mean()*100))
trades = (np.sign(w).diff().abs() > 0).sum(); print("direction changes per asset over 2y:", trades.to_dict())
# save curves for charts
bh = (1 + c.pct_change().mean(axis=1).fillna(0)).cumprod()
out = pd.DataFrame({"strategy": eq, "buy_hold": bh.reindex(eq.index)}).resample("1D").last().dropna()
out.to_csv(sys.argv[1] + "/data/curves.csv")
pos = w.resample("1D").last().dropna(); pos.to_csv(sys.argv[1] + "/data/positions.csv")
