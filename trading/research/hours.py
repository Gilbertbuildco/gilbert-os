import sys; from pathlib import Path; sys.argv[1:] = sys.argv[1:] or [str(Path(__file__).resolve().parent)]; sys.path.insert(0, sys.argv[1])
exec(open(sys.argv[1] + "/final.py").read().split('print("== Portfolio')[0])
for h in (0, 4, 8, 12, 16, 20):
    w = strat_weights(c, hour=h)
    s_ = stats(run(w, c, fb)); first = w.dropna(how="all").index[0]
    print(f"decide at {h:02d}:00 UTC: ret {s_['ret%']}%  sharpe {s_['sharpe']}  maxDD {s_['maxdd%']}%  (first weights at {first})")
