import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pandas as pd, numpy as np
all_tr = pd.read_pickle(Path(__file__).parent / "data" / "monday_trades.pkl")
RISK = 10.0  # £10 risk per trade = 1% of £1,000
print("£1,000 account, £10 risk per trade, each coin traded on its own:")
for (sym, name), (tr, wk) in all_tr.items():
    if name not in ("$10 on BTC (same % on ETH/SOL)", "0.5% of price", "25% of the Monday range"):
        continue
    eq = 1000 + RISK * tr.R_net.cumsum()
    ruin = eq[eq <= 0]
    notional = RISK / (tr.stop_pct / 100)
    when = pd.Timestamp(tr.t[ruin.index[0]], unit="s", tz="UTC").strftime("%d %b %Y") if len(ruin) else None
    r = tr.R_net
    print(f"  {sym} {name:<32} " + (f"wiped out on {when}, after {ruin.index[0] + 1} trades" if when else
          f"end £{eq.iloc[-1]:,.0f}") + f"  | typical position £{notional.median():,.0f}  | t-stat {r.mean() / r.std() * np.sqrt(len(r)):+.2f}")
tr, wk = all_tr[("BTC", "$10 on BTC (same % on ETH/SOL)")]
first = tr[tr.t < tr.t.iloc[0] + 7 * 86400]
print(f"\nBTC with the $10 stop, first week: {len(first)} trades, {int((first.R_net > 0).sum())} winners, "
      f"net {first.R_net.sum():+.0f}R = £{first.R_net.sum() * RISK:+,.0f} at £10 risk; fees alone £{((first.R_gross - first.R_net) * RISK).sum():,.0f}")
