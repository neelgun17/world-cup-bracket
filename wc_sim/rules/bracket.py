"""The 2026 knockout bracket: structure (matches 73-104) and resolution into concrete matchups.

Structure is taken verbatim from the official bracket (Wikipedia "2026 FIFA World Cup
knockout stage"), so the who-plays-who progression is authoritative, not guessed.
"""
from __future__ import annotations

from ..models import FINAL, QF, R16, R32, SF, THIRD, Match

# --- Round of 32 (matches 73-88) -------------------------------------------------
# Tokens: "1A"/"2A" = winner/runner-up of group A; "T:E" = the third-placed team
# assigned to the slot hosted by Group E's winner (resolved via the 495 table).
R32_SLOTS: dict[int, tuple[str, str]] = {
    73: ("2A", "2B"),
    74: ("1E", "T:E"),
    75: ("1F", "2C"),
    76: ("1C", "2F"),
    77: ("1I", "T:I"),
    78: ("2E", "2I"),
    79: ("1A", "T:A"),
    80: ("1L", "T:L"),
    81: ("1D", "T:D"),
    82: ("1G", "T:G"),
    83: ("2K", "2L"),
    84: ("1H", "2J"),
    85: ("1B", "T:B"),
    86: ("1J", "2H"),
    87: ("1K", "T:K"),
    88: ("2D", "2G"),
}

# --- Round of 16 through Final (matches 89-104) ----------------------------------
# Tokens: "W74" = winner of match 74; "L101" = loser of match 101 (third-place game).
KO_FEEDERS: dict[int, tuple[str, str]] = {
    89: ("W74", "W77"), 90: ("W73", "W75"), 91: ("W83", "W84"), 92: ("W81", "W82"),
    93: ("W76", "W78"), 94: ("W79", "W80"), 95: ("W86", "W88"), 96: ("W85", "W87"),
    97: ("W89", "W90"), 98: ("W93", "W94"), 99: ("W91", "W92"), 100: ("W95", "W96"),
    101: ("W97", "W98"), 102: ("W99", "W100"),
    103: ("L101", "L102"),   # match for third place
    104: ("W101", "W102"),   # final
}

STAGE_OF: dict[int, str] = (
    {n: R32 for n in R32_SLOTS}
    | {n: R16 for n in range(89, 97)}
    | {n: QF for n in range(97, 101)}
    | {n: SF for n in (101, 102)}
    | {103: THIRD, 104: FINAL}
)

# Top-to-bottom bracket order per round (derived by walking the tree from the final down),
# so that consecutive pairs of matches always feed the next round's match in order. This is
# what lets the UI draw connector lines and vertically centre each match between its feeders.
BRACKET_ORDER: dict[str, list[int]] = {
    R32: [74, 77, 73, 75, 76, 78, 79, 80, 83, 84, 81, 82, 86, 88, 85, 87],
    R16: [89, 90, 93, 94, 91, 92, 95, 96],
    QF: [97, 98, 99, 100],
    SF: [101, 102],
    FINAL: [104],
    THIRD: [103],
}


def resolve_r32(
    group_winner: dict[str, str],          # {group: team}
    group_runner: dict[str, str],          # {group: team}
    third_assignment: dict[str, str],      # {slot_winner_group: source_group}  (from 495 table)
    third_team_of_group: dict[str, str],   # {group: 3rd-placed team}
) -> list[Match]:
    """Build the 16 concrete Round-of-32 matches from finalized group positions."""

    def resolve(token: str) -> str:
        kind, grp = token[0], token[1:]
        if kind == "1":
            return group_winner[grp]
        if kind == "2":
            return group_runner[grp]
        if kind == "T":  # "T:E" -> third assigned to Group E's winner's slot
            slot_group = token.split(":")[1]
            source_group = third_assignment[slot_group]
            return third_team_of_group[source_group]
        raise ValueError(f"Bad slot token: {token}")

    matches = []
    for no, (h, a) in sorted(R32_SLOTS.items()):
        matches.append(Match(id=f"M{no}", stage=R32, match_no=no, home=resolve(h), away=resolve(a)))
    return matches


def empty_knockout() -> list[Match]:
    """The 16 knockout matches (89-104) with unresolved feeder tokens as placeholders."""
    out = []
    for no, (h, a) in sorted(KO_FEEDERS.items()):
        out.append(Match(id=f"M{no}", stage=STAGE_OF[no], match_no=no, home=h, away=a))
    return out
