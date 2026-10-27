#!/usr/bin/env bash
# Builds the Puzzle Page's logic puzzles from Simon Tatham's Portable Puzzle Collection (MIT
# licence) for the web, at deploy time (GAMES.md). Pinned to one release, checked by SHA-256.
# Two small changes to the official front end:
#   1. post_move() reports the puzzle's status, so The Wire knows when a puzzle is solved
#      (midend_status: >0 solved, <0 lost) and posts it to the parent page.
#   2. A bridge script: the "Mark" toggle (right-click marks iPhone can't make), a dark look
#      (the canvas is inverted, so every game's own palette stays readable), no alert() boxes.
# Output: site/vendor/puzzles/<game>.{html,js,wasm} plus LICENCE. Not committed to git.
set -euo pipefail
VERSION="20260923.616da16"
SHA256="${TATHAM_SHA256:-}"
GAMES="loopy keen towers galaxies signpost dominosa unequal slant range pattern"
OUT="${1:-site/vendor/puzzles}"
WORK="$(mktemp -d)"
UA="TheWire/1.0 (personal news reader; ${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-})"

curl -sSL -A "$UA" -o "$WORK/p.tgz" "https://www.chiark.greenend.org.uk/~sgtatham/puzzles/puzzles-$VERSION.tar.gz"
GOT="$(sha256sum "$WORK/p.tgz" | cut -d' ' -f1)"
echo "puzzles-$VERSION sha256 $GOT"
if [ -n "$SHA256" ] && [ "$GOT" != "$SHA256" ]; then echo "::error::checksum mismatch"; exit 1; fi
tar xzf "$WORK/p.tgz" -C "$WORK"
SRC="$(echo "$WORK"/puzzles-*)"

python3 - "$SRC" <<'PY'
import re, sys, pathlib
src = pathlib.Path(sys.argv[1])
c = src / "emcc.c"
s = c.read_text()
s = s.replace("extern void js_post_init(void);", "extern void js_post_init(void);\nextern void js_puzzle_status(int status);", 1)
old = "static void post_move(void)\n{\n"
assert old in s
s = s.replace(old, old + "    {\n        static int wire_last = 0;\n        int st = midend_status(me);\n        if (st != wire_last) { wire_last = st; if (st) js_puzzle_status(st); }\n    }\n", 1)
c.write_text(s)
l = src / "emcclib.js"
t = l.read_text()
old = "mergeInto(LibraryManager.library, {\n"
assert old in t
t = t.replace(old, old + """    js_puzzle_status: function(st) {
        try { window.parent.postMessage({ wireTatham: st > 0 ? "solved" : "lost" }, location.origin); } catch (e) {}
    },
""", 1)
l.write_text(t)
print("patched emcc.c and emcclib.js")
PY

cd "$SRC"
emcmake cmake -S . -B build-web -DCMAKE_BUILD_TYPE=Release >/dev/null
for g in $GAMES; do cmake --build build-web --target "$g" -j 4 >/dev/null; done
mkdir -p "$OUT"
printf '' > "$WORK/footer.html"
( cd "$OUT" && for g in $GAMES; do perl "$SRC/html/jspage.pl" "$WORK/footer.html" "$SRC/html/$g.html"; done )
for g in $GAMES; do
  cp "build-web/$g.js" "$OUT/"
  [ -f "build-web/$g.wasm" ] && cp "build-web/$g.wasm" "$OUT/"
done
cp LICENCE "$OUT/LICENCE"
cd - >/dev/null
for g in $GAMES; do
  python3 - "$OUT/$g.html" .github/scripts/tatham-bridge.html <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); bridge = pathlib.Path(sys.argv[2]).read_text()
s = p.read_text()
s = s.replace("</head>", bridge.split("<!--BODY-->")[0] + "</head>", 1)
s = s.replace("</body>", bridge.split("<!--BODY-->")[1] + "</body>", 1)
p.write_text(s)
PY
done
ls -la "$OUT" | head -40
du -sh "$OUT"
