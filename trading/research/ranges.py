"""Range fade vs range breakout across range definitions, on 1-minute perp data.

Range definitions (each gives a range window and the window it is then traded in):
  monday      Monday's range, traded Tuesday-Sunday
  prev_week   last week's range, traded through this week
  month_open  the first 7 days of the month, traded for the rest of the month
  prev_month  last month's range, traded through this month
Fade: sell the high and buy the low, target the other edge (or the midpoint), stop a buffer beyond the edge,
flip at the target, re-arm after price closes back inside. Breakout: one long and one short per period at most,
stop at the opposite edge or midpoint, exit at the period's end, optional trend filter.
Fees: limit fills at range edges 0.02%, breakout entries/stops/period-end exits 0.05% + 0.01% slippage.
If one minute touches both a fade entry and its stop, the stop is assumed hit.
"""
import sys
from pathlib import Path
import numpy as np, pandas as pd
sys.path.insert(0, str(Path(__file__).resolve().parent))
from monday_range import load1m, MAKER, TAKER, SLIP
from monday_breakout import trend_scores

SPLIT = pd.Timestamp("2025-11-01", tz="UTC").timestamp()
DAY, WEEK = 86400, 7 * 86400


def windows(ts, kind):
    """List of (range_start, range_end, trade_start, trade_end) unix times."""
    t0, t1 = int(ts[0]), int(ts[-1]) + 60
    out = []
    if kind in ("monday", "prev_week"):
        m = t0 + (-(t0 - 4 * DAY)) % WEEK
        while m + WEEK <= t1:
            if kind == "monday":
                out.append((m, m + DAY, m + DAY, m + WEEK))
            elif m + 2 * WEEK <= t1:
                out.append((m, m + WEEK, m + WEEK, m + 2 * WEEK))
            m += WEEK
    else:
        months = pd.date_range(pd.Timestamp(t0, unit="s", tz="UTC").normalize(), pd.Timestamp(t1, unit="s", tz="UTC"), freq="MS")
        starts = [int(x.timestamp()) for x in months]
        for a, b, c in zip(starts, starts[1:], starts[2:] + [None]):
            if kind == "month_open":
                if b <= t1:
                    out.append((a, a + 7 * DAY, a + 7 * DAY, b))
            elif c is not None and c <= t1:
                out.append((a, b, b, c))
    return out


def idx(ts, t):
    return int(np.searchsorted(ts, t))


def fade(data, wins, buf_frac, target="edge"):
    ts, o, h, l, c = data
    trades = []
    for rs, re_, as_, ae in wins:
        i0, i1, i2, i3 = idx(ts, rs), idx(ts, re_), idx(ts, as_), idx(ts, ae)
        if i3 > len(ts) or i1 <= i0: continue
        MH, ML = max(h[i0:i1]), min(l[i0:i1]); rng = MH - ML; b = buf_frac * rng; mid = (MH + ML) / 2
        pos = 0; armed_s = armed_l = c[i2 - 1] < MH; armed_l = c[i2 - 1] > ML
        def book(side, ent, ext, fee_exit, why, t):
            g = (ext - ent) * side / b
            trades.append({"t": t, "R_gross": g, "R_net": g - (MAKER * ent + fee_exit * ext) / b, "why": why})
        for i in range(i2, i3):
            hi, lo, op, cl = h[i], l[i], o[i], c[i]
            if pos == 0:
                if armed_s and hi >= MH and op < MH + b: pos, ent = -1, MH
                elif armed_l and lo <= ML and op > ML - b: pos, ent = 1, ML
            if pos == -1:
                tgt = ML if target == "edge" else mid
                if hi >= MH + b:
                    book(-1, ent, max(op, MH + b) * (1 + SLIP), TAKER, "stop", ts[i]); pos = 0; armed_s = False
                elif lo <= tgt:
                    book(-1, ent, tgt, MAKER, "target", ts[i]); pos = 0
                    if target == "edge":
                        pos, ent = 1, ML
            elif pos == 1:
                tgt = MH if target == "edge" else mid
                if lo <= ML - b:
                    book(1, ent, min(op, ML - b) * (1 - SLIP), TAKER, "stop", ts[i]); pos = 0; armed_l = False
                elif hi >= tgt:
                    book(1, ent, tgt, MAKER, "target", ts[i]); pos = 0
                    if target == "edge":
                        pos, ent = -1, MH
            if not armed_s and cl < MH: armed_s = True
            if not armed_l and cl > ML: armed_l = True
        if pos:
            book(pos, ent, c[i3 - 1] * (1 - SLIP * pos), TAKER, "period end", ts[i3 - 1])
    return pd.DataFrame(trades)


def breakout(data, wins, stop_mode="opposite", trend=None):
    ts, o, h, l, c = data
    trades = []
    for rs, re_, as_, ae in wins:
        i0, i1, i2, i3 = idx(ts, rs), idx(ts, re_), idx(ts, as_), idx(ts, ae)
        if i3 > len(ts) or i1 <= i0: continue
        MH, ML = max(h[i0:i1]), min(l[i0:i1]); mid = (MH + ML) / 2
        allow = {1: True, -1: True}
        if trend is not None:
            sc = trend.asof(pd.Timestamp(as_, unit="s", tz="UTC"))
            if sc is None or np.isnan(sc): continue
            allow = {1: sc > 0, -1: sc < 0}
        done = {1: False, -1: False}; pos = 0
        for i in range(i2, i3):
            hi, lo, op = h[i], l[i], o[i]
            if pos == 0:
                if allow[1] and not done[1] and hi >= MH: pos, ent = 1, max(op, MH) * (1 + SLIP)
                elif allow[-1] and not done[-1] and lo <= ML: pos, ent = -1, min(op, ML) * (1 - SLIP)
                if pos:
                    done[pos] = True
                    stop = mid if stop_mode == "mid" else (ML if pos == 1 else MH); risk = abs(ent - stop)
                    continue
            if pos and ((pos == 1 and lo <= stop) or (pos == -1 and hi >= stop)):
                ext = (min(op, stop) if pos == 1 else max(op, stop)) * (1 - SLIP * pos)
                g = (ext - ent) * pos / risk
                trades.append({"t": ts[i], "R_gross": g, "R_net": g - TAKER * (ent + ext) / risk, "why": "stop"}); pos = 0
        if pos:
            ext = c[i3 - 1] * (1 - SLIP * pos); g = (ext - ent) * pos / risk
            trades.append({"t": ts[i3 - 1], "R_gross": g, "R_net": g - TAKER * (ent + ext) / risk, "why": "period end"})
    return pd.DataFrame(trades)


def time_in_range(data, wins):
    ts, o, h, l, c = data
    inside, held = [], 0
    for rs, re_, as_, ae in wins:
        i0, i1, i2, i3 = idx(ts, rs), idx(ts, re_), idx(ts, as_), idx(ts, ae)
        if i3 > len(ts): continue
        MH, ML = max(h[i0:i1]), min(l[i0:i1])
        cc = np.asarray(c[i2:i3]); inside.append(((cc <= MH) & (cc >= ML)).mean())
        held += (max(h[i2:i3]) <= MH and min(l[i2:i3]) >= ML)
    return np.mean(inside), held / len(inside), len(inside)


def summarize(tr, years=2.07):
    if tr.empty: return {"trades": 0}
    r = tr.R_net; y1, y2 = r[tr.t < SPLIT], r[tr.t >= SPLIT]
    eq = np.cumprod(1 + 0.02 * r.values)  # 2% risk per trade, trades in time order
    return {"trades": len(r), "win %": round((r > 0).mean() * 100), "avg R": round(r.mean(), 2),
            "t": round(r.mean() / r.std() * np.sqrt(len(r)), 2) if len(r) > 2 else None,
            "year1 R": round(y1.mean(), 2) if len(y1) else None, "year2 R": round(y2.mean(), 2) if len(y2) else None,
            "R per year": round(r.sum() / years, 1), "£1,000 at 2% risk": round(1000 * eq[-1]) if eq[-1] > 0 else 0}


if __name__ == "__main__":
    data = {s: load1m(s) for s in ("BTC", "ETH", "SOL")}
    trend = trend_scores()
    KINDS = {"monday": "Monday range", "prev_week": "Previous week", "month_open": "First week of month",
             "prev_month": "Previous month"}
    print("How range-bound is crypto? Share of time the price sat inside each range while it was being traded:")
    for k, name in KINDS.items():
        vals = [time_in_range(data[s], windows(data[s][0], k)) for s in data]
        print(f"  {name:<20} inside {np.mean([v[0] for v in vals])*100:.0f}% of the time; range never broken in "
              f"{np.mean([v[1] for v in vals])*100:.0f}% of periods ({vals[0][2]} periods per coin)")
    rows = []
    for k, name in KINDS.items():
        variants = [
            ("fade, stop 10% of range, target other edge", lambda d, w, s: fade(d, w, 0.10, "edge")),
            ("fade, stop 25% of range, target other edge", lambda d, w, s: fade(d, w, 0.25, "edge")),
            ("fade, stop 25% of range, target midpoint", lambda d, w, s: fade(d, w, 0.25, "mid")),
            ("breakout, stop opposite edge", lambda d, w, s: breakout(d, w, "opposite")),
            ("breakout, stop opposite edge, trend filter", lambda d, w, s: breakout(d, w, "opposite", trend[s])),
            ("breakout, stop midpoint, trend filter", lambda d, w, s: breakout(d, w, "mid", trend[s])),
        ]
        for vname, fn in variants:
            tr = pd.concat([fn(data[s], windows(data[s][0], k), s) for s in data], ignore_index=True).sort_values("t")
            rows.append({"range": name, "strategy": vname, **summarize(tr)})
            print(rows[-1], flush=True)
    out = pd.DataFrame(rows)
    pd.set_option("display.width", 250)
    print(out.to_string(index=False))
    out.to_csv(Path(__file__).parent / "data" / "ranges_results.csv", index=False)
