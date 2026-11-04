// Call it (2026-11-04): calls validate, change until voting starts, lock, and score from results.
// Run: node tests/calls.test.mjs
import { onRequestGet, onRequestPost } from "../functions/games.js";
import assert from "node:assert/strict";

const race = (id, extra) => Object.assign({ id, election: "General election", title: id, where: "Beacon", scope: "local", date: "2027-11-02", closes: "2027-11-02T06:00:00-05:00", seats: 1, kind: "candidate", margin: true,
  candidates: [{ name: "Ann Ash" }, { name: "Bo Birch" }] }, extra);
const races = [race("e:mayor"), race("e:council", { seats: 2, margin: false, candidates: [{ name: "A" }, { name: "B" }, { name: "C" }] }), race("e:prop", { kind: "proposal", candidates: [{ name: "Yes" }, { name: "No" }] })];
const kv = () => { const m = new Map(); return { m, get: async (k, t) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => m.set(k, v) }; };
const RealDate = Date;
const at = (iso) => { globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [iso])); } static now() { return new RealDate(iso).getTime(); } }; };
const get = async (env) => (await onRequestGet({ request: new Request("https://w/games"), env })).json();
const post = async (env, b) => { const r = await onRequestPost({ request: new Request("https://w/games", { method: "POST", body: JSON.stringify(b) }), env }); return [r.status, await r.json()]; };
const env = { WIRE: kv() };
const setPool = (rs, day) => env.WIRE.m.set("games-today.json", JSON.stringify({ day, made: "x", calls: { races: rs, coming: [] } }));

at("2027-10-20T15:00:00Z"); setPool(races, "2027-10-20");
let D = await get(env);
assert.equal(D.calls.open.length, 3);
let [st, j] = await post(env, { action: "call", race: "e:mayor", pick: ["Ann Ash"], conf: 75 });
assert.equal(st, 400, "margin required"); assert.match(j.error, /margin/);
[st] = await post(env, { action: "call", race: "e:council", pick: ["A"], conf: 65 });
assert.equal(st, 400, "two winners required");
[st] = await post(env, { action: "call", race: "e:mayor", pick: ["Nobody"], margin: "lt5", conf: 75 });
assert.equal(st, 400, "unknown name rejected");
[st, j] = await post(env, { action: "call", race: "e:mayor", pick: ["Ann Ash"], margin: "lt5", conf: 75 });
assert.equal(st, 200); assert.deepEqual(j.calls.open.find((r) => r.id === "e:mayor").mine.pick, ["Ann Ash"]);
[st] = await post(env, { action: "call", race: "e:mayor", pick: ["Ann Ash"], margin: "5to15", conf: 85 });
assert.equal(st, 200, "changeable before voting");
[st] = await post(env, { action: "call", race: "e:council", pick: ["A", "B"], conf: 65 });
assert.equal(st, 200);
[st] = await post(env, { action: "call", race: "e:prop", pick: ["Yes"], margin: "gt15", conf: 95 });
assert.equal(st, 200);

// Election morning: locked.
at("2027-11-02T12:00:00Z"); setPool(races, "2027-11-02");
[st, j] = await post(env, { action: "call", race: "e:mayor", pick: ["Bo Birch"], margin: "lt5", conf: 55 });
assert.equal(st, 400); assert.match(j.error, /locked/);
D = await get(env);
assert.equal(D.calls.open.length, 0); assert.equal(D.calls.locked.length, 3); assert.equal(D.calls.record, null);

// Results recorded: mayor right with margin right (8.2 -> 5to15), council wrong, proposal right (margin not asked... prop is margin:true here, gt15 vs 3.0 -> wrong).
at("2027-11-04T15:00:00Z");
setPool([race("e:mayor", { result: { winner: ["Ann Ash"], margin: 8.2, called: "AP", source: "https://x" } }),
  race("e:council", { seats: 2, margin: false, candidates: [{ name: "A" }, { name: "B" }, { name: "C" }], result: { winner: ["A", "C"], margin: null, called: "BOE", source: "https://y" } }),
  race("e:prop", { kind: "proposal", candidates: [{ name: "Yes" }, { name: "No" }], result: { winner: ["Yes"], margin: 3.0, called: "AP", source: "https://z" } })], "2027-11-04");
D = await get(env);
const rec = D.calls.record;
assert.equal(rec.of, 3); assert.equal(rec.right, 2); assert.equal(rec.margin_of, 2); assert.equal(rec.margin_right, 1);
assert.deepEqual(rec.calibration.map((x) => [x.conf, x.hit, x.of]), [[65, 0, 1], [85, 1, 1], [95, 1, 1]]);
assert.equal(rec.brier, Math.round(((0.85 - 1) ** 2 + (0.65 - 0) ** 2 + (0.95 - 1) ** 2) / 3 * 1000) / 1000);
// Scores persist after the races leave the pool.
at("2028-01-10T15:00:00Z"); setPool([], "2028-01-10");
D = await get(env);
assert.equal(D.calls.record.of, 3);
console.log("calls: all checks passed");
