"""Assemble the full board payload the web UI renders. Stateless: callers pass the base
live matches plus any user overrides, and get back standings + third-place race + the
deterministic projected bracket (with the 495 explanation) in one JSON-able dict."""
from __future__ import annotations

import random
from dataclasses import dataclass

from .engine import Tournament
from .model import MatchModel
from .models import FINAL, GROUP, Match, QF, R16, R32, SF, THIRD, Team
from .rules.assignment import explain_assignment
from .rules.bracket import BRACKET_ORDER, R32_SLOTS, STAGE_OF

STAGE_ORDER = [R32, R16, QF, SF, THIRD, FINAL]
STAGE_LABEL = {R32: "Round of 32", R16: "Round of 16", QF: "Quarter-finals",
               SF: "Semi-finals", THIRD: "Third place", FINAL: "Final"}
POS_TAG = {1: "win", 2: "runner", 3: "third"}


def apply_group_overrides(base: list[Match], overrides: dict) -> list[Match]:
    """Return a copy of base group matches with user score edits/picks applied."""
    out = []
    for m in base:
        ov = overrides.get(m.id)
        score, status, minute = m.score, m.status, m.minute
        if ov:
            if ov.get("score") is not None:
                score = (int(ov["score"][0]), int(ov["score"][1]))
                status = "final"
                minute = None
            if ov.get("clear"):
                score, status, minute = None, "scheduled", None
        out.append(Match(id=m.id, stage=GROUP, group=m.group, home=m.home, away=m.away,
                         score=score, status=status, minute=minute))
    return out


def _table_rows(recs, third_qual_groups: set[str]) -> list[dict]:
    rows = []
    for i, r in enumerate(recs, 1):
        tag = POS_TAG.get(i, "out")
        if i == 3:
            tag = "third_in" if r.group in third_qual_groups else "third_out"
        rows.append({
            "pos": i, "team": r.team, "P": r.played, "W": r.won, "D": r.drawn, "L": r.lost,
            "GF": r.gf, "GA": r.ga, "GD": r.gd, "Pts": r.points, "tag": tag,
        })
    return rows


def build_board(teams: dict[str, Team], base_matches: list[Match],
                overrides: dict | None = None, ko_overrides: dict | None = None) -> dict:
    overrides = overrides or {}
    ko_overrides = {int(k): v for k, v in (ko_overrides or {}).items()}
    matches = apply_group_overrides(base_matches, overrides)
    t = Tournament(teams, matches)
    model = MatchModel(random.Random(0))

    standings = t.standings()
    # Projection gives the final group orders + 8 qualifying thirds + resolved bracket.
    res = t.project(model=model, deterministic=True, ko_overrides=ko_overrides)
    qual_groups = set(res.qualified_groups)

    groups_payload = []
    for g in sorted(standings):
        recs = standings[g]
        gmatches = [m for m in matches if m.group == g]
        groups_payload.append({
            "group": g,
            "table": _table_rows(recs, qual_groups),
            "matches": [{
                "id": m.id, "home": m.home, "away": m.away, "abbr_home": teams[m.home].abbr,
                "abbr_away": teams[m.away].abbr,
                "score": list(m.score) if m.score else None, "status": m.status, "minute": m.minute,
            } for m in gmatches],
        })

    # Third-place race from the PROJECTED final standings, so the panel, the combination
    # key, and the bracket assignment are all consistent ("what the bracket will look like").
    third_race = [{
        "pos": i + 1, "team": r.team, "group": r.group, "Pts": r.points, "GD": r.gd, "GF": r.gf,
        "qualified": i < 8,
    } for i, r in enumerate(res.third_ranking)]

    explain = explain_assignment(res.third_ranking,
                                 {g: recs[2].team for g, recs in res.group_orders.items()})

    # Bracket nodes grouped by round, with favorite probability for shading.
    rounds = {STAGE_LABEL[s]: [] for s in STAGE_ORDER}
    third_source = {s["match_no"]: s for s in explain["slots"]}
    for no in sorted(res.knockout):
        m = res.knockout[no]
        eh = t.elo.get(m.home); ea = t.elo.get(m.away)
        p_home = model.win_probs(eh, ea)[0] if eh and ea else None
        node = {
            "match_no": no, "stage": m.stage, "home": m.home, "away": m.away,
            "abbr_home": teams.get(m.home, _ph(m.home)).abbr,
            "abbr_away": teams.get(m.away, _ph(m.away)).abbr,
            "score": list(m.score) if m.score else None,
            "winner": m.winner(), "p_home": round(p_home, 3) if p_home is not None else None,
            "picked": no in ko_overrides,
        }
        if no in third_source:
            node["third_slot"] = third_source[no]
        rounds[STAGE_LABEL[m.stage]].append(node)

    # Order each round top-to-bottom in bracket order so the UI can pair/centre/connect them.
    for stage in STAGE_ORDER:
        order = {no: i for i, no in enumerate(BRACKET_ORDER[stage])}
        rounds[STAGE_LABEL[stage]].sort(key=lambda nd: order.get(nd["match_no"], 999))

    # "What did my edits change?" — diff the projected Round-of-32 (and final group orders)
    # against the no-override baseline, so the Standings page can show the bracket ripple in
    # place. Only computed when the user has actually edited a score (cheap deterministic run).
    changes = _bracket_changes(teams, base_matches, res) if overrides else None

    played = sum(1 for m in matches if m.played)
    live = sum(1 for m in matches if m.live)
    return {
        "meta": {"played": played, "total": len(matches), "live": live,
                 "champion": res.champion},
        "groups": groups_payload,
        "third_race": third_race,
        "cut_index": 8,
        "assignment": explain,
        "rounds": rounds,
        "round_order": [STAGE_LABEL[s] for s in STAGE_ORDER],
        "changes": changes,
    }


def _bracket_changes(teams: dict[str, Team], base_matches: list[Match], res) -> dict:
    """Diff the current (overridden) projection against the clean live projection."""
    base = Tournament(teams, base_matches).project(
        model=MatchModel(random.Random(0)), deterministic=True)

    def ab(name):
        return teams.get(name, _ph(name)).abbr

    r32 = []
    for no in BRACKET_ORDER[R32]:
        cur, old = res.knockout[no], base.knockout[no]
        if (cur.home, cur.away) != (old.home, old.away):
            r32.append({
                "match_no": no,
                "home": cur.home, "away": cur.away, "abbr_home": ab(cur.home), "abbr_away": ab(cur.away),
                "old_home": old.home, "old_away": old.away,
                "old_abbr_home": ab(old.home), "old_abbr_away": ab(old.away),
            })

    groups = []
    for g in sorted(res.group_orders):
        cur = [r.team for r in res.group_orders[g][:3]]
        old = [r.team for r in base.group_orders[g][:3]]
        if cur != old:
            groups.append({"group": g, "order": cur, "old": old})

    return {"r32": r32, "groups": groups}


def build_team_report(teams: dict[str, Team], base_matches: list[Match], team_name: str,
                      overrides: dict | None = None, runs: int = 6000) -> dict:
    """The 'what does my team need?' payload: a conditioned outlook plus the team's current
    group row and a coarse clinch/eliminated status (probabilistic — exact clinching also
    depends on other groups via the best-thirds cut, so we read it off the simulation)."""
    overrides = overrides or {}
    matches = apply_group_overrides(base_matches, overrides)
    t = Tournament(teams, matches)
    out = t.team_outlook(team_name, runs=runs)

    g = teams[team_name].group
    table = t.standings()[g]
    pos = next(i for i, r in enumerate(table, 1) if r.team == team_name)
    rec = table[pos - 1]
    out["current"] = {
        "pos": pos, "P": rec.played, "W": rec.won, "D": rec.drawn, "L": rec.lost,
        "GD": rec.gd, "Pts": rec.points,
    }
    out["abbr"] = teams[team_name].abbr
    out["games_left"] = len(out["remaining"])

    p = out["p_advance"]
    if p >= 99.9:
        status = "qualified"
    elif p <= 0.1:
        status = "eliminated"
    elif not out["remaining"]:
        status = "waiting"           # own games done; fate hangs on other groups (thirds cut)
    else:
        status = "alive"
    out["status"] = status
    return out


@dataclass
class _PH:
    abbr: str


def _ph(name: str) -> _PH:
    return _PH(abbr=(name[:3].upper() if name else "???"))
