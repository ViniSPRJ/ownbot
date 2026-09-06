#!/usr/bin/env python3
"""Baixa os PDFs do Scotiabank (CAD Weekly e Forecast Summary) e grava o texto integral em .txt.

A interpretacao fica com o Bot research na rotina: leia cad_weekly.txt e forecast.txt por completo
e escreva a analise. Este script so garante os dados brutos, com data e tamanho, para citacao.
"""
import datetime
import os
import sys
import urllib.request

WS = "/workspace"
URLS = {
    "cad_weekly": "https://scotiaequityresearch.com/FX/CAD_Weekly.pdf",
    "forecast": "https://scotiaequityresearch.com/FX/Forecast_Summary.pdf",
}
HEADERS = {"User-Agent": "Mozilla/5.0"}


def download(name, url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
    if not data.startswith(b"%PDF"):
        raise RuntimeError(f"resposta nao e PDF ({len(data)} bytes)")
    path = os.path.join(WS, f"{name}.pdf")
    with open(path, "wb") as f:
        f.write(data)
    return path, len(data)


def extract(path):
    import pdfplumber
    parts = []
    with pdfplumber.open(path) as pdf:
        for i, page in enumerate(pdf.pages, 1):
            parts.append(f"\n--- pagina {i} ---\n{page.extract_text() or ""}")
    return "".join(parts)


def main():
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    status = [f"# Dados brutos Scotiabank (gerado {now})", ""]
    ok = True
    for name, url in URLS.items():
        try:
            path, size = download(name, url)
            text = extract(path)
            txt = os.path.join(WS, f"{name}.txt")
            with open(txt, "w") as f:
                f.write(f"FONTE: {url}\nBAIXADO: {now}\n{text}")
            status.append(f"- {name}: OK, {size} bytes, {len(text)} caracteres em {txt}")
        except Exception as e:
            ok = False
            status.append(f"- {name}: FALHOU ({e}) fonte {url}")
    with open(os.path.join(WS, "ultimo_relatorio_macro.md"), "w") as f:
        f.write("\n".join(status) + "\n")
    print("\n".join(status))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
