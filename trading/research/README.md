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

## Small-account simulation (£1,000, 100× cross margin)

`sim.py` trades hour by hour: it rebalances at the open after each daily close, pays real funding, skips
orders under 10 and adjustments under 20% of target, and checks liquidation every hour at each position's
worst price. Nothing was liquidated at any setting. The exchange leverage only sets how little margin is
locked up: at a 30% target the account used about £4 to £11 of margin.

| Vol target | £1,000 became | Worst drawdown | Year 1 | Year 2 | Peak exposure |
|---|---|---|---|---|---|
| 25% | £1,573 | -14% | +2% | +55% | 0.9× |
| **30%** | **£1,701** | **-16%** | **+1%** | **+68%** | **1.1×** |
| 35% | £1,840 | -19% | +1% | +82% | 1.3× |
| 40% | £1,967 | -21% | +1% | +95% | 1.5× |
| 50% | £2,224 | -26% | -1% | +125% | 2.0× |

The period is 1 Nov 2024 to 25 Nov 2026. The first three months are warm-up with no positions.

**Drawdown brakes.** Shrinking positions from a 10% drawdown hurt badly: it cut size after losses and missed
the recoveries. A brake that starts at 20% and closes everything at 25% never triggered in the backtest, so
it cost nothing, and it caps the tail.

**One-year odds** from a block bootstrap of daily returns (20-day blocks, 20,000 paths), brake on:

| Vol target | Chance of hitting the 25% stop | Chance of a losing year | Median year | Bad year (5th percentile) |
|---|---|---|---|---|
| 25% | under 0.1% | 14% | +25% | -11% |
| **30%** | **2%** | **17%** | **+30%** | **-17%** |
| 35% | 4% | 20% | +32% | -20% |

The bootstrap reuses this period's returns, which included a strong trending year. Treat it as optimistic.

**More coins did not help.** Running the same rules on 6 or 11 large perps (adding XRP, DOGE, BNB, ADA,
AVAX, LINK, LTC, DOT) lowered the Sharpe from 1.15 to 0.92 and 0.56. The smaller coins whipsaw more.
See `universe.py`.

**The bot matches the research.** `validate_bot.py` replays the two years through the bot's own futures engine:
it ends at £1,724 against the simulation's £1,722, with the same 677 trades.

## Fixed-risk sizing with stop losses

`stop_sizing.py` sizes each position so hitting its stop loses a fixed share of equity, with the same entry
votes (4 of 6 agreeing), a trailing stop at 2 or 4 daily ATR checked hourly, gap fills at the open, and
100× cross margin. 2 ATR beat 4 ATR at every risk level.

| Risk per trade (2 ATR stop) | £1,000 became | Worst drawdown | Largest position |
|---|---|---|---|
| 1% (£10) | £1,336 | -10% | about 0.7× equity |
| 2% (£20) | £1,729 | -19% | |
| 5% (£50) | £3,196 | -41% | |
| 10% (£100) | £5,881 | -65% | |
| 20% (£200) | £6,476 | -90% | about 13× equity |

At £200 risk the account went from £4,690 in May 2025 to £470 in October 2025 before recovering.

Trade outcomes averaged +0.15R with a t-stat of 2.06, so the edge is real but uncertain. `stop_bootstrap.py`
resamples trades with replacement, three positions at a time, over two years:

| Risk per trade | Backtest edge: chance of falling below £100 | Half the edge | No edge |
|---|---|---|---|
| 2% | 0% | 0% | 0% |
| 5% | 0% | 0% | 0% |
| 10% | 0% | 1% | 10% |
| 20% | 2% | 23% | 69% |

With half the edge, 20% risk has a median outcome of about break-even, worse than 5% risk. Over-betting a
small, uncertain edge lowers growth as well as raising ruin risk.

## Fixed £ risk per trade

`fixed_risk.py` risks a fixed amount per trade rather than a share of equity. Average daily ranges are
3.5% (BTC), 5.4% (ETH) and 6.3% (SOL).

- **Half an ATR is too tight.** Noise hits the stops: the average trade was -0.03R. With £200 risk the
  positions reached £16,000 (16× equity), ten of twelve trades lost in one week in May 2025, and the
  account was liquidated.
- **1 ATR** averaged +0.19R and **2 ATR** +0.15R.

Resampled two-year paths, three positions at a time, 2 ATR trailing stop:

| Scheme | Wiped out (backtest edge) | Median end | Wiped out (half edge) | Median end | Wiped out (no edge) |
|---|---|---|---|---|---|
| Fixed £50 | 0% | £2,352 | 1% | £1,655 | |
| 5% of equity | 0% | £3,191 | 0% | £1,605 | 0% |
| Fixed £100 | 1% | £3,672 | 9% | £2,274 | 40% |
| £100, then £200 from £2,000 | 1% | £4,903 | 10% | £1,990 | 40% |
| Fixed £200 | 9% | £6,235 | 30% | £3,213 | 66% |

With a 1 ATR stop, fixed £200 was wiped out in 37% of paths even at the backtest edge. Ruin is concentrated
in the first months, while the fixed amount is a large share of a small account.

## Pyramiding: adding to winners

`pyramid.py` adds a unit each time price moves a set number of ATR further in our favour (checked hourly),
optionally moving the stop up behind each add (Turtle style), with unit size fixed or re-computed from equity
including open profit. `pyramid_check.py` confirms the code: in a clean synthetic trend, unlimited compounding
turns £1,000 into astronomical sums.

**On the real data, unlimited or frequent adding destroyed the account.** Every unlimited variant under
£100-then-£200 or fixed £200 sizing was wiped out, mostly between April and October 2025. Under 5% of equity
sizing, unlimited compounding finished between £9 and £1,346. The cause is that crypto trends here retraced
2 ATR or more after most adds. Each add raised the average entry, and moving the stop up turned trades that
had been +3 ATR into losses. The win rate fell from 34% to around 20%.

**A single add helped modestly.** Adding one extra unit at +2 ATR, leaving the stop to trail as before:

| 5% of equity sizing | £1,000 became | Year 1 | Year 2 | Worst drawdown | Average trade |
|---|---|---|---|---|---|
| No adding | £3,196 | +1% | +215% | -41% | +0.15R |
| One add at +2 ATR | £4,417 | -20% | +455% | -55% | +0.23R |

The result holds for adds at +1.5 to +3 ATR. But it amplifies the dependence on trending years: year one went
from flat to -20%. Resampled with half the edge, the median end was £1,731 against £1,609 without adding, with a
27% chance of losing money against 21%. It is a bigger bet on trends, not a better edge. `pyramid_gentle.py` and
`pyramid_robust.py` hold these tests.

## Monday range (mean reversion on 1-minute data)

`download_1m.py` fetches 1-minute perp candles (1,087,200 per coin, no gaps). `monday_range.py` uses Monday's
UTC high and low as a range, then from Tuesday to Sunday sells the high and buys the low, targets the other
side, flips at the target, stops a buffer beyond the range, and re-arms after price closes back inside.
Limit fills at the range edges pay 0.02%, stops 0.05% plus 0.01% slippage. If a minute touches the entry and
the stop, the stop is assumed hit. `monday_checks.py` shows the code profits on a synthetic range-bound market.

The average Monday range was 4.0% of price on BTC, 6.3% on ETH and 7.2% on SOL, and price broke out of it
in 90% to 94% of weeks.

| Stop buffer | Trades per week | Win rate | Average trade, before fees | After fees |
|---|---|---|---|---|
| $10 on BTC (same % on ETH/SOL, about 0.011%) | 35 to 46 | 0.3% to 0.5% | -1.1R to 0R | about -7R |
| 0.1% of price | 15 to 23 | 2% to 4% | -0.2R to +0.3R | -0.9R to -0.4R |
| 0.5% of price | 5 to 8 | 10% to 14% | -0.1R to +0.2R | -0.2R to +0.04R |
| 25% of the Monday range | 3 to 4 | 22% to 25% | -0.1R to +0.1R | -0.2R to 0R |

With a $10 stop, fees alone are about 7R per losing trade: a round trip costs 0.08% of the position, against
a stop 0.011% away. At £10 risk per trade the typical position was about £88,000, and every coin wiped out a
£1,000 account within its first trading week (BTC on 5 Nov 2024, after 16 trades). Wider stops lose more
slowly. Only SOL with wide stops was roughly flat, and not statistically different from zero.
`monday_money.py` holds the account figures.

## Monday range breakout (the opposite trade)

`monday_breakout.py` tests a pre-set grid of 24 variants on 1-minute data: stop at the range midpoint or the
opposite edge, exit at a 1× or 2× range target or at week end, entry buffer 0% or 10% of the range, with or
without a trend filter (trade only in the direction of the trend-ensemble score at Monday's close). At most one
long and one short per coin per week. Breakout entries pay the taker fee plus slippage.

| Variant (all three coins) | Trades | Average trade | t-stat | Year 1 | Year 2 |
|---|---|---|---|---|---|
| Opposite-edge stop, week-end exit, no filter | 440 | +0.15R | 1.93 | +0.16R | +0.14R |
| **Same, with trend filter (chosen)** | **198** | **+0.40R** | **2.92** | **+0.45R** | **+0.36R** |
| Same, with a 1× range target | 440 | -0.03R | -0.64 | | |

The chosen variant was the best on year one and held up in year two. Targets cut the winners and hurt every
variant. By coin: BTC +0.43R, ETH +0.64R, SOL +0.14R. Longs +0.55R, shorts +0.29R. Without the 10 best trades the
average falls to +0.08R, so profits come from a few big weeks.

Its weekly returns correlate 0.74 with the trend ensemble: it is mostly the same trend bet with a different entry.
`monday_breakout_eval.py` combines them:

| Weekly portfolio | £1,000 became | Worst weekly drawdown |
|---|---|---|
| Trend ensemble 35% | £1,841 | -16% |
| Trend 35% + breakout at 2% risk per trade | £5,660 | -34% |
| Trend 35% + breakout at 3% risk per trade | £8,526 | -44% |

`validate_breakout_bot.py` replays both through the bot hour by hour: £5,707, worst drawdown -43%, peak
exposure 3.2×, 399 breakout fills. The worst single hour cost 10.6% of equity, and equity never fell below
61× the maintenance margin.

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
| `sim.py` | Hour-by-hour small-account simulation with margin, liquidation and brakes |
| `risk_check.py` | Brake variants and one-year bootstrap |
| `universe.py` | 3 vs 6 vs 11 coins |
| `validate_bot.py` | Replays the data through the bot's futures engine and compares |
| `trades.py` | Replays at a chosen vol target and lists every trade, best and worst |
| `stop_sizing.py`, `stop_bootstrap.py` | Fixed-risk stop-loss sizing and its ruin odds |
| `fixed_risk.py` | Fixed £ risk, tight stops, and step-up schemes |
| `pyramid*.py` | Adding to winners: unlimited, capped and single-add variants |
| `download_1m.py`, `monday_*.py` | Monday range fade and breakout on 1-minute data |
| `validate_breakout_bot.py` | Bot replay with both strategies, and liquidation stress |
