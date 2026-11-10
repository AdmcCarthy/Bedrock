"""Screenshot every published page into site/shots/*.webp with headless Chrome (light and dark), serving site/ locally.

Usage: uv run --project ../geology-map-processing python scripts/shots.py [--port 8790]
"""

from __future__ import annotations

import argparse
import http.server
import json
import os
import socketserver
import subprocess
import threading
import time
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
CHROME = [r"C:\Program Files\Google\Chrome\Application\chrome.exe", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
          "/usr/bin/google-chrome", "/usr/bin/chromium"]


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".webp": "image/webp", ".topojson": "application/json", ".json": "application/json", ".js": "text/javascript", ".css": "text/css"}

    def log_message(self, *a):
        pass


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8790)
    a = ap.parse_args()
    chrome = next((c for c in CHROME if Path(c).exists()), None)
    if not chrome:
        raise SystemExit("no Chrome or Edge found")
    man = json.loads((SITE / "manifest.json").read_text(encoding="utf-8"))
    out = SITE / "shots"
    out.mkdir(exist_ok=True)
    os.chdir(SITE)
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(("127.0.0.1", a.port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    pages = [(f"geology_{r}", f"geology.html?r={r}&shade=0.9") for r in man["geology"]] + [(f"s2s_{r}", f"s2s.html?r={r}&rivers=flow&fold=3") for r in man["s2s"]]
    try:
        for theme in ("light", "dark"):
            for name, q in pages:
                png = out / f"{name}{'' if theme == 'light' else '_dark'}.png"
                t = time.time()
                subprocess.run([chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1400,1000", "--virtual-time-budget=25000",
                                f"--screenshot={png}", f"http://127.0.0.1:{a.port}/{q}&theme={theme}"], check=True, capture_output=True, timeout=180)
                webp = png.with_suffix(".webp")
                Image.open(png).convert("RGB").save(webp, "WEBP", quality=82, method=6)
                png.unlink()
                print(f"{webp.name}: {webp.stat().st_size // 1000} kB in {time.time() - t:.0f}s")
    finally:
        srv.shutdown()


if __name__ == "__main__":
    main()
