import shutil
from pathlib import Path

import yaml

from trader.__main__ import main
from trader.config import load_config

EXAMPLE = Path(__file__).resolve().parents[1] / "config.example.yaml"


def write_cfg(tmp_path, **market):
    data = yaml.safe_load(EXAMPLE.read_text())
    data["market"].update({"source": "synthetic", **market})
    data["strategy"]["name"] = "sma_cross"
    p = tmp_path / "config.yaml"
    p.write_text(yaml.safe_dump(data))
    return p


def test_example_config_loads():
    cfg = load_config(EXAMPLE)
    assert cfg.strategy.claude.model == "claude-opus-5-5"


def test_cli_run_status_report_stop(tmp_path, capsys):
    p = str(write_cfg(tmp_path))
    main(["-c", p, "run", "--once"])
    main(["-c", p, "status"])
    main(["-c", p, "report", "--decisions", "1"])
    main(["-c", p, "stop"])
    main(["-c", p, "run", "--once"])
    out = capsys.readouterr().out
    assert "kill switch" in out.lower()
    main(["-c", p, "resume"])
    main(["-c", p, "flatten"])
    main(["-c", p, "backtest", "--candles", "600"])
    assert (tmp_path / "data" / "paper.db").exists()


def test_claude_backtest_needs_confirmation(tmp_path):
    import pytest

    p = write_cfg(tmp_path)
    with pytest.raises(SystemExit):
        main(["-c", str(p), "backtest", "--strategy", "claude"])


def test_futures_cli(tmp_path, capsys):
    data = yaml.safe_load((EXAMPLE.parent / "config.futures.example.yaml").read_text())
    data["market"]["source"] = "synthetic"
    p = tmp_path / "config.yaml"
    p.write_text(yaml.safe_dump(data))
    main(["-c", str(p), "run", "--once"])
    main(["-c", str(p), "status"])
    main(["-c", str(p), "report"])
    main(["-c", str(p), "flatten"])
    main(["-c", str(p), "resume"])
    out = capsys.readouterr().out
    assert "Paper futures" in out and "exposure" in out
