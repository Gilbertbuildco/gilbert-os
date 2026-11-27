"""Monday range strategy on 1-minute perp data.

Each week: Monday 00:00-23:59 UTC sets the range high (MH) and low (ML). Tuesday to Sunday:
- short at MH (limit), stop at MH + buffer, target ML; long at ML, stop at ML - buffer, target MH
- on hitting the target, flip into the opposite trade at the same level ("trade the range up and down")
- after a stop, that side re-arms once a candle closes back inside the range
- anything open is closed at Sunday's last close
Fills: entries and targets are limit orders (maker 0.02%), stops and the weekly exit are market (taker 0.05%
plus 0.01% slippage). If one candle touches the entry and the stop, the stop is assumed hit (worst case).
Results are in R: one R is the loss from entry to stop, so they are independent of position size.
"""
import sys
from pathlib import Path
import numpy as np, pandas as pd

HERE = Path(__file__).resolve().parent
MAKER, TAKER, SLIP = 0.0002, 0.0005, 0.0001
WEEK, DAY = 7 * 86400, 86400


def load1m(sym):
    z = np.load(HERE / "data" / "clean" / f"{sym}USDT_1m.npz")
    return z["ts"], z["o"].tolist(), z["h"].tolist(), z["l"].tolist(), z["c"].tolist()


def mondays(ts):
    first = ts[0] + (-(ts[0] - 4 * DAY)) % WEEK
    out = []
    m = first
    while m + WEEK <= ts[-1] + 60:
        out.append(m); m += WEEK
    return out


def simulate(sym, buffer_fn, btc_ref=None, worst_case=True, loader=None):
    ts, o, h, l, c = (loader or load1m)(sym)
    trades, weeks = [], []
    for m in mondays(ts):
        i0 = int(np.searchsorted(ts, m)); i1 = i0 + 1440; i2 = i0 + 7 * 1440
        if i2 > len(ts) or ts[i2 - 1] != m + WEEK - 60:
            continue
        MH = max(h[i0:i1]); ML = min(l[i0:i1]); rng = MH - ML
        b = buffer_fn(MH, ML, c[i1 - 1], btc_ref.get(m) if btc_ref else None)
        weeks.append({"monday": pd.Timestamp(m, unit="s", tz="UTC").date(), "range_pct": rng / c[i1 - 1] * 100,
                      "buffer_pct": b / c[i1 - 1] * 100,
                      "broke_out": max(h[i1:i2]) > MH + b or min(l[i1:i2]) < ML - b})
        pos = 0; entry = 0.0; armed_s = armed_l = True
        def book(side, ent, ext, reason, exit_fee, t):
            stop_dist = b
            gross = (ext - ent) * side / stop_dist
            fees = (MAKER * ent + exit_fee * ext) / stop_dist
            trades.append({"t": t, "side": side, "entry": ent, "exit": ext, "reason": reason, "R_gross": gross,
                           "R_net": gross - fees, "stop_pct": stop_dist / ent * 100, "range_R": rng / stop_dist})
        for i in range(i1, i2):
            hi, lo, op, cl = h[i], l[i], o[i], c[i]
            just_entered = False
            if pos == 0:
                just_entered = True
                if armed_s and hi >= MH and op < MH + b:
                    pos, entry = -1, MH
                elif armed_l and lo <= ML and op > ML - b:
                    pos, entry = 1, ML
                else:
                    just_entered = False
            if just_entered and not worst_case:
                continue  # best case: the entry minute cannot also stop us out
            # manage the open position; loop handles flips within the same candle only once (conservative)
            if pos == -1:
                if hi >= MH + b:
                    book(-1, entry, max(op, MH + b) * (1 + SLIP), "stop", TAKER, ts[i]); pos = 0; armed_s = False
                elif lo <= ML:
                    book(-1, entry, ML, "target", MAKER, ts[i])
                    pos, entry = 1, ML                       # flip long at the low
                    if lo <= ML - b:                          # same candle broke the low too: stopped
                        book(1, entry, min(op, ML - b) * (1 - SLIP), "stop", TAKER, ts[i]); pos = 0; armed_l = False
            elif pos == 1:
                if lo <= ML - b:
                    book(1, entry, min(op, ML - b) * (1 - SLIP), "stop", TAKER, ts[i]); pos = 0; armed_l = False
                elif hi >= MH:
                    book(1, entry, MH, "target", MAKER, ts[i])
                    pos, entry = -1, MH
                    if hi >= MH + b:
                        book(-1, entry, max(op, MH + b) * (1 + SLIP), "stop", TAKER, ts[i]); pos = 0; armed_s = False
            if not armed_s and cl < MH: armed_s = True
            if not armed_l and cl > ML: armed_l = True
        if pos:
            book(pos, entry, c[i2 - 1] * (1 - SLIP * pos), "week end", TAKER, ts[i2 - 1])
    return pd.DataFrame(trades), pd.DataFrame(weeks)


def summarize(tr, wk, label):
    if tr.empty:
        return {"variant": label, "trades": 0}
    n_weeks = len(wk)
    return {"variant": label, "weeks": n_weeks, "trades": len(tr), "trades/week": round(len(tr) / n_weeks, 1),
            "win %": round((tr.R_net > 0).mean() * 100, 1), "targets hit": int((tr.reason == "target").sum()),
            "stops": int((tr.reason == "stop").sum()), "avg R gross": round(tr.R_gross.mean(), 2),
            "avg R net": round(tr.R_net.mean(), 2), "total R net": round(tr.R_net.sum(), 0),
            "stop dist %": round(tr.stop_pct.median(), 3), "fees per loser R": round(((MAKER + TAKER + SLIP) / (tr.stop_pct / 100)).median(), 1)}


if __name__ == "__main__":
    # BTC $10 as a share of BTC's price each Monday, used to scale ETH and SOL to the same tightness
    ts, o, h, l, c = load1m("BTC")
    btc_ref = {m: 10.0 / c[int(np.searchsorted(ts, m)) + 1439] for m in mondays(ts)}
    variants = {
        "$10 on BTC (same % on ETH/SOL)": lambda MH, ML, px, ref: px * ref,
        "0.1% of price": lambda MH, ML, px, ref: px * 0.001,
        "0.25% of price": lambda MH, ML, px, ref: px * 0.0025,
        "0.5% of price": lambda MH, ML, px, ref: px * 0.005,
        "10% of the Monday range": lambda MH, ML, px, ref: (MH - ML) * 0.10,
        "25% of the Monday range": lambda MH, ML, px, ref: (MH - ML) * 0.25,
    }
    rows, all_tr = [], {}
    for sym in ("BTC", "ETH", "SOL"):
        for name, fn in variants.items():
            tr, wk = simulate(sym, fn, btc_ref)
            all_tr[(sym, name)] = (tr, wk)
            rows.append({"coin": sym, **summarize(tr, wk, name)})
            print(rows[-1], flush=True)
        print(f"{sym}: average Monday range {wk.range_pct.mean():.2f}% of price, weeks where price broke out of it "
              f"{wk.broke_out.mean()*100:.0f}%")
    pd.set_option("display.width", 250)
    out = pd.DataFrame(rows); print(out.to_string(index=False))
    pd.to_pickle(all_tr, HERE / "data" / "monday_trades.pkl")
