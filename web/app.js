"use strict";

const state = { overrides: {}, ko_overrides: {} };
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
const VOLATILE_PCT = 55; // a slot whose most-likely occupant is below this is a real coin-flip

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

async function fetchBoard() {
  const r = await fetch("/api/board", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  board = await r.json();
  render();
}

function render() {
  renderStatus();
  renderGroups();
  renderThirds();
  renderBracket();
}

function renderStatus() {
  const m = board.meta;
  const live = m.live ? `<span class="live">● ${m.live} live</span> · ` : "";
  $("#status").innerHTML = `${live}${m.played}/${m.total} group games played · projected winner: <b>${m.champion}</b>`;
}

function renderGroups() {
  const root = $("#groups");
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
}

function onScoreEdit(e) {
  const id = e.target.dataset.id;
  const inputs = document.querySelectorAll(`input[data-id="${id}"]`);
  const h = inputs[0].value.trim(), a = inputs[1].value.trim();
  if (h === "" || a === "") delete state.overrides[id];
  else state.overrides[id] = { score: [parseInt(h) || 0, parseInt(a) || 0] };
  mcByTeam = null; mcSlots = null; // probabilities depend on group scores -> stale after an edit
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
  // With Monte-Carlo loaded: each team's chance to REACH this round. Otherwise: the
  // single-match favourite probability (home side only).
  if (mcByTeam) {
    const t = mcByTeam[team];
    const k = STAGE_KEY[label];
    return t && k != null && t[k] != null ? Math.round(t[k]) : null;
  }
  return side === "home" && n.p_home != null ? Math.round(n.p_home * 100) : null;
}

function renderSlot(n, side, label) {
  const isR32 = n.stage === "R32";
  const detTeam = side === "home" ? n.home : n.away;       // the deterministic-scenario occupant
  const detAbbr = side === "home" ? n.abbr_home : n.abbr_away;
  const dist = (mcSlots && isR32 && mcSlots[String(n.match_no)])
    ? mcSlots[String(n.match_no)][side] : null;
  const isThirdAway = n.third_slot && side === "away";

  // Once probabilities are loaded, every R32 slot shows its MOST-LIKELY occupant + occupancy %
  // (never the deterministic team when that team isn't actually the likeliest to be there).
  // The two tiers are purely visual: gold flags the chaotic third-place slots and genuine
  // coin-flips; stable slots are shown plainly.
  let team = detTeam, abbr = detAbbr, pct = null, gold = false;
  if (dist && dist.length) {
    const top = dist[0];                 // the slot's most-likely occupant across simulations
    team = top.team; abbr = top.abbr; pct = Math.round(top.pct);
    gold = isThirdAway || top.pct < VOLATILE_PCT;
  } else {
    pct = slotPct(n, side, team, label);
  }

  const score = n.score ? n.score[side === "home" ? 0 : 1] : "";
  const isWinner = !gold && n.winner === team;  // no single winner when showing a distribution
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
    state.ko_overrides[n.match_no] = detTeam;  // picks act on the real bracket occupant
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
      // Highlight the path that carries this match's projected winner into the next round.
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

function showTip(text, e) {
  const tip = $("#tooltip");
  tip.textContent = text;
  tip.classList.remove("hidden");
  tip.style.left = Math.min(e.clientX + 12, window.innerWidth - 340) + "px";
  tip.style.top = e.clientY + 14 + "px";
}
function hideTip() { $("#tooltip").classList.add("hidden"); }

async function runMonteCarlo() {
  const panel = $("#mc-panel");
  panel.classList.remove("hidden");
  panel.innerHTML = `<span class="close" onclick="document.getElementById('mc-panel').classList.add('hidden')">✕</span>
    <h3>Probabilities</h3><div class="sub">running 5,000 simulations…</div>`;
  const r = await fetch("/api/montecarlo", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overrides: state.overrides, runs: 5000 }),
  });
  const data = await r.json();
  // Wire the per-team probabilities onto the bracket nodes.
  mcByTeam = {};
  data.teams.forEach((t) => { mcByTeam[t.team] = t; });
  mcSlots = data.r32_slots;
  renderBracket();
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

$("#btn-mc").addEventListener("click", runMonteCarlo);
$("#btn-reset").addEventListener("click", () => {
  state.overrides = {}; state.ko_overrides = {}; mcByTeam = null; mcSlots = null; fetchBoard();
});

window.addEventListener("resize", () => { if (board) drawConnectors(); });

// Deep-link: #mc opens straight into the probability view.
fetchBoard().then(() => { if (location.hash === "#mc") runMonteCarlo(); });
