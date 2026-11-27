"""Replay the real two years of hourly data through the bot's FuturesEngine and compare with sim.py.

Both use the same fixed funding rate so the comparison isolates the trading logic."""
import sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))
from sim import *
from trader.config import Config
from trader.futures import FuturesPaperBroker
from trader.futures_engine import FuturesEngine
from trader.models import Candle

RATE = 0.00005  # 0.005% per 8h
px, fund = load()
const_fund = {s: pd.Series(np.where(px[s].index.hour % 8 == 0, RATE, 0.0), index=px[s].index) for s in SYMS}
cv, ex = simulate(px, const_fund, port_vol=0.30, dd_start=0.20, dd_limit=0.25, band=0.20, min_order=10.0)
print("research sim:", summary(cv, ex))

cfg = Config(); cfg.mode = "futures"; cfg.market.symbols = [f"{s}/USD" for s in SYMS]
cfg.futures.funding_rate_8h_pct = RATE * 100
broker = FuturesPaperBroker(":memory:", 1000.0, cfg.futures.fee_bps, cfg.futures.slippage_bps,
                            cfg.futures.leverage, cfg.futures.maintenance_margin_pct)
eng = FuturesEngine(cfg, broker)
hourly = {f"{s}/USD": [Candle(int(t.timestamp()), float(r.open), float(r.high), float(r.low), float(r.close), float(r.volume)) for t, r in px[s].iterrows()] for s in SYMS}
daily = {}
for s in SYMS:
    d = resample(px[s], "1D")
    daily[f"{s}/USD"] = [Candle(int(t.timestamp()), float(r.open), float(r.high), float(r.low), float(r.close), float(r.volume)) for t, r in d.iterrows()]
n = len(hourly["BTC/USD"]); di = {k: 0 for k in daily}
eq_curve = []
for i in range(1, n):
    ts = hourly["BTC/USD"][i].ts  # cycle at the start of hour i: hours < i are closed
    h = {k: v[max(0, i - 2):i] for k, v in hourly.items()}
    for k in daily:
        while di[k] < len(daily[k]) and daily[k][di[k]].ts + 86400 <= ts:
            di[k] += 1
    d = {k: daily[k][max(0, di[k] - 150):di[k]] for k in daily}
    r = eng.run_cycle(h, d, ts=ts)
    eq_curve.append((ts, r.equity))
    if r.skipped and "kill" in r.skipped:
        print("halted:", r.skipped); break
e = pd.Series({pd.Timestamp(t, unit="s", tz="UTC"): v for t, v in eq_curve})
dd = (e / e.cummax() - 1).min()
trades = broker.trades()
print(f"bot engine:   end {e.iloc[-1]:.0f}  ret {(e.iloc[-1] / 1000 - 1) * 100:.1f}%  maxDD {dd * 100:.1f}%  trades {len(trades)}  "
      f"fees {sum(t['fee'] for t in trades):.0f}  funding {broker.funding_paid():.0f}")
both = pd.DataFrame({"sim": cv.resample("1D").last(), "bot": e.resample("1D").last()}).dropna()
print("max daily equity gap between sim and bot:", round((both.sim / both.bot - 1).abs().max() * 100, 2), "%")
