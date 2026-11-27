"""Bootstrap the stop-sized trade outcomes WITH replacement, so the edge itself is uncertain, and model three
positions open at once (each round, three trades resolve against the same starting equity)."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from stop_sizing import *

px, fund = load()
r = run(px, fund, 0.02, 2)[1]["r"]
se = r.std() / np.sqrt(len(r))
print(f"{len(r)} trades: mean {r.mean():+.3f}R, std {r.std():.2f}R, standard error {se:.3f}R, t-stat {r.mean() / se:.2f}")
rng = np.random.default_rng(7)
N, ROUNDS = 20_000, 56   # 167 trades over two years, about 3 at a time
for risk in (0.02, 0.05, 0.10, 0.20):
    draws = rng.choice(r, size=(N, ROUNDS, 3))
    round_ret = risk * draws.sum(axis=2)                # three positions open together
    eq = np.cumprod(np.maximum(1 + round_ret, 0), axis=1)
    mn, end = eq.min(axis=1), eq[:, -1]
    print(f"risk {int(risk*100):>2}% (£{int(risk*1000)}) per trade: median 2-year end £{np.median(end)*1000:,.0f}  "
          f"P(lose money) {np.mean(end < 1)*100:.0f}%  P(ever below £500) {np.mean(mn < .5)*100:.0f}%  "
          f"P(ever below £100, effectively blown) {np.mean(mn < .1)*100:.0f}%")

print("\nIf the future edge is smaller than this backtest's:")
for label, shift in (("half the edge (+0.075R)", r.mean() / 2), ("no edge (0R)", r.mean())):
    rr = r - shift
    for risk in (0.02, 0.05, 0.10, 0.20):
        draws = rng.choice(rr, size=(N, ROUNDS, 3))
        eq = np.cumprod(np.maximum(1 + risk * draws.sum(axis=2), 0), axis=1)
        mn, end = eq.min(axis=1), eq[:, -1]
        print(f"{label}, risk {int(risk*100):>2}%: median end £{np.median(end)*1000:,.0f}  P(lose money) {np.mean(end < 1)*100:.0f}%  "
              f"P(ever below £500) {np.mean(mn < .5)*100:.0f}%  P(ever below £100) {np.mean(mn < .1)*100:.0f}%")
