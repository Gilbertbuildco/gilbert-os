"""Event-driven simulation of the trend ensemble on a small cross-margin perp account, hour by hour.

Trades at the open of the hour after each daily close, pays fees, slippage and real funding, enforces a minimum
order size and a rebalance band, applies drawdown-based de-risking, and checks liquidation every hour against
the hour's worst price for each position.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from load import *
import warnings; warnings.filterwarnings("ignore")

SPLIT = pd.Timestamp("2025-11-01", tz="UTC")


def ensemble_score(d):
    parts = [np.sign(d - d.rolling(n).mean()) for n in (20, 50, 100)] + \
            [np.sign(np.log(d).diff(k)) for k in (14, 28, 56)]
    return sum(parts) / len(parts)


def corr_factor(d, n, lookback=90, default_rho=0.8):
    """sqrt(rho + (1 - rho) / n) from the trailing average pairwise correlation of daily returns.
    For 3 coins at rho 0.8 this is 0.93, the constant used in the original research."""
    if n == 3 and lookback is None:
        return 0.93
    r = np.log(d).diff()
    rho = pd.Series(default_rho, index=d.index)
    vals = []
    for i in range(len(d)):
        win = r.iloc[max(0, i - lookback + 1): i + 1].dropna()
        if len(win) < 30:
            vals.append(default_rho); continue
        cm = win.corr().values
        vals.append(cm[np.triu_indices(n, 1)].mean())
    rho = pd.Series(vals, index=d.index)
    return np.sqrt(rho + (1 - rho) / n)


def daily_targets(close_1h, port_vol, max_gross=3.0, hour=0, trailing_corr=False):
    """Target weight (signed notional / equity) per coin, indexed by the time it becomes known."""
    d = close_1h.resample("24h", offset=f"{hour}h").last()
    n = d.shape[1]
    score = ensemble_score(d)
    rv = np.log(d).diff().rolling(20).std() * np.sqrt(365)
    cf = corr_factor(d, n) if trailing_corr else 0.93
    w = (score * (port_vol / n) / rv).div(cf, axis=0) if trailing_corr else score * (port_vol / n / 0.93) / rv
    gross = w.abs().sum(axis=1)
    w = w.mul((max_gross / gross).clip(upper=1.0), axis=0)
    w.index = w.index + pd.Timedelta("24h")  # known at the close of the daily bar
    return w.dropna()


def dd_multiplier(dd, start, limit):
    """Full size until drawdown `start`, shrinking linearly to zero at `limit`."""
    if start is None:
        return 1.0
    return float(np.clip((limit - dd) / (limit - start), 0.0, 1.0))


def simulate(px, fund, port_vol=0.30, equity0=1000.0, fee=0.0005, slip=0.0002, band=0.20, min_order=10.0,
             dd_start=None, dd_limit=0.25, leverage=100, mmr=0.005, hour=0, start=None, end=None, trailing_corr=False):
    SYMS = list(px)
    o = pd.DataFrame({s: px[s].open for s in SYMS}); h = pd.DataFrame({s: px[s].high for s in SYMS})
    l = pd.DataFrame({s: px[s].low for s in SYMS}); c = pd.DataFrame({s: px[s].close for s in SYMS})
    f = pd.DataFrame({s: fund[s] for s in SYMS}).reindex(c.index).fillna(0.0)
    tgt = daily_targets(c, port_vol, hour=hour, trailing_corr=trailing_corr)
    idx = c.index
    if start is not None: idx = idx[idx >= start]
    if end is not None: idx = idx[idx < end]
    cash, qty, peak = equity0, {s: 0.0 for s in SYMS}, equity0
    fees = fund_paid = 0.0; trades = 0; liquidated = None
    curve, lev_hist = [], []
    tset = set(tgt.index)
    for t in idx:
        op = o.loc[t]
        eq_open = cash + sum(qty[s] * op[s] for s in SYMS)  # cash holds realised value; qty*price is position value
        # daily rebalance at the open of the hour the signal becomes known
        if t in tset:
            dd = 1 - eq_open / peak
            m = dd_multiplier(dd, dd_start, dd_limit)
            for s in SYMS:
                want = tgt.loc[t, s] * eq_open * m
                have = qty[s] * op[s]
                diff = want - have
                if abs(diff) < min_order:
                    continue
                if abs(want) > 0 and abs(diff) < band * abs(want) and np.sign(want) == np.sign(have):
                    continue
                px_fill = op[s] * (1 + slip * np.sign(diff))
                q = diff / px_fill
                cash -= q * px_fill
                fee_ = abs(diff) * fee; cash -= fee_; fees += fee_; trades += 1
                qty[s] += q
        # intrahour: liquidation check at each position's worst price
        notional = sum(abs(qty[s]) * c.loc[t, s] for s in SYMS)
        worst = cash + sum(qty[s] * (l.loc[t, s] if qty[s] > 0 else h.loc[t, s]) for s in SYMS)
        maint = sum(abs(qty[s]) * (l.loc[t, s] if qty[s] > 0 else h.loc[t, s]) for s in SYMS) * mmr
        if notional > 0 and worst <= maint:
            liquidated = t; cash = max(worst, 0.0); qty = {s: 0.0 for s in SYMS}
            curve.append((t, cash)); break
        # funding at 00/08/16 UTC: longs pay positive rates
        for s in SYMS:
            r = f.loc[t, s]
            if r and qty[s]:
                pay = qty[s] * c.loc[t, s] * r; cash -= pay; fund_paid += pay
        eq = cash + sum(qty[s] * c.loc[t, s] for s in SYMS)
        peak = max(peak, eq)
        # hard brake between rebalances: if the drawdown limit is breached, flatten at the close
        if dd_start is not None and 1 - eq / peak >= dd_limit:
            for s in SYMS:
                if qty[s]:
                    v = qty[s] * c.loc[t, s] * (1 - slip * np.sign(qty[s]))
                    cash += v; fee_ = abs(v) * fee; cash -= fee_; fees += fee_; qty[s] = 0.0; trades += 1
            eq = cash
        curve.append((t, eq)); lev_hist.append(notional / eq if eq > 0 else 0)
    cv = pd.Series(dict(curve))
    return cv, {"fees": fees, "funding": fund_paid, "trades": trades, "liquidated": liquidated,
                "avg_lev": float(np.mean(lev_hist)) if lev_hist else 0, "max_lev": float(np.max(lev_hist)) if lev_hist else 0}


def summary(cv, extra, equity0=1000.0):
    d = cv.resample("1D").last().dropna()
    r = d.pct_change().dropna()
    dd = (d / d.cummax() - 1).min()
    yrs = (d.index[-1] - d.index[0]).days / 365
    return {"end": round(d.iloc[-1], 0), "ret%": round((d.iloc[-1] / equity0 - 1) * 100, 1),
            "cagr%": round(((d.iloc[-1] / equity0) ** (1 / yrs) - 1) * 100, 1) if d.iloc[-1] > 0 else -100,
            "sharpe": round(r.mean() / r.std() * np.sqrt(365), 2) if r.std() > 0 else 0,
            "maxdd%": round(dd * 100, 1), "avg_lev": round(extra["avg_lev"], 2), "max_lev": round(extra["max_lev"], 2),
            "trades": extra["trades"], "fees": round(extra["fees"], 0), "funding": round(extra["funding"], 0),
            "liquidated": extra["liquidated"]}


if __name__ == "__main__":
    px, fund = load()
    rows = []
    for pv in (0.20, 0.25, 0.30, 0.35, 0.40, 0.50):
        for dds in (None, 0.10):
            cv, ex = simulate(px, fund, port_vol=pv, dd_start=dds)
            s = summary(cv, ex)
            y1 = cv[cv.index < SPLIT]; y2 = cv[cv.index >= SPLIT]
            s["year1%"] = round((y1.iloc[-1] / 1000 - 1) * 100, 1)
            s["year2%"] = round((y2.iloc[-1] / y1.iloc[-1] - 1) * 100, 1)
            s["config"] = f"vol {int(pv*100)}% brake {'10->25%' if dds else 'off'}"
            rows.append(s)
    pd.set_option("display.width", 220)
    print(pd.DataFrame(rows).set_index("config").to_string())
    print("\nRebalance band and minimum order check at vol 30%, brake on:")
    for band, mo in ((0.0, 0.0), (0.10, 10.0), (0.20, 10.0), (0.35, 10.0)):
        cv, ex = simulate(px, fund, port_vol=0.30, dd_start=0.10, band=band, min_order=mo)
        s = summary(cv, ex); print(f"band {band:.2f} min ${mo:.0f}: ret {s['ret%']}% sharpe {s['sharpe']} maxDD {s['maxdd%']}% trades {s['trades']} fees ${s['fees']}")
