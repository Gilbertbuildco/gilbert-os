import sys; from pathlib import Path; sys.argv[1:] = sys.argv[1:] or [str(Path(__file__).resolve().parent)]; sys.path.insert(0, sys.argv[1])
from bt import *
c, hi, lo, fb = build(); d = daily_close(c); ld = np.log(d)
TV = 0.40 / np.sqrt(3) * np.sqrt(3)  # per-asset vol target, then /3 per asset -> comparable to grid
vs = vol_scale(c, target_ann=TV)
def w_of(sig): return on_daily(sig, c) * vs / 3
rows = []
def add(name, sig, w=None):
    rows.extend(split_stats(run(w if w is not None else w_of(sig), c, fb), name))

print("== Robustness: price vs SMA n, Sharpe ALL / IS / OOS")
for n in (30, 40, 50, 60, 70, 80):
    s_ = split_stats(run(w_of(np.sign(d - d.rolling(n).mean())), c, fb), "")
    print(f"sma{n}: " + "  ".join(f"{x['sharpe']:>5}" for x in s_), f" maxdd {s_[0]['maxdd%']}")

def ens(d):
    parts = [np.sign(d - d.rolling(n).mean()) for n in (20, 50, 100)] + [np.sign(np.log(d).diff(k)) for k in (14, 28, 56)]
    return sum(parts) / len(parts)
E = ens(d)
add("sma50", np.sign(d - d.rolling(50).mean()))
add("E1 ensemble", E)
# E2: alts follow a blend of their own trend and BTC's trend
E2 = E.copy(); 
for s in ("ETH", "SOL"): E2[s] = 0.5 * E[s] + 0.5 * E["BTC"]
add("E2 ens + BTC filter", E2)
# E3: scale by trend efficiency (|30d move| / path length), cut size in chop
er = (ld.diff(30).abs() / ld.diff().abs().rolling(30).sum())
add("E3 ens x efficiency", E * (er / er.rolling(180, min_periods=60).median()).clip(0, 1.5))
# E4: only trade when the ensemble agrees strongly (|E| >= 2/3), else flat
add("E4 ens, need 2/3 agree", E.where(E.abs() >= 2/3, 0))
# E5: ensemble with a 4h ATR trailing stop (flat until the daily signal changes sign)
def atr_stop(sig_daily, mult=3.0):
    w = w_of(sig_daily); out = w.copy()
    tr = pd.concat([hi - lo, (hi - c.shift()).abs(), (lo - c.shift()).abs()]).groupby(level=0).max()
    atr = tr.rolling(42).mean()  # 7 days of 4h bars
    sd = np.sign(on_daily(sig_daily, c))
    for s in SYMS:
        stopped, ext, last_sign = False, None, 0.0
        for i, t in enumerate(c.index):
            sg = sd[s].iloc[i]
            if np.isnan(sg) or np.isnan(atr[s].iloc[i]): continue
            if sg != last_sign: stopped, ext, last_sign = False, c[s].iloc[i], sg
            if stopped or sg == 0: out.iloc[i, out.columns.get_loc(s)] = 0.0; continue
            ext = max(ext, c[s].iloc[i]) if sg > 0 else min(ext, c[s].iloc[i])
            if (sg > 0 and c[s].iloc[i] < ext - mult * atr[s].iloc[i]) or (sg < 0 and c[s].iloc[i] > ext + mult * atr[s].iloc[i]):
                stopped = True; out.iloc[i, out.columns.get_loc(s)] = 0.0
    return out
add("E5 ens + 3ATR trail", None, atr_stop(E))
add("E6 ens no vol-target", None, on_daily(E, c) * (0.75 / 3) * 3 / 3 * 1.0)
res = pd.DataFrame(rows).set_index("label")
pd.set_option("display.width", 200); print(res.to_string())
print("\n== Per-asset contribution, E2 (ALL / IS / OOS return %)")
w = w_of(E2)
for s in SYMS:
    ws = w.copy(); ws[[x for x in SYMS if x != s]] = 0
    print(s, [x["ret%"] for x in split_stats(run(ws, c, fb), s)])
print("\n== Long vs short side, E2")
for side, f_ in (("long", lambda x: x.clip(lower=0)), ("short", lambda x: x.clip(upper=0))):
    print(side, [x["ret%"] for x in split_stats(run(f_(w), c, fb), side)])
