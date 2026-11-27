"""Out-of-sample test on the full history (2020 to Oct 2024 was never used to design anything)."""
import sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))
import warnings; warnings.filterwarnings("ignore")
from sim import *
from sim import simulate as sim_trend
import ranges
from trader.config import Config
from trader.futures import FuturesPaperBroker
from trader.futures_engine import FuturesEngine
from trader.models import Candle

DESIGN_START = pd.Timestamp("2024-11-01", tz="UTC")
px_all, fund_all = load(["BTC", "ETH", "SOL"], full=True)


def universe(syms, start):
    """Align coins on one hourly index; fill exchange gaps (127 hours on SOL) with the last known price."""
    first = max(start, *(px_all[s].index[0] for s in syms)); last = min(px_all[s].index[-1] for s in syms)
    idx = pd.date_range(first, last, freq="1h")
    px, fund = {}, {}
    for s in syms:
        df = px_all[s].reindex(idx)
        gap = df.close.isna()
        df["close"] = df.close.ffill()
        for col in ("open", "high", "low"):
            df.loc[gap, col] = df.loc[gap, "close"]
        df[["volume", "quote_volume", "taker_buy_quote"]] = df[["volume", "quote_volume", "taker_buy_quote"]].fillna(0)
        px[s] = df
        fund[s] = fund_all[s][fund_all[s].index >= first]
    return px, fund


def yearly(cv):
    d = cv.resample("1D").last().dropna()
    y = d.resample("YE").last(); first = d.iloc[0]
    rets = (y / y.shift(1).fillna(first) - 1) * 100
    dd = d.groupby(d.index.year).apply(lambda x: ((x / x.cummax()) - 1).min() * 100)
    return pd.DataFrame({"return %": rets.round(1).values, "max DD in year %": dd.round(1).values}, index=y.index.year)


def trend_scores_full(px):
    d = pd.DataFrame({s: resample(px[s], "1D").close for s in px})
    sc = ensemble_score(d); sc.index = sc.index + pd.Timedelta("1D")
    return sc


mk = lambda t, r: Candle(int(t.timestamp()), float(r.open), float(r.high), float(r.low), float(r.close), float(r.volume))
def replay(syms, start, breakout=True, risk=2.0, brake=(40, 50)):
    px, fund = universe(syms, start)
    cfg = Config(); cfg.mode = "futures"; cfg.market.symbols = [f"{s}/USD" for s in syms]
    f = cfg.futures; f.vol_target_pct = 35; f.breakout_enabled = breakout; f.breakout_risk_pct = risk
    f.drawdown_brake_start_pct, f.drawdown_stop_pct = brake
    # funding: use the real average for the period per 8h as the paper approximation
    f.funding_rate_8h_pct = float(np.mean([fund[s].mean() for s in syms])) * 100
    b = FuturesPaperBroker(":memory:", 1000.0, f.fee_bps, f.slippage_bps, f.leverage, f.maintenance_margin_pct)
    eng = FuturesEngine(cfg, b)
    hourly = {f"{s}/USD": [mk(t, r) for t, r in px[s].iterrows()] for s in syms}
    daily = {f"{s}/USD": [mk(t, r) for t, r in resample(px[s], "1D").iterrows()] for s in syms}
    n = min(len(v) for v in hourly.values()); di = {k: 0 for k in daily}; eq = []; halted = None
    worst_hour, min_buf = 0.0, 1e9
    for i in range(1, n - 1):
        ts = hourly[f"{syms[0]}/USD"][i].ts
        for k in daily:
            while di[k] < len(daily[k]) and daily[k][di[k]].ts + 86400 <= ts: di[k] += 1
        r = eng.run_cycle({k: v[max(0, i - 200):i] for k, v in hourly.items()},
                          {k: daily[k][max(0, di[k] - 150):di[k]] for k in daily}, ts=ts)
        eq.append((ts, r.equity, b.gross_notional({k: v[i - 1].close for k, v in hourly.items()})))
        pos = b.positions()
        if pos:
            worst = {s: (hourly[s][i].low if p.qty > 0 else hourly[s][i].high) for s, p in pos.items()}
            ew = b.equity({**{k: v[i - 1].close for k, v in hourly.items()}, **worst})
            worst_hour = max(worst_hour, 1 - ew / r.equity)
            mm = b.maintenance_margin(worst); min_buf = min(min_buf, ew / mm if mm else 1e9)
        if r.skipped and "kill" in r.skipped:
            halted = pd.Timestamp(ts, unit="s", tz="UTC"); break
    e = pd.DataFrame(eq, columns=["ts", "equity", "gross"]); e.index = pd.to_datetime(e.ts, unit="s", utc=True)
    return e, halted, worst_hour, min_buf


if "--brake-test" in sys.argv:
    coins = ["BTC", "ETH"] if "--btc-eth" in sys.argv else ["BTC", "ETH", "SOL"]
    start = pd.Timestamp("2020-01-01" if "--btc-eth" in sys.argv else "2020-09-14", tz="UTC")
    print(f"== Brake off (start 99%, stop 100%): {'+'.join(coins)} from {start.date()}")
    for label, kw in (("trend only", dict(breakout=False)),
                      ("trend + breakout 2%", dict(breakout=True, risk=2.0)),
                      ("trend + breakout 1%", dict(breakout=True, risk=1.0))):
        e, halted, wh, buf = replay(coins, start, brake=(99, 100), **kw)
        pre = e[e.index < DESIGN_START].equity
        print(f"-- {label}: £1,000 -> £{e.equity.iloc[-1]:,.0f} (unseen period £{pre.iloc[-1]:,.0f}, max DD "
              f"{((pre / pre.cummax()) - 1).min() * 100:.1f}%); whole-period max DD {((e.equity / e.equity.cummax()) - 1).min() * 100:.1f}%; "
              f"peak exposure {(e.gross / e.equity).max():.1f}x; worst hour {wh * 100:.1f}%; closest to liquidation {buf:.0f}x margin")
        print(yearly(e.equity).T.to_string())
    sys.exit()

print("== 1. Trend ensemble alone, 35% vol target, £1,000 start")
for syms, start in ((["BTC", "ETH"], pd.Timestamp("2020-01-01", tz="UTC")), (["BTC", "ETH", "SOL"], pd.Timestamp("2020-09-14", tz="UTC"))):
    px, fund = universe(syms, start)
    cv, ex = sim_trend(px, fund, port_vol=0.35)
    d = cv.resample("1D").last()
    pre = d[d.index < DESIGN_START]
    print(f"-- {'+'.join(syms)} from {start.date()}: £1,000 -> £{d.iloc[-1]:,.0f}; unseen period only (to Oct 2024): "
          f"£{pre.iloc[-1]:,.0f}, max DD {((pre / pre.cummax()) - 1).min() * 100:.1f}%, liquidated {ex['liquidated']}")
    print(yearly(cv).T.to_string())

print("\n== 2. Monday range breakout (trend filter, opposite-edge stop, week-end exit), hourly bars, per year")
px, fund = universe(["BTC", "ETH", "SOL"], pd.Timestamp("2020-01-01", tz="UTC"))
trend = trend_scores_full(px)
all_tr = []
for s in px:
    df = px[s]
    data = (df.index.as_unit("s").asi8, df.open.tolist(), df.high.tolist(), df.low.tolist(), df.close.tolist())
    for filt in (True, False):
        tr = ranges.breakout(data, ranges.windows(data[0], "monday"), "opposite", trend[s] if filt else None)
        tr["sym"] = s; tr["filter"] = filt; all_tr.append(tr)
T = pd.concat(all_tr); T["year"] = pd.to_datetime(T.t, unit="s", utc=True).dt.year
for filt in (True, False):
    x = T[T["filter"] == filt]
    g = x.groupby("year").R_net.agg(["count", "mean"]).round(2)
    g["t"] = x.groupby("year").R_net.apply(lambda r: round(r.mean() / r.std() * np.sqrt(len(r)), 2))
    pre = x[pd.to_datetime(x.t, unit="s", utc=True) < DESIGN_START].R_net
    print(f"-- {'with' if filt else 'without'} trend filter: unseen period {len(pre)} trades, average {pre.mean():+.2f}R, "
          f"t {pre.mean() / pre.std() * np.sqrt(len(pre)):.2f}")
    print(g.T.to_string())
xs = T[(T["filter"]) & (pd.to_datetime(T.t, unit="s", utc=True) < DESIGN_START)]
print("by coin (unseen period, filtered):", xs.groupby("sym").R_net.mean().round(2).to_dict())

print("\n== 3. Full bot replay: trend 35% + breakout 2%, brake 40-50%, all three coins from SOL's listing")
for syms, start in ((["BTC", "ETH", "SOL"], pd.Timestamp("2020-09-14", tz="UTC")), (["BTC", "ETH"], pd.Timestamp("2020-01-01", tz="UTC"))):
    for bo in (False, True):
        e, halted, wh, buf = replay(syms, start, bo)
        pre = e[e.index < DESIGN_START].equity
        print(f"-- {'+'.join(syms)}, {'trend + breakout' if bo else 'trend only'}: £1,000 -> £{e.equity.iloc[-1]:,.0f} "
              f"(unseen period: £{pre.iloc[-1]:,.0f}, max DD {((pre / pre.cummax()) - 1).min() * 100:.1f}%); "
              f"whole-period max DD {((e.equity / e.equity.cummax()) - 1).min() * 100:.1f}%; peak exposure "
              f"{(e.gross / e.equity).max():.1f}x; worst hour {wh * 100:.1f}%; closest to liquidation {buf:.0f}x margin; halted {halted}")
        print(yearly(e.equity).T.to_string())
