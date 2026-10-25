// Ballot Match (2026-10-24): a public, blind agree/disagree quiz on the races The Wire follows,
// for friends and neighbors. Answers live only in this browser (localStorage); nothing is sent.
// Data: /ballot.json (public information only), served while the owner's share toggle is on.
"use strict";
const $app = document.getElementById("app");
const KEY = "bm.state.v1";
const SCALE = [[2, "Strongly agree"], [1, "Agree"], [0, "Neutral"], [-1, "Disagree"], [-2, "Strongly disagree"]];
const WEIGHT = [[1, "Matters a little"], [2, "Matters"], [3, "Matters a lot"]];
const STATEWIDE = ["governor", "attorney_general", "comptroller"];
let D = null;
let S = load();

function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* private mode: still works for this visit */ } }
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v; else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids) if (c != null && c !== false) n.append(c);
  return n;
}
const link = (href, text) => el("a", { href, target: "_blank", rel: "noopener noreferrer", text });
const show = (...nodes) => { $app.replaceChildren(...nodes.filter(Boolean)); window.scrollTo(0, 0); };
function shuffle(a, seed) { a = a.slice(); let x = seed || 7; for (let i = a.length - 1; i > 0; i--) { x = (x * 1103515245 + 12345) % 2147483648; const j = x % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// Races with at least two candidates who have coded positions can be matched.
function matchable() {
  return D.races.filter((r) => (r.candidates || []).filter((c) => Object.keys(D.stances[c.name] || {}).length >= 2).length >= 2);
}
function itemsFor(raceIds) {
  const names = D.races.filter((r) => raceIds.includes(r.id)).flatMap((r) => r.candidates.map((c) => c.name));
  return D.items.filter((it) => names.some((n) => (D.stances[n] || {})[it.id]));
}
function quickSet(raceIds) {
  // About four statements per race, preferring ones where both candidates have a position.
  const out = new Set();
  for (const r of D.races.filter((r) => raceIds.includes(r.id))) {
    const names = r.candidates.map((c) => c.name);
    const scored = D.items.map((it) => [it, names.filter((n) => (D.stances[n] || {})[it.id]).length]).filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    for (const [it] of scored.filter(([it]) => !out.has(it.id)).slice(0, 4)) out.add(it.id);
  }
  return [...out];
}

async function start() {
  try {
    const r = await fetch("ballot.json", { cache: "no-store" });
    D = await r.json();
  } catch (e) { show(el("p", { text: "Couldn't load the quiz. Try again in a minute." })); return; }
  if (D.closed) { show(el("h1", { text: "Not open right now" }), el("p", { class: "fine", text: "Whoever shared this link has the quiz switched off at the moment." })); return; }
  document.getElementById("asof").textContent = "updated " + new Date(D.built).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (S.election !== D.id) S = { election: D.id };
  if (S.done) results(); else if (S.order) ask(); else home();
}

function home() {
  const local = matchable().filter((r) => !STATEWIDE.includes(r.id));
  const picked = new Set(S.races || STATEWIDE);
  const boxes = local.map((r) => el("label", { class: "check" },
    el("input", { type: "checkbox", checked: picked.has(r.id) ? true : null, onchange: (e) => { e.target.checked ? picked.add(r.id) : picked.delete(r.id); } }),
    el("span", {}, el("b", { text: r.office + (r.district ? " · " + r.district : "") }), el("br"),
      el("span", { class: "fine", text: r.candidates.map((c) => c.name).join(" vs. ") }))));
  const lookup = (D.links || []).find((l) => /registration|poll site|lookup/i.test(l.label + l.url));
  const go = (mode) => {
    const races = [...STATEWIDE.filter((id) => D.races.some((r) => r.id === id)), ...local.filter((r) => picked.has(r.id)).map((r) => r.id)];
    const ids = mode === "quick" ? quickSet(races) : itemsFor(races).map((it) => it.id);
    S = { election: D.id, races, mode, order: shuffle(ids, Date.now() % 100000), answers: {} };
    save(); ask();
  };
  show(
    el("h1", { text: D.title }),
    el("p", { text: "Answer a set of statements about the issues in these races, without knowing who's on which side. At the end you'll see how closely each candidate's public positions match yours, with every position linked to its source." }),
    el("p", { class: "fine", text: "Covers " + (D.jurisdiction || "these races") + ". Your answers stay on this phone." }),
    el("h3", { text: "Statewide (everyone)" }),
    el("p", {}, D.races.filter((r) => STATEWIDE.includes(r.id)).map((r) => r.office).join(" · ")),
    local.length ? el("h3", { text: "Also on your ballot? Tick the ones that are" }) : null,
    ...boxes,
    lookup ? el("p", { class: "fine" }, "Not sure which districts you're in? ", link(lookup.url, "Look up your registration and districts"), ".") : null,
    el("h3", { text: "How long?" }),
    el("button", { class: "btn primary", text: "Quick: about 15 statements", onclick: () => go("quick") }),
    el("button", { class: "btn", text: "Full: every statement for your races", onclick: () => go("full") }),
  );
}

function ask() {
  const byId = Object.fromEntries(D.items.map((it) => [it.id, it]));
  const order = S.order.map((id) => byId[id]).filter(Boolean);
  let i = order.findIndex((it) => !S.answers[it.id]);
  if (i < 0) { S.done = true; save(); results(); return; }
  const render = () => {
    if (i >= order.length) { S.done = true; save(); results(); return; }
    const it = order[i];
    const cur = S.answers[it.id];
    let weight = cur && cur.w ? cur.w : 2;
    const chips = el("div", { class: "chips" }, ...WEIGHT.map(([w, label]) => { const b = el("button", { class: "chip" + (w === weight ? " on" : ""), text: label });
      b.onclick = () => { weight = w; [...chips.children].forEach((c) => c.classList.toggle("on", c === b)); }; return b; }));
    const put = (x) => { S.answers[it.id] = x; save(); i += 1; render(); };
    const ex = D.explain[it.id];
    const exBox = el("div", {});
    show(
      el("div", { class: "prog" }, el("span", { text: (i + 1) + " of " + order.length }), el("span", { class: "bar" }, el("i", { style: "width:" + Math.round(100 * i / order.length) + "%" }))),
      el("h2", { text: it.text }),
      ex ? el("button", { class: "explain", text: "ⓘ What's this about?", onclick: () => { exBox.replaceChildren(explainer(ex)); } }) : null,
      exBox,
      el("p", { class: "fine", text: "How much does this matter to you? (set this first)" }), chips,
      ...SCALE.map(([v, label]) => el("button", { class: "btn opt" + (cur && cur.v === v ? " on" : ""), text: label, onclick: () => put({ v, w: weight }) })),
      el("div", { class: "nav" },
        i > 0 ? el("button", { class: "link", text: "‹ Back", onclick: () => { i -= 1; render(); } }) : el("span"),
        el("button", { class: "link", text: "Skip", onclick: () => put({ skip: true }) }),
        el("button", { class: "link", text: "See results now", onclick: () => { S.done = true; save(); results(); } })));
  };
  render();
}
function explainer(e) {
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (x) { return u; } };
  return el("div", { class: "card" },
    el("h3", { text: "Where things stand" }), el("p", { text: e.now }),
    el("h3", { text: "The case for agreeing" }), el("p", { text: e.case_for }),
    el("h3", { text: "The case for disagreeing" }), el("p", { text: e.case_against }),
    (e.sources || []).length ? el("p", { class: "fine" }, "Sources: ", ...e.sources.flatMap((u, n) => [n ? " · " : "", link(u, host(u))])) : null);
}

function match(name) {
  const st = D.stances[name] || {};
  let num = 0, den = 0, n = 0;
  const rows = [];
  for (const [q, x] of Object.entries(st)) {
    const a = S.answers[q];
    if (!a || a.skip || a.v == null) continue;
    const agree = 1 - Math.abs(a.v - x.v) / 4;
    num += a.w * agree; den += a.w; n += 1;
    rows.push({ q, you: a.v, them: x.v, agree, source: x.source, note: x.note });
  }
  return { pct: den ? Math.round(100 * num / den) : null, n, rows: rows.sort((a, b) => a.agree - b.agree) };
}
// Rough economic and cultural lean from the statements that carry a scale, for "which line".
function lean() {
  const acc = { econ: [0, 0], culture: [0, 0] };
  for (const it of D.items) {
    const a = S.answers[it.id];
    if (!it.axis || !acc[it.axis] || !a || a.skip || a.v == null) continue;
    acc[it.axis][0] += a.v * it.dir * (a.w || 2); acc[it.axis][1] += 2 * (a.w || 2);
  }
  if (acc.econ[1] < 4 || acc.culture[1] < 4) return null;
  return [acc.econ[0] / acc.econ[1], acc.culture[0] / acc.culture[1]];
}
function bestLine(c, me) {
  if (!me || !D.line_info || (c.lines || []).length < 2) return null;
  return c.lines.filter((l) => D.line_info[l]).map((l) => [l, Math.hypot(D.line_info[l].pos[0] - me[0], D.line_info[l].pos[1] - me[1])]).sort((a, b) => a[1] - b[1])[0][0];
}
const label = (v) => (SCALE.find(([k]) => k === v) || [0, "–"])[1];

function softWarning() {
  const given = Object.values(S.answers || {});
  const soft = given.filter((a) => a.skip || a.v === 0).length;
  return given.length && soft / given.length > 1 / 3 ? el("p", { class: "card fine", text: "More than a third of your answers are Neutral or Skip (" + soft + " of " + given.length + "), so these matches rest on fewer real differences." }) : null;
}
function results() {
  const byId = Object.fromEntries(D.items.map((it) => [it.id, it]));
  const me = lean();
  const races = D.races.filter((r) => (S.races || STATEWIDE).includes(r.id));
  const plan = [];
  const blocks = races.map((r) => {
    const ms = r.candidates.map((c) => ({ c, m: match(c.name) })).filter((x) => x.m.n > 0).sort((a, b) => (b.m.n >= 2) - (a.m.n >= 2) || (b.m.pct || 0) - (a.m.pct || 0));
    const top = ms.find((x) => x.m.n >= 2);
    if (top) plan.push({ r, c: top.c, pct: top.m.pct, line: bestLine(top.c, me) });
    return el("details", { class: "card race" },
      el("summary", {}, el("b", { text: r.office + (r.district ? " · " + r.district : "") }), el("br"),
        el("span", { class: "fine", text: ms.length ? ms.map((x) => x.c.name.split(" ").slice(-1)[0] + " " + (x.m.n >= 2 ? x.m.pct + "%" : "—")).join(" · ") + (ms.filter((x) => x.m.n >= 2).length > 1 && new Set(ms.filter((x) => x.m.n >= 2).map((x) => x.m.pct)).size < ms.filter((x) => x.m.n >= 2).length ? " (tied)" : "") : "Not enough answers on this race" })),
      ...r.candidates.map((c) => {
        const m = match(c.name), best = bestLine(c, me);
        return el("div", {},
          el("div", { class: "cand" + (top && top.c === c ? " top1" : "") }, el("span", {}, el("b", { text: c.name }), c.incumbent ? el("span", { class: "fine", text: " · incumbent" }) : null),
            el("span", { class: "pct", text: m.n >= 2 ? m.pct + "%" : "—" })),
          (c.lines || []).length ? el("div", { class: "lines" }, ...c.lines.map((l) => el("span", { class: "line" + (l === best ? " best" : ""), text: l }))) : null,
          el("p", { class: "fine", text: m.n >= 2 ? m.n + " statements in common." : "Too few statements in common to score." }),
          m.rows.length ? el("ul", { class: "pos" }, ...m.rows.map((x) => el("li", {}, el("b", { text: x.agree >= 0.75 ? "Agree · " : x.agree <= 0.25 ? "Differ · " : "Partly · " }),
            "“" + byId[x.q].text + "” You: " + label(x.you) + ". " + c.name.split(" ").slice(-1)[0] + ": " + label(x.them) + (x.note ? " (" + x.note + ")" : "") + " ", x.source ? link(x.source, "source") : null))) : null,
          best ? el("p", { class: "fine", text: "Of " + c.name.split(" ").slice(-1)[0] + "'s lines, your answers sit closest to " + best + ": " + ((D.line_info[best] || {}).what || "") }) : null);
      }));
  });
  const dates = (D.dates || []).filter((d) => !d.date || d.date >= new Date().toISOString().slice(0, 10));
  show(
    el("h1", { text: "Your ballot match" }),
    el("p", { class: "fine", text: "How closely your answers match each candidate's public positions, weighted by how much each statement matters to you. A candidate needs at least two statements in common to be scored. It's one input for your own decision, not a recommendation." }),
    softWarning(),
    el("details", { class: "card" }, el("summary", {}, el("b", { text: "How this works" })),
      el("p", { class: "fine", text: "Statements are shuffled and unlabeled. Each candidate's position is coded only from a source (platform, votes, their own statements, or reliable reporting), checked by a second coder, and linked; a missing position stays missing. Agreement = 1 − weighted distance ÷ largest possible distance (city-block), over the statements you both have a position on, weighted by how much each matters to you. Neutral counts as a middle answer; Skip is left out. Ties are shown as ties. It measures agreement on these statements only, positions can shift, and it isn't advice." })),
    ...blocks,
    plan.length ? el("h3", { text: "Your notes for the booth" }) : null,
    plan.length ? el("ul", { class: "plan" }, ...plan.map((p) => el("li", {}, el("b", { text: p.r.office + ": " }), "closest match " + p.c.name + " (" + p.pct + "%)" + (p.line ? "; of the lines, closest to " + p.line : "")))) : null,
    D.fusion ? el("h3", { text: "Why the line can matter" }) : null, D.fusion ? el("p", { class: "fine", text: D.fusion }) : null,
    dates.length ? el("h3", { text: "Key dates" }) : null,
    dates.length ? el("ul", { class: "plan" }, ...dates.map((d) => el("li", {}, el("b", { text: (d.date ? new Date(d.date + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ": " : "") }), d.label + (d.note ? " (" + d.note + ")" : "") + " ", d.source ? link(d.source, "↗") : null))) : null,
    (D.links || []).length ? el("h3", { text: "Official links" }) : null,
    ...(D.links || []).map((l) => el("p", { class: "fine" }, link(l.url, l.label))),
    el("div", { class: "row" },
      el("button", { class: "btn", text: "Answer more", onclick: () => { const more = itemsFor(S.races).map((it) => it.id).filter((id) => !S.order.includes(id)); S.order = [...S.order, ...shuffle(more, 3)]; S.done = false; save(); ask(); } }),
      el("button", { class: "btn", text: "Start over", onclick: () => { S = { election: D.id }; save(); home(); } })),
  );
}
start();
