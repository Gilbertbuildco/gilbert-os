"""Vectorised perp-futures backtester on 4h bars. Positions are decided on a bar's close and held over the next bar."""
import sys; from pathlib import Path; sys.path.insert(0, str(Path(__file__).resolve().parent))
from load import *
import warnings; warnings.filterwarnings("ignore")

FEE = 0.0005 + 0.0002   # taker fee + slippage per unit of notional traded
SPLIT = pd.Timestamp("2025-11-01", tz="UTC")
BARS_PER_YEAR = 6 * 365

def build(rule="4h"):
    px, fund = load()
    c = pd.DataFrame({s: resample(px[s], rule).close for s in SYMS})
    hi = pd.DataFrame({s: resample(px[s], rule).high for s in SYMS})
    lo = pd.DataFrame({s: resample(px[s], rule).low for s in SYMS})
    f = pd.DataFrame({s: fund[s] for s in SYMS}).fillna(0)
    # funding printed at bar-internal timestamps, summed into the bar it falls in
    fb = f.resample(rule, label="left", closed="left").sum().reindex(c.index).fillna(0)
    return c, hi, lo, fb

def daily_close(c):  # signal inputs sampled at 00:00 UTC each day, forward-filled on 4h bars
    return c.resample("1D").last()

def run(w, c, fb, fee=FEE):
    """w: target weights (notional / equity) per bar, decided at bar close. Returns per-bar net returns."""
    w = w.reindex(c.index).fillna(0)
    r = c.pct_change().shift(-1)            # return of the next bar
    fnext = fb.shift(-1)                    # funding paid during the next bar (long pays positive)
    gross = (w * r).sum(axis=1)
    funding = (w * fnext).sum(axis=1)
    turn = w.diff().abs().sum(axis=1).fillna(w.abs().sum(axis=1))
    net = gross - funding - turn * fee
    return pd.DataFrame({"net": net, "gross": gross, "funding": funding, "cost": turn * fee,
                         "lev": w.abs().sum(axis=1)}).dropna()

def stats(df, label=""):
    n = df.net
    eq = (1 + n).cumprod()
    yrs = len(n) / BARS_PER_YEAR
    cagr = eq.iloc[-1] ** (1 / yrs) - 1 if eq.iloc[-1] > 0 else -1
    vol = n.std() * np.sqrt(BARS_PER_YEAR)
    sharpe = n.mean() / n.std() * np.sqrt(BARS_PER_YEAR) if n.std() > 0 else 0
    dd = (eq / eq.cummax() - 1).min()
    return {"label": label, "ret%": round((eq.iloc[-1] - 1) * 100, 1), "cagr%": round(cagr * 100, 1),
            "vol%": round(vol * 100, 1), "sharpe": round(sharpe, 2), "maxdd%": round(dd * 100, 1),
            "avg_lev": round(df.lev.mean(), 2), "max_lev": round(df.lev.max(), 2),
            "cost%/yr": round(df.cost.sum() / yrs * 100, 1), "fund%/yr": round(df.funding.sum() / yrs * 100, 1)}

def split_stats(df, label):
    return [stats(df, label + " ALL"), stats(df[df.index < SPLIT], label + " IS"), stats(df[df.index >= SPLIT], label + " OOS")]

def vol_scale(c, target_ann=0.5, lookback_days=20, cap=3.0):
    """Per-asset weight multiplier so each position runs at target_ann annualised vol."""
    d = daily_close(c)
    rv = np.log(d).diff().rolling(lookback_days).std() * np.sqrt(365)
    m = (target_ann / rv).clip(upper=cap)
    return available(m, c)

def available(daily, c):
    """A value computed from the daily bar labelled D uses the close at D+1 00:00, which is the close of the
    4h bar labelled D 20:00. Weights at a 4h bar apply to the following bar, so that is the first bar it may be used."""
    x = daily.copy()
    x.index = x.index + pd.Timedelta("1D") - pd.Timedelta("4h")
    return x.reindex(c.index, method="ffill")

def on_daily(sig_daily, c):
    return available(sig_daily, c)
