#!/usr/bin/env python3
"""Previsão do dólar (PTAX venda, SGS 1) a N meses, com backtest rolante e comparação com o Focus.

Modelos (todos em log do preço):
  rw          passeio aleatório: último valor; bandas por volatilidade EWMA (lambda 0.94) x sqrt(h)
  rw_drift    passeio aleatório com deriva média dos últimos 5 anos
  arima       ARIMA(p,1,q), p,q em 0..2, escolhido por AIC nos últimos 5 anos
  ets         suavização exponencial com tendência amortecida (Holt damped) nos últimos 5 anos
  focus       mediana do Boletim Focus (câmbio fim de período) na última pesquisa <= origem

Backtest: origem = último dia útil de cada mês; alvo = PTAX do último dia útil do mês M+N.
Saída: relatório markdown (stdout e arquivo) e gráfico PNG. Dados: api.bcb.gov.br (SGS) e Olinda (Focus).
"""
import argparse
import datetime as dt
import json
import math
import os
import sys
import urllib.parse
import urllib.request
import warnings

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

SGS_URL = "https://api.bcb.gov.br/dados/serie/bcdata.sgs.{code}/dados?formato=json&dataInicial={a}&dataFinal={b}"
FOCUS_URL = ("https://olinda.bcb.gov.br/olinda/servico/Expectativas/versao/v1/odata/ExpectativaMercadoMensais"
             "?$filter=Indicador eq 'Câmbio' and baseCalculo eq 0 and Data ge '{since}'"
             "&$select=Data,DataReferencia,Mediana,Media,DesvioPadrao,numeroRespondentes&$top=200000&$format=json")
Z = {80: 1.2816, 95: 1.9600}


def http_json(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def fetch_sgs(code, start_year, cache_dir):
    """Série diária do SGS em blocos anuais (a API limita janelas longas), com cache local."""
    path = os.path.join(cache_dir, f"sgs{code}.json")
    rows = {}
    if os.path.exists(path):
        rows = json.load(open(path))
    today = dt.date.today()
    first_year = start_year if not rows else max(int(k[:4]) for k in rows)  # refaz só o último ano
    for y in range(first_year, today.year + 1):
        a, b = f"01/01/{y}", f"31/12/{y}" if y < today.year else today.strftime("%d/%m/%Y")
        data = http_json(SGS_URL.format(code=code, a=a, b=b))
        if isinstance(data, list):
            for r in data:
                d = dt.datetime.strptime(r["data"], "%d/%m/%Y").date().isoformat()
                rows[d] = float(r["valor"])
    json.dump(rows, open(path, "w"))
    s = pd.Series(rows, dtype=float)
    s.index = pd.to_datetime(s.index)
    return s.sort_index()


def fetch_focus(since, cache_dir):
    path = os.path.join(cache_dir, "focus_cambio_mensal.json")
    if os.path.exists(path) and (dt.date.today() - dt.date.fromtimestamp(os.path.getmtime(path))).days < 1:
        data = json.load(open(path))
    else:
        url = FOCUS_URL.format(since=since)
        url = url.replace("$", "%24").replace(" ", "%20").replace("'", "%27").replace("â", "%C3%A2")
        data = http_json(url, timeout=180)["value"]
        json.dump(data, open(path, "w"))
    f = pd.DataFrame(data)
    f["Data"] = pd.to_datetime(f["Data"])
    f["ref"] = pd.to_datetime(f["DataReferencia"], format="%m/%Y").dt.to_period("M")
    return f.sort_values("Data")


def focus_at(focus, origin, ref_period):
    """Mediana da última pesquisa Focus publicada até a origem para o mês de referência."""
    sub = focus[(focus["Data"] <= origin) & (focus["ref"] == ref_period)]
    if sub.empty:
        return None
    return float(sub.iloc[-1]["Mediana"])


# ---------- modelos: recebem a série até a origem e o horizonte h (dias úteis); devolvem dict ----------

def ewma_vol(logret, lam=0.94):
    var = logret.iloc[0] ** 2
    for r in logret.iloc[1:]:
        var = lam * var + (1 - lam) * r * r
    return math.sqrt(var)


def bands(center_log, sigma_h):
    return {f"lo{p}": math.exp(center_log - z * sigma_h) for p, z in Z.items()} | \
           {f"hi{p}": math.exp(center_log + z * sigma_h) for p, z in Z.items()}


def model_rw(s, h):
    lp = np.log(s)
    sig = ewma_vol(lp.diff().dropna().iloc[-500:]) * math.sqrt(h)
    return {"point": float(s.iloc[-1])} | bands(lp.iloc[-1], sig)


def model_rw_drift(s, h):
    lp = np.log(s)
    rets = lp.diff().dropna()
    mu = rets.iloc[-1250:].mean()
    sig = ewma_vol(rets.iloc[-500:]) * math.sqrt(h)
    c = lp.iloc[-1] + mu * h
    return {"point": math.exp(c)} | bands(c, sig)


def model_arima(s, h):
    from statsmodels.tsa.arima.model import ARIMA
    lp = np.log(s.iloc[-1250:]).reset_index(drop=True)
    best = None
    for p in range(3):
        for q in range(3):
            try:
                fit = ARIMA(lp, order=(p, 1, q)).fit()
            except Exception:
                continue
            if best is None or fit.aic < best[0]:
                best = (fit.aic, (p, q), fit)
    fit = best[2]
    fc = fit.get_forecast(h)
    c = float(fc.predicted_mean.iloc[-1])
    se = float(fc.se_mean.iloc[-1])
    return {"point": math.exp(c), "order": best[1]} | bands(c, se)


def model_ets(s, h):
    from statsmodels.tsa.exponential_smoothing.ets import ETSModel
    lp = np.log(s.iloc[-1250:]).reset_index(drop=True)
    fit = ETSModel(lp, error="add", trend="add", damped_trend=True).fit(disp=False)
    pred = fit.get_prediction(start=len(lp), end=len(lp) + h - 1)
    sf = pred.summary_frame(alpha=0.05)
    c = float(sf["mean"].iloc[-1])
    se = float((sf["pi_upper"].iloc[-1] - sf["pi_lower"].iloc[-1]) / (2 * Z[95]))
    return {"point": math.exp(c)} | bands(c, se)


MODELS = {"rw": model_rw, "rw_drift": model_rw_drift, "arima": model_arima, "ets": model_ets}


# ---------- backtest ----------

def month_ends(s):
    return s.groupby(s.index.to_period("M")).apply(lambda x: x.index[-1])


def backtest(s, focus, months, start_year):
    ends = month_ends(s)
    periods = list(ends.index)
    rows = []
    for i, per in enumerate(periods):
        if per.year < start_year or i + months >= len(periods):
            continue
        origin, target_per = ends[per], periods[i + months]
        target_date = ends[target_per]
        # o mês alvo só conta se estiver completo (último dia útil já é fim de mês de fato)
        if target_per == periods[-1] and target_date.month == dt.date.today().month and target_date.year == dt.date.today().year:
            continue
        hist = s[:origin]
        h = int(np.busday_count(origin.date(), target_date.date()))
        actual = float(s[target_date])
        row = {"origin": origin.date(), "target": target_date.date(), "h": h, "actual": actual, "last": float(hist.iloc[-1])}
        for name, fn in MODELS.items():
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                out = fn(hist, h)
            row[name] = out["point"]
            for k in ("lo80", "hi80", "lo95", "hi95"):
                row[f"{name}_{k}"] = out[k]
        row["focus"] = focus_at(focus, origin, target_per)
        rows.append(row)
    return pd.DataFrame(rows)


def metrics(bt):
    out = []
    for name in list(MODELS) + ["focus"]:
        d = bt.dropna(subset=[name])
        err = d[name] - d["actual"]
        m = {"modelo": name, "n": len(d), "MAE": err.abs().mean(), "RMSE": math.sqrt((err ** 2).mean()),
             "MAPE%": (err.abs() / d["actual"]).mean() * 100, "viés": err.mean(),
             "acerto direção%": ((np.sign(d[name] - d["last"]) == np.sign(d["actual"] - d["last"])).mean() * 100) if name != "rw" else float("nan")}
        if name in MODELS:
            m["cobertura 80%"] = ((d["actual"] >= d[f"{name}_lo80"]) & (d["actual"] <= d[f"{name}_hi80"])).mean() * 100
            m["cobertura 95%"] = ((d["actual"] >= d[f"{name}_lo95"]) & (d["actual"] <= d[f"{name}_hi95"])).mean() * 100
        out.append(m)
    return pd.DataFrame(out)


# ---------- relatório ----------

def fmt(x, nd=4):
    return "" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x:.{nd}f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", type=int, default=3)
    ap.add_argument("--backtest-from", type=int, default=2015)
    ap.add_argument("--out", default=".")
    ap.add_argument("--cache", default=None)
    args = ap.parse_args()
    cache = args.cache or os.path.join(args.out, ".cache")
    os.makedirs(cache, exist_ok=True)

    s = fetch_sgs(1, 2009, cache)
    focus = fetch_focus(f"{args.backtest_from - 1}-06-01", cache)
    last_date, last = s.index[-1], float(s.iloc[-1])

    # previsão atual
    # alvo = o fim de mês mais próximo de "hoje + N meses", para o horizonte bater com o do backtest
    cur_per = s.index[-1].to_period("M")
    wanted = last_date + pd.DateOffset(months=args.months)
    target_per = min((cur_per + args.months - 1, cur_per + args.months),
                     key=lambda p: abs((p.to_timestamp(how="end") - wanted).days))
    target_date = (target_per.to_timestamp(how="end")).normalize()
    h = int(np.busday_count(last_date.date(), target_date.date()))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        now = {name: fn(s, h) for name, fn in MODELS.items()}
    focus_now = focus_at(focus, s.index[-1], target_per)
    focus_row = focus[(focus["ref"] == target_per)].sort_values("Data").iloc[-1] if focus_now is not None else None

    bt = backtest(s, focus, args.months, args.backtest_from)
    met = metrics(bt)
    recent = bt.tail(12)

    lines = [f"# Dólar PTAX venda: previsão a {args.months} meses", "",
             f"Gerado em {dt.datetime.now():%Y-%m-%d %H:%M}. Último dado: {last_date:%d/%m/%Y} = R$ {last:.4f} (SGS 1, BCB). "
             f"Alvo: fim de {target_per.strftime('%m/%Y')} ({h} dias úteis à frente).", "",
             "## Previsão atual", "",
             "| modelo | ponto | banda 80% | banda 95% | vs último |", "|---|---|---|---|---|"]
    for name, o in now.items():
        extra = f" ({o['order'][0]},1,{o['order'][1]})" if name == "arima" else ""
        lines.append(f"| {name}{extra} | {o['point']:.4f} | {o['lo80']:.4f} a {o['hi80']:.4f} | {o['lo95']:.4f} a {o['hi95']:.4f} | {(o['point'] / last - 1) * 100:+.2f}% |")
    if focus_now is not None:
        lines.append(f"| focus (mediana, pesquisa {focus_row['Data']:%d/%m/%Y}, {int(focus_row['numeroRespondentes'])} resp.) | {focus_now:.4f} | "
                     f"média {focus_row['Media']:.4f}, desvio {focus_row['DesvioPadrao']:.4f} | | {(focus_now / last - 1) * 100:+.2f}% |")
    lines += ["", f"## Backtest {args.backtest_from}-{bt['target'].iloc[-1].year}: origem no último dia útil de cada mês, alvo o fim do mês M+{args.months}", "",
              f"{len(bt)} previsões por modelo. Erros em R$/US$; cobertura = % dos alvos dentro da banda (ideal 80 e 95).", "",
              "| modelo | n | MAE | RMSE | MAPE% | viés | acerto direção% | cobertura 80% | cobertura 95% |", "|---|---|---|---|---|---|---|---|---|"]
    for _, m in met.iterrows():
        lines.append(f"| {m['modelo']} | {int(m['n'])} | {m['MAE']:.4f} | {m['RMSE']:.4f} | {m['MAPE%']:.2f} | {m['viés']:+.4f} | {fmt(m['acerto direção%'], 1)} | {fmt(m.get('cobertura 80%'), 1)} | {fmt(m.get('cobertura 95%'), 1)} |")
    lines += ["", "## Últimas 12 previsões do backtest (alvo realizado)", "",
              "| origem | alvo | real | rw | rw_drift | arima | ets | focus |", "|---|---|---|---|---|---|---|---|"]
    for _, r in recent.iterrows():
        lines.append(f"| {r['origin']} | {r['target']} | {r['actual']:.4f} | {r['rw']:.4f} | {r['rw_drift']:.4f} | {r['arima']:.4f} | {r['ets']:.4f} | {fmt(r['focus'])} |")
    lines += ["", "## Leitura", "",
              "- O passeio aleatório é a referência: um modelo só vale se bater MAE/RMSE dele fora da amostra. Câmbio raramente permite isso a 3 meses.",
              "- A banda de volatilidade diz mais do que o ponto: use-a para dimensionar risco, não para adivinhar nível.",
              "- Focus é a expectativa de mercado, não uma previsão calibrada; compare o viés dele com o dos modelos.",
              "- Regime: choques (2020, 2024) ficam fora das bandas de qualquer modelo; a cobertura abaixo de 80/95 mede isso."]
    report = "\n".join(lines) + "\n"
    os.makedirs(args.out, exist_ok=True)
    open(os.path.join(args.out, "fx_usdbrl_forecast.md"), "w").write(report)
    bt.to_csv(os.path.join(args.out, "fx_usdbrl_backtest.csv"), index=False)
    print(report)

    # gráfico
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(figsize=(11, 5.5))
        hist = s[s.index >= s.index[-1] - pd.DateOffset(years=2)]
        ax.plot(hist.index, hist.values, color="black", lw=1.2, label="PTAX venda")
        x1 = target_date
        colors = {"rw": "tab:blue", "rw_drift": "tab:orange", "arima": "tab:green", "ets": "tab:red"}
        for i, (name, o) in enumerate(now.items()):
            xb = x1 + pd.Timedelta(days=4 * (i - 1.5))  # barras lado a lado, não sobrepostas
            ax.plot([last_date, x1], [last, o["point"]], color=colors[name], lw=1.5, label=f"{name} {o['point']:.3f}")
            ax.plot([xb, xb], [o["lo95"], o["hi95"]], color=colors[name], lw=2, alpha=0.5)
            ax.plot([xb, xb], [o["lo80"], o["hi80"]], color=colors[name], lw=6, alpha=0.45)
        if focus_now is not None:
            ax.scatter([x1], [focus_now], marker="D", color="purple", zorder=5, label=f"focus {focus_now:.3f}")
        ax.set_title(f"USD/BRL: previsão a {args.months} meses (alvo fim de {target_per.strftime('%m/%Y')}; barra grossa = 80%, fina = 95%)")
        ax.grid(alpha=0.3)
        ax.legend(loc="upper left", fontsize=8)
        fig.autofmt_xdate()
        fig.tight_layout()
        fig.savefig(os.path.join(args.out, "fx_usdbrl_forecast.png"), dpi=120)
    except Exception as e:
        print(f"[gráfico não gerado: {e}]", file=sys.stderr)


if __name__ == "__main__":
    main()
