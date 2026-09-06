#!/usr/bin/env python3
"""Curva de DI futuro (DI1) e FRA de cupom cambial (FRC) na B3, intraday, via cotacao.b3.com.br.

Uso: python3 /workspace/curva_di_frc.py            -> tabela texto das duas curvas
Saida: apenas vencimentos com negocio ou oferta no dia; taxa em % a.a.; var em pontos-base
sobre o ajuste anterior. Grava tambem /workspace/curva_di_frc.md com o mesmo texto.
"""
import datetime
import json
import sys
import urllib.request

API = "https://cotacao.b3.com.br/mds/api/v1/DerivativeQuotation/{}"
HEADERS = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}


def fetch(code):
    req = urllib.request.Request(API.format(code), headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def rows(payload):
    out = []
    for s in payload.get("Scty", []):
        q = s.get("SctyQtn", {})
        a = s.get("asset", {}).get("AsstSummry", {})
        last = q.get("curPrc")
        prev = q.get("prvsDayAdjstmntPric")
        bid = (s.get("buyOffer") or {}).get("price")
        ask = (s.get("sellOffer") or {}).get("price")
        if last is None and bid is None and ask is None:
            continue
        chg = None if (last is None or prev is None) else round((last - prev) * 100, 1)
        out.append((a.get("mtrtyCode", ""), s.get("symb", ""), last, prev, chg, bid, ask,
                    a.get("traddCtrctsQty"), a.get("opnCtrcts")))
    out.sort()
    return out


def table(title, data, ts):
    lines = [f"## {title} (B3 {ts})", "",
             "| venc | símbolo | último | ajuste ant. | var (bps) | bid | ask | contratos | aberto |",
             "|---|---|---|---|---|---|---|---|---|"]
    f = lambda v: "" if v is None else v
    for m, sym, last, prev, chg, bid, ask, qty, oi in data:
        lines.append(f"| {m} | {sym} | {f(last)} | {f(prev)} | {f(chg)} | {f(bid)} | {f(ask)} | {f(qty)} | {f(oi)} |")
    if len(data) == 0:
        lines.append("| sem negócios ou ofertas no momento |")
    return "\n".join(lines)


def main():
    parts = []
    ok = True
    for code, title in (("DI1", "DI futuro (DI1), % a.a."), ("FRC", "FRA de cupom cambial (FRC), % a.a.")):
        try:
            p = fetch(code)
            ts = p.get("Msg", {}).get("dtTm", "")
            parts.append(table(title, rows(p), ts))
        except Exception as e:
            ok = False
            parts.append(f"## {title}\nFALHOU: {e} ({API.format(code)})")
    text = f"# Curvas B3 lidas em {datetime.datetime.now():%Y-%m-%d %H:%M:%S}\n\n" + "\n\n".join(parts) + "\n"
    with open("/workspace/curva_di_frc.md", "w") as fh:
        fh.write(text)
    print(text)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
