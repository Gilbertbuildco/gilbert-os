"""Fixed-risk sizing with stop losses: each position is sized so hitting its stop loses `risk` of equity.

Same trend votes as the main strategy. Enter after the daily close when at least 4 of 6 votes agree, size =
risk x equity / stop distance, trail the stop at k x daily ATR from the best close since entry, check it every
hour (a bar that opens through the stop fills at the open), exit on a vote flip, and re-enter at a later daily
close if the trend still holds. 100x cross margin, liquidation checked hourly at worst prices.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from sim import *


def run(px, fund, risk, k, fee=0.0005, slip=0.0002, stop_slip=0.001, equity0=1000.0, leverage=100, mmr=0.005):
    syms = list(px)
    o = pd.DataFrame({s: px[s].open for s in syms}); h = pd.DataFrame({s: px[s].high for s in syms})
    l = pd.DataFrame({s: px[s].low for s in syms}); c = pd.DataFrame({s: px[s].close for s in syms})
    f = pd.DataFrame({s: fund[s] for s in syms}).reindex(c.index).fillna(0.0)
    dbar = {s: resample(px[s], "1D") for s in syms}
    dc = pd.DataFrame({s: dbar[s].close for s in syms})
    score = ensemble_score(dc)
    atr = pd.DataFrame({s: pd.concat([dbar[s].high - dbar[s].low, (dbar[s].high - dbar[s].close.shift()).abs(),
                                      (dbar[s].low - dbar[s].close.shift()).abs()], axis=1).max(axis=1).rolling(20).mean()
                        for s in syms})
    score.index = score.index + pd.Timedelta("1D"); atr.index = atr.index + pd.Timedelta("1D")
    dset = set(score.index)
    cash = equity0; qty = {s: 0.0 for s in syms}; stop = {s: None for s in syms}; best = {s: None for s in syms}
    entry_eq = {s: None for s in syms}; entry_px = {s: None for s in syms}; results = []; rmult = []
    curve = []; blown = None; path = []
    def close(s, price, t):
        nonlocal cash
        v = qty[s] * price; cash += v; fee_ = abs(v) * fee; cash -= fee_
        pnl = qty[s] * (price - entry_px[s]) - fee_ - abs(qty[s] * entry_px[s]) * fee
        results.append(pnl); rmult.append(pnl / (risk * entry_eq[s]))
        path.append((t, s, "long" if qty[s] > 0 else "short", entry_px[s], price, abs(qty[s] * entry_px[s]), pnl))
        qty[s] = 0.0; stop[s] = None; best[s] = None
    for t in c.index:
        op = o.loc[t]
        if t in dset:
            eq = cash + sum(qty[s] * op[s] for s in syms)
            for s in syms:
                sc, a = score.loc[t, s], atr.loc[t, s]
                if np.isnan(sc) or np.isnan(a):
                    continue
                want = 1 if sc >= 4/6 - 1e-9 else -1 if sc <= -4/6 + 1e-9 else 0
                have = int(np.sign(qty[s]))
                if have and want != have:
                    close(s, op[s] * (1 - slip * have), t)
                    have = 0
                if have:  # trail the stop
                    best[s] = max(best[s], dc[s].asof(t - pd.Timedelta("1D"))) if have > 0 else min(best[s], dc[s].asof(t - pd.Timedelta("1D")))
                    stop[s] = max(stop[s], best[s] - k * a) if have > 0 else min(stop[s], best[s] + k * a)
                elif want:
                    dist = k * a
                    q = risk * eq / dist * want
                    gross_after = sum(abs(qty[x]) * op[x] for x in syms) + abs(q) * op[s]
                    if gross_after / leverage > eq:  # margin cap
                        q *= max(0.0, (eq * leverage - (gross_after - abs(q) * op[s]))) / (abs(q) * op[s])
                    if abs(q) * op[s] < 10:
                        continue
                    fill = op[s] * (1 + slip * want)
                    entry_eq[s] = eq; entry_px[s] = fill
                    cash -= q * fill + abs(q * fill) * fee; qty[s] = q
                    best[s] = op[s]; stop[s] = op[s] - dist * want
        # hourly stop checks
        for s in syms:
            if qty[s] > 0 and l.loc[t, s] <= stop[s]:
                close(s, min(op[s], stop[s]) * (1 - stop_slip), t)
            elif qty[s] < 0 and h.loc[t, s] >= stop[s]:
                close(s, max(op[s], stop[s]) * (1 + stop_slip), t)
        # liquidation at worst prices
        worst = {s: (l.loc[t, s] if qty[s] > 0 else h.loc[t, s]) for s in syms}
        notional_w = sum(abs(qty[s]) * worst[s] for s in syms)
        if notional_w and cash + sum(qty[s] * worst[s] for s in syms) <= notional_w * mmr:
            blown = t; cash = max(0.0, cash + sum(qty[s] * worst[s] for s in syms)); qty = {s: 0.0 for s in syms}
            curve.append((t, cash)); break
        for s in syms:
            if f.loc[t, s] and qty[s]:
                cash -= qty[s] * c.loc[t, s] * f.loc[t, s]
        eq = cash + sum(qty[s] * c.loc[t, s] for s in syms)
        curve.append((t, eq))
        if eq <= 1:
            blown = t; break
    cv = pd.Series(dict(curve)); res = np.array(results)
    streak = cur = 0
    for x in res:
        cur = cur + 1 if x <= 0 else 0; streak = max(streak, cur)
    peak_notional = None
    return cv, {"trades": len(res), "win%": round((res > 0).mean() * 100) if len(res) else 0,
                "longest_losing_streak": streak, "blown": blown, "r": np.array(rmult), "path": path}


if __name__ == "__main__":
    px, fund = load()
    cv, ex = run(px, fund, 0.20, 2)
    d = cv.resample("1D").last().dropna()
    pk = d.cummax(); trough = (d / pk).idxmin()
    print(f"£200 risk, 2 ATR stop: peak £{pk[trough]:.0f} on {pk[:trough].idxmax().date()}, trough £{d[trough]:.0f} on "
          f"{trough.date()}, end £{d.iloc[-1]:.0f}")
    print("biggest positions opened (notional £):", sorted([round(p[5]) for p in ex["path"]])[-5:])
    worst = sorted(ex["path"], key=lambda p: p[6])[:3]
    for p in worst:
        print(f"  worst: {p[0].date()} {p[1]} {p[2]} entry {p[3]:.4g} exit {p[4]:.4g} notional £{p[5]:.0f} pnl £{p[6]:.0f}")
    r = ex["r"]
    print(f"\nTrade outcomes in units of risk (R): {len(r)} trades, win rate {np.mean(r > 0) * 100:.0f}%, "
          f"average {r.mean():+.2f}R, worst {r.min():.2f}R (stop slipped past), best {r.max():+.1f}R")
    print("\nShuffled trade order, 20,000 runs of the same 167 trades, sequential compounding:")
    rng = np.random.default_rng(1)
    for risk in (0.01, 0.02, 0.05, 0.10, 0.20):
        ends, ruin, half = [], 0, 0
        for _ in range(20_000):
            seq = rng.permutation(r)
            eq = np.cumprod(1 + risk * seq)
            ends.append(eq[-1]); ruin += eq.min() < 0.10; half += eq.min() < 0.50
        ends = np.array(ends)
        print(f"risk {int(risk*100):>2}% (£{int(risk*1000)}): median end £{np.median(ends)*1000:,.0f}  "
              f"P(account ever below £500) {half/200:.0f}%  P(ever below £100) {ruin/200:.1f}%  "
              f"P(end below £1,000) {np.mean(ends < 1)*100:.0f}%")
