# World Cup 2026 — Live Bracket Visualizer & Simulator

An interactive tool that takes the **live current scores/standings** and shows **what the
2026 World Cup bracket will look like** — correctly applying the new (and genuinely confusing)
2026 format, and demystifying the part nobody can follow by hand: how the eight best
third-placed teams get slotted into the Round of 32.

> The 2026 format is new: **48 teams, 12 groups, top 2 + 8 best 3rd-placed teams → a Round of
> 32**. Figuring out *who plays who* requires a fixed **495-row FIFA table**. This tool resolves
> it to real teams and explains *why*, live.

## Run

```bash
python3 -m wc_sim.server          # then open http://localhost:8000
python3 -m wc_sim.cli             # text version (standings + bracket) in the terminal
python3 tests/test_rules.py       # correctness tests
```

No third-party dependencies — standard library only. Live data comes from ESPN's public
(keyless) FIFA World Cup API; if it's unreachable, the last fetched state is cached and reused.

## What you can do in the UI

- **See live group tables** for all 12 groups (qualification colour-coded).
- **The third-place race** with the top-8 cut line drawn, plus the active 495-combination key.
- **The full R32 → Final bracket**, drawn as a real bracket with **connector lines** (the
  projected winner's path highlighted), each game shaded by the favourite's win probability.
- **The 495 explainer:** hover the ⓘ on any third-place slot to see, in plain English, which
  team fills it and *why* (which groups qualified a third → which table row → which slot).
- **Pick-em / what-if:** edit any score, or click a team in the bracket to send them through —
  standings, the 8 best thirds, the slot assignments, and the whole bracket recompute instantly.
- **Run probabilities:** Monte-Carlo the rest of the tournament; each team's odds to reach the
  final / win it appear both in a side panel and **directly on every bracket node** ("% to
  reach"). Deep-link `#mc` opens straight into this view.
- **Marginal matchups on the R32:** the single most-likely *bracket* can show a different
  opponent than the most-likely *opponent* (the 495-assignment is chaotic, and group runner-ups
  can flip). With probabilities loaded, every R32 slot shows the team that actually fills it most
  often across simulations + its occupancy %, with the full distribution on hover. Two tiers:
  the chaotic third-place slots and genuine coin-flips (most-likely occupant < 55%) are flagged
  gold (e.g. *USA → Bosnia 53%*); stable slots are shown plainly — so the gold signal stays
  meaningful.

## How it works

```
ESPN live scores ─► group tables (2026 tiebreakers) ─► 8 best thirds ─► 495-table assignment
                                                                              │
   Elo + Dixon–Coles Poisson model ◄── fills undecided games ──► full R32…Final bracket
                                                                              │
                              Monte Carlo (10k runs) ─► advancement probabilities
```

### The 2026 rules (encoded exactly — see `wc_sim/rules/standings.py`)

- **Within a group** (2026 order, changed 2026-04-19): points → **head-to-head** (pts, GD,
  goals, re-applied to any tied subset) → overall GD → overall goals → fair-play → FIFA rank.
  *Head-to-head is now applied **before** overall goal difference — the headline 2026 change.*
- **Across groups** (ranking the twelve thirds): points → overall GD → overall goals →
  fair-play → FIFA rank. **No head-to-head** (different groups never met) — a separate comparator.
- **Slot assignment:** the official 495-combination table (`wc_sim/data/third_place_table.json`),
  scraped from the FIFA regulations / Wikipedia and validated (all 495 combinations are a clean
  bijection within the allowed source groups, no same-group rematches).

### The prediction model (`wc_sim/model/elo.py`)

Each team has a **World-Football-Elo** rating (seeded from eloratings.net, then **updated live**
from results already played, so in-tournament form feeds back in). Elo difference → expected
goals → a **bivariate-Poisson** scoreline with a **Dixon–Coles** low-score correction (so draws
aren't under-counted). Scorelines — not just win/lose — are produced because group goal
difference and the third-place ranking depend on them. Host nations (USA/Canada/Mexico) get a
home-advantage bump; knockout ties go to extra time then penalties. The model sits behind a small
swappable interface, so it can be upgraded (e.g. to a Bayesian or odds-based model) without
touching the rules engine.

## Layout

```
wc_sim/
  models.py            shared dataclasses (Team, Match, TeamRecord)
  ingest.py            ESPN live fetch + manual-override layer
  rules/standings.py   2026 tiebreakers (two comparators)
  rules/assignment.py  495-table resolver + plain-English explanation
  rules/bracket.py     official knockout structure (matches 73-104)
  model/elo.py         Elo + Dixon–Coles Poisson + live Elo updates
  engine/tournament.py orchestrator: projection + Monte Carlo
  api.py               board payload builder
  server.py            dependency-free HTTP server
  data/                teams.json, third_place_table.json, Elo seed
web/                   index.html, app.js, style.css
tests/test_rules.py    tiebreaker + 495-table correctness tests
```
