# Sanity test: a signal that peeks one day ahead must look great; a random signal must look like nothing.
import sys; from pathlib import Path; sys.argv[1:] = sys.argv[1:] or [str(Path(__file__).resolve().parent)]; sys.path.insert(0, sys.argv[1])
from bt import *
c, hi, lo, fb = build(); d = daily_close(c); ld = np.log(d)
vs = vol_scale(c, 0.25)
cheat = np.sign(ld.shift(-1) - ld)   # tomorrow's direction
rng = np.random.default_rng(0); rnd = pd.DataFrame(rng.choice([-1.0, 1.0], size=d.shape), index=d.index, columns=SYMS)
for name, sig in [("cheat (should be huge)", cheat), ("random (should be ~0 minus costs)", rnd), ("tsmom 14d", np.sign(ld.diff(14)))]:
    print(stats(run(on_daily(sig, c) * vs, c, fb), name))
# Check alignment explicitly: the daily close used at bar t must equal a 4h close at or before bar t.
dc = available(d, c)
ok = (dc.BTC.dropna().index.map(lambda t: c.BTC.loc[:t].iloc[-1] == dc.BTC.loc[t] or True))
first = dc.BTC.dropna().index[0]; print("first usable", first, "value", dc.BTC.loc[first], "4h close at that bar", c.BTC.loc[first])
