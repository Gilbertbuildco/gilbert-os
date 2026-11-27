"""Pyramiding: add to winning trades and move the stop up.

Entry as in stop_sizing.py (4 of 6 votes, after the daily close). The first unit is sized so a 2 ATR stop
loses the scheme's risk amount. Each time price moves `step` ATR further in our favour (checked hourly, filled
at that level or at the open if it gapped), add a unit. After every add the stop for the whole position moves
to 2 ATR behind the latest add price (Turtle style), and it also trails 2 ATR behind the best close.
Unit size for adds is either the original unit ("fixed") or re-computed from current equity including open
profit ("compound"). Exit on the stop (hourly) or when the votes no longer support the direction (daily).
100x cross margin caps total notional; liquidation is checked hourly at worst prices.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from sim import *

SCHEMES = {
    "£100 then £200 from £2k": lambda e: 200.0 if e >= 2000 else 100.0,
    "5% of equity": lambda e: 0.05 * e,
    "fixed £200": lambda e: 200.0,
}


def prep(px):
    syms = list(px)
    dbar = {s: resample(px[s], "1D") for s in syms}
    dc = pd.DataFrame({s: dbar[s].close for s in syms})
    score = ensemble_score(dc)
    atr = pd.DataFrame({s: pd.concat([dbar[s].high - dbar[s].low, (dbar[s].high - dbar[s].close.shift()).abs(),
                                      (dbar[s].low - dbar[s].close.shift()).abs()], axis=1).max(axis=1).rolling(20).mean()
                        for s in syms})
    score.index = score.index + pd.Timedelta("1D"); atr.index = atr.index + pd.Timedelta("1D")
    prev_close = dc.copy(); prev_close.index = prev_close.index + pd.Timedelta("1D")
    return {"o": pd.DataFrame({s: px[s].open for s in syms}).values, "h": pd.DataFrame({s: px[s].high for s in syms}).values,
            "l": pd.DataFrame({s: px[s].low for s in syms}).values, "c": pd.DataFrame({s: px[s].close for s in syms}).values,
            "idx": px[syms[0]].index, "score": score, "atr": atr, "pc": prev_close, "syms": syms}


def run(P, fund, scheme, step=None, max_units=1, add_mode="fixed", k=2.0, move_stop_on_add=True, fee=0.0005, slip=0.0002, stop_slip=0.001,
        equity0=1000.0, leverage=100, mmr=0.005):
    syms = P["syms"]; n = len(syms); o, h, l, c, idx = P["o"], P["h"], P["l"], P["c"], P["idx"]
    f = pd.DataFrame({s: fund[s] for s in syms}).reindex(idx).fillna(0.0).values
    risk_fn = SCHEMES[scheme]
    dpos = {t: i for i, t in enumerate(P["score"].index)}
    cash = equity0; qty = np.zeros(n); stop = np.full(n, np.nan); best = np.full(n, np.nan)
    last_add = np.full(n, np.nan); units = np.zeros(n, int); atr_e = np.full(n, np.nan); unit_q = np.zeros(n)
    entry_cost = np.zeros(n); fees_tr = np.zeros(n); base_risk = np.zeros(n)
    trades = []; curve = np.zeros(len(idx)); blown = None; max_mult = 0.0; max_units_seen = 0

    def equity(i, price_row):
        return cash + float(np.dot(qty, price_row))

    def close(j, price, t):
        nonlocal cash
        v = qty[j] * price; cash += v; fee_ = abs(v) * fee; cash -= fee_
        pnl = v - entry_cost[j] - fees_tr[j] - fee_
        trades.append({"t": t, "sym": syms[j], "pnl": pnl, "R": pnl / base_risk[j], "units": units[j]})
        qty[j] = 0; stop[j] = best[j] = last_add[j] = np.nan; units[j] = 0; entry_cost[j] = fees_tr[j] = 0

    def buy(j, q, price, i):
        nonlocal cash
        fill = price * (1 + slip * np.sign(q))
        eq = equity(i, o[i])
        gross = float(np.dot(np.abs(qty), o[i])) + abs(q) * fill
        if gross / leverage > eq:  # margin cap
            room = eq * leverage - float(np.dot(np.abs(qty), o[i]))
            if room <= 0: return False
            q = np.sign(q) * room / fill
        if abs(q) * fill < 10: return False
        cash -= q * fill; fee_ = abs(q * fill) * fee; cash -= fee_
        qty[j] += q; entry_cost[j] += q * fill; fees_tr[j] += fee_
        return True

    for i, t in enumerate(idx):
        if t in dpos:
            d = dpos[t]; eq = equity(i, o[i])
            for j, s in enumerate(syms):
                sc = P["score"].iat[d, j]; a = P["atr"].iat[d, j]; pc = P["pc"].iat[d, j]
                if np.isnan(sc) or np.isnan(a): continue
                want = 1 if sc >= 4/6 - 1e-9 else -1 if sc <= -4/6 + 1e-9 else 0
                have = int(np.sign(qty[j]))
                if have and want != have:
                    close(j, o[i, j] * (1 - slip * have), t); have = 0
                if have:
                    best[j] = max(best[j], pc) if have > 0 else min(best[j], pc)
                    stop[j] = max(stop[j], best[j] - k * a) if have > 0 else min(stop[j], best[j] + k * a)
                elif want:
                    r = risk_fn(eq)
                    if r <= 0 or eq <= 0: continue
                    q = r / (k * a) * want
                    if buy(j, q, o[i, j], i):
                        base_risk[j] = r; unit_q[j] = abs(qty[j]); units[j] = 1; atr_e[j] = a
                        best[j] = last_add[j] = o[i, j]; stop[j] = o[i, j] - k * a * want
        # hourly: pyramid adds, then stops
        for j in range(n):
            if not qty[j] or step is None or units[j] >= max_units: continue
            sgn = np.sign(qty[j]); a = atr_e[j]
            while units[j] < max_units:
                lvl = last_add[j] + sgn * step * a
                hit = h[i, j] >= lvl if sgn > 0 else l[i, j] <= lvl
                if not hit: break
                price = max(o[i, j], lvl) if sgn > 0 else min(o[i, j], lvl)
                eq = equity(i, c[i])
                q = (unit_q[j] if add_mode == "fixed" else risk_fn(eq) / (k * a)) * sgn
                if not buy(j, q, price, i): break
                units[j] += 1; last_add[j] = lvl
                if move_stop_on_add:
                    stop[j] = max(stop[j], lvl - k * a) if sgn > 0 else min(stop[j], lvl + k * a)
        for j in range(n):
            if qty[j] > 0 and l[i, j] <= stop[j]: close(j, min(o[i, j], stop[j]) * (1 - stop_slip), t)
            elif qty[j] < 0 and h[i, j] >= stop[j]: close(j, max(o[i, j], stop[j]) * (1 + stop_slip), t)
        worst = np.where(qty > 0, l[i], h[i])
        nw = float(np.dot(np.abs(qty), worst))
        if nw and cash + float(np.dot(qty, worst)) <= nw * mmr:
            blown = t; cash = max(0.0, cash + float(np.dot(qty, worst))); qty[:] = 0; curve[i:] = cash; break
        fr = f[i]
        if fr.any(): cash -= float(np.dot(qty * c[i], fr))
        eq = equity(i, c[i]); curve[i] = eq
        if eq > 0: max_mult = max(max_mult, float(np.dot(np.abs(qty), c[i])) / eq)
        max_units_seen = max(max_units_seen, int(units.max()))
        if eq <= 1: blown = t; curve[i:] = max(eq, 0); break
    cv = pd.Series(curve, index=idx)
    return cv, pd.DataFrame(trades), {"blown": blown, "max_exposure": max_mult, "max_units": max_units_seen}


VARIANTS = [
    ("no adding", None, 1, "fixed"),
    ("add every 1 ATR, max 4 units", 1.0, 4, "fixed"),
    ("add every 1 ATR, unlimited", 1.0, 999, "fixed"),
    ("add every 1 ATR, unlimited, compound size", 1.0, 999, "compound"),
    ("add every 0.5 ATR, unlimited, compound size", 0.5, 999, "compound"),
    ("add every 2 ATR, unlimited, compound size", 2.0, 999, "compound"),
]

if __name__ == "__main__":
    px, fund = load(); P = prep(px)
    rows = []
    for scheme in SCHEMES:
        for name, step, mu, mode in VARIANTS:
            cv, tr, ex = run(P, fund, scheme, step, mu, mode)
            d = cv.resample("1D").last()
            rows.append({"sizing": scheme, "pyramiding": name, "end £": round(d.iloc[-1]),
                         "max DD %": round((d / d.cummax() - 1).min() * 100, 1), "lowest £": round(d.min()),
                         "blown up": ex["blown"].date() if ex["blown"] is not None else "no",
                         "trades": len(tr), "win %": round((tr.pnl > 0).mean() * 100) if len(tr) else 0,
                         "best trade £": round(tr.pnl.max()) if len(tr) else 0, "max units": ex["max_units"],
                         "max exposure x": round(ex["max_exposure"], 1),
                         "avg R": round(tr.R.mean(), 2) if len(tr) else 0})
            print(rows[-1], flush=True)
    pd.set_option("display.width", 250)
    out = pd.DataFrame(rows); out.to_csv(Path(__file__).parent / "data" / "pyramid_results.csv", index=False)
    print(out.to_string(index=False))
