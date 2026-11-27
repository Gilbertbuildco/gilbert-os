"""Does trading more coins with the same rules improve return per unit of drawdown?"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from sim import *

ALL = ["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "AVAX", "LINK", "LTC", "DOT", "BNB"]
px_all, fund_all = load(ALL)
d = pd.DataFrame({s: resample(px_all[s], "1D").close for s in ALL})
r = np.log(d).diff().dropna()
cm = r.corr(); print("average pairwise correlation, 11 coins:", round(cm.values[np.triu_indices(11, 1)].mean(), 2))
print("buy and hold 2y return by coin %:", {s: round((d[s].iloc[-1] / d[s].iloc[0] - 1) * 100) for s in ALL})

universes = {"3 coins (BTC ETH SOL)": ALL[:3], "6 coins (+XRP DOGE BNB)": ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB"],
             "11 coins": ALL}
rows = []
for name, syms in universes.items():
    px = {s: px_all[s] for s in syms}; fund = {s: fund_all[s] for s in syms}
    for pv in (0.30, 0.40):
        cv, ex = simulate(px, fund, port_vol=pv, trailing_corr=True)
        s_ = summary(cv, ex)
        y1 = cv[cv.index < SPLIT]; y2 = cv[cv.index >= SPLIT]
        s_["year1%"] = round((y1.iloc[-1] / 1000 - 1) * 100, 1); s_["year2%"] = round((y2.iloc[-1] / y1.iloc[-1] - 1) * 100, 1)
        s_["return/maxDD"] = round(s_["ret%"] / -s_["maxdd%"], 2)
        s_["config"] = f"{name}, vol {int(pv*100)}%"
        rows.append(s_); print(s_["config"], "done", flush=True)
pd.set_option("display.width", 250)
print(pd.DataFrame(rows).set_index("config")[["end", "ret%", "sharpe", "maxdd%", "return/maxDD", "year1%", "year2%", "avg_lev", "max_lev", "trades", "fees", "funding"]].to_string())
