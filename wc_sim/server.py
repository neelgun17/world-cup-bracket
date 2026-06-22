"""Dependency-free HTTP server (stdlib only) for the bracket visualizer.

Run:  python3 -m wc_sim.server   then open http://localhost:8000

State model: the server caches the live base matches once at startup. The browser holds the
override/pick state and sends it with each request, so the server stays stateless and the
bracket recomputes instantly on every pick.
"""
from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .api import apply_group_overrides, build_board
from .engine import Tournament
from .ingest import cache_state, fetch_group_matches, load_cached, load_teams

WEB = Path(__file__).parent.parent / "web"
CACHE = Path(__file__).parent / "data" / "state_cache.json"

TEAMS = load_teams()
try:
    BASE = fetch_group_matches(TEAMS)
    cache_state(BASE, CACHE)
    print(f"[server] live state fetched: {sum(1 for m in BASE if m.played)}/{len(BASE)} played")
except Exception as e:  # noqa: BLE001
    print(f"[server] live fetch failed ({e}); using cache")
    BASE = load_cached(TEAMS, CACHE)

CONTENT_TYPES = {".html": "text/html", ".js": "application/javascript", ".css": "text/css"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quieter logs
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _static(self, name):
        path = WEB / name
        if not path.is_file():
            return self._send(404, "not found", "text/plain")
        ctype = CONTENT_TYPES.get(path.suffix, "application/octet-stream")
        self._send(200, path.read_bytes(), ctype)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            return self._static("index.html")
        if self.path.startswith("/static/"):
            return self._static(self.path[len("/static/"):])
        if self.path == "/api/board":
            return self._send(200, json.dumps(build_board(TEAMS, BASE)))
        return self._send(404, "not found", "text/plain")

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def do_POST(self):
        body = self._body()
        overrides = body.get("overrides", {})
        ko = body.get("ko_overrides", {})
        if self.path == "/api/board":
            return self._send(200, json.dumps(build_board(TEAMS, BASE, overrides, ko)))
        if self.path == "/api/montecarlo":
            runs = int(body.get("runs", 5000))
            matches = apply_group_overrides(BASE, overrides)
            t = Tournament(TEAMS, matches)
            return self._send(200, json.dumps(t.monte_carlo(runs=runs, seed=1)))
        return self._send(404, "not found", "text/plain")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"[server] http://localhost:{port}  (Ctrl-C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[server] bye")


if __name__ == "__main__":
    main()
