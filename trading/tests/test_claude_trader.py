import anthropic
import httpx2

from trader.broker import PaperBroker
from trader.engine import Engine
from trader.strategies.claude_trader import ClaudeTrader, output_schema
from helpers import FakeClient, candles, config, fake_response

TS = 1_800_000_000
PLAN = {
    "market_view": "BTC trending up, ETH weak.",
    "decisions": [
        {"symbol": "BTC/USD", "action": "target", "target_pct": 35, "confidence": 0.7, "reasoning": "uptrend"},
        {"symbol": "ETH/USD", "action": "hold", "target_pct": 0, "confidence": 0.4, "reasoning": "unclear"},
    ],
    "notes_for_next_time": "Watch BTC 105.",
}


def run(client, plan_cycles=1):
    cfg = config()
    b = PaperBroker(":memory:", 10_000, 0, 0)
    e = Engine(cfg, b, ClaudeTrader(cfg, client=client))
    data = {"BTC/USD": candles(100), "ETH/USD": candles(10)}
    results = [e.run_cycle(data, ts=TS + i * 3600) for i in range(plan_cycles)]
    return b, results


def test_plan_is_executed_and_request_is_well_formed():
    client = FakeClient(fake_response(PLAN))
    b, (r,) = run(client)
    assert b.positions()["BTC/USD"].qty * 100 == 3_500
    assert "ETH/USD" not in b.positions()
    assert r.decision.notes == "Watch BTC 105."
    assert r.decision.meta["est_cost_usd"] == round((5000 * 4 + 1000 * 20) / 1e6, 4)
    call = client.calls[0]
    assert call["model"] == "claude-opus-5-5"
    assert call["fallbacks"] == "default"
    assert call["output_config"]["format"]["schema"]["properties"]["decisions"]["items"]["properties"]["symbol"][
        "enum"] == ["BTC/USD", "ETH/USD"]
    assert "thinking" not in call  # always on for this model; effort controls depth


def test_notes_are_fed_back_next_cycle():
    client = FakeClient(fake_response(PLAN))
    run(client, plan_cycles=2)
    second = client.calls[1]["messages"][0]["content"]
    assert "Watch BTC 105." in second
    assert '"positions":[{"symbol":"BTC/USD"' in second


def test_refusal_and_bad_json_and_api_errors_hold():
    for resp in (fake_response(PLAN, stop_reason="refusal"), fake_response(PLAN, stop_reason="max_tokens"),
                 fake_response(text="not json"), fake_response({"market_view": "x"})):
        b, (r,) = run(FakeClient(resp))
        assert r.fills == [] and not b.positions(), r.decision.summary
    err = anthropic.APIConnectionError(request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))
    b, (r,) = run(FakeClient(error=err))
    assert r.fills == [] and "API error" in r.decision.summary


def test_claude_cannot_exceed_limits():
    plan = {**PLAN, "decisions": [
        {"symbol": "BTC/USD", "action": "target", "target_pct": 400, "confidence": 1, "reasoning": "all in"},
        {"symbol": "ETH/USD", "action": "target", "target_pct": 400, "confidence": 1, "reasoning": "all in"},
        {"symbol": "DOGE/USD", "action": "target", "target_pct": 50, "confidence": 1, "reasoning": "not allowed"},
    ]}
    b, (r,) = run(FakeClient(fake_response(plan)))
    assert (10_000 - b.cash) <= 10_000 * 0.90 + 1e-6
    assert all(p.qty * (100 if s == "BTC/USD" else 10) <= 4_000 + 1e-6 for s, p in b.positions().items())
    assert "DOGE/USD" not in b.positions()


def test_schema_is_strict():
    s = output_schema(["BTC/USD"])
    assert s["additionalProperties"] is False
    assert s["properties"]["decisions"]["items"]["additionalProperties"] is False
