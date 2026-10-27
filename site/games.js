// The Wire — Puzzle Page (GAMES.md, approved 2026-10-27). Loaded only when Puzzles opens.
// Four a day, any skipped: slots 1–2 fit a 2-minute gap, 3–4 are for night. Every reveal leads
// back to the news. Results go to /games (Workers KV, private); nothing here goes to the
// engagement log, and partial progress stays on this device.
(function () {
  "use strict";
  const G = { day: null, busy: false };
  const QKEY = "wire.games.q";                // results waiting to be sent
  const PKEY = "wire.games.p.";               // partial progress per puzzle
  const store = window.localStorage;
  const get = (k, d) => { try { const v = store.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const put = (k, v) => { try { store.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };

  // ---------------------------------------------------------------- shared: answers
  // Typed answers (rule 4): accents folded, punctuation ignored, filler words dropped, surname
  // alone accepted, one typo allowed on longer names. No autocomplete.
  const FILLER = new Set(["the", "a", "an", "and", "of", "sen", "senator", "rep", "gov", "governor", "mr", "ms", "mrs", "dr", "president", "justice", "judge", "mayor"]);
  function fold(s) {
    return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w && !FILLER.has(w)).join(" ");
  }
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 2;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  function accepts(guess, answer, accept) {
    const g = fold(guess);
    if (!g) return false;
    const opts = [answer, ...(accept || [])].map(fold).filter(Boolean);
    const last = fold(answer).split(" ").pop();
    if (last && last.length >= 3) opts.push(last);
    return opts.some((o) => o === g || (o.length >= 5 && lev(o, g) <= 1));
  }
  window.wireAccepts = accepts;               // exposed for the CI test

  // Certainty-based marking (rule 6): sure +3/−6, think +2/−2, guess +1/0.
  const CBM = { sure: [3, -6], think: [2, -2], guess: [1, 0] };
  const cbm = (ok, cert) => (CBM[cert] || CBM.think)[ok ? 0 : 1];

  // ---------------------------------------------------------------- shared: results
  function send(r) {
    const q = get(QKEY, []);
    q.push(r);
    put(QKEY, q.slice(-40));
    flush();
  }
  let flushing = false;
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      let q = get(QKEY, []);
      while (q.length) {
        const r = await fetch("games", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ action: "result" }, q[0])) });
        if (!r.ok) break;
        const j = await r.json();
        if (j && j.stats && G.day) G.day.stats = j.stats;
        q = get(QKEY, []).slice(1);
        put(QKEY, q);
      }
    } catch (e) { /* offline: sent next time */ }
    flushing = false;
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flush(); });

  function markDone(slot, res) {
    if (!G.day) return;
    G.day.done = G.day.done || {};
    G.day.done[String(slot)] = res;
    put("wire.games.today", { day: G.day.day, done: Object.keys(G.day.done).length, n: G.day.slots.length });
  }

  // ---------------------------------------------------------------- shared: reveal card
  // What it was, the fact to keep, outlet + time, the source, Open the thread, back in N days.
  function reveal(o) {
    const th = o.thread && ((typeof data !== "undefined" && data && data.threads) || []).find((t) => t.id === o.thread);
    return el("section", { class: "gm-reveal" + (o.ok ? " ok" : " miss") },
      el("div", { class: "gm-verdict", text: o.ok ? "✓ " + (o.verdict || "Solved") : "✗ " + (o.verdict || "Not this time") }),
      o.keep ? el("p", { class: "gm-keep" }, el("b", { text: o.keep })) : null,
      o.why ? el("p", { class: "fine", text: o.why }) : null,
      o.meta ? el("p", { class: "asrc", text: o.meta }) : null,
      el("div", { class: "sactions" },
        o.link ? el("a", { class: "sbtn", href: o.link, target: "_blank", rel: "noopener", text: o.linkText || "Source ↗" }) : null,
        th ? el("button", { class: "sbtn", text: "Open the thread ›", onclick: () => openThread(th) }) : null,
        o.next ? el("button", { class: "sbtn primary", text: o.next.text, onclick: o.next.fn }) : null),
      o.back ? el("p", { class: "fine", text: o.back }) : null);
  }
  const when = (t) => { try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(t)); } catch (e) { return ""; } };

  function certButtons(onPick, label) {
    return el("div", { class: "gm-cert" },
      el("span", { class: "fine", text: label || "How sure?" }),
      ...["sure", "think", "guess"].map((c) => el("button", { class: "sbtn" + (c === "think" ? " primary" : ""), text: c === "sure" ? "Sure" : c === "think" ? "Think so" : "Guess", onclick: () => onPick(c) })));
  }
  function answerInput(ph) {
    return el("input", { class: "tin gm-in", type: "text", placeholder: ph || "Type a name", autocomplete: "off", autocorrect: "off", autocapitalize: "off", spellcheck: "false", enterkeyhint: "go" });
  }
  // Keep the input above the iPhone keyboard.
  function keepVisible(input) {
    input.addEventListener("focus", () => setTimeout(() => input.scrollIntoView({ block: "center", behavior: "smooth" }), 250));
  }

  // ---------------------------------------------------------------- Puzzle Page
  async function load(force) {
    if (G.day && !force && G.day.day === nyDay()) return G.day;
    const r = await fetch("games", { credentials: "same-origin" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    G.day = await r.json();
    put("wire.games.today", { day: G.day.day, done: Object.keys(G.day.done || {}).length, n: (G.day.slots || []).length });
    return G.day;
  }
  function nyDay() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()); }

  const NAMES = { who_said_it: "Who said it", cryptoquote: "Cryptoquote", chess: "Chess", logic: "Logic", connections: "Connections" };
  const LOGIC_NAMES = { loopy: "Loopy", keen: "Keen", towers: "Towers", galaxies: "Galaxies", signpost: "Signpost", dominosa: "Dominosa", unequal: "Unequal", slant: "Slant", range: "Range", pattern: "Pattern" };
  function slotLine(s) {
    const p = s.puzzle || {};
    if (s.game === "logic") return (LOGIC_NAMES[p.game] || p.game) + " · tier " + p.tier;
    if (s.game === "chess") { const th = (p.themes || []).filter((t) => !/^(short|long|veryLong|oneMove|middlegame|endgame|opening|master|masterVsMaster|crushing|advantage|equality)$/.test(t)).slice(0, 2); return "Puzzle rated " + p.rating + (th.length ? " · " + th.join(", ") : ""); }
    if (s.game === "cryptoquote") return ["", "Easy", "Medium", "Hard"][p.tier] + " · " + (p.cipher || "").replace(/[^A-Z]/g, "").length + " letters";
    if (s.game === "who_said_it") return p.outlet ? "From " + p.outlet : "This week's news";
    return "";
  }

  async function openPuzzles() {
    let D;
    openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Puzzles" }), el("p", { class: "fine", text: "Loading today's set…" })], "Puzzles");
    try { D = await load(true); } catch (e) {
      openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Puzzles" }), el("p", { class: "fine", text: "Couldn't load today's puzzles (" + e.message + "). They open again when you're back online." })], "Puzzles");
      return;
    }
    flush();
    const done = D.done || {};
    const n = D.slots.length, k = Object.keys(done).length;
    const st = D.stats || {};
    const nodes = [
      el("h2", { id: "sheet-title", class: "stitle", text: "Puzzles" }),
      el("p", { class: "asrc", text: n + " today" + (k ? " · " + k + " done" : "") + " · as of " + (D.as_of ? when(D.as_of) : "—") }),
    ];
    for (const s of D.slots) {
      const d = done[String(s.slot)];
      nodes.push(el("button", { class: "gm-slot" + (d ? " done" : ""), onclick: () => play(s) },
        el("span", { class: "gm-n", text: String(s.slot) }),
        el("span", { class: "gm-txt" },
          el("span", { class: "gm-t", text: NAMES[s.game] || s.game }),
          el("span", { class: "gm-s", text: (s.slot <= 2 ? "2 min · " : "night · ") + slotLine(s) })),
        el("span", { class: "gm-mark", text: d ? (d.ok ? "✓" : "·") : "›" })));
    }
    if ((D.callbacks || []).length) nodes.push(el("p", { class: "fine", text: "Woven in today: " + D.callbacks.length + " from earlier (they come up inside Who said it)." }));
    nodes.push(el("div", { class: "sactions" },
      el("span", { class: "fine", text: "Brain break:" }),
      ...["logic", "chess"].map((b) => el("button", { class: "chip" + ((D.pick || "logic") === b ? " on" : ""), text: b === "logic" ? "Logic" : "Chess", onclick: async () => {
        try { await fetch("games", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "pick", brain: b }) }); D.pick = b; } catch (e) { /* later */ }
        openPuzzles(); } }))));
    const bits = [st.played7 != null ? "played " + st.played7 + " of the last 7 days" : null, st.sure_right != null ? "when sure, right " + st.sure_right + "%" : null, st.chess ? "chess " + st.chess : null].filter(Boolean);
    if (bits.length) nodes.push(el("p", { class: "fine", text: bits.join(" · ") }));
    const bad = (D.health || []).filter((h) => !h.made);
    if (bad.length) nodes.push(el("details", { class: "gm-health" }, el("summary", { text: "Puzzle health · " + bad.length + " generator" + (bad.length > 1 ? "s" : "") + " made nothing today" }),
      el("ul", { class: "admin" }, ...(D.health || []).map((h) => el("li", { text: (NAMES[h.game] || h.game) + ": made " + h.made + ", dropped " + h.dropped + ((h.why || []).length ? " (" + h.why.map((w) => w[0] + " ×" + w[1]).join("; ") + ")" : "") })))));
    openSheet(nodes, "Puzzles");
  }

  function play(s) {
    if (s.game === "who_said_it") return whoSaidIt(s);
    if (s.game === "cryptoquote") return cryptoquote(s);
    if (s.game === "chess") return chess(s);
    if (s.game === "logic") return logic(s);
    openPuzzles();
  }
  const backBtn = () => el("button", { class: "sbtn wide", text: "‹ Puzzles", onclick: () => openPuzzles() });

  // ---------------------------------------------------------------- Who said it
  // The headline (speaker masked) is shown up front so it's fair cold. Three tries; each miss
  // shows the next hint: date → outlet → role. Then up to three items from earlier, woven in.
  function whoSaidIt(s) {
    const p = s.puzzle;
    const rounds = [{ q: p.quote, a: p.answer, accept: p.accept, hints: p.hints, context: p.context, main: true }];
    for (const c of (G.day && G.day.callbacks) || []) if (c.type === "speaker" && c.id !== p.id) rounds.push({ q: c.q, a: c.a, accept: c.accept, hints: [c.hint].filter(Boolean), id: c.id, link: c.link, thread: c.thread });
    let r = 0, total = 0, mainRes = null;
    const t0 = Date.now();
    const items = [];
    function round() {
      const R = rounds[r];
      let tries = 0, hintN = 0;
      const input = answerInput("Who said it?");
      keepVisible(input);
      const hintBox = el("ul", { class: "gm-hints" });
      const msg = el("p", { class: "fine", text: "" });
      const submit = (cert) => {
        const v = input.value.trim();
        if (!v) { input.focus(); return; }
        tries += 1;
        if (accepts(v, R.a, R.accept)) return finish(true, cert);
        if (tries >= 3) return finish(false, cert);
        msg.textContent = "Not " + v + ". " + (3 - tries) + " left.";
        input.value = "";
        if (R.hints[hintN]) hintBox.append(el("li", { text: ["Said on ", "Reported by ", "Role: "][hintN] + R.hints[hintN] }));
        hintN += 1;
        input.focus();
      };
      function finish(ok, cert) {
        const pts = cbm(ok, cert) - (ok ? Math.max(0, tries - 1) : 0);
        total += pts;
        items.push({ id: R.main ? p.id : R.id, type: "speaker", q: R.q, a: R.a, accept: R.accept, hint: R.hints[R.hints.length - 1] || "", link: R.main ? p.link : R.link, story: R.main ? p.story : null, thread: R.main ? p.thread : R.thread, ok, cert, hinted: tries > 1 });
        if (R.main) mainRes = { ok, cert, tries };
        const more = r + 1 < rounds.length;
        openSheet([
          el("h2", { id: "sheet-title", class: "stitle", text: R.main ? "Who said it" : "From earlier" }),
          el("blockquote", { class: "gm-quote", text: "“" + R.q + "”" }),
          reveal({
            ok, verdict: ok ? (tries === 1 ? "First try" : "Got it") : "It was " + R.a,
            keep: R.a + (R.main && p.role ? " · " + p.role : ""),
            meta: R.main ? [p.outlet, p.t ? when(p.t) : null, p.thread_title ? "thread: " + p.thread_title : null].filter(Boolean).join(" · ") : null,
            link: R.main ? p.link : R.link, linkText: "Read where it was said ↗", thread: R.main ? p.thread : R.thread,
            back: ok ? (cert === "sure" ? "Back in a few days to make it stick." : "Back soon.") : "Back tomorrow.",
            next: more ? { text: "Next: one from earlier ›", fn: () => { r += 1; round(); } } : { text: "Done ›", fn: () => openPuzzles() },
          }),
        ], "Who said it");
        if (!more) {
          const res = { ok: mainRes ? mainRes.ok : ok, score: total, ms: Date.now() - t0, hints: mainRes ? mainRes.tries - 1 : 0, cert: mainRes && mainRes.cert };
          send(Object.assign({ slot: s.slot, game: "who_said_it", puzzle: p.id, items }, res));
          markDone(s.slot, res);
        }
      }
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit("think"); });
      openSheet([
        el("h2", { id: "sheet-title", class: "stitle", text: R.main ? "Who said it" : "From earlier · " + r + " of " + (rounds.length - 1) }),
        R.context ? el("p", { class: "asrc", text: "Story: " + R.context }) : null,
        el("blockquote", { class: "gm-quote", text: "“" + R.q + "”" }),
        hintBox, input, msg,
        certButtons(submit, "Answer — how sure?"),
        el("p", { class: "fine", text: "Surname is enough. Sure scores +3 (−6 if wrong), Think so +2/−2, Guess +1/0." }),
        backBtn(),
      ], "Who said it");
      setTimeout(() => input.focus(), 50);
    }
    round();
  }

  // ---------------------------------------------------------------- Cryptoquote
  // Tap a letter, type its replacement: it fills every instance; a letter already used elsewhere
  // moves here. Hints: a letter → a crib (a word and its position) → the speaker. Check costs a point.
  function cryptoquote(s) {
    const p = s.puzzle;
    const saved = get(PKEY + p.id, null);
    const S = saved || { map: {}, hints: 0, checks: 0, t0: null, ms: 0, speaker: false, crib: false };
    const cipher = p.cipher, plain = p.plain;
    const truth = {};
    for (let i = 0; i < cipher.length; i++) if (/[A-Z]/.test(cipher[i])) truth[cipher[i]] = plain[i];
    if (p.give && !saved) { const c = Object.keys(truth).find((k) => truth[k] === p.given); if (c) S.map[c] = p.given; }
    let sel = null;
    const input = el("input", { class: "gm-hidden", type: "text", autocomplete: "off", autocorrect: "off", autocapitalize: "characters", spellcheck: "false", maxlength: "1", "aria-label": "Letter" });
    const board = el("div", { class: "gm-crypt" });
    const strip = el("div", { class: "gm-strip" });
    const msg = el("p", { class: "fine", text: "" });
    const save = () => put(PKEY + p.id, S);
    function solved() { return Object.keys(truth).every((c) => S.map[c] === truth[c]); }
    function draw() {
      board.replaceChildren(...cipher.split(" ").map((word) => el("span", { class: "gm-word" }, ...word.split("").map((ch) => {
        if (!/[A-Z]/.test(ch)) return el("span", { class: "gm-punct", text: ch });
        const b = el("button", { class: "gm-cell" + (ch === sel ? " sel" : "") + (S.map[ch] ? " filled" : ""), onclick: () => { sel = ch; draw(); input.value = ""; input.focus(); } },
          el("span", { class: "gm-p", text: S.map[ch] || " " }), el("span", { class: "gm-c", text: ch }));
        return b;
      }))));
      const used = new Set(Object.values(S.map));
      strip.replaceChildren(...("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((L) => el("span", { class: "gm-l" + (used.has(L) ? " used" : ""), text: L }))));
    }
    function nextOpen(from) {
      const order = cipher.replace(/[^A-Z]/g, "").split("");
      const start = Math.max(0, order.indexOf(from));
      for (let i = 1; i <= order.length; i++) { const c = order[(start + i) % order.length]; if (!S.map[c]) return c; }
      return null;
    }
    input.addEventListener("input", () => {
      const L = (input.value || "").toUpperCase().replace(/[^A-Z]/g, "").slice(-1);
      input.value = "";
      if (!sel || !L) return;
      if (S.t0 == null) S.t0 = Date.now();
      for (const k of Object.keys(S.map)) if (S.map[k] === L) delete S.map[k];   // reassigning moves it
      S.map[sel] = L;
      save();
      if (solved()) return done(true);
      sel = nextOpen(sel);
      draw();
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Backspace" && sel) { delete S.map[sel]; save(); draw(); } });
    function done(ok) {
      const ms = (S.t0 ? Date.now() - S.t0 : 0) + (S.ms || 0);
      // Revealing more than a third of the alphabet in play isn't a solve.
      if (ok && S.hints > Math.max(2, Object.keys(truth).length / 3)) ok = false;
      const res = { ok, score: ok ? Math.max(1, 10 - S.hints * 2 - S.checks) : 0, ms, hints: S.hints + S.checks };
      send(Object.assign({ slot: s.slot, game: "cryptoquote", puzzle: p.id, items: [] }, res));
      markDone(s.slot, res);
      store.removeItem(PKEY + p.id);
      openSheet([
        el("h2", { id: "sheet-title", class: "stitle", text: "Cryptoquote" }),
        el("blockquote", { class: "gm-quote", text: plain }),
        reveal({ ok, verdict: !ok && S.hints ? "Mostly revealed" : ok ? "Solved in " + Math.max(1, Math.round(ms / 60000)) + " min" + (S.hints ? " · " + S.hints + " hint" + (S.hints > 1 ? "s" : "") : "") : "Revealed",
          keep: "— " + p.speaker + (p.role ? ", " + p.role : ""), meta: [p.outlet, p.t ? when(p.t) : null].filter(Boolean).join(" · "),
          link: p.link, thread: p.thread, next: { text: "Done ›", fn: () => openPuzzles() } }),
      ], "Cryptoquote");
    }
    const hintRow = el("div", { class: "sactions" },
      el("button", { class: "sbtn", text: "Reveal a letter", onclick: () => {
        const c = sel && S.map[sel] !== truth[sel] ? sel : Object.keys(truth).find((k) => S.map[k] !== truth[k]);
        if (!c) return;
        for (const k of Object.keys(S.map)) if (S.map[k] === truth[c]) delete S.map[k];
        S.map[c] = truth[c]; S.hints += 1; save();
        if (solved()) return done(true);
        draw(); } }),
      el("button", { class: "sbtn", text: "Crib", onclick: () => { S.crib = true; S.hints += 1; save(); msg.textContent = "Crib: the word " + p.crib.word + " starts at letter " + (cipher.slice(0, p.crib.at).replace(/[^A-Z]/g, "").length + 1) + "."; } }),
      el("button", { class: "sbtn", text: "Speaker", onclick: () => { S.speaker = true; S.hints += 1; save(); msg.textContent = "Said by " + p.speaker + (p.role ? ", " + p.role : "") + "."; } }),
      el("button", { class: "sbtn", text: "Check", onclick: () => { S.checks += 1; save(); const wrong = Object.keys(S.map).filter((k) => S.map[k] !== truth[k]).length; msg.textContent = wrong ? wrong + " letter" + (wrong > 1 ? "s are" : " is") + " wrong." : "Everything so far is right."; } }),
      el("button", { class: "unsave", text: "Give up", onclick: () => { for (const k of Object.keys(truth)) S.map[k] = truth[k]; done(false); } }));
    if (S.crib) msg.textContent = "Crib: the word " + p.crib.word + " starts at letter " + (cipher.slice(0, p.crib.at).replace(/[^A-Z]/g, "").length + 1) + ".";
    sel = nextOpen(null);
    draw();
    openSheet([
      el("h2", { id: "sheet-title", class: "stitle", text: "Cryptoquote" }),
      el("p", { class: "asrc", text: ["", "Easy", "Medium", "Hard"][p.tier] + " · a quote from this week's news, letters swapped. Speaker hidden." + (p.give ? " One letter is given." : "") }),
      board, strip, input, msg, hintRow,
      el("p", { class: "fine", text: "Progress saves on this device, so you can stop and pick it up later." }),
      backBtn(),
    ], "Cryptoquote");
  }

  // ---------------------------------------------------------------- Chess
  // Lichess puzzle: the opponent's move plays first, then find the only good move (any mate in
  // one is accepted). Tap a piece, then its square. One wrong move fails the puzzle.
  let ChessMod = null;
  async function chess(s) {
    const p = s.puzzle;
    if (!ChessMod) {
      try { ChessMod = await import("./vendor/chess/chess.js"); } catch (e) {
        openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Chess" }), el("p", { class: "fine", text: "Couldn't load the chess engine (" + e.message + ")." }), backBtn()], "Chess");
        return;
      }
    }
    const game = new ChessMod.Chess(p.fen);
    const moves = p.moves.slice();
    const t0 = Date.now();
    let k = 0, from = null, failed = false, last = null;
    const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
    const apply = (uci) => { const m = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" }); last = [uci.slice(0, 2), uci.slice(2, 4)]; return m; };
    apply(moves[0]);
    k = 1;
    const me = game.turn();
    const boardEl = el("div", { class: "gm-board" });
    const msg = el("p", { class: "fine", text: (me === "w" ? "White" : "Black") + " to move. Find the best move." });
    function draw() {
      const files = me === "w" ? "abcdefgh" : "hgfedcba";
      const ranks = me === "w" ? "87654321" : "12345678";
      const cells = [];
      for (const r of ranks) for (const f of files) {
        const sq = f + r, pc = game.get(sq);
        const dark = (files.indexOf(f) + ranks.indexOf(r)) % 2 === 1;
        cells.push(el("button", { class: "gm-sq" + (dark ? " d" : "") + (sq === from ? " sel" : "") + (last && last.includes(sq) ? " last" : ""), "aria-label": sq + (pc ? " " + pc.color + pc.type : ""), onclick: () => tap(sq) },
          pc ? el("span", { class: "gm-pc " + pc.color, text: GLYPH[pc.type] }) : null));
      }
      boardEl.replaceChildren(...cells);
    }
    function tap(sq) {
      if (k >= moves.length || failed) return;
      const pc = game.get(sq);
      if (!from) { if (pc && pc.color === me) { from = sq; draw(); } return; }
      if (pc && pc.color === me) { from = sq; draw(); return; }
      const want = moves[k];
      const promo = want.length > 4 && want.slice(0, 4) === from + sq ? want[4] : "q";
      const tryMove = from + sq + (game.get(from) && game.get(from).type === "p" && /[18]$/.test(sq) ? promo : "");
      const legal = game.moves({ verbose: true }).some((m) => m.from === from && m.to === sq);
      from = null;
      if (!legal) { draw(); return; }
      const isLast = k === moves.length - 1;
      const m = apply(tryMove);
      const right = tryMove === want || (isLast && game.isCheckmate());
      if (!right) { failed = true; draw(); return finish(false, m && m.san); }
      k += 1;
      draw();
      if (k >= moves.length) return finish(true);
      msg.textContent = "Good. Opponent replies…";
      setTimeout(() => { apply(moves[k]); k += 1; msg.textContent = "Your move."; draw(); }, 450);
    }
    function finish(ok, bad) {
      const res = { ok, score: ok ? 1 : 0, ms: Date.now() - t0, hints: 0, rating: p.rating };
      send(Object.assign({ slot: s.slot, game: "chess", puzzle: p.id, items: [] }, res));
      markDone(s.slot, res);
      msg.replaceChildren(reveal({ ok, verdict: ok ? "Solved" : (bad ? bad + " doesn't work" : "Missed"),
        keep: "Themes: " + (p.themes || []).join(", "), meta: "Puzzle rated " + p.rating + " · Lichess puzzle database (CC0)",
        link: p.url, linkText: "See it on Lichess ↗", next: { text: "Done ›", fn: () => openPuzzles() } }));
    }
    draw();
    openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Chess" }), boardEl, msg, backBtn()], "Chess");
  }

  // ---------------------------------------------------------------- Logic (Simon Tatham's Puzzles)
  // The official web build, patched to report "solved" and themed dark (built at deploy time).
  // "Mark" sends a right-click for the marks iPhone can't make (Loopy ×, pencil marks).
  async function logic(s) {
    const p = s.puzzle;
    const src = "vendor/puzzles/" + p.game + ".html#" + p.params + "#" + p.seed;
    let ok = false;
    try { ok = (await fetch("vendor/puzzles/" + p.game + ".html", { method: "HEAD" })).ok; } catch (e) { ok = false; }
    if (!ok) {
      openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Logic" }),
        el("p", { class: "fine", text: "The logic puzzles arrive with the next site deploy. Chess is ready now." }),
        el("button", { class: "sbtn primary", text: "Play chess instead", onclick: async () => { await fetch("games", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "pick", brain: "chess" }) }); G.day = null; openPuzzles(); } }), backBtn()], "Logic");
      return;
    }
    const t0 = Date.now();
    let mark = false, finished = false;
    const frame = el("iframe", { class: "gm-frame", src, title: LOGIC_NAMES[p.game] || p.game });
    const markBtn = el("button", { class: "chip", text: "Mark", onclick: () => { mark = !mark; markBtn.classList.toggle("on", mark); try { frame.contentWindow.postMessage({ wireMark: mark }, location.origin); } catch (e) { /* not ready */ } } });
    const msg = el("p", { class: "fine", text: "Tier " + p.tier + " · " + (LOGIC_NAMES[p.game] || p.game) + ". No guessing needed: every step can be deduced." });
    const onMsg = (ev) => {
      if (ev.origin !== location.origin || !ev.data || !ev.data.wireTatham || finished) return;
      if (ev.data.wireTatham === "solved") {
        finished = true;
        window.removeEventListener("message", onMsg);
        const res = { ok: true, score: 1, ms: Date.now() - t0, hints: 0 };
        send(Object.assign({ slot: s.slot, game: "logic", puzzle: p.id, items: [] }, res));
        markDone(s.slot, res);
        msg.replaceChildren(reveal({ ok: true, verdict: "Solved in " + mmss(Math.round((Date.now() - t0) / 1000)), keep: (LOGIC_NAMES[p.game] || p.game) + " · tier " + p.tier,
          meta: "Simon Tatham's Portable Puzzle Collection (MIT licence)", next: { text: "Done ›", fn: () => openPuzzles() } }));
      }
    };
    window.addEventListener("message", onMsg);
    openSheet([el("h2", { id: "sheet-title", class: "stitle", text: LOGIC_NAMES[p.game] || "Logic" }),
      el("div", { class: "sactions" }, markBtn, el("span", { class: "fine", text: "Rules are under the puzzle." })),
      frame, msg, backBtn()], "Logic");
  }

  // ---------------------------------------------------------------- home card
  function homeCard() {
    const t = get("wire.games.today", null);
    const today = nyDay();
    const done = t && t.day === today ? t.done : 0;
    const n = t && t.day === today ? t.n : 4;
    return el("button", { class: "briefcard gamescard", onclick: openPuzzles },
      el("span", { class: "bc-ico", "aria-hidden": "true", text: "⌗" }),
      el("span", { class: "bc-txt" },
        el("span", { class: "bc-t", text: "Puzzles" }),
        el("span", { class: "bc-s", text: n + " today" + (done ? " · " + done + " done" : "") + " · a break from reading" })));
  }

  window.WireGames = { openPuzzles, homeCard, accepts, flush };
  flush();
})();
