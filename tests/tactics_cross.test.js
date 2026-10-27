// Cross-check: the page's tactics engine (site/games.js) must agree with pipeline/tactics.py on
// every sampled line. Run: node tests/tactics_cross.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");
const src = fs.readFileSync(path.join(__dirname, "..", "site", "games.js"), "utf8");
const ctx = { window: { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } }, document: { addEventListener() {} }, fetch: async () => ({ ok: false }), Intl, console };
ctx.window.window = ctx.window;
vm.createContext(ctx);
vm.runInContext(src.replace(/^\(function \(\) \{/, "(function () { var window = this.window;"), ctx);
const fx = JSON.parse(execFileSync("python3", [path.join(__dirname, "tactics_fixture.py")], { maxBuffer: 1 << 26 }).toString());
let n = 0, fail = 0, wins = 0;
for (const { board, lines } of fx) for (const { line, win } of lines) {
  n++; if (win) wins++;
  if (ctx.window.wireTactics.replay(board, line) !== win) { fail++; if (fail < 5) console.log("FAIL", board.id, JSON.stringify(line), "python:", win); }
}
console.log(`${n} lines (${wins} winning) across ${fx.length} boards; ${fail} disagreements`);
process.exit(fail || !n ? 1 : 0);
