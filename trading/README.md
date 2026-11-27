# Gilbert paper trader

A crypto trading bot that runs on a **simulated (paper) account** with live market prices.
Claude makes the trading decisions; hard risk limits in code keep it inside the lines.

There is no exchange account, no exchange API key, and no code path that can place a real order.
Market data comes from Kraken's public price feed, which needs no login.

## How it works

Every candle (hourly by default) the bot runs one cycle:

1. **Fetch** the latest closed candles for each symbol from Kraken.
2. **Decide.** Claude receives the account, positions, indicators (moving averages, RSI, ATR,
   volatility, recent closes), its last trades, its last few decisions and the notes it wrote to
   itself. It answers with a target allocation per symbol (or "hold") as strict JSON.
3. **Apply hard limits.** The risk manager caps each position, caps total exposure, enforces the
   stop-loss, blocks buys after the daily loss limit, and limits trades per day. Claude cannot
   override any of this.
4. **Trade** on the paper broker. Fills include fees and slippage.
5. **Journal** every decision, Claude's reasoning, every trade and the equity curve in SQLite.

If the Claude API fails, Claude declines, or its answer is unreadable, the bot holds for that cycle.
Server-side refusal fallbacks are switched on, so a declined request is retried on a fallback model
inside the same call.

## Quick start

```bash
cd trading
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
cp config.example.yaml config.yaml          # edit symbols, limits, interval
export ANTHROPIC_API_KEY=sk-ant-...         # only needed for the Claude strategy

python -m trader run --once                 # one cycle, to check everything works
python -m trader run                        # keep going, one cycle per candle
```

To try it with no API key and no network, set `market.source: synthetic` and
`strategy.name: sma_cross` in `config.yaml`.

## Futures mode: the researched trend strategy

`config.futures.example.yaml` runs a paper perpetual-futures account with the strategy from
[`research/`](research/README.md): long or short BTC, ETH and SOL depending on six daily trend votes,
sized by volatility.

```bash
cp config.futures.example.yaml config.yaml
python -m trader run            # checks hourly, rebalances once after each daily close (00:00 UTC)
python -m trader status         # positions, exposure, margin, drawdown
```

- **Position size comes from `vol_target_pct`** and `breakout_risk_pct`, not the leverage setting. With the
  defaults, the two-year replay turned £1,000 into £5,707, with a worst drawdown of 43% and peak exposure of
  3.2× equity. The trend strategy alone made £1,867 with a 19.5% drawdown.
- **100× cross margin** only means very little margin is locked up. The bot checks every hour whether the
  worst price since the last check would have liquidated the account.
- **Monday range breakout** (`breakout_enabled`, on by default): Monday's UTC high and low set the week's
  range. From Tuesday, the bot buys a break above the high or sells a break below the low, only in the trend's
  direction, with the stop at the other side of the range and an exit at the end of the week. Each trade risks
  `breakout_risk_pct` (2%) of equity.
- **Drawdown brake:** from a 40% drawdown positions shrink, and at 50% everything is closed and trading stops.
  `python -m trader resume` restarts it, measuring drawdown from that point.
- **Funding** is approximated at 0.005% per 8 hours: longs pay it and shorts receive it.
- **Optional Claude overseer** (`overseer: claude`): once a day Claude reviews the targets and may shrink or
  close positions. The engine prevents it from opening, growing or flipping anything. If the call fails, the
  rules stand.
- Prices come from Kraken spot, a close proxy for perpetual prices.

## Commands

| Command | What it does |
|---|---|
| `python -m trader run` | Trade continuously, one cycle per candle. `--once` runs a single cycle. |
| `python -m trader status` | Positions, cash, return, and Claude's latest view and notes. |
| `python -m trader report` | Return, drawdown, win rate, fees, Claude API cost, trade log. `--decisions 10` adds recent decisions. |
| `python -m trader backtest` | Replay a strategy over past candles. `--data synthetic\|csv\|kraken`, `--strategy sma_cross\|claude`. |
| `python -m trader download` | Save Kraken candles to CSV for backtests. Run it regularly to build history. |
| `python -m trader stop` / `resume` | Kill switch. While on, the bot records prices but makes no trades. |
| `python -m trader flatten` | Sell every position now. |
| `python -m trader reset --yes` | Wipe the paper account and start again. |

## Risk limits (config.yaml)

| Setting | Default | Effect |
|---|---|---|
| `max_position_pct` | 40 | No single coin above 40% of equity. |
| `max_total_exposure_pct` | 90 | At least 10% always stays in cash. |
| `stop_loss_pct` | 10 | Any position 10% below its average cost is sold. |
| `max_daily_loss_pct` | 5 | After a 5% loss on the UTC day, only sells are allowed until tomorrow. |
| `max_trades_per_day` | 20 | Stop-loss exits don't count. |

## Cost

The Claude strategy makes one API call per cycle. Each request is about 3,500 input tokens.
Output depends on the `effort` setting. At `medium` on Claude Opus 5.5 expect very roughly
3 to 8 US cents per cycle, so about $1 to $2 a day on hourly candles. `python -m trader report`
shows the actual running cost. Shorter candles mean more calls and higher cost.

## Running it 24/7

The bot needs a machine that stays on: your own computer, a Raspberry Pi, or a small VPS.

```bash
nohup python -m trader run > trader.log 2>&1 &      # simple
# or cron, one cycle per hour:
# 1 * * * * cd /path/to/gilbert-os/trading && .venv/bin/python -m trader run --once >> trader.log 2>&1
```

## A word on results

Paper results flatter real trading: fills here are instant and complete, and there is no queue or
partial fill. Synthetic-data backtests show only that the code works, not that a strategy has an edge.
Judge Claude against the `sma_cross` baseline and against simply holding, over weeks, not days.

## Layout

```
trader/
  config.py          config loading and validation
  data.py            Kraken, CSV and synthetic candle feeds
  indicators.py      SMA, EMA, RSI, ATR, volatility, prompt snapshot
  broker.py          paper broker and SQLite journal
  risk.py            hard risk limits
  engine.py          one trading cycle
  backtest.py        historical replay with buy-and-hold benchmark
  report.py          performance summary
  strategies/
    claude_trader.py Claude as portfolio manager
    sma_cross.py     moving-average baseline
tests/               pytest suite, no network or API key needed
```
