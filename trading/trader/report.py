from __future__ import annotations

from datetime import datetime, timezone

from .broker import PaperBroker


def max_drawdown(values: list[float]) -> float:
    peak, worst = float("-inf"), 0.0
    for v in values:
        peak = max(peak, v)
        if peak > 0:
            worst = max(worst, (peak - v) / peak * 100)
    return worst


def summarize(broker: PaperBroker) -> dict:
    hist = broker.equity_history()
    trades = broker.trades()
    # A closing trade realised a gain or loss beyond its own fee. Spot buys log 0; futures opens log -fee.
    sells = [t for t in trades if t["realized_pnl"] != 0 and abs(t["realized_pnl"] + t["fee"]) > 1e-9]
    start = broker.starting_cash
    end = hist[-1]["equity"] if hist else broker.cash
    cost = 0.0
    for d in broker.recent_decisions(1_000_000):
        c = (d["payload"].get("meta") or {}).get("est_cost_usd")
        cost += c or 0.0
    return {
        "starting_cash": round(start, 2),
        "equity": round(end, 2),
        "return_pct": round((end / start - 1) * 100, 2),
        "max_drawdown_pct": round(max_drawdown([h["equity"] for h in hist]), 2),
        "trades": len(trades),
        "closing_trades": len(sells),
        "win_rate_pct": round(sum(t["realized_pnl"] > 0 for t in sells) / len(sells) * 100, 1) if sells else None,
        "realized_pnl": round(sum(t["realized_pnl"] for t in trades), 2),
        "fees_paid": round(sum(t["fee"] for t in trades), 2),
        "cycles": len(hist),
        "claude_cost_usd": round(cost, 2),
    }


def fmt_ts(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def print_table(d: dict) -> None:
    w = max(len(k) for k in d)
    for k, v in d.items():
        print(f"  {k.replace('_', ' '):<{w}}  {v}")
