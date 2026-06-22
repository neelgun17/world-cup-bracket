"""Canonical data structures shared across the simulator."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

# Stages of the tournament.
GROUP = "group"
R32, R16, QF, SF, FINAL, THIRD = "R32", "R16", "QF", "SF", "final", "3P"


@dataclass
class Team:
    name: str
    abbr: str
    group: str
    elo: float
    code: Optional[str] = None
    # Conduct/fair-play points (negative = worse). Tiebreaker #6. Default 0 = clean.
    fair_play: int = 0
    # Lower FIFA-ranking number = better. Final tiebreaker. Default from Elo order if unknown.
    fifa_rank: int = 999


@dataclass
class Match:
    """A single fixture. For group matches home/away are team names. For knockout
    matches they may be unresolved slot tokens (e.g. '1A', '2B', '3rd:E') until filled."""
    id: str
    stage: str
    home: str
    away: str
    group: Optional[str] = None
    match_no: Optional[int] = None          # FIFA match number (1-104)
    score: Optional[tuple[int, int]] = None  # (home_goals, away_goals) once known
    status: str = "scheduled"                # scheduled | in_progress | final
    minute: Optional[int] = None             # for in-progress matches
    # For knockout matches that can't draw, the shootout winner ('home'/'away') if needed.
    shootout_winner: Optional[str] = None

    @property
    def played(self) -> bool:
        return self.status == "final" and self.score is not None

    @property
    def live(self) -> bool:
        return self.status == "in_progress" and self.score is not None

    def winner(self) -> Optional[str]:
        """Name of the winning team for a decided match, else None (group draws -> None)."""
        if self.score is None:
            return None
        h, a = self.score
        if h > a:
            return self.home
        if a > h:
            return self.away
        if self.shootout_winner == "home":
            return self.home
        if self.shootout_winner == "away":
            return self.away
        return None  # genuine draw (group stage)

    def loser(self) -> Optional[str]:
        w = self.winner()
        if w is None:
            return None
        return self.away if w == self.home else self.home


@dataclass
class TeamRecord:
    """A team's group-stage table row."""
    team: str
    group: str = ""
    played: int = 0
    won: int = 0
    drawn: int = 0
    lost: int = 0
    gf: int = 0
    ga: int = 0
    fair_play: int = 0
    fifa_rank: int = 999

    @property
    def points(self) -> int:
        return 3 * self.won + self.drawn

    @property
    def gd(self) -> int:
        return self.gf - self.ga
