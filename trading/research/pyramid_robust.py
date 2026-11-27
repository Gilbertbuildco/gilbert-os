import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pyramid import *

px, fund = load(); P = prep(px)
SPLIT = pd.Timestamp("2025-11-01", tz="UTC")
rng = np.random.default_rng(11)
print("One add (max 2 units), stop trails only, 5% of equity sizing:")
Rs = {}
for step in (None, 1.5, 2.0, 2.5, 3.0):
    kw = dict(step=step, max_units=2, move_stop_on_add=False) if step else {}
    cv, tr, ex = run(P, fund, "5% of equity", **kw)
    y1 = cv[cv.index < SPLIT].iloc[-1]; y2 = cv.iloc[-1] / y1
    Rs[step] = tr.R.values
    print(f"  {'no adding' if step is None else f'add at +{step} ATR':<14} end £{cv.iloc[-1]:>6,.0f}  year1 {(y1/1000-1)*100:+5.0f}%  "
          f"year2 {(y2-1)*100:+5.0f}%  avg R {tr.R.mean():+.2f}  t-stat {tr.R.mean()/tr.R.std()*np.sqrt(len(tr)):.2f}")
print("\nResampled two years, three positions at a time, 5% of equity per trade:")
for step in (None, 2.0):
    r = Rs[step]
    for label, rr in (("backtest edge", r), ("half the edge", r - r.mean() / 2)):
        draws = rng.choice(rr, size=(20_000, 60, 3))
        eq = np.cumprod(np.maximum(1 + 0.05 * draws.sum(axis=2), 0), axis=1)
        print(f"  {'no adding' if step is None else 'one add at +2 ATR':<18} {label:<14} median end £{np.median(eq[:, -1])*1000:>6,.0f}  "
              f"P(lose money) {np.mean(eq[:, -1] < 1)*100:>3.0f}%  P(ever below £300) {np.mean(eq.min(axis=1) < .3)*100:>3.0f}%")
