"""Replay two years through the bot with the trend strategy (35%) plus the Monday breakout (2% risk)."""
import sys, json
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))
from sim import *
from trader.config import Config
from trader.futures import FuturesPaperBroker
from trader.futures_engine import FuturesEngine
from trader.models import Candle

px, fund = load()
mk = lambda t, r: Candle(int(t.timestamp()), float(r.open), float(r.high), float(r.low), float(r.close), float(r.volume))
hourly = {f"{s}/USD": [mk(t, r) for t, r in px[s].iterrows()] for s in SYMS}
daily = {f"{s}/USD": [mk(t, r) for t, r in resample(px[s], "1D").iterrows()] for s in SYMS}

def replay(breakout, risk=2.0, brake=(40, 50)):
    cfg = Config(); cfg.mode = "futures"; cfg.market.symbols = [f"{s}/USD" for s in SYMS]
    f = cfg.futures; f.vol_target_pct = 35; f.breakout_enabled = breakout; f.breakout_risk_pct = risk
    f.drawdown_brake_start_pct, f.drawdown_stop_pct = brake
    b = FuturesPaperBroker(":memory:", 1000.0, f.fee_bps, f.slippage_bps, f.leverage, f.maintenance_margin_pct)
    eng = FuturesEngine(cfg, b)
    di = {k: 0 for k in daily}; eq = []; bo_fills = 0; halted = None
    for i in range(1, len(hourly["BTC/USD"])):
        ts = hourly["BTC/USD"][i].ts
        for k in daily:
            while di[k] < len(daily[k]) and daily[k][di[k]].ts + 86400 <= ts: di[k] += 1
        r = eng.run_cycle({k: v[max(0, i - 200):i] for k, v in hourly.items()},
                          {k: daily[k][max(0, di[k] - 150):di[k]] for k in daily}, ts=ts)
        bo_fills += sum(1 for x in r.fills if x.reason.startswith("breakout"))
        eq.append((ts, r.equity, b.gross_notional({k: v[i - 1].close for k, v in hourly.items()})))
        if r.skipped and "kill" in r.skipped:
            halted = ts; break
    e = pd.DataFrame(eq, columns=["ts", "equity", "gross"])
    return e, bo_fills, halted

for label, kw in (("trend 35% only", dict(breakout=False)), ("trend 35% + breakout 2%", dict(breakout=True))):
    e, n, halted = replay(**kw)
    print(f"{label:<26} end £{e.equity.iloc[-1]:,.0f}  max DD {((e.equity / e.equity.cummax()) - 1).min() * 100:.1f}%  "
          f"peak exposure {(e.gross / e.equity).max():.2f}x  breakout fills {n}  halted {halted}")

# Closest approach to liquidation: equity at each hour's worst prices vs maintenance margin
def stress(breakout):
    cfg = Config(); cfg.mode = "futures"; cfg.market.symbols = [f"{s}/USD" for s in SYMS]
    f = cfg.futures; f.vol_target_pct = 35; f.breakout_enabled = breakout; f.breakout_risk_pct = 2.0
    f.drawdown_brake_start_pct, f.drawdown_stop_pct = 40, 50
    b = FuturesPaperBroker(":memory:", 1000.0, f.fee_bps, f.slippage_bps, f.leverage, f.maintenance_margin_pct)
    eng = FuturesEngine(cfg, b); di = {k: 0 for k in daily}
    worst_drop, worst_t, min_buffer = 0.0, None, 1e9
    for i in range(1, len(hourly["BTC/USD"]) - 1):
        ts = hourly["BTC/USD"][i].ts
        for k in daily:
            while di[k] < len(daily[k]) and daily[k][di[k]].ts + 86400 <= ts: di[k] += 1
        r = eng.run_cycle({k: v[max(0, i - 200):i] for k, v in hourly.items()},
                          {k: daily[k][max(0, di[k] - 150):di[k]] for k in daily}, ts=ts)
        pos = b.positions()
        if not pos: continue
        nxt = {k: v[i] for k, v in hourly.items()}  # the hour that follows this cycle
        worst = {s: (nxt[s].low if p.qty > 0 else nxt[s].high) for s, p in pos.items()}
        eq_now = r.equity; eq_w = b.equity({**{k: v[i - 1].close for k, v in hourly.items()}, **worst})
        drop = 1 - eq_w / eq_now
        if drop > worst_drop: worst_drop, worst_t = drop, nxt["BTC/USD"].ts
        mm = b.maintenance_margin(worst)
        min_buffer = min(min_buffer, eq_w / mm if mm else 1e9)
    return worst_drop, worst_t, min_buffer

for label, bo in (("trend only", False), ("trend + breakout", True)):
    d, t, buf = stress(bo)
    print(f"{label:<17} worst single-hour loss at the hour's worst prices: {d*100:.1f}% "
          f"({pd.Timestamp(t, unit='s', tz='UTC')}); closest to liquidation: equity was {buf:.0f}x the maintenance margin")
