"""Sanity check: in a clean, persistent trend pyramiding must beat a single unit."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pyramid import *

idx = pd.date_range("2024-01-01", periods=24 * 400, freq="1h", tz="UTC")
rng = np.random.default_rng(0)
px, fund = {}, {}
for s, p0 in (("BTC", 50000), ("ETH", 3000), ("SOL", 100)):
    # 150 days flat-ish noise to warm up, then a steady trend up with mild noise
    drift = np.where(np.arange(len(idx)) < 24 * 150, 0.0, 0.0006)
    r = drift + rng.normal(0, 0.003, len(idx))
    close = p0 * np.exp(np.cumsum(r)); open_ = np.r_[p0, close[:-1]]
    hi = np.maximum(open_, close) * 1.001; lo = np.minimum(open_, close) * 0.999
    px[s] = pd.DataFrame({"open": open_, "high": hi, "low": lo, "close": close, "volume": 1.0, "quote_volume": 1.0,
                          "taker_buy_quote": 0.5}, index=idx)
    fund[s] = pd.Series(0.0, index=idx)
P = prep(px)
for name, step, mu, mode in VARIANTS[:4]:
    cv, tr, ex = run(P, fund, "5% of equity", step, mu, mode)
    print(f"{name:<45} end £{cv.iloc[-1]:>12,.0f}  trades {len(tr)}  max units {ex['max_units']}  max exposure {ex['max_exposure']:.1f}x")
