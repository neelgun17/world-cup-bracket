"""Cache-busting for the static front-end.

Browsers cache /static/app.js and /static/style.css aggressively, so after a deploy a
returning visitor keeps running the old bundle until they hard-refresh. We stamp a short
content hash onto the asset URLs in index.html; the hash only changes when the files'
contents change, so caches stay valid across redeploys that don't touch the front-end and
bust automatically on the one that does.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

WEB = Path(__file__).parent.parent / "web"
_ASSETS = ("app.js", "style.css")


def asset_version() -> str:
    """A short hash of the current JS/CSS contents (stable until they change)."""
    h = hashlib.sha256()
    for name in _ASSETS:
        try:
            h.update((WEB / name).read_bytes())
        except OSError:
            pass
    return h.hexdigest()[:10]


def version_html(html: str, version: str | None = None) -> str:
    """Append ?v=<hash> to the index.html asset references (idempotent per build)."""
    v = version or asset_version()
    return (html
            .replace('/static/style.css', f'/static/style.css?v={v}')
            .replace('/static/app.js', f'/static/app.js?v={v}'))
