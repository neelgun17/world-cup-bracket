"""Live current-state ingest from ESPN's public (keyless) FIFA World Cup API.

Primary source: site.api.espn.com scoreboard over the group-stage date range. Per-match
results are needed (not just aggregate standings) because the 2026 head-to-head tiebreaker
depends on individual scores. A manual-override layer lets any match be edited.
"""
from __future__ import annotations

import json
import urllib.request
from pathlib import Path
from typing import Optional

from .models import GROUP, Match, Team

ESPN_SCOREBOARD = (
    "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard"
    "?dates=20260611-20260627&limit=200"
)
DATA = Path(__file__).parent / "data"


def load_teams() -> dict[str, Team]:
    raw = json.loads((DATA / "teams.json").read_text())
    # Seed FIFA-rank tiebreaker from Elo order (best Elo = rank 1) as a reasonable proxy.
    order = sorted(raw, key=lambda t: -t["elo"])
    rank = {t["name"]: i + 1 for i, t in enumerate(order)}
    return {
        t["name"]: Team(
            name=t["name"], abbr=t["abbr"], group=t["group"], elo=float(t["elo"]),
            code=t.get("code"), fifa_rank=rank[t["name"]],
        )
        for t in raw
    }


def _http_json(url: str, timeout: float = 8.0) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "wc-bracket-sim/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _status_of(desc: str, detail: str) -> str:
    d = f"{desc} {detail}".lower()
    if any(k in d for k in ("full time", "ft", "final", "aet", "pens")):
        return "final"
    if any(k in d for k in ("scheduled", "postponed", "delayed", "pre")):
        return "scheduled"
    return "in_progress"


def _minute_of(comp: dict) -> Optional[int]:
    clock = (comp.get("status") or {}).get("displayClock") or ""
    digits = "".join(ch for ch in clock.split("+")[0] if ch.isdigit())
    return int(digits) if digits else None


def fetch_group_matches(teams: dict[str, Team], url: str = ESPN_SCOREBOARD) -> list[Match]:
    """Return the 72 group-stage matches with current scores/status from ESPN."""
    data = _http_json(url)
    matches: list[Match] = []
    for ev in data.get("events", []):
        comp = ev["competitions"][0]
        st = comp.get("status", {}).get("type", {})
        status = _status_of(st.get("description", ""), st.get("detail", ""))
        sides = {c.get("homeAway"): c for c in comp["competitors"]}
        home_c, away_c = sides.get("home"), sides.get("away")
        if not home_c or not away_c:
            continue
        home = home_c["team"]["displayName"]
        away = away_c["team"]["displayName"]
        if home not in teams or away not in teams:
            continue  # not a group-stage participant pairing we track
        group = teams[home].group if teams[home].group == teams[away].group else None
        score = None
        if status in ("final", "in_progress"):
            try:
                score = (int(home_c.get("score")), int(away_c.get("score")))
            except (TypeError, ValueError):
                score = None
        matches.append(Match(
            id=ev.get("id", f"{home}-{away}"), stage=GROUP, group=group,
            home=home, away=away, score=score, status=status,
            minute=_minute_of(comp) if status == "in_progress" else None,
        ))
    return matches


def apply_overrides(matches: list[Match], overrides: dict[str, dict]) -> list[Match]:
    """Apply manual edits keyed by match id: {id: {"score":[h,a], "status":"final"}}."""
    by_id = {m.id: m for m in matches}
    for mid, ov in overrides.items():
        m = by_id.get(mid)
        if not m:
            continue
        if "score" in ov and ov["score"] is not None:
            m.score = (int(ov["score"][0]), int(ov["score"][1]))
        if "status" in ov:
            m.status = ov["status"]
        if "minute" in ov:
            m.minute = ov["minute"]
    return matches


def cache_state(matches: list[Match], path: Path) -> None:
    path.write_text(json.dumps([
        {"id": m.id, "group": m.group, "home": m.home, "away": m.away,
         "score": list(m.score) if m.score else None, "status": m.status, "minute": m.minute}
        for m in matches
    ], indent=2))


def load_cached(teams: dict[str, Team], path: Path) -> list[Match]:
    raw = json.loads(path.read_text())
    return [
        Match(id=d["id"], stage=GROUP, group=d.get("group"), home=d["home"], away=d["away"],
              score=tuple(d["score"]) if d.get("score") else None,
              status=d.get("status", "scheduled"), minute=d.get("minute"))
        for d in raw
    ]
