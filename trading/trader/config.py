from __future__ import annotations

from dataclasses import dataclass, field, fields, is_dataclass
from pathlib import Path

import yaml


@dataclass
class AccountConfig:
    starting_cash: float = 10_000.0
    db_path: str = "data/paper.db"


@dataclass
class MarketConfig:
    source: str = "kraken"
    symbols: list[str] = field(default_factory=lambda: ["BTC/USD", "ETH/USD", "SOL/USD"])
    interval_minutes: int = 60
    lookback: int = 200
    csv_dir: str = "data/csv"


@dataclass
class ExecutionConfig:
    fee_bps: float = 26.0
    slippage_bps: float = 5.0
    min_trade_usd: float = 25.0
    rebalance_threshold_pct: float = 2.0


@dataclass
class RiskConfig:
    max_position_pct: float = 40.0
    max_total_exposure_pct: float = 90.0
    max_daily_loss_pct: float = 5.0
    max_trades_per_day: int = 20
    stop_loss_pct: float = 10.0


@dataclass
class SmaCrossConfig:
    fast: int = 20
    slow: int = 50
    allocation_pct: float = 30.0


@dataclass
class ClaudeConfig:
    model: str = "claude-opus-5-5"
    effort: str = "medium"
    max_tokens: int = 16_000
    history_decisions: int = 6


@dataclass
class FuturesConfig:
    leverage: float = 100.0              # exchange leverage setting; only sets margin locked, not risk
    maintenance_margin_pct: float = 0.5
    fee_bps: float = 5.0                 # taker fee on notional
    slippage_bps: float = 2.0
    funding_rate_8h_pct: float = 0.005   # paper approximation: longs pay, shorts receive
    vol_target_pct: float = 30.0         # portfolio volatility target; this is what sets position size
    max_gross_leverage: float = 3.0      # hard cap on total notional / equity
    rebalance_band_pct: float = 20.0     # skip adjustments smaller than this share of the target
    min_order: float = 10.0
    drawdown_brake_start_pct: float = 20.0
    drawdown_stop_pct: float = 25.0
    overseer: str = "off"                # off | claude (Claude may only shrink or close positions)
    breakout_enabled: bool = False       # Monday range breakout strategy alongside the trend strategy
    breakout_risk_pct: float = 2.0       # equity lost if a breakout trade hits its stop


@dataclass
class StrategyConfig:
    name: str = "claude"
    sma_cross: SmaCrossConfig = field(default_factory=SmaCrossConfig)
    claude: ClaudeConfig = field(default_factory=ClaudeConfig)


@dataclass
class Config:
    mode: str = "spot"
    account: AccountConfig = field(default_factory=AccountConfig)
    market: MarketConfig = field(default_factory=MarketConfig)
    execution: ExecutionConfig = field(default_factory=ExecutionConfig)
    risk: RiskConfig = field(default_factory=RiskConfig)
    strategy: StrategyConfig = field(default_factory=StrategyConfig)
    futures: FuturesConfig = field(default_factory=FuturesConfig)
    base_dir: Path = field(default_factory=Path.cwd)

    def path(self, p: str) -> Path:
        """Resolve a config path relative to the config file's directory."""
        q = Path(p)
        return q if q.is_absolute() else self.base_dir / q

    @property
    def kill_switch_path(self) -> Path:
        return self.path(self.account.db_path).parent / "STOP"


def _build(cls, data: dict | None):
    data = data or {}
    known = {f.name: f for f in fields(cls)}
    unknown = set(data) - set(known)
    if unknown:
        raise ValueError(f"Unknown config keys for {cls.__name__}: {sorted(unknown)}")
    kwargs = {}
    for name, value in data.items():
        ftype = known[name].type
        sub = _SECTIONS.get(ftype) if isinstance(ftype, str) else (ftype if is_dataclass(ftype) else None)
        kwargs[name] = _build(sub, value) if sub else value
    return cls(**kwargs)


_SECTIONS = {
    "AccountConfig": AccountConfig,
    "MarketConfig": MarketConfig,
    "ExecutionConfig": ExecutionConfig,
    "RiskConfig": RiskConfig,
    "SmaCrossConfig": SmaCrossConfig,
    "ClaudeConfig": ClaudeConfig,
    "StrategyConfig": StrategyConfig,
    "FuturesConfig": FuturesConfig,
}


def load_config(path: str | Path | None) -> Config:
    if path is None:
        return Config()
    p = Path(path)
    data = yaml.safe_load(p.read_text()) or {}
    cfg = _build(Config, data)
    cfg.base_dir = p.resolve().parent
    validate(cfg)
    return cfg


def validate(cfg: Config) -> None:
    r = cfg.risk
    for name in ("max_position_pct", "max_total_exposure_pct"):
        v = getattr(r, name)
        if not 0 <= v <= 100:
            raise ValueError(f"risk.{name} must be between 0 and 100, got {v}")
    if cfg.market.source not in ("kraken", "synthetic", "csv"):
        raise ValueError(f"market.source must be kraken, synthetic or csv, got {cfg.market.source!r}")
    if cfg.mode not in ("spot", "futures"):
        raise ValueError(f"mode must be spot or futures, got {cfg.mode!r}")
    f = cfg.futures
    if f.overseer is False:  # YAML reads a bare `off` as false
        f.overseer = "off"
    if f.overseer not in ("off", "claude"):
        raise ValueError(f"futures.overseer must be off or claude, got {f.overseer!r}")
    if not 0 < f.drawdown_brake_start_pct < f.drawdown_stop_pct <= 100:
        raise ValueError("futures needs 0 < drawdown_brake_start_pct < drawdown_stop_pct <= 100")
    if f.leverage < 1 or f.max_gross_leverage <= 0:
        raise ValueError("futures.leverage must be >= 1 and max_gross_leverage > 0")
    if cfg.strategy.name not in ("claude", "sma_cross"):
        raise ValueError(f"strategy.name must be claude or sma_cross, got {cfg.strategy.name!r}")
    for s in cfg.market.symbols:
        if s.count("/") != 1:
            raise ValueError(f"Symbols look like BTC/USD, got {s!r}")
