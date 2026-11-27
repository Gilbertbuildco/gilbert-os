import sys; from pathlib import Path; sys.argv[1:] = sys.argv[1:] or [str(Path(__file__).resolve().parent)]; sys.path.insert(0, sys.argv[1])
from bt import *
c, hi, lo, fb = build()
d = daily_close(c); ld = np.log(d)
vs = vol_scale(c, target_ann=0.40/np.sqrt(3))  # ~40% portfolio vol if assets were uncorrelated; we cap later
rows = []
def add(name, sig):
    w = on_daily(sig, c) * vs / 3 * 3 ** 0.5  # equal risk budget across 3 assets
    rows.extend(split_stats(run(w, c, fb), name))

add("buy&hold 1x", pd.DataFrame(1.0, index=d.index, columns=SYMS) / vs.reindex(d.index, method="ffill") * (1/np.sqrt(3)) )
for k in (7, 10, 14, 21, 28, 45):
    add(f"tsmom {k}d", np.sign(ld.diff(k)))
for n in (10, 20, 30, 50, 100):
    add(f"price>sma{n}", np.sign(d - d.rolling(n).mean()))
for f_, s_ in ((5, 20), (10, 30), (10, 50), (20, 50), (20, 100)):
    add(f"ema {f_}/{s_}", np.sign(d.ewm(span=f_).mean() - d.ewm(span=s_).mean()))
for n in (10, 20, 30, 55):
    dh, dl = d.rolling(n).max(), d.rolling(n).min()
    m = n // 2; xh, xl = d.rolling(m).max(), d.rolling(m).min()
    pos = pd.DataFrame(0.0, index=d.index, columns=SYMS)
    for s in SYMS:
        p = 0.0; out = []
        for t in range(len(d)):
            px_ = d[s].iloc[t]
            if p <= 0 and px_ >= dh[s].iloc[t]: p = 1.0
            elif p >= 0 and px_ <= dl[s].iloc[t]: p = -1.0
            elif p > 0 and px_ <= xl[s].iloc[t]: p = 0.0
            elif p < 0 and px_ >= xh[s].iloc[t]: p = 0.0
            out.append(p)
        pos[s] = out
    add(f"donchian {n}/{m}", pos)
# long-only versions of a couple, to see how much the short side matters
add("tsmom 14d long-only", np.sign(ld.diff(14)).clip(lower=0))
add("ema 10/30 long-only", np.sign(d.ewm(span=10).mean() - d.ewm(span=30).mean()).clip(lower=0))
# cross-sectional: long strongest, short weakest by k-day return (dollar neutral, risk scaled)
for k in (7, 14, 28):
    rk = ld.diff(k); rank = rk.rank(axis=1)
    sig = (rank == 3).astype(float) - (rank == 1).astype(float)
    add(f"xsec {k}d L/S", sig)
res = pd.DataFrame(rows).set_index("label")
pd.set_option("display.width", 200)
print(res.to_string())
res.to_csv(sys.argv[1] + "/data/grid_results.csv")
