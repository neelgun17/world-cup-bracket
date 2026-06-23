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
    return { overrides: s.overrides || {}, ko_overrides: s.ko_overrides || {}, team: s.team || null };
  } catch (_) {
    return { overrides: {}, ko_overrides: {}, team: null };
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

// ================================ data ===========================================
async function fetchBoard() {
  const r = await fetch("/api/board", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overrides: state.overrides, ko_overrides: state.ko_overrides }),
  });
  board = await r.json();
  render();
}

function render() {
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

function renderStatus() {
  const m = board.meta;
  const live = m.live ? `<span class="live">● ${m.live} live</span> · ` : "";
  $("#status").innerHTML = `${live}${m.played}/${m.total} group games · winner: <b>${m.champion}</b>`;
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

function onScoreEdit(e) {
  const id = e.target.dataset.id;
  const inputs = document.querySelectorAll(`input[data-id="${id}"]`);
  const h = inputs[0].value.trim(), a = inputs[1].value.trim();
  // Both blank reverts to the live/projected result; otherwise a blank side counts as 0, so
  // state always matches what's shown (no stale half-override) and a half-typed future game
  // isn't wiped — focus/caret are restored across the debounced re-render below.
  if (h === "" && a === "") delete state.overrides[id];
  else state.overrides[id] = { score: [parseInt(h) || 0, parseInt(a) || 0] };
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
      if (board.meta.champion) {
        const pc = mcByTeam && mcByTeam[board.meta.champion]
          ? ` · ${Math.round(mcByTeam[board.meta.champion].champion)}%` : "";
        col.appendChild(el("div", "champion-banner", `🏆 ${board.meta.champion}${pc}`));
      }
      const tp = (board.rounds["Third place"] || [])[0];
      if (tp && tp.winner) {
        const loser = tp.winner === tp.home ? tp.away : tp.home;
        col.appendChild(el("div", "thirdplace", `3rd place<br><b>${tp.winner}</b> def. ${loser}`));
      }
    }
    root.appendChild(col);
  });
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

  let team = detTeam, abbr = detAbbr, pct = null, gold = false;
  if (dist && dist.length) {
    const top = dist[0];
    team = top.team; abbr = top.abbr; pct = Math.round(top.pct);
    gold = isThirdAway || top.pct < VOLATILE_PCT;
  } else {
    pct = slotPct(n, side, team, label);
  }

  const score = n.score ? n.score[side === "home" ? 0 : 1] : "";
  const isWinner = !gold && n.winner === team;
  const slot = el("div", "slot" + (isWinner ? " winner" : "") + (n.picked && isWinner ? " picked" : "") + (gold ? " marginal" : ""));

  let why = isThirdAway ? n.third_slot.why : null;
  if (dist && dist.length > 1) {
    const top5 = dist.slice(0, 5).map((o) => `${o.team} ${Math.round(o.pct)}%`).join(", ");
    const head = isThirdAway ? "Most likely opponents" : "Most likely to fill this slot";
    why = `${head}: ${top5}.` + (isThirdAway ? `\n\n${n.third_slot.why}` : "");
  }
  const info = why ? `<span class="info" data-why="${encodeURIComponent(why)}">ⓘ</span>` : "";
  slot.innerHTML = `<span class="abbr">${abbr}</span><span class="nm">${team}${info}</span>
    <span class="pct">${pct != null ? pct + "%" : ""}</span><span class="sc">${score}</span>`;
  if (pct != null) {
    const bar = el("span", "bar"); bar.style.width = Math.min(100, pct) + "%"; slot.appendChild(bar);
  }
  slot.addEventListener("click", (e) => {
    if (e.target.classList.contains("info")) return;
    state.ko_overrides[n.match_no] = detTeam;
    saveState();
    fetchBoard();
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
      body: JSON.stringify({ team: want, overrides: state.overrides, runs: 6000 }),
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

function setBracketNote(text) {
  const note = $("#bracket-note");
  if (!text) { note.classList.add("hidden"); return; }
  note.textContent = text;
  note.classList.remove("hidden");
}

async function loadProbabilities(showPanel) {
  if (mcLoading) return;
  mcLoading = true;
  const panel = $("#mc-panel");
  if (showPanel) {
    panel.classList.remove("hidden");
    panel.innerHTML = `<span class="close" onclick="document.getElementById('mc-panel').classList.add('hidden')">✕</span>
      <h3>Probabilities</h3><div class="sub">running 5,000 simulations…</div>`;
  }
  setBracketNote("Simulating to find the most-likely Round-of-32 opponents…");
  try {
    const r = await fetch("/api/montecarlo", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overrides: state.overrides, runs: 5000 }),
    });
    if (!r.ok) throw new Error(`server returned ${r.status}`);
    const data = await r.json();
    mcByTeam = {};
    data.teams.forEach((t) => { mcByTeam[t.team] = t; });
    mcSlots = data.r32_slots;
    renderBracket();
    if (showPanel) {
      const top = data.teams.slice(0, 16);
      let html = `<span class="close" onclick="document.getElementById('mc-panel').classList.add('hidden')">✕</span>
        <h3>Probabilities</h3><div class="sub">${data.runs.toLocaleString()} simulated tournaments · now shown on the bracket too</div>
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
    setBracketNote(null);
  }
}

// ================================ wiring ========================================
$("#btn-mc").addEventListener("click", () => loadProbabilities(true));
$("#btn-reset").addEventListener("click", () => {
  state.overrides = {}; state.ko_overrides = {};
  mcByTeam = null; mcSlots = null; teamReport = null;
  saveState();
  fetchBoard();
});
$("#team-select").addEventListener("change", (e) => {
  state.team = e.target.value || null;
  teamReport = null;
  saveState();
  ensureTeamReport();
});

window.addEventListener("hashchange", route);
window.addEventListener("resize", () => { if (board && currentPage() === "bracket") drawConnectors(); });

fetchBoard().then(() => {
  if (location.hash === "#mc") { location.hash = "#/bracket"; loadProbabilities(true); }
  route();
});
