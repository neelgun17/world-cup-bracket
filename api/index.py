"""Vercel serverless entrypoint for the bracket visualizer.

Mirrors `wc_sim.server`'s JSON API (the rules engine is unchanged) but as a single
stateless function, and additionally:
  * serves the SPA HTML for `/` with per-bracket Open Graph meta tags injected, so a
    shared `?s=…` link unfurls into a rich preview card; and
  * renders that preview card on demand at `/api/og` (a 1200×630 PNG of the bracket's
    projected champion + finalists for the link's encoded picks).

Live ESPN state is fetched once per warm container and cached in a module global; if
the fetch fails it falls back to the bundled seed snapshot so the app always renders.
"""
import base64
import html
import json
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler
from io import BytesIO
from pathlib import Path

# api/index.py lives one level below the repo root; put the root on sys.path so
# `import wc_sim` resolves inside the lambda bundle.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from wc_sim.api import apply_group_overrides, build_board, build_team_report
from wc_sim.assets import version_html
from wc_sim.engine import Tournament
from wc_sim.ingest import fetch_group_matches, load_cached, load_teams

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "wc_sim" / "data" / "state_seed.json"
# Stamp a content hash onto the JS/CSS URLs so a deploy that changes them busts the cache.
INDEX_HTML = version_html((ROOT / "web" / "index.html").read_text())

_TEAMS = None
_BASE = None
# Memoized default-view Monte Carlo, keyed by run count. The unedited bracket auto-fires an
# identical simulation for every cold visitor, so under a traffic spike this serves it from a
# warm container instead of re-running the same 5k-sim tournament thousands of times. Valid for
# the container's lifetime because _BASE is fetched once and never mutated.
_MC_CACHE: dict = {}


def _state():
    """Lazily load teams + base live matches, cached for the container's lifetime."""
    global _TEAMS, _BASE
    if _TEAMS is None:
        _TEAMS = load_teams()
    if _BASE is None:
        try:
            _BASE = fetch_group_matches(_TEAMS)
        except Exception:  # noqa: BLE001 - any network/parse failure -> bundled snapshot
            _BASE = load_cached(_TEAMS, SEED)
    return _TEAMS, _BASE


# ---- shared-bracket token (mirror of web/app.js encodeShare) --------------------
def _decode_share(token):
    """token -> (overrides, ko_overrides, team). Empty/garbage decodes to no picks."""
    if not token:
        return {}, {}, None
    try:
        b64 = token.replace("-", "+").replace("_", "/")
        b64 += "=" * (-len(b64) % 4)
        payload = json.loads(base64.b64decode(b64).decode("utf-8"))
        overrides = {k: {"score": v} for k, v in (payload.get("o") or {}).items()}
        return overrides, (payload.get("k") or {}), payload.get("t")
    except Exception:  # noqa: BLE001
        return {}, {}, None


def _board_for(token):
    teams, base = _state()
    overrides, ko, _team = _decode_share(token)
    return build_board(teams, base, overrides, ko)


# ---- Open Graph -----------------------------------------------------------------
def _og_meta(base_url, token, board):
    m = board["meta"]
    champ, played, total = m["champion"], m["played"], m["total"]
    img = f"{base_url}/api/og" + (f"?s={token}" if token else "")
    url = f"{base_url}/" + (f"?s={token}" if token else "")
    title = "My World Cup 2026 Bracket" if token else "World Cup 2026 — Live Bracket Visualizer"
    desc = (f"{champ} projected to win · {played}/{total} group games in. "
            f"The confusing 2026 bracket, resolved to real teams and explained.")
    e = html.escape
    tags = [
        ('meta', 'property', 'og:type', 'website'),
        ('meta', 'property', 'og:site_name', 'World Cup 2026 Bracket'),
        ('meta', 'property', 'og:title', title),
        ('meta', 'property', 'og:description', desc),
        ('meta', 'property', 'og:image', img),
        ('meta', 'property', 'og:image:width', '1200'),
        ('meta', 'property', 'og:image:height', '630'),
        ('meta', 'property', 'og:url', url),
        ('meta', 'name', 'twitter:card', 'summary_large_image'),
        ('meta', 'name', 'twitter:title', title),
        ('meta', 'name', 'twitter:description', desc),
        ('meta', 'name', 'twitter:image', img),
    ]
    return "\n  ".join(f'<{t} {k}="{a}" content="{e(v, quote=True)}">' for t, k, a, v in tags)


def _og_png(board):
    """Render the 1200×630 preview card. Lazy Pillow import (only needed on this path)."""
    from PIL import Image, ImageDraw, ImageFont

    W, H = 1200, 630
    GOLD, TXT, DIM, BG, PANEL = (227, 179, 65), (230, 237, 243), (139, 152, 165), (11, 15, 20), (18, 25, 34)
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    fnt = ImageFont.load_default

    def center(text, y, size, fill):
        f = fnt(size=size)
        w = d.textlength(text, font=f)
        d.text(((W - w) / 2, y), text, font=f, fill=fill)

    d.rectangle([0, 0, W, 8], fill=GOLD)
    d.text((60, 46), "WORLD CUP 2026", font=fnt(size=46), fill=GOLD)
    d.text((62, 104), "MY BRACKET  ·  LIVE VISUALIZER", font=fnt(size=22), fill=DIM)

    champ = board["meta"]["champion"] or "—"
    center("PROJECTED CHAMPION", 210, 26, DIM)
    center(champ.upper(), 250, 92, GOLD)

    fin = (board["rounds"].get("Final") or [{}])[0]
    if fin.get("home"):
        center(f"Final:  {fin['home']}  vs  {fin['away']}", 392, 34, TXT)
    semis = []
    for n in board["rounds"].get("Semi-finals") or []:
        semis += [n["home"], n["away"]]
    if semis:
        center("Semifinalists:  " + "   ·   ".join(semis), 450, 24, DIM)
    center(f"{board['meta']['played']}/{board['meta']['total']} group games played", 510, 24, DIM)

    d.rectangle([0, H - 66, W, H], fill=PANEL)
    center("world-cup-bracket-tau.vercel.app", H - 48, 24, GOLD)

    buf = BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


# ---- JSON API -------------------------------------------------------------------
def _route(method, path, body):
    teams, base = _state()
    overrides = body.get("overrides", {})
    ko = body.get("ko_overrides", {})

    if path == "/api/board":
        return 200, build_board(teams, base, overrides, ko)
    if method == "POST" and path == "/api/montecarlo":
        runs = max(500, min(int(body.get("runs", 5000)), 20000))
        default_view = not overrides and not ko
        if default_view and runs in _MC_CACHE:
            return 200, _MC_CACHE[runs]
        t = Tournament(teams, apply_group_overrides(base, overrides))
        result = t.monte_carlo(runs=runs, seed=1, ko_overrides=ko)
        if default_view:
            _MC_CACHE[runs] = result
        return 200, result
    if method == "POST" and path == "/api/team":
        team = body.get("team")
        if team not in teams:
            return 400, {"error": "unknown team"}
        try:
            runs = int(body.get("runs", 6000))
        except (TypeError, ValueError):
            runs = 6000
        runs = max(500, min(runs, 20000))
        return 200, build_team_report(teams, base, team, overrides, runs)
    return 404, {"error": "not found"}


def _token(raw_path):
    if "?" not in raw_path:
        return None
    return (urllib.parse.parse_qs(raw_path.split("?", 1)[1]).get("s") or [None])[0]


class handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # keep function logs quiet
        pass

    def _base_url(self):
        proto = self.headers.get("x-forwarded-proto", "https")
        host = (self.headers.get("x-forwarded-host") or self.headers.get("Host")
                or "world-cup-bracket-tau.vercel.app")
        return f"{proto}://{host}"

    def _raw(self, code, data, ctype, cache=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if cache:
            self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(data)

    def _send(self, code, payload):
        self._raw(code, json.dumps(payload).encode(), "application/json")

    def _serve_og(self, token):
        try:
            png = _og_png(_board_for(token))
        except Exception:  # noqa: BLE001 - never hand a scraper a broken image
            try:
                png = _og_png(_board_for(None))
            except Exception:  # noqa: BLE001
                return self._raw(500, b"og render failed", "text/plain")
        self._raw(200, png, "image/png", cache="public, max-age=300")

    def _serve_html(self, token):
        try:
            meta = _og_meta(self._base_url(), token, _board_for(token))
        except Exception:  # noqa: BLE001 - HTML must still render without meta
            meta = ""
        body = INDEX_HTML.replace("<!--OG-->", meta).encode()
        self._raw(200, body, "text/html; charset=utf-8", cache="public, max-age=60")

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/og":
            return self._serve_og(_token(self.path))
        if path.startswith("/api/"):
            try:
                code, payload = _route("GET", path, {})
            except Exception as e:  # noqa: BLE001
                code, payload = 500, {"error": str(e)}
            return self._send(code, payload)
        # Everything else is the single-page app (hash-routed) — serve HTML with OG meta.
        return self._serve_html(_token(self.path))

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            code, payload = _route("POST", self.path.split("?", 1)[0], body)
        except Exception as e:  # noqa: BLE001
            code, payload = 500, {"error": str(e)}
        self._send(code, payload)
