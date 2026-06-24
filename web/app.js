"use strict";

const LS_KEY = "wc2026.state";
const state = loadState();           // { overrides, ko_overrides, team }
let board = null;
let debounce = null;

const SVGNS = "http://www.w3.org/2000/svg";
// Map a round's display label -> the Monte-Carlo "reached this stage" key.
const STAGE_KEY = {
  "Round of 32": "R32", "Round of 16": "R16", "Quarter-finals": "QF",
  "Semi-finals": "SF", "Final": "final",
};
let mcByTeam = null; // {team: {R32,R16,QF,SF,final,champion}} after a Monte-Carlo run
let mcSlots = null;  // {match_no: {home:[{team,abbr,pct}], away:[...]}} marginal R32 occupants
let mcLoading = false;
const VOLATILE_PCT = 55; // a slot whose most-likely occupant is below this is a real coin-flip

let teamReport = null;   // last /api/team payload for the chosen team
let teamLoading = false;
let teamError = null;
let teamReq = 0;         // request counter so only the latest team fetch drives the UI

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

// ---- persistent state (picks/edits now span pages, so survive reloads) ----------
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    // `snapshot` (set only by opening a frozen share link) pins the group results so the
    // bracket stays static; null = live mode. `overrides` are edits layered on whichever base.
    return { overrides: s.overrides || {}, ko_overrides: s.ko_overrides || {},
             team: s.team || null, snapshot: s.snapshot || null };
  } catch (_) {
    return { overrides: {}, ko_overrides: {}, team: null, snapshot: null };
  }
}
function saveState() {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}

// ================================ routing ========================================
const PAGES = ["standings", "bracket", "team"];
function currentPage() {
  const p = (location.hash.replace(/^#\//, "") || "standings");
  return PAGES.includes(p) ? p : "standings";
}
function route() {
  const page = currentPage();
  PAGES.forEach((p) => $(`#page-${p}`).classList.toggle("active", p === page));
  document.querySelectorAll("nav.tabs a").forEach((a) =>
    a.classList.toggle("on", a.dataset.page === page));
  if (page === "bracket") {
    requestAnimationFrame(drawConnectors); // sizes are only real when visible
    maybeAutoProbabilities();
  }
  if (page === "team") ensureTeamReport();
}

// The bracket's default deterministic third-place slots are misleading (a single fluky 495
// assignment), so as soon as the bracket is shown we simulate to replace each Round-of-32 slot
// with its *most-likely* occupant — the honest "who will we play". Re-runs after a score edit.
function maybeAutoProbabilities() {
  if (board && !mcSlots && !mcLoading) loadProbabilities(false);
}

// A knockout pick-em changes the conditioned odds, so re-run the simulation — but debounced,
// so building a bracket by clicking through it doesn't fire a run on every click.
let mcRerunTimer = null;
function scheduleMcRerun() {
  if (!mcByTeam && !mcSlots) return;   // nothing loaded yet — first-open auto-run will cover it
  clearTimeout(mcRerunTimer);
  mcRerunTimer = setTimeout(function run() {
    if (mcLoading) { mcRerunTimer = setTimeout(run, 300); return; }
    loadProbabilities(false);   // background refresh; the legend bar shows the "updating" state
  }, 500);
}

// ================================ data ===========================================
async function fetchBoard() {
  try {
    const r = await fetch("/api/board", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overrides: state.overrides, ko_overrides: state.ko_overrides,
                             snapshot: state.snapshot }),
    });
    if (!r.ok) throw new Error(`server returned ${r.status}`);
    board = await r.json();
    render();
  } catch (e) {
    // Don't leave the header stuck on "loading…" if a request fails; surface a retry instead.
    const s = $("#status");
    if (s) s.innerHTML = `couldn't load — <a href="#" id="board-retry">retry</a>`;
    const retry = $("#board-retry");
    if (retry) retry.addEventListener("click", (ev) => { ev.preventDefault(); fetchBoard(); });
  }
}

function render() {
  renderSnapshotBanner();
  renderStatus();
  renderGroups();
  renderThirds();
  renderBracket();
  renderChanges();
  renderTeamSelect();
  if (currentPage() === "team") ensureTeamReport();
  if (currentPage() === "bracket") maybeAutoProbabilities();
}

// Make the standings -> bracket ripple legible in place: when an edit changes the projected
// knockouts, summarise the flipped Round-of-32 matchups here, and flag the Bracket tab.
function renderChanges() {
  const strip = $("#bracket-diff");
  const dot = $("#bracket-dot");
  const ch = board.changes;
  if (!ch || (!ch.r32.length && !ch.groups.length)) {
    strip.classList.add("hidden");
    dot.classList.add("hidden");
    return;
  }
  dot.classList.remove("hidden");
  const grpNote = ch.groups.length
    ? `<div class="bd-grp">Final group order changed in ${ch.groups.map((g) => "Group " + g.group).join(", ")}.</div>`
    : "";
  const shown = ch.r32.slice(0, 6);
  const rows = shown.map((c) => `
    <div class="bd-row">
      <span class="bd-no">R32 #${c.match_no}</span>
      <span class="bd-now"><b>${c.abbr_home}</b> v <b>${c.abbr_away}</b></span>
      <span class="bd-was">was ${c.old_abbr_home} v ${c.old_abbr_away}</span>
    </div>`).join("");
  const more = ch.r32.length > 6 ? `<div class="bd-more">+${ch.r32.length - 6} more matchup${ch.r32.length - 6 > 1 ? "s" : ""}</div>` : "";
  const headline = ch.r32.length
    ? `Your edits reshuffle <b>${ch.r32.length}</b> Round-of-32 matchup${ch.r32.length > 1 ? "s" : ""}`
    : `Your edits change the final group order`;
  strip.innerHTML = `
    <div class="bd-head"><span>${headline}</span>
      <a class="bd-link" href="#/bracket">see bracket →</a></div>
    ${grpNote}${rows}${more}`;
  strip.classList.remove("hidden");
}

// The most-likely champion across the simulations (≠ the chalk bracket winner when a team
// with an easier draw wins more often than the one who'd edge it head-to-head).
function mcChampion() {
  if (!mcByTeam) return null;
  let best = null;
  for (const [team, d] of Object.entries(mcByTeam)) {
    if (d && (best === null || d.champion > best.pct)) best = { team, pct: d.champion };
  }
  return best && best.pct > 0 ? best : null;
}

// A shared ?s= link is a frozen snapshot, not the live tournament. Make that explicit so a
// viewer doesn't read stale scores as live, and give them a one-click way back to the live state.
function renderSnapshotBanner() {
  const b = $("#snapshot-banner");
  if (!b) return;
  if (!state.snapshot) { b.classList.add("hidden"); b.innerHTML = ""; return; }
  b.classList.remove("hidden");
  b.innerHTML = `<span class="snap-pin">📌</span>
    <span class="snap-txt">You're viewing a <b>shared snapshot</b> — frozen when it was shared, not the live tournament.</span>
    <a href="#" class="snap-live" id="to-live">Switch to live →</a>`;
  $("#to-live").addEventListener("click", (e) => { e.preventDefault(); goLive(); });
}

// Return to the live tournament: drop the frozen snapshot and any edits/picks (keeps the team).
function goLive() {
  state.snapshot = null; state.overrides = {}; state.ko_overrides = {};
  mcByTeam = null; mcSlots = null; teamReport = null;
  saveState();
  fetchBoard();
}

function renderStatus() {
  const m = board.meta;
  const live = m.live ? `<span class="live">● ${m.live} live</span> · ` : "";
  // Once probabilities are loaded, lead with the honest "who actually wins most often" rather
  // than the chalk-bracket winner, so the header matches the probabilities panel.
  const champ = mcChampion();
  const winner = champ
    ? `most likely winner: <b style="color:var(--gold)">${champ.team}</b> ${Math.round(champ.pct)}%`
    : `projected winner: <b>${m.champion}</b>`;
  $("#status").innerHTML = `${live}${m.played}/${m.total} group games · ${winner}`;
}

// ================================ standings page =================================
function renderGroups() {
  const root = $("#groups");
  // Keep the user's place: a debounced re-render rebuilds these inputs, so remember which
  // score box was focused (and the caret) and restore it after rebuilding.
  const af = document.activeElement;
  const focusKey = af && af.dataset && af.dataset.id
    ? { id: af.dataset.id, side: af.dataset.side, pos: af.selectionStart } : null;
  root.innerHTML = "";
  for (const g of board.groups) {
    const card = el("div", "card");
    card.appendChild(el("h3", null, `Group ${g.group}`));
    const rows = g.table.map((t) => `
      <tr class="${t.tag}">
        <td class="team">${t.team}</td>
        <td>${t.P}</td><td>${t.W}</td><td>${t.D}</td><td>${t.L}</td>
        <td>${t.GD > 0 ? "+" + t.GD : t.GD}</td><td><b>${t.Pts}</b></td>
      </tr>`).join("");
    card.insertAdjacentHTML("beforeend", `
      <table><thead><tr><th class="team">Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr></thead>
      <tbody>${rows}</tbody></table>`);

    const mwrap = el("div", "matches");
    for (const mt of g.matches) {
      const done = mt.status === "final" || mt.status === "in_progress";
      const row = el("div", "matchrow" + (done ? " done" : ""));
      const sh = mt.score ? mt.score[0] : "";
      const sa = mt.score ? mt.score[1] : "";
      const liveBadge = mt.status === "in_progress" ? `<span class="live-badge">${mt.minute || ""}'</span>` : "";
      row.innerHTML = `<span class="mt">${mt.abbr_home}</span>
        <input data-id="${mt.id}" data-side="h" value="${sh}" inputmode="numeric" />
        <span>-</span>
        <input data-id="${mt.id}" data-side="a" value="${sa}" inputmode="numeric" />
        <span class="mt away">${mt.abbr_away} ${liveBadge}</span>`;
      mwrap.appendChild(row);
    }
    card.appendChild(mwrap);
    root.appendChild(card);
  }
  root.querySelectorAll("input").forEach((inp) => inp.addEventListener("input", onScoreEdit));
  if (focusKey) {
    const back = root.querySelector(`input[data-id="${focusKey.id}"][data-side="${focusKey.side}"]`);
    if (back) {
      back.focus();
      try { back.setSelectionRange(focusKey.pos, focusKey.pos); } catch (_) {}
    }
  }
}

// A goal count is a small non-negative integer; clamp typos (NaN, negatives, "999") to 0..30.
function clampGoals(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 30);
}

function onScoreEdit(e) {
  const id = e.target.dataset.id;
  const inputs = document.querySelectorAll(`input[data-id="${id}"]`);
  const h = inputs[0].value.trim(), a = inputs[1].value.trim();
  // Both blank reverts to the live/projected result; otherwise a blank side counts as 0, so
  // state always matches what's shown (no stale half-override) and a half-typed future game
  // isn't wiped — focus/caret are restored across the debounced re-render below.
  if (h === "" && a === "") delete state.overrides[id];
  else state.overrides[id] = { score: [clampGoals(h), clampGoals(a)] };
  mcByTeam = null; mcSlots = null; teamReport = null; // probabilities depend on group scores
  saveState();
  clearTimeout(debounce);
  debounce = setTimeout(fetchBoard, 280);
}

function renderThirds() {
  const root = $("#thirds");
  root.innerHTML = `<h3>Third-place race</h3>
    <div class="combo">Best 8 of 12 advance · combination <b>${board.assignment.combination_key}</b></div>`;
  board.third_race.forEach((t, i) => {
    if (i === board.cut_index) root.appendChild(el("div", "cutline", "— top 8 cut —"));
    const row = el("div", "trow " + (t.qualified ? "in" : "outq"));
    row.innerHTML = `<span>${t.pos}.</span><span style="flex:1">${t.team}</span>
      <span class="grp">${t.group} · ${t.Pts}p ${t.GD > 0 ? "+" + t.GD : t.GD}</span>`;
    root.appendChild(row);
  });
}

// ================================ bracket page ==================================
function renderBracket() {
  const root = $("#bracket");
  root.innerHTML = "";
  const mainRounds = board.round_order.filter((l) => l !== "Third place");
  mainRounds.forEach((label) => {
    const nodes = board.rounds[label] || [];
    if (!nodes.length) return;
    const col = el("div", "round main");
    col.appendChild(el("h4", null, label + (mcByTeam ? " · % to reach" : "")));
    const ties = el("div", "ties");
    for (const n of nodes) ties.appendChild(renderTie(n, label));
    col.appendChild(ties);
    if (label === "Final") {
      // The banner crowns the team the *bracket tree* sends through (the chalk path), so it
      // always agrees with the final node above it.
      if (board.meta.champion) {
        const sub = mcByTeam ? `<span class="cb-sub">chalk bracket winner</span>` : "";
        col.appendChild(el("div", "champion-banner", `🏆 ${board.meta.champion}${sub}`));
      }
      // The simulation's most-likely champion is a separate, clearly-labelled callout — and
      // when it disagrees with the chalk path, we explain *why* (the app's whole point).
      const champ = mcChampion();
      if (champ) {
        const diff = board.meta.champion && board.meta.champion !== champ.team;
        const why = diff
          ? `The bracket is the single most-likely path: every game goes to the favourite, so `
            + `${board.meta.champion} wins it. But the simulation plays the whole tournament `
            + `5,000 times — and ${champ.team} lifts the trophy most often (${Math.round(champ.pct)}%). `
            + `An easier draw or a stronger expected deep run can make a team the likeliest `
            + `champion even when the chalk bracket crowns someone who'd edge it head-to-head.`
          : `${champ.team} wins ${Math.round(champ.pct)}% of the 5,000 simulated tournaments — `
            + `the most of any team, matching the chalk bracket.`;
        const callout = el("div", "mc-champ" + (diff ? " diff" : ""),
          `Most likely to win it all: <b>${champ.team}</b> ${Math.round(champ.pct)}%`
          + ` <span class="info" data-why="${encodeURIComponent(why)}">ⓘ</span>`);
        col.appendChild(callout);
        const inf = callout.querySelector(".info");
        inf.addEventListener("mouseenter", (e) => showTip(decodeURIComponent(e.target.dataset.why), e));
        inf.addEventListener("mouseleave", hideTip);
      }
      const tp = (board.rounds["Third place"] || [])[0];
      if (tp && tp.winner) {
        const loser = tp.winner === tp.home ? tp.away : tp.home;
        col.appendChild(el("div", "thirdplace", `3rd place<br><b>${tp.winner}</b> def. ${loser}`));
      }
    }
    root.appendChild(col);
  });
  renderSimStatus();
  requestAnimationFrame(drawConnectors);
}

function renderTie(n, label) {
  const tie = el("div", "tie");
  tie.appendChild(renderSlot(n, "home", label));
  tie.appendChild(renderSlot(n, "away", label));
  return tie;
}

function slotPct(n, side, team, label) {
  if (mcByTeam) {
    const t = mcByTeam[team];
    const k = STAGE_KEY[label];
    return t && k != null && t[k] != null ? Math.round(t[k]) : null;
  }
  return side === "home" && n.p_home != null ? Math.round(n.p_home * 100) : null;
}

function renderSlot(n, side, label) {
  const isR32 = n.stage === "R32";
  const detTeam = side === "home" ? n.home : n.away;
  const detAbbr = side === "home" ? n.abbr_home : n.abbr_away;
  const dist = (mcSlots && isR32 && mcSlots[String(n.match_no)])
    ? mcSlots[String(n.match_no)][side] : null;
  const isThirdAway = n.third_slot && side === "away";

  // Always label the slot with the chalk-bracket occupant, so a click advances the team you
  // actually see. The marginal "who most likely fills this slot" distribution stays in the ⓘ
  // tooltip and only drives the coin-flip (gold) styling — never the visible name.
  const team = detTeam, abbr = detAbbr;
  let pct = slotPct(n, side, team, label);
  const gold = !!(dist && dist.length) && (isThirdAway || dist[0].pct < VOLATILE_PCT);

  const score = n.score ? n.score[side === "home" ? 0 : 1] : "";
  const isWinner = !gold && n.winner === team;
  // A pick only "counts" as one when it overrides the model — i.e. the team you sent through
  // isn't the one the model itself favours (n.fav). Picking the model's own choice doesn't
  // earn a badge, and clicking it clears the pick entirely (see the click handler below).
  // Flagged even on a gold (coin-flip) slot so a real override is never read as a projection.
  const isPicked = n.picked && n.winner === team && n.winner !== n.fav;
  const slot = el("div", "slot" + (isWinner ? " winner" : "") + (isPicked ? " picked" : "") + (gold ? " marginal" : ""));

  let why = isThirdAway ? n.third_slot.why : null;
  if (dist && dist.length > 1) {
    const top5 = dist.slice(0, 5).map((o) => `${o.team} ${Math.round(o.pct)}%`).join(", ");
    const head = isThirdAway ? "Most likely opponents" : "Most likely to fill this slot";
    why = `${head}: ${top5}.` + (isThirdAway ? `\n\n${n.third_slot.why}` : "");
  }
  const info = why ? `<span class="info" data-why="${encodeURIComponent(why)}">ⓘ</span>` : "";
  const flag = isPicked ? `<span class="pickflag" title="You picked this team through (not the model's projection)">pick</span>` : "";
  slot.innerHTML = `<span class="abbr">${abbr}</span><span class="nm">${team}${info}</span>
    ${flag}<span class="pct">${pct != null ? pct + "%" : ""}</span><span class="sc">${score}</span>`;
  if (pct != null) {
    const bar = el("span", "bar"); bar.style.width = Math.min(100, pct) + "%"; slot.appendChild(bar);
  }
  slot.addEventListener("click", (e) => {
    if (e.target.classList.contains("info")) return;
    // Clicking the team the model already favours reverts this match to the model (clears any
    // pick); clicking the other side records a real override. So "going back" to the model's
    // own choice leaves no leftover pick.
    if (detTeam === n.fav) delete state.ko_overrides[n.match_no];
    else state.ko_overrides[n.match_no] = detTeam;
    saveState();
    fetchBoard();
    scheduleMcRerun();   // refresh the conditioned probabilities to reflect this pick
  });
  const infoSpan = slot.querySelector(".info");
  if (infoSpan) {
    infoSpan.addEventListener("mouseenter", (e) => showTip(decodeURIComponent(e.target.dataset.why), e));
    infoSpan.addEventListener("mouseleave", hideTip);
  }
  return slot;
}

function drawConnectors() {
  const wrap = $("#bracket");
  if (!wrap.offsetParent) return; // bracket page hidden -> geometry is meaningless, skip
  let svg = wrap.querySelector("svg.connectors");
  if (!svg) {
    svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "connectors");
    wrap.prepend(svg);
  }
  svg.innerHTML = "";
  svg.setAttribute("width", wrap.scrollWidth);
  svg.setAttribute("height", wrap.scrollHeight);
  const brect = wrap.getBoundingClientRect();
  const toX = (r) => r.left - brect.left + wrap.scrollLeft;
  const toY = (r) => r.top - brect.top + wrap.scrollTop;
  const mainRounds = board.round_order.filter((l) => l !== "Third place" && (board.rounds[l] || []).length);
  const cols = [...wrap.querySelectorAll(".round.main")];
  for (let c = 0; c < cols.length - 1; c++) {
    const cur = [...cols[c].querySelectorAll(".tie")];
    const nxt = [...cols[c + 1].querySelectorAll(".tie")];
    cur.forEach((node, i) => {
      const target = nxt[Math.floor(i / 2)];
      if (!target) return;
      const a = node.getBoundingClientRect();
      const b = target.getBoundingClientRect();
      const x1 = toX(a) + a.width, y1 = toY(a) + a.height / 2;
      const x2 = toX(b), y2 = toY(b) + b.height / 2;
      const mx = (x1 + x2) / 2;
      const winnerNode = board.rounds[mainRounds[c]][i];
      const advancing = winnerNode && winnerNode.winner;
      const tgtNode = board.rounds[mainRounds[c + 1]][Math.floor(i / 2)];
      const live = advancing && tgtNode && (tgtNode.home === advancing || tgtNode.away === advancing);
      const path = document.createElementNS(SVGNS, "path");
      path.setAttribute("d", `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`);
      path.setAttribute("class", "conn" + (live ? " live" : ""));
      svg.appendChild(path);
    });
  }
}

// ================================ My Team page ==================================
function renderTeamSelect() {
  const sel = $("#team-select");
  if (sel.dataset.filled) { sel.value = state.team || ""; return; }
  sel.innerHTML = `<option value="">Choose a team…</option>`;
  for (const g of board.groups) {
    const og = el("optgroup");
    og.label = `Group ${g.group}`;
    for (const t of g.table) {
      const o = el("option", null, t.team);
      o.value = t.team;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  sel.dataset.filled = "1";
  sel.value = state.team || "";
}

function ensureTeamReport() {
  if (!state.team) { renderTeamReport(); return; }
  if (teamReport && teamReport.team === state.team) { renderTeamReport(); return; }
  fetchTeam();
}

async function fetchTeam() {
  if (!state.team) return;
  const want = state.team;
  const myReq = ++teamReq;            // a newer fetch supersedes this one
  teamLoading = true;
  teamError = null;
  renderTeamReport();
  try {
    const r = await fetch("/api/team", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team: want, overrides: state.overrides,
                             snapshot: state.snapshot, runs: 6000 }),
    });
    if (myReq !== teamReq) return;     // superseded mid-flight; let the latest request own the UI
    if (!r.ok) throw new Error(`server returned ${r.status}`);
    teamReport = await r.json();
  } catch (e) {
    if (myReq === teamReq) teamError = e.message || "request failed";
  } finally {
    if (myReq === teamReq) {
      teamLoading = false;
      renderTeamReport();
    }
  }
}

const STATUS_META = {
  qualified: { cls: "ok", icon: "✓", head: "Through to the Round of 32" },
  eliminated: { cls: "bad", icon: "✗", head: "Eliminated" },
  waiting: { cls: "warn", icon: "⏳", head: "Group games done — waiting on other groups" },
  alive: { cls: "live", icon: "●", head: "Still alive" },
};

function pctBar(label, value, cls) {
  return `<div class="pbar">
    <span class="pl">${label}</span>
    <span class="ptrack"><span class="pfill ${cls || ""}" style="width:${Math.min(100, value)}%"></span></span>
    <span class="pv">${value}%</span></div>`;
}

function renderTeamReport() {
  const root = $("#team-report");
  if (!state.team) {
    root.innerHTML = `<div class="empty">Pick a team above to break down its path.</div>`;
    return;
  }
  if (teamLoading) {
    root.innerHTML = `<div class="empty">Simulating thousands of tournaments for <b>${state.team}</b>…</div>`;
    return;
  }
  if (teamError) {
    root.innerHTML = `<div class="empty">Couldn't load ${state.team}: ${teamError}.
      <button id="team-retry" class="ghost" style="margin-left:8px">Retry</button></div>`;
    $("#team-retry").addEventListener("click", fetchTeam);
    return;
  }
  if (!teamReport) {
    root.innerHTML = `<div class="empty">Pick a team above to break down its path.</div>`;
    return;
  }
  const r = teamReport;
  const sm = STATUS_META[r.status] || STATUS_META.alive;
  const c = r.current;
  const ord = ["1st", "2nd", "3rd", "4th"][c.pos - 1] || c.pos + "th";

  let sub = "";
  if (r.status === "alive") sub = `${r.p_advance}% to reach the Round of 32 across ${r.runs.toLocaleString()} simulations.`;
  else if (r.status === "qualified") sub = r.p_group_win >= 99.9 ? "Group winner — locked." :
    `Most likely to finish ${topFinish(r)} in the group.`;
  else if (r.status === "waiting") sub = `${r.p_advance}% to sneak through as one of the best third-placed teams.`;
  else if (r.status === "eliminated") sub = "No combination of remaining results lets them reach the knockouts.";

  let html = `
    <div class="status-banner ${sm.cls}">
      <div class="sb-icon">${sm.icon}</div>
      <div><div class="sb-head">${sm.head}</div><div class="sb-sub">${sub}</div></div>
    </div>
    <div class="team-grid">
      <div class="tcard">
        <h4>Right now</h4>
        <div class="bigpos">${ord} <span class="dim">in Group ${r.group}</span></div>
        <div class="reclist">
          <span>${c.P} played</span><span>${c.W}W ${c.D}D ${c.L}L</span>
          <span>${c.GD > 0 ? "+" + c.GD : c.GD} GD</span><span><b>${c.Pts} pts</b></span>
        </div>
        <div class="finish-dist">${renderFinish(r.finish)}</div>
      </div>
      <div class="tcard">
        <h4>Chances</h4>
        ${pctBar("Reach Round of 32", r.p_advance, "ok")}
        ${pctBar("Win the group", r.p_group_win, "")}
        ${pctBar("Qualify as a best third", r.p_third_qualify, "warn")}
      </div>
    </div>`;

  if (r.remaining.length) {
    html += `<div class="tcard wide"><h4>What each result is worth</h4>${renderScenarios(r)}</div>`;
  } else {
    html += `<div class="tcard wide"><h4>What each result is worth</h4>
      <div class="dim">No group games left — the table above is final. ${
        r.status === "waiting" ? "Whether they advance now depends on other groups' results." : ""
      }</div></div>`;
  }

  if (r.opponents.length) {
    html += `<div class="tcard wide"><h4>Most likely Round-of-32 opponent</h4>
      <p class="dim small">Across the simulations where ${r.team} advances. Third-place qualifiers
      get their opponent from the 495-combination table, so this can be wide open.</p>
      ${renderOpponents(r.opponents)}</div>`;
  }

  root.innerHTML = html;
}

function topFinish(r) {
  const best = Object.entries(r.finish).sort((a, b) => b[1] - a[1])[0][0];
  return ["1st", "2nd", "3rd", "4th"][best - 1];
}

function renderFinish(f) {
  const labels = { "1": "1st", "2": "2nd", "3": "3rd", "4": "4th" };
  return Object.keys(labels).map((k) => `
    <div class="fcol">
      <div class="fbar"><span style="height:${Math.max(2, f[k])}%"></span></div>
      <div class="fpct">${f[k]}%</div><div class="flab">${labels[k]}</div>
    </div>`).join("");
}

function renderScenarios(r) {
  const LBL = { win: "Win", draw: "Draw", loss: "Lose" };
  return r.remaining.map((m) => {
    const chips = ["win", "draw", "loss"].map((o) => {
      const v = m.outcomes[o];
      const pa = v.p_advance;
      let cls = "mid";
      if (pa === 100) cls = "lock"; else if (pa != null && pa <= 1) cls = "dead";
      const adv = pa == null ? "—" : pa + "%";
      return `<div class="chip ${cls}">
        <div class="chip-t">${LBL[o]}</div>
        <div class="chip-p">${adv}</div>
        <div class="chip-s">through</div></div>`;
    }).join("");
    return `<div class="scen">
      <div class="scen-vs">${m.home ? "vs" : "at"} <b>${m.opponent}</b></div>
      <div class="chips">${chips}</div></div>`;
  }).join("");
}

function renderOpponents(opps) {
  const max = opps[0].pct || 1;
  return `<div class="opps">` + opps.map((o) => `
    <div class="opp">
      <span class="on">${o.team}</span>
      <span class="ot"><span class="of" style="width:${(o.pct / max) * 100}%"></span></span>
      <span class="ov">${o.pct}%</span>
    </div>`).join("") + `</div>`;
}

// ================================ tooltip / MC ==================================
function showTip(text, e) {
  const tip = $("#tooltip");
  tip.textContent = text;
  tip.classList.remove("hidden");
  tip.style.left = Math.min(e.clientX + 12, window.innerWidth - 340) + "px";
  tip.style.top = e.clientY + 14 + "px";
}
function hideTip() { $("#tooltip").classList.add("hidden"); }

// One small bar on the bracket that doubles as (a) a live "a simulation is running" indicator —
// shown for every run, including the quiet re-runs after a pick — and (b) a plain-English legend
// explaining what the percentages mean, with the full detail behind an ⓘ.
function renderSimStatus() {
  const bar = $("#bracket-legend");
  if (!bar) return;
  if (mcLoading) {
    bar.className = "legend running";
    bar.innerHTML = `<span class="lg-dot"></span><span>Updating odds — running 5,000 simulations…</span>`;
    return;
  }
  if (!mcByTeam) { bar.className = "legend hidden"; return; }
  const why =
    `How to read the bracket\n\n` +
    `• Each % on a team is its chance to REACH that round, measured across 5,000 simulated ` +
    `tournaments (not a single-game win chance).\n\n` +
    `• Gold, italic slots are genuine coin-flips — the most-likely team there is under 55%, or ` +
    `it's a chaotic third-place slot whose opponent swings on the 495-rule table.\n\n` +
    `• In the Probabilities panel: "Final" = chance to reach the final, "Win" = chance to win it all.\n\n` +
    `• The odds re-run automatically whenever you edit a score or change a pick.`;
  bar.className = "legend";
  bar.innerHTML =
    `<span class="lg-dot done"></span>` +
    `<span>Odds from <b>5,000 simulations</b> · each % is a team's chance to reach that round</span>` +
    `<span class="info" data-why="${encodeURIComponent(why)}">ⓘ</span>`;
  const inf = bar.querySelector(".info");
  inf.addEventListener("mouseenter", (e) => showTip(decodeURIComponent(e.target.dataset.why), e));
  inf.addEventListener("mouseleave", hideTip);
}

async function loadProbabilities(showPanel) {
  if (mcLoading) return;
  mcLoading = true;
  renderSimStatus();   // subtle "updating odds…" indicator (shows for quiet pick-refreshes too)
  const panel = $("#mc-panel");
  if (showPanel) {
    panel.classList.remove("hidden");
    panel.innerHTML = `<span class="close" onclick="document.getElementById('mc-panel').classList.add('hidden')">✕</span>
      <h3>Probabilities</h3><div class="sub">running 5,000 simulations…</div>`;
  }
  try {
    const r = await fetch("/api/montecarlo", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        overrides: state.overrides, ko_overrides: state.ko_overrides,
        snapshot: state.snapshot, runs: 5000,
      }),
    });
    if (!r.ok) throw new Error(`server returned ${r.status}`);
    const data = await r.json();
    mcByTeam = {};
    data.teams.forEach((t) => { mcByTeam[t.team] = t; });
    mcSlots = data.r32_slots;
    renderStatus();   // header now leads with the most-likely champion
    renderBracket();
    if (showPanel) {
      const top = data.teams.slice(0, 16);
      let html = `<span class="close" onclick="document.getElementById('mc-panel').classList.add('hidden')">✕</span>
        <h3>Probabilities</h3><div class="sub">${data.runs.toLocaleString()} simulated tournaments · "Final" = reach the final, "Win" = win the cup</div>
        <div class="mc-row head"><span>Team</span><span>Final</span><span>Win</span></div>`;
      for (const t of top) {
        html += `<div class="mc-row"><span>${t.team} <span class="grp" style="color:#8b98a5">${t.group}</span>
          <div class="mc-bar" style="width:${Math.max(2, t.champion * 2)}%"></div></span>
          <span>${t.final}%</span><span><b>${t.champion}%</b></span></div>`;
      }
      panel.innerHTML = html;
    }
  } catch (e) {
    if (showPanel) {
      panel.innerHTML = `<span class="close" onclick="document.getElementById('mc-panel').classList.add('hidden')">✕</span>
        <h3>Probabilities</h3><div class="sub">Couldn't run simulations: ${e.message}.</div>`;
    }
  } finally {
    mcLoading = false;
    renderSimStatus();
  }
}

// ============================ share + image export ==============================
// A bracket is only viral if it travels. Picks live in the URL (so a link reproduces
// the exact what-if), and the bracket can be exported as a clean PNG for group chats.

// A shared link is a STATIC snapshot: it freezes every group result currently shown (live +
// your edits) so the bracket reproduces exactly, even after newer real results land. Packed
// into a base64url token: f = frozen flag, o = {matchId:[h,a]} the full group snapshot,
// k = knockout picks {matchNo:team}, t = the chosen "My Team".
function encodeShare() {
  const o = {};
  if (board) {
    for (const g of board.groups)
      for (const mt of g.matches)
        if (mt.score) o[mt.id] = mt.score;   // every result on screen, frozen as final
  }
  const payload = { o, f: 1, k: state.ko_overrides, t: state.team || undefined };
  const json = JSON.stringify(payload);
  return btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeShare(token) {
  try {
    const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(escape(atob(b64)));
    const p = JSON.parse(json);
    if (p.f) {  // frozen link: o is the full group snapshot (the base), not a set of edits.
      return { overrides: {}, ko_overrides: p.k || {}, team: p.t || null, snapshot: p.o || {} };
    }
    const overrides = {};   // legacy link: edits layered on the live base
    for (const [id, sc] of Object.entries(p.o || {})) overrides[id] = { score: sc };
    return { overrides, ko_overrides: p.k || {}, team: p.t || null, snapshot: null };
  } catch (_) {
    return null;
  }
}

// On load: if the URL carries ?s=…, that shared bracket wins over whatever is in
// localStorage. Then strip the token (keeping the route hash) so later edits aren't
// clobbered by a stale link on the next reload.
function hydrateFromUrl() {
  const m = location.search.match(/[?&]s=([^&]+)/);
  if (!m) return;
  const shared = decodeShare(decodeURIComponent(m[1]));
  if (!shared) return;
  state.overrides = shared.overrides;
  state.ko_overrides = shared.ko_overrides;
  state.team = shared.team;
  state.snapshot = shared.snapshot;   // frozen base (or null for a legacy live link)
  saveState();
  history.replaceState(null, "", location.pathname + (location.hash || ""));
}

async function shareLink() {
  const base = location.origin + location.pathname;
  const url = `${base}?s=${encodeShare()}${location.hash || "#/bracket"}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied — paste it anywhere to share this exact bracket");
  } catch (_) {
    window.prompt("Copy this link to share your bracket:", url);
  }
}

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2800);
}

const ROUND_SHORT = {
  "Round of 32": "R32", "Round of 16": "R16", "Quarter-finals": "QF",
  "Semi-finals": "SF", "Final": "Final",
};

// The team shown in an exported R32 slot matches the on-screen bracket: the chalk-bracket
// occupant (the marginal distribution is a hover-only detail that can't render in a static PNG).
function imgSlotTeam(n, side) {
  return side === "home"
    ? { abbr: n.abbr_home, team: n.home }
    : { abbr: n.abbr_away, team: n.away };
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function drawImgSlot(ctx, n, side, x, y, w, h) {
  const { abbr, team } = imgSlotTeam(n, side);
  const detTeam = side === "home" ? n.home : n.away;
  const isWinner = n.winner && (n.winner === team || n.winner === detTeam);
  rrect(ctx, x, y + 1, w, h - 2, 3);
  ctx.fillStyle = isWinner ? "#16361f" : "#121922";
  ctx.fill();
  ctx.fillStyle = isWinner ? "#e3b341" : "#c7d0d9";
  ctx.font = `${isWinner ? "600 " : ""}11px -apple-system, "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(abbr || "—", x + 7, y + h / 2 + 1);
  const sc = n.score ? n.score[side === "home" ? 0 : 1] : null;
  if (sc != null) {
    ctx.textAlign = "right";
    ctx.fillText(String(sc), x + w - 7, y + h / 2 + 1);
    ctx.textAlign = "left";
  }
}

// Draw the whole R32->Final tree to a canvas and trigger a PNG download. Built from the
// `board` data (not a DOM screenshot) so it's dependency-free and looks intentional.
function saveImage() {
  if (!board) {
    toast("Bracket still loading…");
    return;
  }
  const rounds = board.round_order.filter(
    (l) => l !== "Third place" && (board.rounds[l] || []).length);
  if (!rounds.length) return;

  const COLW = 150, GAP = 26, PAD = 28, SLOTH = 17, TIEGAP = 9, HEADER = 100, FOOTER = 38;
  const r32 = board.rounds[rounds[0]] || [];
  const tieH = SLOTH * 2;
  const bodyH = r32.length * tieH + Math.max(0, r32.length - 1) * TIEGAP;
  const W = PAD * 2 + rounds.length * COLW + (rounds.length - 1) * GAP;
  const H = HEADER + bodyH + FOOTER;

  const scale = 2;
  const cv = document.createElement("canvas");
  cv.width = W * scale;
  cv.height = H * scale;
  const ctx = cv.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = "#0b0f14";
  ctx.fillRect(0, 0, W, H);

  // Tie centres per round: R32 evenly spaced, every later tie centred on its two feeders.
  const centers = [];
  const c0 = [];
  for (let i = 0; i < r32.length; i++) c0.push(HEADER + i * (tieH + TIEGAP) + tieH / 2);
  centers.push(c0);
  for (let r = 1; r < rounds.length; r++) {
    const prev = centers[r - 1];
    const nodes = board.rounds[rounds[r]] || [];
    const cur = [];
    for (let j = 0; j < nodes.length; j++) cur.push((prev[2 * j] + prev[2 * j + 1]) / 2);
    centers.push(cur);
  }

  // Connectors behind the boxes.
  ctx.strokeStyle = "rgba(120,140,160,.32)";
  ctx.lineWidth = 1;
  for (let r = 0; r < rounds.length - 1; r++) {
    const x1 = PAD + r * (COLW + GAP) + COLW;
    const x2 = PAD + (r + 1) * (COLW + GAP);
    const mx = (x1 + x2) / 2;
    centers[r].forEach((cy, i) => {
      const ty = centers[r + 1][Math.floor(i / 2)];
      if (ty == null) return;
      ctx.beginPath();
      ctx.moveTo(x1, cy);
      ctx.bezierCurveTo(mx, cy, mx, ty, x2, ty);
      ctx.stroke();
    });
  }

  // Header.
  ctx.fillStyle = "#e3b341";
  ctx.font = `700 24px -apple-system, "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText("World Cup 2026 — My Bracket", PAD, 42);
  ctx.fillStyle = "#9aa6b2";
  ctx.font = `13px -apple-system, "Segoe UI", system-ui, sans-serif`;
  const imgChamp = mcChampion();
  const winnerLine = imgChamp
    ? `Most likely winner: ${imgChamp.team} (${Math.round(imgChamp.pct)}%)`
    : (board.meta.champion ? `Projected winner: ${board.meta.champion}` : "");
  if (winnerLine) ctx.fillText(winnerLine, PAD, 66);
  ctx.fillStyle = "#5f6b76";
  ctx.fillText(`${board.meta.played}/${board.meta.total} group games played`, PAD, 84);

  // Column labels + slots.
  for (let r = 0; r < rounds.length; r++) {
    const x = PAD + r * (COLW + GAP);
    ctx.fillStyle = "#7a8794";
    ctx.font = `600 11px -apple-system, "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(ROUND_SHORT[rounds[r]] || rounds[r], x + COLW / 2, HEADER - 14);
    ctx.textAlign = "left";
    const nodes = board.rounds[rounds[r]] || [];
    nodes.forEach((n, i) => {
      const cy = centers[r][i];
      drawImgSlot(ctx, n, "home", x, cy - SLOTH, COLW, SLOTH);
      drawImgSlot(ctx, n, "away", x, cy, COLW, SLOTH);
    });
  }

  // Footer / branding.
  ctx.fillStyle = "#5b6671";
  ctx.font = `11px -apple-system, "Segoe UI", system-ui, sans-serif`;
  ctx.fillText(location.host || "World Cup 2026 bracket", PAD, H - 14);

  cv.toBlob((blob) => {
    if (!blob) {
      toast("Couldn't render image");
      return;
    }
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = "world-cup-2026-bracket.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("Bracket image saved");
  }, "image/png");
}

// ================================ wiring ========================================
$("#btn-mc").addEventListener("click", () => loadProbabilities(true));
$("#btn-share").addEventListener("click", shareLink);
$("#btn-image").addEventListener("click", saveImage);
$("#btn-reset").addEventListener("click", goLive);  // drop edits, picks, and any frozen snapshot
$("#team-select").addEventListener("change", (e) => {
  state.team = e.target.value || null;
  teamReport = null;
  saveState();
  ensureTeamReport();
});

window.addEventListener("hashchange", route);
window.addEventListener("resize", () => { if (board && currentPage() === "bracket") drawConnectors(); });

hydrateFromUrl();   // a shared ?s=… link seeds the picks before the first fetch
fetchBoard().then(() => {
  if (location.hash === "#mc") { location.hash = "#/bracket"; loadProbabilities(true); }
  route();
});
