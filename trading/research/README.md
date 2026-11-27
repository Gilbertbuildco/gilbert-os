# Strategy research: BTC, ETH, SOL perpetual futures

Data: Binance USDT-margined perpetuals, hourly candles and funding rates, 1 Nov 2024 to 25 Nov 2026.
`python download.py` fetches and checksum-verifies it into `data/` (not committed).

Every backtest decides on a bar's close and trades on the next bar. It charges 0.07% per side
(0.05% taker fee plus 0.02% slippage) and pays or receives real funding. `lookahead_check.py` proves the
timing: a signal that peeks at tomorrow looks spectacular, and a random signal loses its costs.

## What the market did

| | BTC | ETH | SOL |
|---|---|---|---|
| Two-year return | -13% | -33% | -58% |
| Annualised volatility | 44% | 69% | 76% |
| Worst drawdown | -53% | -68% | -76% |
| Beta to BTC | 1.0 | 1.3 | 1.4 |
| Average funding, per year | +5.1% | +4.7% | +1.0% |

BTC peaked at $124.6k on 6 Oct 2025, fell to $58.6k by June 2026, rallied in Q3 and is back near $60k.
Daily returns correlate at about 0.8, so the three coins are close to one bet.

## Patterns tested

| Pattern | Result |
|---|---|
| 7 to 14 day momentum | **Persists.** Coins up over the past 1 to 2 weeks kept rising more often than not. |
| 4h RSI above 75 | Continuation, not reversal. Overbought kept going. |
| Short-term mean reversion | Nothing usable on 1h, 4h or daily. |
| BTC leading ETH and SOL hour to hour | No. Correlation of BTC's hour with the next alt hour is about zero. |
| Funding extremes | No consistent link to the next 3 days. |
| Day of week, hour of day | Thursdays weak for all three, but likely chance given the number of tests. |
| Cross-sectional rotation (long strongest, short weakest) | Worked in year one, failed in year two. Rejected. |

## Strategy families, tuned on year one, judged on year two

Year one is Nov 2024 to Oct 2025, a choppy bull market. Year two is Nov 2025 to Nov 2026, mostly a bear market.

| Strategy | 2-year return | Year 1 | Year 2 | Sharpe | Worst drawdown |
|---|---|---|---|---|---|
| Buy and hold, equal weight | -56% | +4% | -57% | -0.42 | -67% |
| Long above / short below 50-day average | +130% | +10% | +110% | 1.28 | -26% |
| 14-day momentum, long and short | +125% | -8% | +145% | 1.25 | -29% |
| Donchian 30/15 breakout | +54% | -15% | +80% | 0.83 | -26% |
| **Trend ensemble (chosen)** | **+89%** | **-2%** | **+92%** | **1.20** | **-21%** |
| Same signal, long only | small | | | 0.5 or less | |

Fast signals (under 10 days) lose to fees and whipsaws. The short side earned most of the profit.
Filters that did not help: following BTC's trend for alts, a choppiness filter, requiring strong
agreement, and a 3 ATR trailing stop on 4h bars.

## The chosen strategy: trend ensemble

**Universe:** BTC, ETH and SOL perpetual futures. Long or short, never more than one direction per coin.

**Once a day**, for each coin, take six votes:

1. Price above or below its 20-day simple moving average
2. Price above or below its 50-day simple moving average
3. Price above or below its 100-day simple moving average
4. Sign of the 14-day return
5. Sign of the 28-day return
6. Sign of the 56-day return

Each vote is +1 or -1. The **score** is their average, from -1 (all bearish) to +1 (all bullish).

**Position size** = score × risk budget ÷ the coin's 20-day realised volatility. Each coin gets an
equal share of a portfolio volatility target, so SOL gets a smaller notional than BTC for the same score.
Total exposure is capped at 3× equity.

**Rebalance** daily to the new targets. No stop-losses: an opposing trend flips the votes.

### How much leverage

Leverage here means total position size divided by account equity. It comes out of the volatility
target, not a fixed number.

| Volatility target | 2-year return | Worst drawdown | Average leverage | Peak leverage |
|---|---|---|---|---|
| 15% | +32% | -9% | 0.2× | 0.6× |
| **30% (recommended start)** | **+69%** | **-17%** | **0.4×** | **1.2×** |
| 45% | +111% | -25% | 0.6× | 1.8× |
| 60% | +155% | -32% | 0.8× | 2.4× |
| 90% | +242% | -44% | 1.2× | 3.0× |

The worst moves in the data were a 31% 4-hour wick on SOL, 28% on ETH and 13% on BTC. A position at
3× isolated margin or higher would have been liquidated by those wicks. Use cross margin and keep
account-level leverage under 2×. Never set the exchange to 10× or more.

### Robustness checks

- 40 to 60 day moving averages all work. The result does not hinge on one setting.
- Doubling costs to 0.14% per side keeps a Sharpe of 1.09. Tripling gives 0.99.
- Moving the daily decision time across the day gives Sharpe 1.2 to 1.5. Midnight UTC, used above, is the worst.

## Caveats

- **Two years is short, and year two was a strong trend.** In the choppy year the strategy roughly
  broke even. Expect long flat or losing stretches: 12 of 25 months were winners.
- The first three months are warm-up for the 100-day average, so year one has nine trading months.
- Backtest fills are perfect. Real futures add queueing, partial fills and occasional exchange outages.
- In the UK, the FCA bans selling crypto derivatives to retail customers. Paper trading is fine.
  Real money would need a venue that can legally serve you.

## Files

| Script | Purpose |
|---|---|
| `download.py` | Fetch and verify the data |
| `load.py`, `bt.py` | Data loading and the futures backtester |
| `lookahead_check.py` | Timing sanity checks |
| `patterns.py` | Pattern statistics |
| `grid.py` | Strategy family grid, year one vs year two |
| `ensemble.py` | Ensemble variants and filters |
| `final.py`, `hours.py` | Sizing, costs, stress and decision-time tests for the chosen strategy |
