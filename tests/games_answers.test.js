// Typed-answer acceptance for the Puzzle Page (GAMES.md rule 4). Run: node tests/games_answers.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "..", "site", "games.js"), "utf8");
const store = {};
const ctx = { window: { localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } } }, document: { addEventListener() {} }, fetch: async () => ({ ok: false }), Intl, console };
ctx.window.window = ctx.window;
vm.createContext(ctx);
vm.runInContext(src.replace(/^\(function \(\) \{/, "(function () { var window = this.window;"), ctx);
const accepts = ctx.window.wireAccepts;
const cases = [
  ["Nunez", "Laurent Nuñez", [], true],
  ["laurent nunez", "Laurent Nuñez", [], true],
  ["Sen. Schumer", "Charles E. Schumer", ["chuck schumer"], true],
  ["Chuck Schumer", "Charles E. Schumer", ["chuck schumer"], true],
  ["Shumer", "Charles E. Schumer", [], true],        // one typo on a 7-letter surname
  ["Gillibrand", "Charles E. Schumer", [], false],
  ["", "Kirsten Gillibrand", [], false],
  ["Laurent", "Laurent Nuñez", [], false],           // first name alone isn't enough
];
let fail = 0;
for (const [g, a, acc, want] of cases) {
  const got = accepts(g, a, acc);
  if (got !== want) { fail++; console.log("FAIL", JSON.stringify(g), "vs", a, "got", got); } else console.log("ok  ", JSON.stringify(g), "→", a, want);
}
process.exit(fail ? 1 : 0);
