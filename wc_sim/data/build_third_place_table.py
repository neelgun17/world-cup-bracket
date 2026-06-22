"""Parse the 495-combination 3rd-place assignment table from Wikipedia raw wikitext.

Source: Template:2026 FIFA World Cup third-place table  (?action=raw)

Output: third_place_table.json
  key   = sorted string of the 8 groups that sent a 3rd-placed team through, e.g. "EFGHIJKL"
  value = { winner_group_of_slot : third_place_group }  for the 8 third-facing R32 slots
          e.g. {"A":"E","B":"J","D":"I","E":"F","G":"H","I":"G","K":"L","L":"K"}

Run:  python3 wc_sim/data/build_third_place_table.py /tmp/tp_table.wikitext
"""
import json
import re
import sys
from pathlib import Path

# The 8 R32 slots that host a 3rd-placed team, keyed by the WINNER group, in the
# exact column order of the Wikipedia table header (1A,1B,1D,1E,1G,1I,1K,1L).
SLOT_WINNERS = ["A", "B", "D", "E", "G", "I", "K", "L"]

# Allowed 3rd-place source groups per slot, from the R32 skeleton (matches 73-88).
# Used purely to validate the parse; the table itself is authoritative.
ALLOWED = {
    "E": set("ABCDF"),  # Match 74: 1E vs 3rd A/B/C/D/F
    "I": set("CDFGH"),  # Match 77: 1I vs 3rd C/D/F/G/H
    "A": set("CEFHI"),  # Match 79: 1A vs 3rd C/E/F/H/I
    "L": set("EHIJK"),  # Match 80: 1L vs 3rd E/H/I/J/K
    "D": set("BEFIJ"),  # Match 81: 1D vs 3rd B/E/F/I/J
    "G": set("AEHIJ"),  # Match 82: 1G vs 3rd A/E/H/I/J
    "B": set("EFGIJ"),  # Match 85: 1B vs 3rd E/F/G/I/J
    "K": set("DEIJL"),  # Match 87: 1K vs 3rd D/E/I/J/L
}


def parse(wikitext: str) -> dict:
    # Each data row begins with `! scope="row" | <N>`. Split on that marker.
    blocks = re.split(r'!\s*scope="row"\s*\|', wikitext)
    table = {}
    rows = 0
    for block in blocks[1:]:  # blocks[0] is the header
        m = re.match(r"\s*(\d+)", block)
        if not m:
            continue
        num = int(m.group(1))
        # Cut the block at the start of the next row's content; a row's payload
        # ends at the wikitable row separator `|-` or end of block.
        payload = re.split(r"\n\|-", block, maxsplit=1)[0]
        # Bold single letters = the 8 groups that advanced a 3rd-placed team.
        advanced = re.findall(r"'''([A-L])'''", payload)
        # `3X` tokens = the third assigned to each slot, in header (SLOT_WINNERS) order.
        thirds = re.findall(r"\b3([A-L])\b", payload)
        if len(advanced) != 8 or len(thirds) != 8:
            raise ValueError(
                f"Row {num}: expected 8 advanced/8 thirds, got "
                f"{len(advanced)}/{len(thirds)} -> {advanced} {thirds}"
            )
        key = "".join(sorted(advanced))
        mapping = {SLOT_WINNERS[i]: thirds[i] for i in range(8)}
        table[key] = mapping
        rows += 1
    if rows != 495:
        raise ValueError(f"Expected 495 rows, parsed {rows}")
    return table


def validate(table: dict) -> None:
    from itertools import combinations

    # Every C(12,8)=495 combination of qualifying groups must be present exactly once.
    all_groups = "ABCDEFGHIJKL"
    expected = {"".join(sorted(c)) for c in combinations(all_groups, 8)}
    keys = set(table)
    missing = expected - keys
    extra = keys - expected
    if missing or extra:
        raise ValueError(f"Combination coverage off. missing={len(missing)} extra={len(extra)}")

    for key, mapping in table.items():
        qualified = set(key)
        assigned_thirds = list(mapping.values())
        # 1) Bijection: the 8 slots use each qualifying third exactly once.
        if sorted(assigned_thirds) != sorted(qualified):
            raise ValueError(f"{key}: thirds {assigned_thirds} != qualified {sorted(qualified)}")
        # 2) Each assignment respects the slot's allowed source groups (no illegal draw).
        for winner, third in mapping.items():
            if third not in ALLOWED[winner]:
                raise ValueError(f"{key}: slot 1{winner} drew 3{third} not in {ALLOWED[winner]}")
        # 3) No same-group rematch (a slot's third must differ from its winner group).
        for winner, third in mapping.items():
            if winner == third:
                raise ValueError(f"{key}: slot 1{winner} drew its own group's third")
    print(f"OK: 495 combinations, all bijective, all within allowed sets, no same-group rematches.")


if __name__ == "__main__":
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/tp_table.wikitext")
    out = Path(__file__).parent / "third_place_table.json"
    table = parse(src.read_text())
    validate(table)
    out.write_text(json.dumps(table, separators=(",", ":"), sort_keys=True))
    print(f"Wrote {out} ({len(table)} combinations, {out.stat().st_size} bytes)")
