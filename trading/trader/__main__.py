"""Command line for the paper-trading bot.  Run `python -m trader --help`."""
from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

from .broker import PaperBroker
from .futures import FuturesPaperBroker
from .config import load_config
from .data import CSVFeed, FeedError, KrakenFeed, make_feed, save_csv, synthetic_series
from .engine import Engine
from .report import fmt_ts, print_table, summarize
from .strategies import make_strategy

log = logging.getLogger("trader")


def _config(args):
    path = Path(args.config)
    if not path.exists():
        sys.exit(f"Config {path} not found. Copy config.example.yaml to config.yaml first.")
    return load_config(path)


def _broker(cfg) -> PaperBroker:
    if cfg.mode == "futures":
        f = cfg.futures
        return FuturesPaperBroker(cfg.path(cfg.account.db_path), cfg.account.starting_cash, f.fee_bps,
                                  f.slippage_bps, f.leverage, f.maintenance_margin_pct)
    return PaperBroker(cfg.path(cfg.account.db_path), cfg.account.starting_cash,
                       cfg.execution.fee_bps, cfg.execution.slippage_bps)


def _print_cycle(res) -> None:
    print(f"\n=== {fmt_ts(res.ts)}  equity {res.equity:,.2f}")
    if res.skipped:
        print(f"  skipped: {res.skipped}")
        return
    d = res.decision
    if d.summary:
        print(f"  view: {d.summary}")
    for s, why in d.reasoning.items():
        print(f"  {s}: {why}")
    for n in res.risk_notes:
        print(f"  risk: {n}")
    for f in res.fills:
        pnl = f"  pnl {f.realized_pnl:+,.2f}" if f.side == "sell" else ""
        print(f"  FILL {f.side} {f.qty:.8g} {f.symbol} @ {f.price:,.6g}  fee {f.fee:.2f}{pnl}  ({f.reason})")
    if not res.fills:
        print("  no trades")
    if d.meta.get("est_cost_usd") is not None:
        print(f"  claude: {d.meta.get('input_tokens')} in / {d.meta.get('output_tokens')} out tokens, "
              f"~${d.meta['est_cost_usd']}")


def _futures_feeds(cfg):
    from .data import SyntheticFeed
    if cfg.market.source == "kraken":
        return KrakenFeed(60), KrakenFeed(1440)
    if cfg.market.source == "synthetic":
        return SyntheticFeed(60), SyntheticFeed(1440)
    sys.exit("Futures mode supports market.source kraken or synthetic.")


def _print_futures_cycle(res, broker) -> None:
    print(f"\n=== {fmt_ts(res.ts)}  equity {res.equity:,.2f}  drawdown {res.drawdown_pct:.1f}%")
    if res.skipped:
        print(f"  skipped: {res.skipped}")
        return
    if res.decision:
        for s, why in res.decision.reasoning.items():
            print(f"  {s}: {why}")
        if res.decision.meta.get("overseer"):
            print(f"  overseer: {res.decision.meta['overseer']}")
    for n in res.notes:
        print(f"  note: {n}")
    for f in res.fills:
        print(f"  FILL {f.side} {f.qty:.8g} {f.symbol} @ {f.price:,.6g}  fee {f.fee:.2f}  pnl {f.realized_pnl:+,.2f}  ({f.reason})")
    if not res.rebalanced and not res.fills:
        print("  hourly check: no action")


def cmd_run_futures(args, cfg) -> None:
    from .futures_engine import FuturesEngine
    from .strategies.overseer import ClaudeOverseer

    broker = _broker(cfg)
    overseer = ClaudeOverseer(cfg) if cfg.futures.overseer == "claude" else None
    engine = FuturesEngine(cfg, broker, overseer=overseer, kill_switch_path=cfg.kill_switch_path)
    hourly_feed, daily_feed = _futures_feeds(cfg)
    f = cfg.futures
    print(f"Paper futures: {', '.join(cfg.market.symbols)}, trend ensemble, vol target {f.vol_target_pct}%, "
          f"{f.leverage:g}x cross margin, brake from {f.drawdown_brake_start_pct}% drawdown, stop at "
          f"{f.drawdown_stop_pct}%, overseer {f.overseer}, Monday breakout "
          f"{'on at ' + str(f.breakout_risk_pct) + '% risk' if f.breakout_enabled else 'off'}. Checks hourly, rebalances after each daily close. Ctrl+C to stop.")
    while True:
        hourly, daily = {}, {}
        for s in cfg.market.symbols:
            try:
                hourly[s] = hourly_feed.candles(s, 200)  # a week of candles for the Monday range
                daily[s] = daily_feed.candles(s, 150)
            except FeedError as e:
                log.error("%s", e)
        _print_futures_cycle(engine.run_cycle(hourly, daily), broker)
        if args.once:
            return
        wait = 3600 - time.time() % 3600 + 20
        try:
            time.sleep(wait)
        except KeyboardInterrupt:
            print("\nStopped.")
            return


def cmd_run(args) -> None:
    cfg = _config(args)
    if cfg.mode == "futures":
        return cmd_run_futures(args, cfg)
    broker = _broker(cfg)
    engine = Engine(cfg, broker, make_strategy(cfg), kill_switch_path=cfg.kill_switch_path)
    feed = make_feed(cfg)
    step = cfg.market.interval_minutes * 60
    print(f"Paper trading {', '.join(cfg.market.symbols)} every {cfg.market.interval_minutes} min with "
          f"strategy '{cfg.strategy.name}' on {cfg.market.source} data. Ctrl+C to stop.")
    while True:
        candles = {}
        for s in cfg.market.symbols:
            try:
                candles[s] = feed.candles(s, cfg.market.lookback)
            except FeedError as e:
                log.error("%s", e)
        if candles:
            _print_cycle(engine.run_cycle(candles))
        else:
            print("No market data this cycle, will retry.")
        if args.once:
            return
        wait = step - time.time() % step + 20  # just after the next candle closes
        print(f"  next cycle in {wait / 60:.1f} min")
        try:
            time.sleep(wait)
        except KeyboardInterrupt:
            print("\nStopped.")
            return


def cmd_status(args) -> None:
    cfg = _config(args)
    b = _broker(cfg)
    prices = b.last_prices()
    eq = b.equity(prices)
    print(f"Equity {eq:,.2f}  cash {b.cash:,.2f}  start {b.starting_cash:,.2f}  "
          f"return {(eq / b.starting_cash - 1) * 100:+.2f}%  (prices from last cycle)")
    if cfg.kill_switch_path.exists():
        print("KILL SWITCH ON: the bot is not trading. `python -m trader resume` to turn it off.")
    for s, p in b.positions().items():
        px = prices.get(s, p.avg_price)
        side = "LONG " if p.qty > 0 else "SHORT"
        print(f"  {s:<10} {side} qty {abs(p.qty):.8g}  entry {p.avg_price:,.6g}  last {px:,.6g}  "
              f"notional {abs(p.qty) * px:,.2f}  pnl {(px / p.avg_price - 1) * 100 * (1 if p.qty > 0 else -1):+.2f}%")
    if cfg.mode == "futures":
        peak = float(b.get_meta("peak_equity", eq))
        gross = b.gross_notional(prices)
        print(f"  exposure {gross / eq if eq else 0:.2f}x equity, margin used {b.initial_margin(prices):,.2f} at "
              f"{cfg.futures.leverage:g}x, drawdown {(1 - eq / peak) * 100 if peak else 0:.1f}% from peak {peak:,.2f}, "
              f"funding paid {b.funding_paid():+,.2f}")
    last = b.recent_decisions(1)
    if last:
        d = last[0]
        print(f"\nLast decision {fmt_ts(d['ts'])}: {d['summary']}")
        if d["notes"]:
            print(f"Notes to self: {d['notes']}")


def cmd_report(args) -> None:
    cfg = _config(args)
    b = _broker(cfg)
    print_table(summarize(b))
    trades = b.trades(limit=args.trades)
    if trades:
        print(f"\nLast {len(trades)} trades:")
        for t in trades:
            pnl = f" pnl {t['realized_pnl']:+,.2f}" if t["side"] == "sell" else ""
            print(f"  {fmt_ts(t['ts'])}  {t['side']:<4} {t['qty']:.8g} {t['symbol']} @ {t['price']:,.6g}{pnl}  "
                  f"({t['reason']})")
    if args.decisions:
        print(f"\nLast {args.decisions} decisions:")
        for d in b.recent_decisions(args.decisions):
            print(f"  {fmt_ts(d['ts'])}  {d['summary']}")
            for n in d["payload"].get("risk_notes", []):
                print(f"      risk: {n}")


def cmd_backtest(args) -> None:
    from .backtest import run_backtest

    cfg = _config(args)
    if cfg.mode == "futures":
        sys.exit("Futures backtests live in research/: see research/README.md (sim.py, validate_bot.py).")
    if args.strategy:
        cfg.strategy.name = args.strategy
    if cfg.strategy.name == "claude" and not args.yes:
        sys.exit("Backtesting the Claude strategy makes one API call per candle and costs real money. "
                 "Re-run with --yes to confirm, or use --strategy sma_cross.")
    source = args.data or cfg.market.source
    n = args.candles
    if source == "synthetic":
        history = {s: synthetic_series(s, n, cfg.market.interval_minutes, seed=args.seed) for s in cfg.market.symbols}
    elif source == "csv":
        feed = CSVFeed(cfg.path(cfg.market.csv_dir))
        history = {s: feed.load(s)[-n:] for s in cfg.market.symbols}
    else:
        feed = KrakenFeed(cfg.market.interval_minutes)
        history = {s: feed.candles(s, n) for s in cfg.market.symbols}  # Kraken returns at most 720
    strat = make_strategy(cfg)
    print(f"Backtesting '{cfg.strategy.name}' on {source} data, {n} candles of {cfg.market.interval_minutes} min...")
    print_table(run_backtest(cfg, history, strat))


def cmd_download(args) -> None:
    cfg = _config(args)
    feed = KrakenFeed(cfg.market.interval_minutes)
    out = cfg.path(cfg.market.csv_dir)
    for s in cfg.market.symbols:
        candles = feed.candles(s, 10_000)
        csv = CSVFeed(out)
        existing = csv.load(s) if csv.path(s).exists() else []
        merged = {c.ts: c for c in existing + candles}
        save_csv(sorted(merged.values(), key=lambda c: c.ts), csv.path(s))
        print(f"{s}: {len(merged)} candles in {csv.path(s)}")


def cmd_flatten(args) -> None:
    cfg = _config(args)
    b = _broker(cfg)
    feed = make_feed(cfg)
    ts = int(time.time())
    for s, p in b.positions().items():
        try:
            px = feed.candles(s, 1)[-1].close
        except (FeedError, IndexError):
            px = b.last_prices().get(s, p.avg_price)
        if cfg.mode == "futures":
            f = b.trade(s, -p.qty * px, px, ts, "manual flatten")
        else:
            f = b.sell(s, p.qty, px, ts, "manual flatten")
        print(f"Sold {f.qty:.8g} {s} @ {f.price:,.6g}  pnl {f.realized_pnl:+,.2f}")
    print(f"Cash {b.cash:,.2f}")


def cmd_stop(args) -> None:
    cfg = _config(args)
    cfg.kill_switch_path.parent.mkdir(parents=True, exist_ok=True)
    cfg.kill_switch_path.write_text(f"stopped at {time.ctime()}\n")
    print(f"Kill switch on ({cfg.kill_switch_path}). The bot will skip trading until `resume`.")


def cmd_resume(args) -> None:
    cfg = _config(args)
    cfg.kill_switch_path.unlink(missing_ok=True)
    if cfg.mode == "futures":
        _broker(cfg).set_meta("peak_equity", None)
        print("Kill switch off. Drawdown is now measured from current equity.")
        return
    print("Kill switch off.")


def cmd_reset(args) -> None:
    cfg = _config(args)
    if not args.yes:
        sys.exit("This wipes the paper account, its trades and Claude's notes. Re-run with --yes.")
    _broker(cfg).reset(cfg.account.starting_cash)
    print(f"Paper account reset to {cfg.account.starting_cash:,.2f}.")


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="trader", description="Paper-trading bot (simulated money only).")
    p.add_argument("-c", "--config", default="config.yaml")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="trade on the paper account, one cycle per candle")
    r.add_argument("--once", action="store_true", help="run a single cycle and exit (for cron)")
    r.set_defaults(fn=cmd_run)
    sub.add_parser("status", help="positions, cash and Claude's latest notes").set_defaults(fn=cmd_status)
    rp = sub.add_parser("report", help="performance summary and trade log")
    rp.add_argument("--trades", type=int, default=20)
    rp.add_argument("--decisions", type=int, default=0)
    rp.set_defaults(fn=cmd_report)
    bt = sub.add_parser("backtest", help="replay a strategy over past candles")
    bt.add_argument("--strategy", choices=["sma_cross", "claude"])
    bt.add_argument("--data", choices=["synthetic", "csv", "kraken"])
    bt.add_argument("--candles", type=int, default=2000)
    bt.add_argument("--seed", type=int, default=7)
    bt.add_argument("--yes", action="store_true", help="confirm a paid Claude backtest")
    bt.set_defaults(fn=cmd_backtest)
    sub.add_parser("download", help="save Kraken candles to CSV for backtests").set_defaults(fn=cmd_download)
    sub.add_parser("flatten", help="sell every position now").set_defaults(fn=cmd_flatten)
    sub.add_parser("stop", help="kill switch: stop trading").set_defaults(fn=cmd_stop)
    sub.add_parser("resume", help="turn the kill switch off").set_defaults(fn=cmd_resume)
    rs = sub.add_parser("reset", help="wipe the paper account")
    rs.add_argument("--yes", action="store_true")
    rs.set_defaults(fn=cmd_reset)

    args = p.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    args.fn(args)


if __name__ == "__main__":
    main()
