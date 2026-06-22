"""Match prediction model: Elo -> expected goals -> Dixon-Coles Poisson scorelines.

Swappable behind one small surface (`MatchModel`) so the rules engine never depends on
*how* a score is produced. Scorelines (not just W/D/L) are produced because group GD/goals
and the cross-group third-place ranking depend on them.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Iterable, Optional

# --- calibration constants (international football, neutral venue) ----------------
MU_TOTAL = 2.65          # avg total goals per game
SUP_PER_100_ELO = 0.38   # goal supremacy added per 100 Elo of advantage
HOME_ADV_GOALS = 0.35    # extra expected goals for a host nation playing at home
DC_RHO = -0.10           # Dixon-Coles low-score dependence (raises draw prob a touch)
MAX_GOALS = 12           # grid cap for the joint scoreline pmf
MIN_LAMBDA = 0.15        # floor so heavy favorites don't zero out the underdog

HOSTS = {"United States", "Canada", "Mexico"}


def _poisson_pmf(k: int, lam: float) -> float:
    return math.exp(-lam) * lam ** k / math.factorial(k)


def _dc_tau(i: int, j: int, lh: float, la: float, rho: float) -> float:
    if i == 0 and j == 0:
        return 1.0 - lh * la * rho
    if i == 0 and j == 1:
        return 1.0 + lh * rho
    if i == 1 and j == 0:
        return 1.0 + la * rho
    if i == 1 and j == 1:
        return 1.0 - rho
    return 1.0


@dataclass
class MatchModel:
    rng: random.Random

    def lambdas(self, home_elo: float, away_elo: float, home_host: bool = False) -> tuple[float, float]:
        sup = SUP_PER_100_ELO * (home_elo - away_elo) / 100.0
        lh = MU_TOTAL / 2 + sup / 2 + (HOME_ADV_GOALS if home_host else 0.0)
        la = MU_TOTAL / 2 - sup / 2
        return max(MIN_LAMBDA, lh), max(MIN_LAMBDA, la)

    def score_grid(self, lh: float, la: float) -> list[list[float]]:
        """Normalized joint pmf over (home_goals, away_goals) with the DC correction."""
        grid = [[_poisson_pmf(i, lh) * _poisson_pmf(j, la) * _dc_tau(i, j, lh, la, DC_RHO)
                 for j in range(MAX_GOALS + 1)] for i in range(MAX_GOALS + 1)]
        total = sum(sum(row) for row in grid)
        return [[v / total for v in row] for row in grid]

    def win_probs(self, home_elo: float, away_elo: float, home_host: bool = False) -> tuple[float, float, float]:
        """Analytic (P_home_win, P_draw, P_away_win) for shading and favorite selection."""
        lh, la = self.lambdas(home_elo, away_elo, home_host)
        grid = self.score_grid(lh, la)
        ph = pd = pa = 0.0
        for i in range(MAX_GOALS + 1):
            for j in range(MAX_GOALS + 1):
                p = grid[i][j]
                if i > j:
                    ph += p
                elif i == j:
                    pd += p
                else:
                    pa += p
        return ph, pd, pa

    def sample_score(self, home_elo: float, away_elo: float, home_host: bool = False) -> tuple[int, int]:
        lh, la = self.lambdas(home_elo, away_elo, home_host)
        grid = self.score_grid(lh, la)
        r = self.rng.random()
        cum = 0.0
        for i in range(MAX_GOALS + 1):
            for j in range(MAX_GOALS + 1):
                cum += grid[i][j]
                if r <= cum:
                    return i, j
        return 0, 0

    def sample_score_fast(self, home_elo: float, away_elo: float, home_host: bool = False) -> tuple[int, int]:
        """Sample a scoreline without building the full grid (Poisson draws + DC rejection on
        the four low-score cells). Used in the hot Monte-Carlo loop."""
        lh, la = self.lambdas(home_elo, away_elo, home_host)
        tau_max = 1.0 + abs(DC_RHO) * (1 + lh * la)  # safe upper bound on tau
        while True:
            i, j = self._poisson_draw(lh), self._poisson_draw(la)
            if i <= 1 and j <= 1:
                if self.rng.random() <= _dc_tau(i, j, lh, la, DC_RHO) / tau_max:
                    return i, j
            else:
                return i, j

    def sample_remaining(
        self, current: tuple[int, int], minute: int,
        home_elo: float, away_elo: float, home_host: bool = False,
    ) -> tuple[int, int]:
        """Complete an in-progress match: keep the live score, simulate only the time left."""
        lh, la = self.lambdas(home_elo, away_elo, home_host)
        frac = max(0.0, (90 - minute) / 90.0)
        gh = current[0] + self._poisson_draw(lh * frac)
        ga = current[1] + self._poisson_draw(la * frac)
        return gh, ga

    def sample_knockout(
        self, home_elo: float, away_elo: float,
        current: Optional[tuple[int, int]] = None, minute: Optional[int] = None,
    ) -> tuple[int, int, Optional[str]]:
        """Resolve a knockout match (no draws): returns (gh, ga, shootout_winner|None).

        If the score is level after 90', play 30' of extra time; if still level, penalties
        (slight Elo tilt). `shootout_winner` is 'home'/'away' only when pens decide it.
        """
        if current is not None and minute is not None:
            gh, ga = self.sample_remaining(current, minute, home_elo, away_elo)
        else:
            gh, ga = self.sample_score_fast(home_elo, away_elo)
        if gh != ga:
            return gh, ga, None
        # extra time: ~1/3 of a match
        lh, la = self.lambdas(home_elo, away_elo)
        gh += self._poisson_draw(lh / 3.0)
        ga += self._poisson_draw(la / 3.0)
        if gh != ga:
            return gh, ga, None
        # penalties: mild Elo tilt around a coin flip
        p_home = 1.0 / (1.0 + 10 ** (-(home_elo - away_elo) / 800.0))
        return gh, ga, ("home" if self.rng.random() < p_home else "away")

    def _poisson_draw(self, lam: float) -> int:
        if lam <= 0:
            return 0
        # Knuth's algorithm
        L, k, p = math.exp(-lam), 0, 1.0
        while True:
            k += 1
            p *= self.rng.random()
            if p <= L:
                return k - 1


# --- live Elo update -------------------------------------------------------------
WC_K = 60.0  # eloratings.net World Cup K-factor


def _gd_multiplier(goal_diff: int) -> float:
    g = abs(goal_diff)
    if g <= 1:
        return 1.0
    if g == 2:
        return 1.5
    return (11 + g) / 8.0  # 3 -> 1.75, 4 -> 1.875, ...


def update_elo_from_results(
    elo: dict[str, float],
    results: Iterable[tuple[str, str, int, int]],
) -> dict[str, float]:
    """Return updated Elo dict after applying finished results (home, away, gh, ga).

    Lets in-tournament form feed back into the model ('live-updating' Architecture B).
    """
    out = dict(elo)
    for home, away, gh, ga in results:
        rh, ra = out.get(home), out.get(away)
        if rh is None or ra is None:
            continue
        we_home = 1.0 / (1.0 + 10 ** (-(rh - ra) / 400.0))
        w_home = 1.0 if gh > ga else 0.5 if gh == ga else 0.0
        k = WC_K * _gd_multiplier(gh - ga)
        delta = k * (w_home - we_home)
        out[home] = rh + delta
        out[away] = ra - delta
    return out
