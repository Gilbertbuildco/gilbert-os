import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pyramid import *

px, fund = load(); P = prep(px)
rows = []
for scheme in ("£100 then £200 from £2k", "5% of equity"):
    for name, kw in [
        ("no adding, 2 ATR stop", dict(k=2.0)),
        ("no adding, 3 ATR stop", dict(k=3.0)),
        ("add every 2 ATR, max 2 units, stop trails only", dict(step=2.0, max_units=2, move_stop_on_add=False)),
        ("add every 2 ATR, max 4, stop trails only", dict(step=2.0, max_units=4, move_stop_on_add=False)),
        ("add every 3 ATR, max 3, 3 ATR stop, stop trails only", dict(step=3.0, max_units=3, k=3.0, move_stop_on_add=False)),
        ("add every 2 ATR, unlimited, 3 ATR stop, compound", dict(step=2.0, max_units=999, k=3.0, add_mode="compound")),
    ]:
        cv, tr, ex = run(P, fund, scheme, **kw)
        d = cv.resample("1D").last()
        rows.append({"sizing": scheme, "variant": name, "end £": round(d.iloc[-1]), "max DD %": round((d / d.cummax() - 1).min() * 100, 1),
                     "lowest £": round(d.min()), "blown": ex["blown"].date() if ex["blown"] is not None else "no",
                     "trades": len(tr), "win %": round((tr.pnl > 0).mean() * 100), "avg R": round(tr.R.mean(), 2),
                     "max exposure x": round(ex["max_exposure"], 1)})
pd.set_option("display.width", 250); print(pd.DataFrame(rows).to_string(index=False))
