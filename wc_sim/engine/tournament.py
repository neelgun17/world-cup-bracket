"""Orchestrator: live standings -> projected group orders -> 495 assignment -> full bracket.

Two projection modes share one code path:
  * deterministic=True  -> favorite outcome in every undecided match (the clean "most likely"
                           bracket used for the default view).
  * deterministic=False -> sampled scorelines (one Monte-Carlo run).
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field

from ..model import MatchModel, update_elo_from_results
from ..models import FINAL, GROUP, Match, R16, R32, QF, SF, THIRD, Team, TeamRecord
from ..rules.assignment import assign_thirds, explain_assignment
from ..rules.bracket import KO_FEEDERS, R32_SLOTS, STAGE_OF, resolve_r32
from ..rules.standings import build_records, rank_group, rank_third_placed

HOSTS = {"United States", "Canada", "Mexico"}
# Stage a team has reached, used for Monte-Carlo advancement tallies.
REACH_STAGES = [R32, R16, QF, SF, FINAL, "champion"]


@dataclass
class ProjectionResult:
    group_orders: dict[str, list[TeamRecord]]      # {group: [1st,2nd,3rd,4th]}
    third_ranking: list[TeamRecord]                # all 12 thirds, best->worst
    qualified_groups: list[str]                    # the 8 groups sending a third through
    assignment: dict[str, str]                     # {slot_winner_group: source_group}
    knockout: dict[int, Match]                     # match_no -> resolved/played match (73-104)
    champion: str = ""


class Tournament:
    def __init__(self, teams: dict[str, Team], group_matches: list[Match], live_elo: bool = True):
        self.teams = teams
        self.group_matches = group_matches
        self.by_group: dict[str, list[Match]] = {}
        for m in group_matches:
            if m.group:
                self.by_group.setdefault(m.group, []).append(m)
        # Working Elo: optionally updated by results already played ("live-updating" B).
        self.elo = {n: t.elo for n, t in teams.items()}
        if live_elo:
            finished = [(m.home, m.away, m.score[0], m.score[1])
                        for m in group_matches if m.played and m.score]
            self.elo = update_elo_from_results(self.elo, finished)

    # ---- current live snapshot --------------------------------------------------
    def standings(self) -> dict[str, list[TeamRecord]]:
        """Current group tables from played + live matches (live counted at current score)."""
        out = {}
        for g, matches in self.by_group.items():
            group_teams = {n: t for n, t in self.teams.items() if t.group == g}
            out[g] = rank_group(group_teams, matches)
        return out

    def third_place_snapshot(self) -> dict:
        st = self.standings()
        thirds = [recs[2] for recs in st.values() if len(recs) >= 3]
        ranked = rank_third_placed(thirds)
        return {
            "ranked": ranked,
            "qualified": [r.team for r in ranked[:8]],
            "cut_team": ranked[8].team if len(ranked) > 8 else None,
        }

    # ---- projection (deterministic favorite or one sampled run) -----------------
    def _host(self, team: str) -> bool:
        return team in HOSTS

    def _fill_group_scores(self, model: MatchModel, deterministic: bool) -> dict[str, tuple[int, int]]:
        scores: dict[str, tuple[int, int]] = {}
        for m in self.group_matches:
            if m.played and m.score:
                scores[m.id] = m.score
                continue
            eh, ea = self.elo[m.home], self.elo[m.away]
            host = self._host(m.home)
            if m.live and m.score is not None:
                cur, minute = m.score, (m.minute or 80)
                if deterministic:
                    scores[m.id] = self._argmax_remaining(model, cur, minute, eh, ea, host)
                else:
                    scores[m.id] = model.sample_remaining(cur, minute, eh, ea, host)
            else:
                if deterministic:
                    scores[m.id] = self._argmax_score(model, eh, ea, host)
                else:
                    scores[m.id] = model.sample_score_fast(eh, ea, host)
        return scores

    def _argmax_score(self, model, eh, ea, host) -> tuple[int, int]:
        lh, la = model.lambdas(eh, ea, host)
        grid = model.score_grid(lh, la)
        best, bij = -1.0, (0, 0)
        for i, row in enumerate(grid):
            for j, p in enumerate(row):
                if p > best:
                    best, bij = p, (i, j)
        return bij

    def _argmax_remaining(self, model, cur, minute, eh, ea, host) -> tuple[int, int]:
        # Most likely completion: add the modal number of remaining goals per side.
        lh, la = model.lambdas(eh, ea, host)
        frac = max(0.0, (90 - minute) / 90.0)
        return cur[0] + int(lh * frac), cur[1] + int(la * frac)

    def _orders_from_scores(self, scores: dict[str, tuple[int, int]]) -> dict[str, list[TeamRecord]]:
        out = {}
        for g, matches in self.by_group.items():
            group_teams = {n: t for n, t in self.teams.items() if t.group == g}
            projected = [Match(id=m.id, stage=GROUP, group=g, home=m.home, away=m.away,
                               score=scores[m.id], status="final") for m in matches]
            out[g] = rank_group(group_teams, projected)
        return out

    def project(self, model: MatchModel | None = None, deterministic: bool = True,
                rng: random.Random | None = None,
                ko_overrides: dict[int, str] | None = None) -> ProjectionResult:
        model = model or MatchModel(rng or random.Random())
        scores = self._fill_group_scores(model, deterministic)
        orders = self._orders_from_scores(scores)

        winners = {g: recs[0].team for g, recs in orders.items()}
        runners = {g: recs[1].team for g, recs in orders.items()}
        third_team_of_group = {g: recs[2].team for g, recs in orders.items()}
        thirds = [recs[2] for recs in orders.values()]
        ranked = rank_third_placed(thirds)
        qualified_groups = sorted(r.group for r in ranked[:8])
        assignment = assign_thirds(qualified_groups)

        r32 = resolve_r32(winners, runners, assignment, third_team_of_group)
        knockout = self._play_knockout(r32, model, deterministic, ko_overrides or {})
        champion = knockout[104].winner() or ""
        return ProjectionResult(orders, ranked, qualified_groups, assignment, knockout, champion)

    def _play_knockout(self, r32: list[Match], model: MatchModel, deterministic: bool,
                       ko_overrides: dict[int, str] | None = None) -> dict[int, Match]:
        ko_overrides = ko_overrides or {}
        ko: dict[int, Match] = {m.match_no: m for m in r32}
        winner: dict[int, str] = {}
        loser: dict[int, str] = {}

        def decide(m: Match):
            forced = ko_overrides.get(m.match_no)
            if forced in (m.home, m.away):
                # user pick-em: force this team through with a nominal 1-0.
                m.score = (1, 0) if forced == m.home else (0, 1)
                m.status = "final"
                winner[m.match_no] = forced
                loser[m.match_no] = m.away if forced == m.home else m.home
                return
            eh, ea = self.elo[m.home], self.elo[m.away]
            if deterministic:
                ph, _pd, pa = model.win_probs(eh, ea)
                base = self._argmax_score(model, eh, ea, False)
                hi, lo = max(base), min(base)
                if hi == lo:  # most-likely outcome is a draw -> decisive 1-goal win for favorite
                    hi, lo = lo + 1, lo
                m.score = (hi, lo) if ph >= pa else (lo, hi)
                w = m.home if ph >= pa else m.away
            else:
                gh, ga, so = model.sample_knockout(eh, ea)
                m.score, m.shootout_winner = (gh, ga), so
                w = m.winner()
            m.status = "final"
            winner[m.match_no] = w
            loser[m.match_no] = m.away if w == m.home else m.home

        for m in r32:
            decide(m)

        for no in sorted(KO_FEEDERS):
            fh, fa = KO_FEEDERS[no]
            home = winner[int(fh[1:])] if fh[0] == "W" else loser[int(fh[1:])]
            away = winner[int(fa[1:])] if fa[0] == "W" else loser[int(fa[1:])]
            m = Match(id=f"M{no}", stage=STAGE_OF[no], match_no=no, home=home, away=away)
            decide(m)
            ko[no] = m
        return ko

    # ---- Monte Carlo ------------------------------------------------------------
    def monte_carlo(self, runs: int = 10000, seed: int = 0,
                    ko_overrides: dict[int, str] | None = None) -> dict:
        """Run the tournament `runs` times. `ko_overrides` (match_no -> forced team) conditions
        every run on the user's knockout pick-ems: in each sim the forced team is sent through
        any match it actually reaches, and plays normally in sims where it doesn't reach it."""
        from collections import Counter

        ko_overrides = {int(k): v for k, v in (ko_overrides or {}).items()}
        rng = random.Random(seed)
        model = MatchModel(rng)
        names = list(self.teams)
        reach = {n: {s: 0 for s in REACH_STAGES} for n in names}
        group_winner = {n: 0 for n in names}
        # Who actually OCCUPIES each R32 slot across sims (home & away separately). This is
        # what answers "who will my team most likely play" — the marginal matchup, which for
        # the third-place slots differs sharply from the single most-likely bracket.
        slot_home = {no: Counter() for no in R32_SLOTS}
        slot_away = {no: Counter() for no in R32_SLOTS}

        for _ in range(runs):
            res = self.project(model, deterministic=False, rng=rng, ko_overrides=ko_overrides)
            for g, recs in res.group_orders.items():
                group_winner[recs[0].team] += 1
            for no in R32_SLOTS:
                m = res.knockout[no]
                reach[m.home][R32] += 1
                reach[m.away][R32] += 1
                slot_home[no][m.home] += 1
                slot_away[no][m.away] += 1
            self._tally_advancement(res, reach)

        def pct(c):
            return round(100.0 * c / runs, 1)

        def topk(counter, k=5):
            return [{"team": t, "abbr": self.teams[t].abbr, "pct": pct(c)}
                    for t, c in counter.most_common(k)]

        return {
            "runs": runs,
            "teams": sorted(
                [{
                    "team": n, "group": self.teams[n].group, "elo": round(self.elo[n]),
                    "group_winner": pct(group_winner[n]),
                    **{s: pct(reach[n][s]) for s in REACH_STAGES},
                } for n in names],
                key=lambda d: -d["champion"],
            ),
            # Marginal R32 matchups: most-likely occupant of each slot, both sides.
            "r32_slots": {
                str(no): {"home": topk(slot_home[no]), "away": topk(slot_away[no])}
                for no in R32_SLOTS
            },
        }

    # ---- single-team outlook ("what does my team need?") ------------------------
    def team_outlook(self, team_name: str, runs: int = 6000, seed: int = 0) -> dict:
        """Conditioned Monte-Carlo for one team. Runs the group stage `runs` times and,
        rather than forcing results, *slices* the same sims by the team's outcome in each of
        its remaining group games. That yields P(advance), the finish-position spread, the
        marginal Round-of-32 opponent distribution, and — per remaining match — P(advance |
        win / draw / loss). One run answers "what do I need?" honestly, with the 495 chaos
        baked in (third-place qualifiers get assigned opponents via the real table)."""
        from collections import Counter

        if team_name not in self.teams:
            raise KeyError(team_name)
        rng = random.Random(seed)
        model = MatchModel(rng)
        g = self.teams[team_name].group

        # The team's own remaining (not-yet-final) group games, with which side it is on.
        remaining = [(m, m.home == team_name) for m in self.by_group.get(g, [])
                     if (m.home == team_name or m.away == team_name) and not m.played]
        rem_meta = {m.id: (m, is_home) for m, is_home in remaining}

        advanced = group_win = qual_third = 0
        finish = Counter()                  # final group position 1..4
        opp = Counter()                     # R32 opponent when the team advances
        # per remaining match: outcome -> [times it happened, times the team then advanced]
        OUTCOMES = ("win", "draw", "loss")
        cond = {mid: {o: [0, 0] for o in OUTCOMES} for mid in rem_meta}

        for _ in range(runs):
            scores = self._fill_group_scores(model, deterministic=False)
            orders = self._orders_from_scores(scores)
            winners = {gg: recs[0].team for gg, recs in orders.items()}
            runners = {gg: recs[1].team for gg, recs in orders.items()}
            third_of = {gg: recs[2].team for gg, recs in orders.items()}
            ranked = rank_third_placed([recs[2] for recs in orders.values()])
            qualified_groups = sorted(r.group for r in ranked[:8])
            assignment = assign_thirds(qualified_groups)
            r32 = resolve_r32(winners, runners, assignment, third_of)

            pos = next(i for i, r in enumerate(orders[g], 1) if r.team == team_name)
            finish[pos] += 1
            if pos == 1:
                group_win += 1
            is_qual_third = pos == 3 and g in qualified_groups
            if is_qual_third:
                qual_third += 1
            adv = pos in (1, 2) or is_qual_third
            if adv:
                advanced += 1
                for m in r32:               # the team's R32 pairing is fixed once positions are set
                    if m.home == team_name:
                        opp[m.away] += 1
                        break
                    if m.away == team_name:
                        opp[m.home] += 1
                        break

            for mid, (m, is_home) in rem_meta.items():
                sh, sa = scores[mid]
                tf, of = (sh, sa) if is_home else (sa, sh)
                outcome = "win" if tf > of else "draw" if tf == of else "loss"
                cond[mid][outcome][0] += 1
                if adv:
                    cond[mid][outcome][1] += 1

        def pct(c, total=runs):
            return round(100.0 * c / total, 1) if total else 0.0

        remaining_payload = []
        for m, is_home in remaining:
            other = m.away if is_home else m.home
            outs = {}
            for o in OUTCOMES:
                n, a = cond[m.id][o]
                outs[o] = {"p": pct(n), "p_advance": round(100.0 * a / n, 1) if n else None}
            remaining_payload.append({
                "id": m.id, "opponent": other,
                "abbr_opponent": self.teams.get(other).abbr if other in self.teams else other[:3].upper(),
                "home": is_home, "outcomes": outs,
            })

        return {
            "team": team_name, "group": g, "elo": round(self.elo[team_name]), "runs": runs,
            "p_advance": pct(advanced),
            "p_group_win": pct(group_win),
            "p_third_qualify": pct(qual_third),
            "finish": {str(p): pct(finish[p]) for p in (1, 2, 3, 4)},
            "remaining": remaining_payload,
            "opponents": [{"team": t, "abbr": self.teams[t].abbr, "pct": pct(c, advanced)}
                          for t, c in opp.most_common(8)],
        }

    def _tally_advancement(self, res: ProjectionResult, reach: dict):
        ko = res.knockout
        # winners of each round have "reached" the next round
        round_winsets = {
            R16: range(73, 89),   # R32 winners reach R16
            QF: range(89, 97),    # R16 winners reach QF
            SF: range(97, 101),   # QF winners reach SF
            FINAL: (101, 102),    # SF winners reach Final
        }
        for stage, match_nos in round_winsets.items():
            for no in match_nos:
                w = ko[no].winner()
                if w:
                    reach[w][stage] += 1
        if res.champion:
            reach[res.champion]["champion"] += 1
