"""Smoke test for the built logic puzzles (GAMES.md): every game opens at every tier the Puzzle
Page uses (params from functions/games.js) without an error box, and pressing Solve makes the page
report "solved" to its parent. Run after build-tatham.sh: python tests/tatham_smoke.py site/vendor/puzzles"""
import http.server, json, re, socketserver, sys, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(sys.argv[1]).resolve()
logic = re.search(r"const LOGIC = \{(.*?)\n\};", Path("functions/games.js").read_text(), re.S).group(1)
games = {m.group(1): json.loads(m.group(2)) for m in re.finditer(r"(\w+): (\[[^\]]*\])", logic)}
(root / "_smoke.html").write_text("""<!doctype html><body><script>
window.msgs=[];addEventListener('message',e=>msgs.push(e.data));
function load(src){msgs=[];const f=document.querySelector('iframe')||document.body.appendChild(document.createElement('iframe'));f.width=600;f.height=700;f.src=src;}
</script></body>""")

class Q(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=str(root), **k)
    def log_message(self, *a): pass
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm"}
srv = socketserver.TCPServer(("127.0.0.1", 8799), Q); threading.Thread(target=srv.serve_forever, daemon=True).start()
fails = 0
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 620, "height": 720})
    pg.goto("http://127.0.0.1:8799/_smoke.html")
    for g, tiers in games.items():
        for t, params in enumerate(tiers, 1):
            pg.evaluate(f"load('{g}.html?t={t}#{params}#20261027')")   # query forces a fresh page
            err, frame = [], None
            for _ in range(40):
                pg.wait_for_timeout(250)
                frame = next((f for f in pg.frames if f.url.split("#")[0].split("?")[0].endswith(f"/{g}.html")), None)
                try:
                    if frame and frame.evaluate("!!document.getElementById('puzzlecanvas') && typeof Module !== 'undefined' && !!Module.calledRun"): break
                except Exception:
                    pass
            pg.wait_for_timeout(600)
            visible = frame.evaluate("(()=>{const c=document.getElementById('puzzlecanvas');if(!c)return false;const r=c.getBoundingClientRect();return r.width>100&&r.height>100&&getComputedStyle(c).display!=='none'})()") if frame else False
            if not visible:
                err.append("puzzle canvas not visible")
            if g in ("keen", "towers", "unequal") and t == 1 and frame:
                before = frame.evaluate("document.getElementById('undo').disabled")
                cw = frame.evaluate("(()=>{const c=document.getElementById('puzzlecanvas');const r=c.getBoundingClientRect();return [r.left+r.width*0.1, r.top+r.height*0.1]})()")
                pg.mouse.click(pg.frame_locator("iframe").locator("#puzzlecanvas").bounding_box()["x"] + 25, pg.frame_locator("iframe").locator("#puzzlecanvas").bounding_box()["y"] + 25)
                pg.evaluate("document.querySelector('iframe').contentWindow.postMessage({wireKey:'1'}, location.origin)")
                pg.wait_for_timeout(300)
                if frame.evaluate("document.getElementById('undo').disabled") and before:
                    err.append("number pad key did not reach the puzzle")
            if t == 2:
                Path("shots").mkdir(exist_ok=True)
                pg.screenshot(path=f"shots/{g}.png")
            err += [m for m in pg.evaluate("msgs") if isinstance(m, dict) and m.get("wireTatham") == "error"]
            try:
                frame.evaluate("document.getElementById('solve').click()")
            except Exception as e:
                err.append(str(e)[:200])
            pg.wait_for_timeout(800)
            solved = any(isinstance(m, dict) and m.get("wireTatham") == "solved" for m in pg.evaluate("msgs"))
            ok = not err and solved
            fails += not ok
            print(("ok  " if ok else "FAIL"), g, f"tier {t}", params, "" if ok else f"errors={err} solved={solved}")
    b.close()
(root / "_smoke.html").unlink()
srv.shutdown()
sys.exit(1 if fails else 0)
