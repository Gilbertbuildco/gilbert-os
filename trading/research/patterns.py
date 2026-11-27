import sys; from pathlib import Path; sys.argv[1:] = sys.argv[1:] or [str(Path(__file__).resolve().parent)]; sys.path.insert(0, sys.argv[1])
from load import *
px, fund = load()
h = pd.DataFrame({s: px[s].close for s in SYMS}); rh = np.log(h).diff()
def t(x): x = x.dropna(); return x.mean()/x.std()*np.sqrt(len(x)) if len(x) > 2 else np.nan
def bps(x): return round(x*1e4, 1)

print("== Lead-lag: corr of BTC return at hour t with alt return at t+1 (and own autocorr)")
for s in SYMS: print(s, "btc->next", round(rh.BTC.corr(rh[s].shift(-1)),3), " own lag1", round(rh[s].autocorr(1),3))

print("\n== Autocorrelation of returns by horizon (sign of past k-bar return vs next k-bar return, mean fwd ret in bps when past>0 minus past<0)")
for rule, ks in [("4h", [1, 3, 6]), ("1D", [1, 3, 7, 14, 30])]:
    c = pd.DataFrame({s: resample(px[s], rule).close for s in SYMS}); lr = np.log(c)
    for k in ks:
        row = []
        for s in SYMS:
            past = lr[s].diff(k); fwd = lr[s].shift(-k) - lr[s]
            row.append(f"{s} {bps(fwd[past>0].mean()-fwd[past<0].mean()):>7} (t {t(np.sign(past)*fwd):.1f})")
        print(f"{rule} k={k:>2}:", " | ".join(row))

print("\n== RSI(14) extremes on 1h and 4h: mean forward return (bps), n")
def rsi(c, n=14):
    d = c.diff(); g = d.clip(lower=0).ewm(alpha=1/n, adjust=False).mean(); l = (-d.clip(upper=0)).ewm(alpha=1/n, adjust=False).mean()
    return 100 - 100/(1 + g/l)
for rule, fwdn in [("1h", 12), ("4h", 6)]:
    for s in SYMS:
        c = px[s].close if rule == "1h" else resample(px[s], rule).close
        r = rsi(c); fwd = np.log(c).shift(-fwdn) - np.log(c); base = fwd.mean()
        lo, hi = fwd[r < 25], fwd[r > 75]
        print(f"{rule} {s}: RSI<25 {bps(lo.mean()-base):>6} (n {len(lo)}, t {t(lo-base):.1f})  RSI>75 {bps(hi.mean()-base):>6} (n {len(hi)}, t {t(hi-base):.1f})  fwd {fwdn} bars")

print("\n== Big daily moves (>2 sd of trailing 30d): next 1d and 3d return (bps)")
d = pd.DataFrame({s: resample(px[s], "1D").close for s in SYMS}); ld = np.log(d); rd = ld.diff()
for s in SYMS:
    z = rd[s] / rd[s].rolling(30).std().shift(1)
    f1, f3 = rd[s].shift(-1), ld[s].shift(-3) - ld[s]
    print(s, "after up-shock: 1d", bps(f1[z>2].mean()), "3d", bps(f3[z>2].mean()), f"(n {int((z>2).sum())})", "| after down-shock: 1d", bps(f1[z<-2].mean()), "3d", bps(f3[z<-2].mean()), f"(n {int((z<-2).sum())})")

print("\n== Funding: forward 3d return by funding quintile (bps)")
for s in SYMS:
    f = fund[s].resample("8h").last().reindex(h.index, method="ffill")
    f8 = f.rolling(24).mean()  # trailing ~1 day avg
    fwd = np.log(h[s]).shift(-72) - np.log(h[s])
    qq = pd.qcut(f8, 5, labels=False, duplicates="drop")
    print(s, [bps(fwd[qq==i].mean()) for i in range(5)])

print("\n== Day of week mean daily return bps (t) and vol")
for s in SYMS:
    g = rd[s].groupby(rd.index.day_of_week)
    print(s, " ".join(f"{'MTWTFSS'[i]}:{bps(g.mean()[i]):>5}({t(rd[s][rd.index.day_of_week==i]):.1f})" for i in range(7)), " vol wkend/wkday", round(rd[s][rd.index.day_of_week>=5].std()/rd[s][rd.index.day_of_week<5].std(),2))
print("\n== Hour of day (UTC) mean return bps, top/bottom 3, BTC")
g = rh.BTC.groupby(rh.index.hour).agg(["mean", lambda x: t(x)])
g.columns = ["m","t"]; g["m"] = g.m*1e4
print(g.sort_values("m").round(2).iloc[[0,1,2,-3,-2,-1]].to_string())
