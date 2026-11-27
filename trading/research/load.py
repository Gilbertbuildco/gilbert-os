import pandas as pd, numpy as np
from pathlib import Path
D = Path(__file__).resolve().parent / "data" / "clean"
D_FULL = Path(__file__).resolve().parent / "data" / "full"
SYMS = ["BTC", "ETH", "SOL"]
def load(syms=None, full=False):
    px, fund = {}, {}
    base = D_FULL if full else D
    for s in (syms or SYMS):
        df = pd.read_csv(base / f"{s}USDT_1h.csv")
        df.index = pd.to_datetime(df.ts, unit="s", utc=True)
        px[s] = df.drop(columns="ts").astype(float)
        f = pd.read_csv(base / f"{s}USDT_funding.csv")
        f.index = pd.to_datetime(f.ts, unit="s", utc=True)
        fund[s] = f.rate.astype(float)
    return px, fund
def resample(df, rule):
    return df.resample(rule, label="left", closed="left").agg({"open":"first","high":"max","low":"min","close":"last","volume":"sum","quote_volume":"sum","taker_buy_quote":"sum"}).dropna()
