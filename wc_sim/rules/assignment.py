"""Resolve the eight best 3rd-placed teams into their Round-of-32 slots.

This is the genuinely confusing part of the 2026 format. FIFA publishes a fixed
495-row table (one row per choice of which 8 of the 12 groups send a third through).
Each row says: the slot hosted by group X's winner draws the third-placed team from
some group Y. We resolve that AND explain it in plain English — the project's core value.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from ..models import TeamRecord

_TABLE_PATH = Path(__file__).parent.parent / "data" / "third_place_table.json"

# The eight R32 slots that host a third-placed team, keyed by the WINNER's group,
# with the allowed source groups (from the R32 skeleton) for display.
SLOT_ALLOWED = {
    "E": "A/B/C/D/F", "I": "C/D/F/G/H", "A": "C/E/F/H/I", "L": "E/H/I/J/K",
    "D": "B/E/F/I/J", "G": "A/E/H/I/J", "B": "E/F/G/I/J", "K": "D/E/I/J/L",
}
# Slot winner-group -> the R32 match number it belongs to.
SLOT_MATCH = {"E": 74, "I": 77, "A": 79, "L": 80, "D": 81, "G": 82, "B": 85, "K": 87}


@lru_cache(maxsize=1)
def _table() -> dict:
    return json.loads(_TABLE_PATH.read_text())


def assign_thirds(qualified_groups: list[str]) -> dict[str, str]:
    """Given the 8 groups that qualified a 3rd-placed team, return {slot_winner_group: source_group}.

    e.g. {"E":"A", ...} means the slot hosted by Group E's winner (Match 74) draws Group A's 3rd.
    """
    if len(qualified_groups) != 8:
        raise ValueError(f"Need exactly 8 qualified third-place groups, got {len(qualified_groups)}")
    key = "".join(sorted(qualified_groups))
    mapping = _table().get(key)
    if mapping is None:
        raise KeyError(f"No 495-table row for combination {key}")
    return mapping


def explain_assignment(
    ranked_thirds: list[TeamRecord],
    third_team_of_group: dict[str, str],
) -> dict:
    """Produce a fully resolved + explained assignment for the UI.

    ranked_thirds: all twelve 3rd-placed TeamRecords, already ranked best->worst (each
                   carries its .group). third_team_of_group: {group: team_name}.

    Returns the qualifying groups, the combination key, and per-slot detail (which actual
    team fills each slot and a one-line human-readable 'why').
    """
    qualifiers = ranked_thirds[:8]
    qualified_groups = sorted(r.group for r in qualifiers)
    mapping = assign_thirds(qualified_groups)
    cut_team = ranked_thirds[8].team if len(ranked_thirds) > 8 else None

    slots = []
    for winner_group, source_group in sorted(mapping.items(), key=lambda kv: SLOT_MATCH[kv[0]]):
        team = third_team_of_group.get(source_group, f"3rd of {source_group}")
        slots.append({
            "match_no": SLOT_MATCH[winner_group],
            "winner_group": winner_group,           # e.g. "E"
            "allowed": SLOT_ALLOWED[winner_group],  # e.g. "A/B/C/D/F"
            "source_group": source_group,           # e.g. "A"
            "team": team,                           # resolved actual team
            "why": (
                f"Slot 1{winner_group} (Match {SLOT_MATCH[winner_group]}) can face a third "
                f"from {SLOT_ALLOWED[winner_group]}; with groups "
                f"{','.join(qualified_groups)} sending a third through, the table assigns it "
                f"Group {source_group}'s third → {team}."
            ),
        })

    return {
        "qualified_groups": qualified_groups,
        "combination_key": "".join(qualified_groups),
        "cut_team": cut_team,
        "slots": slots,
    }
