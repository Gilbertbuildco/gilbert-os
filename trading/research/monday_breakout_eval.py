import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from monday_breakout import *
from sim import simulate as sim_trend, summary
import warnings; warnings.filterwarnings("ignore")

trend = trend_scores(); data = {s: load1m(s) for s in ("BTC", "ETH", "SOL")}
tr = pd.concat([simulate(s, "opposite", None, 0.0, trend[s], data[s]) for s in data], ignore_index=True)
tr["week"] = pd.to_datetime(tr.t_in, unit="s", utc=True).dt.to_period("W-SUN").dt.start_time.dt.tz_localize("UTC")
print("Chosen rule: Monday range breakout, trend-filtered, stop at the opposite edge, exit at week end")
print(f"  {len(tr)} trades, average {tr.R_net.mean():+.2f}R, median risk distance {tr.risk_pct.median():.1f}% of price")
for s in data:
    x = tr[tr.sym == s].R_net; print(f"  {s}: {len(x)} trades, average {x.mean():+.2f}R, t {x.mean()/x.std()*np.sqrt(len(x)):.2f}")
for side, nm in ((1, "longs"), (-1, "shorts")):
    x = tr[tr.side == side].R_net; print(f"  {nm}: {len(x)} trades, average {x.mean():+.2f}R")
srt = tr.R_net.sort_values(ascending=False)
print(f"  without the best 5 trades: average {srt.iloc[5:].mean():+.2f}R; without the best 10: {srt.iloc[10:].mean():+.2f}R")
print(f"  exits: {tr.why.value_counts().to_dict()}; best {tr.R_net.max():+.1f}R, worst {tr.R_net.min():+.2f}R")

# Weekly returns: breakout sleeve at r% risk per trade vs the trend ensemble at a 35% vol target
px, fund = load()
cv, ex = sim_trend(px, fund, port_vol=0.35)
trend_w = cv.resample("W-SUN").last().pct_change().dropna()
trend_w.index = trend_w.index.normalize() - pd.Timedelta("6D")  # label by week start (Monday)
bo_R = tr.groupby("week").R_net.sum()
weeks = trend_w.index[trend_w.index >= bo_R.index.min()]
bo_R = bo_R.reindex(weeks).fillna(0.0); tw = trend_w.reindex(weeks).fillna(0.0)
print(f"\nCorrelation of weekly returns, breakout sleeve vs trend ensemble: {np.corrcoef(bo_R, tw)[0, 1]:.2f}")

def perf(w):
    eq = (1 + w).cumprod(); dd = (eq / eq.cummax() - 1).min()
    return eq.iloc[-1], dd, w.mean() / w.std() * np.sqrt(52)
print(f"{'portfolio':<44} {'£1,000 ->':>10} {'max DD':>8} {'Sharpe':>7}")
for name, w in [("trend ensemble 35% (current bot)", tw)] + \
               [(f"breakout only, {int(r*100)}% risk per trade", r * bo_R) for r in (0.01, 0.02, 0.03)] + \
               [(f"trend 35% + breakout {int(r*100)}% risk per trade", tw + r * bo_R) for r in (0.01, 0.02, 0.03)]:
    e, dd, sh = perf(w)
    print(f"{name:<44} {e*1000:>10,.0f} {dd*100:>7.1f}% {sh:>7.2f}")

# Resampled two years (weeks drawn with replacement, both sleeves together)
rng = np.random.default_rng(5)
both = np.c_[tw.values, bo_R.values]
print("\nResampled 2-year paths (whole weeks drawn together, 20,000 paths):")
for name, wts in [("trend 35% alone", (1, 0)), ("trend 35% + breakout 2%", (1, 0.02)), ("trend 35% + breakout 3%", (1, 0.03))]:
    idx = rng.integers(0, len(both), size=(20_000, 104))
    wr = both[idx, 0] * wts[0] + both[idx, 1] * wts[1]
    eq = np.cumprod(1 + wr, axis=1); mdd = (1 - eq / np.maximum.accumulate(eq, axis=1)).max(axis=1)
    print(f"  {name:<26} median end £{np.median(eq[:, -1])*1000:>6,.0f}  P(lose money) {np.mean(eq[:, -1] < 1)*100:>3.0f}%  "
          f"P(drawdown > 40%) {np.mean(mdd > .4)*100:>3.0f}%  P(drawdown > 60%) {np.mean(mdd > .6)*100:>3.0f}%")
