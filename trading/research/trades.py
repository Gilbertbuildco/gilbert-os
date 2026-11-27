"""Replay the two years through the bot at a 35% vol target and list the individual trades it took."""
import sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))
from sim import *
from trader.config import Config
from trader.futures import FuturesPaperBroker
from trader.futures_engine import FuturesEngine
from trader.models import Candle

VT = float(sys.argv[1]) if len(sys.argv) > 1 else 35
px, fund = load()
cfg = Config(); cfg.mode = "futures"; cfg.market.symbols = [f"{s}/USD" for s in SYMS]
cfg.futures.vol_target_pct = VT
b = FuturesPaperBroker(":memory:", 1000.0, cfg.futures.fee_bps, cfg.futures.slippage_bps, 100, 0.5)
eng = FuturesEngine(cfg, b)
mk = lambda t, r: Candle(int(t.timestamp()), float(r.open), float(r.high), float(r.low), float(r.close), float(r.volume))
hourly = {f"{s}/USD": [mk(t, r) for t, r in px[s].iterrows()] for s in SYMS}
daily = {f"{s}/USD": [mk(t, r) for t, r in resample(px[s], "1D").iterrows()] for s in SYMS}
di = {k: 0 for k in daily}; eqs = []
for i in range(1, len(hourly["BTC/USD"])):
    ts = hourly["BTC/USD"][i].ts
    for k in daily:
        while di[k] < len(daily[k]) and daily[k][di[k]].ts + 86400 <= ts: di[k] += 1
    r = eng.run_cycle({k: v[max(0, i - 2):i] for k, v in hourly.items()},
                      {k: daily[k][max(0, di[k] - 150):di[k]] for k in daily}, ts=ts)
    eqs.append((ts, r.equity, b.gross_notional({k: v[i - 1].close for k, v in hourly.items()})))
e = pd.DataFrame(eqs, columns=["ts", "equity", "gross"]); e["t"] = pd.to_datetime(e.ts, unit="s", utc=True)
print(f"vol {VT}%: end £{e.equity.iloc[-1]:.0f}, max drawdown {((e.equity / e.equity.cummax()) - 1).min() * 100:.1f}%, "
      f"peak exposure {(e.gross / e.equity).max():.2f}x, peak notional £{e.gross.max():.0f}")

# Group fills into episodes: from opening a direction until flat or flipped
tr = pd.DataFrame(b.trades()); tr["t"] = pd.to_datetime(tr.ts, unit="s", utc=True)
tr["signed"] = np.where(tr.side == "buy", 1, -1) * tr.qty
decisions = {d["ts"]: d for d in b.recent_decisions(100000)}
eps = []
for s in cfg.market.symbols:
    q = 0.0; cur = None
    for _, row in tr[tr.symbol == s].iterrows():
        prev = q; q += row.signed
        if abs(q) * row.price < 1: q = 0.0
        if cur is None:
            cur = {"symbol": s, "side": "LONG" if q > 0 else "SHORT", "open": row.t, "entry": row.price, "pnl": 0.0,
                   "fees": 0.0, "max_notional": 0.0, "adds": 0, "votes": decisions.get(row.ts, {}).get("payload", {}).get("votes", {}).get(s)}
        cur["pnl"] += row.realized_pnl; cur["fees"] += row.fee; cur["adds"] += 1
        cur["max_notional"] = max(cur["max_notional"], abs(q) * row.price)
        flipped = prev != 0 and q != 0 and np.sign(prev) != np.sign(q)
        if q == 0 or flipped:
            cur["close"] = row.t; cur["exit"] = row.price
            if flipped:  # the flip's realised pnl belongs to the closing leg; the remainder opens a new episode
                eps.append(cur)
                cur = {"symbol": s, "side": "LONG" if q > 0 else "SHORT", "open": row.t, "entry": row.price, "pnl": 0.0,
                       "fees": 0.0, "max_notional": abs(q) * row.price, "adds": 0,
                       "votes": decisions.get(row.ts, {}).get("payload", {}).get("votes", {}).get(s)}
            else:
                eps.append(cur); cur = None
    if cur:
        cur["close"] = None; cur["exit"] = hourly[s][-1].close
        p = b.positions().get(s)
        if p: cur["pnl"] += p.qty * (hourly[s][-1].close - p.avg_price)  # unrealised
        eps.append(cur)
E = pd.DataFrame(eps)
E["days"] = ((E.close.fillna(e.t.iloc[-1]) - E.open).dt.total_seconds() / 86400).round(1)
E["move%"] = ((E.exit / E.entry - 1) * 100 * np.where(E.side == "LONG", 1, -1)).round(1)
pd.set_option("display.width", 250)
cols = ["symbol", "side", "open", "close", "days", "entry", "exit", "move%", "max_notional", "adds", "pnl"]
print(f"\n{len(E)} trades, {int((E.pnl > 0).sum())} winners, {int((E.pnl <= 0).sum())} losers; "
      f"average winner £{E.pnl[E.pnl > 0].mean():.2f}, average loser £{E.pnl[E.pnl <= 0].mean():.2f}")
print("\nBest 5:"); print(E.sort_values("pnl", ascending=False)[cols].head(5).round(2).to_string(index=False))
print("\nWorst 5:"); print(E.sort_values("pnl")[cols].head(5).round(2).to_string(index=False))
best = E.sort_values("pnl", ascending=False).iloc[0]
print("\nBest trade votes at entry:", best.votes)
# daily path of the best trade
s = best.symbol; path = tr[(tr.symbol == s) & (tr.t >= best.open) & (tr.t <= (best.close or tr.t.max()))]
print("\nFills in the best trade:")
print(path[["t", "side", "qty", "price", "fee", "realized_pnl", "reason"]].round(4).to_string(index=False))
E.to_csv(HERE / "data" / f"trades_vol{int(VT)}.csv", index=False)

print("\n==== Example: ETH long, July to September 2025")
ex = E[(E.symbol == "ETH/USD") & (E.open == pd.Timestamp("2025-07-07", tz="UTC"))].iloc[0]
f = tr[(tr.symbol == "ETH/USD") & (tr.t >= ex.open) & (tr.t <= ex.close)].copy()
pos = 0.0; rows = []
for _, r in f.iterrows():
    pos += r.signed
    d = decisions.get(r.ts, {})
    v = d.get("payload", {}).get("votes", {}).get("ETH/USD", {})
    rows.append({"date": r.t.date(), "action": r.side, "price": round(r.price, 2), "notional_after": round(abs(pos) * r.price, 2),
                 "bull_votes": sum(1 for x in v.values() if x > 0), "pnl_realised": round(r.realized_pnl, 2), "reason": r.reason})
print(pd.DataFrame(rows).to_string(index=False))
print(f"held {ex.days} days, entry {ex.entry:.2f}, exit {ex.exit:.2f}, move {ex['move%']}%, profit £{ex.pnl:.2f}")
eth = resample(px["ETH"], "1D").close
print("ETH high during trade:", round(eth[ex.open:ex.close].max(), 2), "on", eth[ex.open:ex.close].idxmax().date())

print("\n==== Worst hour for the account, and the 10 Oct 2025 crash")
e["ret"] = e.equity.pct_change()
w = e.loc[e.ret.idxmin()]
print(f"worst hour {w.t}: equity change {w.ret * 100:.2f}%, exposure {w.gross / w.equity:.2f}x")
crash = e[(e.t >= "2025-10-10 18:00") & (e.t <= "2025-10-11 06:00")]
print(crash[["t", "equity", "gross"]].assign(exposure=lambda x: (x.gross / x.equity).round(2)).round(2).to_string(index=False))
lo4 = min((px[s].low.rolling(4).min() / px[s].close.shift(4) - 1).min() for s in SYMS)
print(f"liquidation needs equity to fall to 0.5% of notional: at peak exposure {(e.gross / e.equity).max():.2f}x that is a "
      f"{(1 - 0.005 * (e.gross / e.equity).max()) / (e.gross / e.equity).max() * 100:.0f}% move against every position at once; "
      f"worst 4h drop of any coin in the data: {lo4 * 100:.1f}%")
