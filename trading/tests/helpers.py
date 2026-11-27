import json
from types import SimpleNamespace

from trader.config import Config
from trader.models import Candle, Decision
from trader.strategies.base import Strategy


def config(**risk) -> Config:
    cfg = Config()
    cfg.market.symbols = ["BTC/USD", "ETH/USD"]
    cfg.execution.fee_bps = 0
    cfg.execution.slippage_bps = 0
    for k, v in risk.items():
        setattr(cfg.risk, k, v)
    return cfg


def candles(price: float, n: int = 60, step: int = 3600, end: int = 1_800_000_000) -> list[Candle]:
    return [Candle(end - (n - 1 - i) * step, price, price, price, price, 1) for i in range(n)]


class Fixed(Strategy):
    """Returns whatever targets it is given, and records what it was shown."""

    name = "fixed"

    def __init__(self, targets):
        self.targets = targets
        self.seen = []

    def decide(self, ctx):
        self.seen.append(ctx)
        return Decision(targets=dict(self.targets), summary="fixed")


class Boom(Strategy):
    name = "boom"

    def decide(self, ctx):
        raise RuntimeError("bug")


def fake_response(plan=None, stop_reason="end_turn", text=None):
    body = text if text is not None else json.dumps(plan)
    return SimpleNamespace(
        stop_reason=stop_reason,
        model="claude-opus-5-5",
        content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=body)],
        usage=SimpleNamespace(input_tokens=5000, output_tokens=1000),
    )


class FakeClient:
    def __init__(self, response=None, error=None):
        self.response, self.error, self.calls = response, error, []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.response
