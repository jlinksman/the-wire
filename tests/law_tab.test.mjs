// The Law tab (2026-11-04): format rotation, the tab's own session, the weekend issue spotter.
// Run: node tests/law_tab.test.mjs
import { onRequestGet, onRequestPost } from "../functions/games.js";
import assert from "node:assert/strict";

const card = (id, area, extra) => Object.assign({ id, area, family: "elements", title: id.toUpperCase() + " — test", jurisdiction: "NY", cite: "cite", source: "https://x", verified: "2026-11-04",
  elements: [{ text: "A", keys: ["a"] }, { text: "B", keys: ["b"] }] }, extra);
const pool = {
  day: null, made: "2026-11-04T10:00:00Z",
  legal: {
    cards: [
      card("c1", "environmental", { cloze: { text: "x ___", answer: "y", accept: ["y"] }, missing: [{ facts: "f", missing: 1, why: "w" }], cases: [{ name: "Alpha v. Beta", cite: "1 N.Y.3d 1", holding: "h1", element: 0 }] }),
      card("c2", "torts", { cases: [{ name: "Gamma v. Delta", cite: "2 N.Y.3d 2", holding: "h2", element: null }], numbers: [{ q: "q?", answer: 3, unit: "years", cite: "CPLR 214" }] }),
      card("c3", "practice", { numbers: [{ q: "n?", answer: 6, unit: "years" }] }),
      card("c4", "contracts", { missing: [{ facts: "g", missing: 0, why: "w" }] }),
    ],
    featured: [], order: ["environmental", "torts", "practice", "contracts"],
    areas: [{ id: "environmental", name: "Environmental", n: 1 }, { id: "torts", name: "Torts", n: 1 }, { id: "practice", name: "Practice", n: 1 }, { id: "contracts", name: "Contracts", n: 1 }],
    issues: [{ id: "i1", title: "Mill", facts: "facts ".repeat(50), claims: [{ card: "c1", why: "raised" }], decoys: [{ card: "c2", why_not: "no" }], verified: "2026-11-04" }],
  },
};
function kv() {
  const m = new Map();
  return { m, get: async (k, t) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => m.set(k, v) };
}
const RealDate = Date;
function at(iso) { globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [iso])); } static now() { return new RealDate(iso).getTime(); } }; }
async function get(env) { const r = await onRequestGet({ request: new Request("https://w/games"), env }); return r.json(); }
async function post(env, b) { const r = await onRequestPost({ request: new Request("https://w/games", { method: "POST", body: JSON.stringify(b) }), env }); return r.json(); }

// Wednesday: the tab has its own session; three cards, a tap format leads, indexes attached.
at("2026-11-04T15:00:00Z");
const env = { WIRE: kv() };
env.WIRE.m.set("games-today.json", JSON.stringify(Object.assign({}, pool, { day: "2026-11-04" })));
let D = await get(env);
assert.ok(D.law && D.law.session, "Wednesday has a tab session");
assert.equal(D.law.slot, null);
const S = D.law.session;
assert.equal(S.cards.length, 3);
assert.ok(["cloze", "missing", "case"].includes(S.cards[0].fmt), "never opens on a type-in: " + S.cards[0].fmt);
for (const c of S.cards) {
  if (c.fmt === "case") { assert.ok(c.case_opts.includes(c.cases[c.cs].name)); assert.ok(c.case_opts.length >= 2); }
  if (c.fmt === "missing") assert.equal(typeof c.mi, "number");
  if (c.fmt === "number") assert.equal(typeof c.nu, "number");
}
assert.equal(D.law.issue, null, "no issue spotter midweek");
assert.equal(D.law.areas.length, 4);
// Same session on reload.
const D2 = await get(env);
assert.deepEqual(D2.law.session.cards.map((c) => c.id + c.fmt), S.cards.map((c) => c.id + c.fmt));

// Finish the tab session with c1's cloze missed: slot "law" done, numbered slots untouched, cz due tomorrow.
const items = S.cards.map((c) => ({ id: { cloze: "cz:" + c.id, elements: "el:" + c.id + ":0", missing: "mi:" + c.id + ":" + c.mi, case: "cs:" + c.id + ":" + c.cs, number: "nu:" + c.id + ":" + c.nu }[c.fmt], type: "element", q: "q", a: "a", ok: false, cert: "think" }));
await post(env, { action: "result", slot: "law", game: "legal", puzzle: S.id, ok: false, score: 0, ms: 1000, items });
D = await get(env);
assert.ok(D.law.done.law, "law marked done");
assert.ok(!Object.keys(D.done).some((k) => /^\d+$/.test(k)), "no numbered slot marked");
assert.equal(D.stats.week.days.slice(-1)[0].done, 0, "the week strip counts slots only");

// Next day: the missed items are due and lead; formats rotate to ones not yet seen.
at("2026-11-05T15:00:00Z");   // Thursday: slot 3 is the law session, so the tab points at it
env.WIRE.m.set("games-today.json", JSON.stringify(Object.assign({}, pool, { day: "2026-11-05" })));
D = await get(env);
assert.ok(D.law.slot, "Thursday: the tab points at slot 3");
const s3 = D.slots.find((x) => x.slot === D.law.slot);
assert.equal(s3.game, "legal");
const missedIds = new Set(S.cards.map((c) => c.id));
assert.ok(s3.puzzle.cards.filter((c) => missedIds.has(c.id)).length >= 2, "due cards lead the next session");
assert.equal(D.callbacks.filter((c) => /^(el|cz|mi|cs|nu):/.test(c.id) && s3.puzzle.cards.some((k) => k.id === c.id.split(":")[1])).length, 0, "no duplicate callbacks for today's law cards");

// Saturday: issue spotter with claims, decoys and two extras.
at("2026-11-07T15:00:00Z");
env.WIRE.m.set("games-today.json", JSON.stringify(Object.assign({}, pool, { day: "2026-11-07" })));
D = await get(env);
assert.ok(D.law.issue, "Saturday has an issue spotter");
assert.equal(D.law.issue.options.length, 4);
assert.ok(D.law.issue.claims[0].title.startsWith("C1"));
await post(env, { action: "result", slot: "issue", game: "issue", puzzle: D.law.issue.pid, ok: false, score: 0, ms: 1000, items: [{ id: "is:i1:c1", type: "fact", q: "q", a: "C1", ok: false }] });
at("2026-11-08T15:00:00Z");
env.WIRE.m.set("games-today.json", JSON.stringify(Object.assign({}, pool, { day: "2026-11-08" })));
D = await get(env);
assert.equal(D.law.issue, null, "the only issue was served; Sunday has none left");
console.log("law tab: all checks passed");
