"""CLI sanity driver: pull live state, print standings, the third-place race, the resolved
R32 (with the 495 explanation), and the most-likely bracket. Run: python3 -m wc_sim.cli"""
from __future__ import annotations

import sys
from pathlib import Path

from .engine import Tournament
from .ingest import (cache_state, fetch_group_matches, load_cached, load_teams)
from .models import FINAL, QF, R16, R32, SF, THIRD
from .rules.assignment import explain_assignment

CACHE = Path(__file__).parent / "data" / "state_cache.json"
STAGE_NAME = {R32: "Round of 32", R16: "Round of 16", QF: "Quarter-final", SF: "Semi-final",
              THIRD: "Third place", FINAL: "Final"}


def get_matches(teams, offline: bool):
    if offline and CACHE.exists():
        print("(using cached state)\n")
        return load_cached(teams, CACHE)
    try:
        matches = fetch_group_matches(teams)
        cache_state(matches, CACHE)
        return matches
    except Exception as e:  # noqa: BLE001
        print(f"[live fetch failed: {e}; falling back to cache]\n")
        return load_cached(teams, CACHE)


def main():
    offline = "--offline" in sys.argv
    teams = load_teams()
    matches = get_matches(teams, offline)
    played = sum(1 for m in matches if m.played)
    print(f"Loaded {len(teams)} teams, {len(matches)} group matches ({played} played).\n")

    t = Tournament(teams, matches)

    print("=== CURRENT GROUP STANDINGS ===")
    for g, recs in sorted(t.standings().items()):
        print(f"Group {g}:")
        for i, r in enumerate(recs, 1):
            tag = "  ←1st" if i == 1 else "  ←2nd" if i == 2 else "  (3rd)" if i == 3 else ""
            print(f"  {i}. {r.team:<16} P{r.played} {r.points}pts  GD{r.gd:+d} GF{r.gf}{tag}")
    print()

    snap = t.third_place_snapshot()
    print("=== THIRD-PLACE RACE (live) ===")
    for i, r in enumerate(snap["ranked"], 1):
        line = "  ---- top 8 cut ----" if i == 9 else ""
        mark = "✓" if i <= 8 else "✗"
        print(f"  {i:>2}. {mark} {r.team:<16} (Grp {r.group}) {r.points}pts GD{r.gd:+d}{line}")
    print()

    print("=== MOST-LIKELY PROJECTION (favorite advances) ===")
    res = t.project(deterministic=True)
    exp = explain_assignment(res.third_ranking, {g: recs[2].team for g, recs in res.group_orders.items()})
    print(f"Qualifying thirds: groups {','.join(exp['qualified_groups'])}  (combination {exp['combination_key']})")
    if exp["cut_team"]:
        print(f"Just missed: {exp['cut_team']}")
    print("\nThird-place slot assignments (the confusing part, resolved):")
    for s in exp["slots"]:
        print(f"  M{s['match_no']}: 1{s['winner_group']} vs 3rd[{s['source_group']}] = {s['team']}")
    print("\nRound of 32:")
    for no in sorted(res.knockout):
        if res.knockout[no].stage != R32:
            continue
        m = res.knockout[no]
        print(f"  M{no}: {m.home} {m.score[0]}-{m.score[1]} {m.away}  → {m.winner()}")
    print(f"\nProjected champion: {res.champion}")
    print(f"Final: {res.knockout[104].home} vs {res.knockout[104].away}")


if __name__ == "__main__":
    main()
