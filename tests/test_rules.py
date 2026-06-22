"""Correctness tests for the 2026 rules engine — tiebreakers and the 495-table."""
import sys
from itertools import combinations
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from wc_sim.models import GROUP, Match, Team  # noqa: E402
from wc_sim.rules.assignment import SLOT_ALLOWED, assign_thirds, explain_assignment  # noqa: E402
from wc_sim.rules.standings import rank_group, rank_third_placed, build_records  # noqa: E402


def _grp(letters, elos=None):
    elos = elos or {}
    return {n: Team(name=n, abbr=n, group="A", elo=elos.get(n, 1500)) for n in letters}


def _m(h, a, gh, ga):
    return Match(id=f"{h}{a}", stage=GROUP, group="A", home=h, away=a, score=(gh, ga), status="final")


def test_head_to_head_beats_overall_gd_2026():
    """2026 change: with equal points, the head-to-head winner ranks above a team with
    BETTER overall goal difference."""
    teams = _grp("ABCD")
    matches = [
        _m("A", "B", 1, 0),  # A wins the head-to-head
        _m("A", "C", 2, 1),
        _m("D", "A", 1, 0),
        _m("B", "C", 3, 0),
        _m("B", "D", 2, 0),
        _m("C", "D", 1, 1),
    ]
    order = [r.team for r in rank_group(teams, matches)]
    recs = build_records(teams, matches)
    assert recs["A"].points == recs["B"].points == 6
    assert recs["B"].gd > recs["A"].gd          # B has the better overall GD
    assert order.index("A") < order.index("B")  # ...but A wins on head-to-head (2026 rule)


def test_three_way_tie_resolved_by_h2h_mini_table():
    """Three teams level on points; head-to-head mini-table orders them."""
    teams = _grp("ABCD")
    matches = [
        _m("A", "B", 1, 0),
        _m("B", "C", 1, 0),
        _m("C", "A", 1, 0),   # rock-paper-scissors on results...
        _m("A", "D", 5, 0),   # ...broken by goals: A piles them up vs D
        _m("B", "D", 2, 0),
        _m("C", "D", 1, 0),
    ]
    order = [r.team for r in rank_group(teams, matches)]
    # A,B,C all 6 pts and 1-1-1 head-to-head among themselves -> fall to overall GD/goals.
    assert order[3] == "D"
    assert order[0] == "A"  # best overall goal difference of the tied trio


def _third(name, group, won=0, drawn=0, gf=0, ga=0):
    from wc_sim.models import TeamRecord
    return TeamRecord(team=name, group=group, won=won, drawn=drawn, gf=gf, ga=ga)


def test_third_place_ranking_ignores_head_to_head():
    """Cross-group thirds are ranked by points, overall GD, goals — never head-to-head."""
    x = _third("X", "C", won=1, gf=3, ga=1)  # 3 pts, GD +2, 3 goals
    y = _third("Y", "F", won=1, gf=5, ga=3)  # 3 pts, GD +2, 5 goals
    ranked = rank_third_placed([x, y])
    assert ranked[0].team == "Y"  # more goals scored breaks the GD tie


def test_495_table_integrity():
    """Every C(12,8)=495 combination assigns all 8 thirds bijectively within allowed sets."""
    all_groups = "ABCDEFGHIJKL"
    combos = list(combinations(all_groups, 8))
    assert len(combos) == 495
    for combo in combos:
        mapping = assign_thirds(list(combo))
        assert len(mapping) == 8
        assert sorted(mapping.values()) == sorted(combo)          # bijection onto qualifiers
        for winner_group, source_group in mapping.items():
            assert source_group in SLOT_ALLOWED[winner_group].split("/")  # within allowed
            assert winner_group != source_group                          # no same-group rematch


def test_explain_assignment_resolves_real_team():
    """The explainer maps a slot to an actual team name with a 'why' sentence."""
    thirds = []
    for g in "CDEFGHIL":  # 8 qualifying groups
        t = Team(name=f"3rd{g}", abbr=g, group=g, elo=1500)
        rec = build_records({f"3rd{g}": t}, [])[f"3rd{g}"]
        rec.won = 1
        thirds.append(rec)
    # add 4 non-qualifying thirds with 0 points so they sit below the cut
    for g in "ABJK":
        t = Team(name=f"3rd{g}", abbr=g, group=g, elo=1500)
        thirds.append(build_records({f"3rd{g}": t}, [])[f"3rd{g}"])
    third_team = {g: f"3rd{g}" for g in "ABCDEFGHIJKL"}
    exp = explain_assignment(rank_third_placed(thirds), third_team)
    assert exp["qualified_groups"] == list("CDEFGHIL")
    assert len(exp["slots"]) == 8
    for s in exp["slots"]:
        assert s["team"].startswith("3rd")
        assert "table assigns" in s["why"]


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"PASS {fn.__name__}")
    print(f"\nAll {len(fns)} tests passed.")
