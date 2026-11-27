"""Monday range BREAKOUT on 1-minute perp data.

Monday 00:00-23:59 UTC sets MH/ML. Tuesday to Sunday, at most one long and one short per week:
- long when price trades above MH + entry buffer (stop order: taker fee + slippage, gap fills at the open)
- short when price trades below ML - entry buffer
- stop at the range midpoint or the opposite edge
- exit at a target (k x range beyond the breakout level, limit/maker) or at the week's last close
- optional trend filter: only trade in the direction of the daily trend-ensemble score known at Monday's close
Results in R (entry-to-stop risk), net of fees.
"""
import sys
from pathlib import Path
import numpy as np, pandas as pd
sys.path.insert(0, str(Path(__file__).resolve().parent))
from monday_range import load1m, mondays, MAKER, TAKER, SLIP, WEEK
from sim import ensemble_score
from load import load, resample

SPLIT = pd.Timestamp("2025-11-01", tz="UTC").timestamp()


def trend_scores():
    px, _ = load()
    d = pd.DataFrame({s: resample(px[s], "1D").close for s in px})
    sc = ensemble_score(d)
    sc.index = sc.index + pd.Timedelta("1D")  # known at the close of the daily bar
    return sc


def simulate(sym, stop_mode="mid", target_k=None, entry_buf=0.0, trend=None, data=None):
    ts, o, h, l, c = data or load1m(sym)
    trades = []
    for m in mondays(ts):
        i0 = int(np.searchsorted(ts, m)); i1 = i0 + 1440; i2 = i0 + 7 * 1440
        if i2 > len(ts) or ts[i2 - 1] != m + WEEK - 60:
            continue
        MH = max(h[i0:i1]); ML = min(l[i0:i1]); rng = MH - ML; mid = (MH + ML) / 2
        allow = {1: True, -1: True}
        if trend is not None:
            t = pd.Timestamp(m + 86400, unit="s", tz="UTC")
            s_ = trend.get(t)
            if s_ is None or np.isnan(s_):
                continue
            allow = {1: s_ > 0, -1: s_ < 0}
        up, dn = MH + entry_buf * rng, ML - entry_buf * rng
        done = {1: False, -1: False}; pos = 0
        for i in range(i1, i2):
            hi, lo, op = h[i], l[i], o[i]
            if pos == 0:
                if allow[1] and not done[1] and hi >= up:
                    pos, entry = 1, max(op, up) * (1 + SLIP)
                elif allow[-1] and not done[-1] and lo <= dn:
                    pos, entry = -1, min(op, dn) * (1 - SLIP)
                if pos:
                    done[pos] = True
                    stop = mid if stop_mode == "mid" else (ML if pos == 1 else MH)
                    risk = abs(entry - stop)
                    tgt = (up + pos * target_k * rng) if pos == 1 and target_k else (dn - target_k * rng if target_k else None)
                    t_in = ts[i]
                    continue  # stop/target checks start next minute (entry minute rarely reaches either)
            if pos:
                exit_px = None
                if (pos == 1 and lo <= stop) or (pos == -1 and hi >= stop):
                    exit_px = (min(op, stop) if pos == 1 else max(op, stop)) * (1 - SLIP * pos); fee = TAKER; why = "stop"
                elif tgt is not None and ((pos == 1 and hi >= tgt) or (pos == -1 and lo <= tgt)):
                    exit_px = tgt; fee = MAKER; why = "target"
                if exit_px is not None:
                    g = (exit_px - entry) * pos / risk
                    trades.append({"t_in": t_in, "t": ts[i], "sym": sym, "side": pos, "R_gross": g,
                                   "R_net": g - (TAKER * entry + fee * exit_px) / risk, "why": why, "risk_pct": risk / entry * 100})
                    pos = 0
        if pos:
            exit_px = c[i2 - 1] * (1 - SLIP * pos)
            g = (exit_px - entry) * pos / risk
            trades.append({"t_in": t_in, "t": ts[i2 - 1], "sym": sym, "side": pos, "R_gross": g,
                           "R_net": g - (TAKER * entry + TAKER * exit_px) / risk, "why": "week end", "risk_pct": risk / entry * 100})
    return pd.DataFrame(trades)


def stats(tr):
    if tr.empty:
        return dict(n=0)
    y1, y2 = tr[tr.t_in < SPLIT].R_net, tr[tr.t_in >= SPLIT].R_net
    r = tr.R_net
    return dict(n=len(tr), win=round((r > 0).mean() * 100), avgR=round(r.mean(), 3), totR=round(r.sum(), 1),
                t=round(r.mean() / r.std() * np.sqrt(len(r)), 2), y1R=round(y1.mean(), 3) if len(y1) else None,
                y2R=round(y2.mean(), 3) if len(y2) else None, n_y1=len(y1), n_y2=len(y2))


if __name__ == "__main__":
    trend = trend_scores()
    data = {s: load1m(s) for s in ("BTC", "ETH", "SOL")}
    grid = []
    for stop_mode in ("mid", "opposite"):
        for target_k in (None, 1.0, 2.0):
            for entry_buf in (0.0, 0.1):
                for use_trend in (False, True):
                    tr = pd.concat([simulate(s, stop_mode, target_k, entry_buf, trend[s] if use_trend else None, data[s])
                                    for s in data], ignore_index=True)
                    st = stats(tr)
                    grid.append({"stop": stop_mode, "target": f"{target_k}x range" if target_k else "week end",
                                 "entry buffer": f"{int(entry_buf*100)}% of range", "trend filter": use_trend, **st})
    g = pd.DataFrame(grid)
    pd.set_option("display.width", 250)
    print(g.sort_values("y1R", ascending=False).to_string(index=False))
    g.to_csv(Path(__file__).parent / "data" / "monday_breakout_grid.csv", index=False)
