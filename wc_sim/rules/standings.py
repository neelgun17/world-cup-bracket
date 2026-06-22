"""Group standings with the OFFICIAL 2026 World Cup tiebreakers.

Two distinct comparators are required (this is a common source of error):

  * WITHIN a group (rank the 4 teams) — 2026 order (changed 2026-04-19):
      1. points
      2. head-to-head points        ] applied only among the still-tied teams,
      3. head-to-head goal diff     ] and RE-APPLIED to any subset they create
      4. head-to-head goals scored  ] (FIFA's recursive re-apply rule)
      5. overall goal difference
      6. overall goals scored
      7. fair-play / conduct score
      8. FIFA world ranking
    Head-to-head is now applied BEFORE overall goal difference (reversed since-1970 rule).

  * ACROSS groups (rank the twelve 3rd-placed teams, keep best 8):
      points -> overall GD -> overall goals -> fair-play -> FIFA ranking.
    Head-to-head CANNOT apply (these teams never met).
"""
from __future__ import annotations

from typing import Iterable

from ..models import Match, Team, TeamRecord


def build_records(teams: dict[str, Team], matches: Iterable[Match]) -> dict[str, TeamRecord]:
    """Aggregate finished (and live) group matches into per-team table rows.

    Live matches are counted at their current score so standings reflect the live state.
    """
    recs = {
        name: TeamRecord(team=name, group=t.group, fair_play=t.fair_play, fifa_rank=t.fifa_rank)
        for name, t in teams.items()
    }
    for m in matches:
        if m.score is None or not (m.played or m.live):
            continue
        h, a = m.score
        rh, ra = recs[m.home], recs[m.away]
        rh.played += 1; ra.played += 1
        rh.gf += h; rh.ga += a
        ra.gf += a; ra.ga += h
        if h > a:
            rh.won += 1; ra.lost += 1
        elif a > h:
            ra.won += 1; rh.lost += 1
        else:
            rh.drawn += 1; ra.drawn += 1
    return recs


def _h2h_table(names: list[str], matches: list[Match]) -> dict[str, TeamRecord]:
    """Mini-table using only matches played between the given (tied) teams."""
    s = set(names)
    recs = {n: TeamRecord(team=n) for n in names}
    for m in matches:
        if m.score is None or not (m.played or m.live):
            continue
        if m.home in s and m.away in s:
            h, a = m.score
            rh, ra = recs[m.home], recs[m.away]
            rh.gf += h; rh.ga += a
            ra.gf += a; ra.ga += h
            if h > a:
                rh.won += 1; ra.lost += 1
            elif a > h:
                ra.won += 1; rh.lost += 1
            else:
                rh.drawn += 1; ra.drawn += 1
    return recs


def _partition(names: list[str], key) -> list[list[str]]:
    """Order names by key (desc) and split into equal-key buckets, best bucket first."""
    ordered = sorted(names, key=key, reverse=True)
    buckets: list[list[str]] = []
    for n in ordered:
        if buckets and key(buckets[-1][0]) == key(n):
            buckets[-1].append(n)
        else:
            buckets.append([n])
    return buckets


def _break_overall(names: list[str], recs: dict[str, TeamRecord]) -> list[str]:
    """Final fallbacks once head-to-head cannot separate: overall GD, goals, fair-play, FIFA."""
    def key(n: str):
        r = recs[n]
        # fair_play: higher (less negative) is better; fifa_rank: lower is better.
        return (r.gd, r.gf, r.fair_play, -r.fifa_rank)
    return sorted(names, key=key, reverse=True)


def _resolve_tie(names: list[str], recs: dict[str, TeamRecord], matches: list[Match]) -> list[str]:
    """Order a set of teams equal on points, applying head-to-head with FIFA's re-apply rule."""
    if len(names) == 1:
        return names

    h2h = _h2h_table(names, matches)
    buckets = _partition(names, key=lambda n: (h2h[n].points, h2h[n].gd, h2h[n].gf))

    # If head-to-head produced no split at all, it can't help -> go to overall fallbacks.
    if len(buckets) == 1:
        return _break_overall(names, recs)

    # Otherwise order the buckets; RE-APPLY head-to-head within any multi-team bucket.
    out: list[str] = []
    for bucket in buckets:
        out.extend(_resolve_tie(bucket, recs, matches) if len(bucket) > 1 else bucket)
    return out


def rank_group(teams: dict[str, Team], matches: list[Match]) -> list[TeamRecord]:
    """Return the 4 teams of a group ordered 1st..4th by the 2026 within-group rules."""
    recs = build_records(teams, matches)
    names = list(teams)
    ordered: list[str] = []
    for bucket in _partition(names, key=lambda n: recs[n].points):
        ordered.extend(_resolve_tie(bucket, recs, matches) if len(bucket) > 1 else bucket)
    return [recs[n] for n in ordered]


def rank_third_placed(records: list[TeamRecord]) -> list[TeamRecord]:
    """Rank the twelve 3rd-placed teams (cross-group): pts, overall GD, goals, fair-play, FIFA.

    No head-to-head — different groups never met.
    """
    return sorted(
        records,
        key=lambda r: (r.points, r.gd, r.gf, r.fair_play, -r.fifa_rank),
        reverse=True,
    )
