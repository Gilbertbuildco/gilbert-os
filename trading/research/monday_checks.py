import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import monday_range as mr
import numpy as np, pandas as pd

ts, o, h, l, c = mr.load1m("BTC")
btc_ref = {m: 10.0 / c[int(np.searchsorted(ts, m)) + 1439] for m in mr.mondays(ts)}

# 1. Best case: an entry candle can never also stop us out (stop checks start on the next minute).
print("Best case (no stop-out in the entry minute):")
for sym in ("BTC", "ETH", "SOL"):
    for name, fn in (("$10 on BTC", lambda MH, ML, px, ref: px * ref), ("0.5% of price", lambda MH, ML, px, ref: px * 0.005)):
        tr, wk = mr.simulate(sym, fn, btc_ref, worst_case=False)
        s_ = mr.summarize(tr, wk, name)
        print(f"  {sym} {name:<14} trades/week {s_['trades/week']:>5}  win {s_['win %']:>5}%  avg R gross {s_['avg R gross']:+.2f}  net {s_['avg R net']:+.2f}")

# 2. Synthetic range-bound market: Monday sets a range, the rest of the week oscillates inside it
print("\nSynthetic range-bound market (should profit):")
n_weeks = 20; mins = n_weeks * 7 * 1440
start = 1_730_678_400  # a Monday 00:00 UTC
t = start + 60 * np.arange(mins)
phase = 2 * np.pi * np.arange(mins) / (1440 * 1.5)
mid = 100_000; amp = 2_000
close = mid + amp * np.sin(phase) * 0.999
op = np.r_[close[0], close[:-1]]; hi = np.maximum(op, close) + 1; lo = np.minimum(op, close) - 1
tr, wk = mr.simulate("SYN", lambda MH, ML, px, ref: 50.0,
                     loader=lambda s: (t, op.tolist(), hi.tolist(), lo.tolist(), close.tolist()))
print(f"  trades {len(tr)}, win {(tr.R_net > 0).mean()*100:.0f}%, total R net {tr.R_net.sum():+.0f}, reasons {tr.reason.value_counts().to_dict()}")
