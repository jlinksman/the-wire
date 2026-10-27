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

  const NAMES = { timeline: "Timeline", beacon_agenda: "Beacon Agenda", docket: "The Docket", ledger: "The Ledger", friday_quiz: "Friday quiz", legal: "Law refresher", defectors: "Defectors", who_said_it: "Who said it", cryptoquote: "Cryptoquote", chess: "Chess", logic: "Logic", connections: "Connections" };
  const LOGIC_NAMES = { loopy: "Loopy", keen: "Keen", towers: "Towers", galaxies: "Galaxies", signpost: "Signpost", dominosa: "Dominosa", unequal: "Unequal", slant: "Slant", range: "Range", pattern: "Pattern" };
  function slotLine(s) {
    const p = s.puzzle || {};
    if (s.game === "logic") return (LOGIC_NAMES[p.game] || p.game) + " · tier " + p.tier;
    if (s.game === "chess") { const th = (p.themes || []).filter((t) => !/^(short|long|veryLong|oneMove|middlegame|endgame|opening|master|masterVsMaster|crushing|advantage|equality)$/.test(t)).slice(0, 2); return "Puzzle rated " + p.rating + (th.length ? " · " + th.join(", ") : ""); }
    if (s.game === "cryptoquote") return ["", "Easy", "Medium", "Hard"][p.tier] + " · " + (p.cipher || "").replace(/[^A-Z]/g, "").length + " letters";
    if (s.game === "who_said_it") return p.outlet ? "From " + p.outlet : "This week's news";
    if (s.game === "timeline") return (p.cards || []).length + " events · votes and decisions";
    if (s.game === "beacon_agenda") return (p.items || []).length + " items · which board hears it?";
    if (s.game === "docket") return (p.emergency ? "Emergency docket" : "Decided case") + " · " + p.date + (p.in_news ? " · in the news" : "");
    if (s.game === "ledger") return "Estimate · " + ((p.estimate || {}).subject || "");
    if (s.game === "friday_quiz") return (p.questions || []).length + " questions from the week";
    if (s.game === "legal") return (p.cards || []).map((c) => c.title.split(" — ")[0].split(" (")[0]).join(" · ");
    if (s.game === "defectors") return (p.chamber === "senate" ? "Senate" : "House") + " · " + (p.bill || "roll call " + p.num) + (p.in_news ? " · in the news" : "");
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
    if ((D.callbacks || []).length) nodes.push(el("p", { class: "fine", text: "Woven in today: " + D.callbacks.length + " from earlier (they follow the news puzzle)." }));
    nodes.push(el("button", { class: "sbtn wide", text: "Library: name them all, match ›", onclick: () => openLibrary() }));
    nodes.push(el("div", { class: "sactions" },
      el("span", { class: "fine", text: "Brain break:" }),
      ...["logic", "chess"].map((b) => el("button", { class: "chip" + ((D.pick || "logic") === b ? " on" : ""), text: b === "logic" ? "Logic" : "Chess", onclick: async () => {
        try { await fetch("games", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "pick", brain: b }) }); D.pick = b; } catch (e) { /* later */ }
        openPuzzles(); } }))));
    const bits = [st.played7 != null ? "played " + st.played7 + " of the last 7 days" : null, st.sure_right != null ? "when sure, right " + st.sure_right + "%" : null, st.chess ? "chess " + st.chess : null, st.ranges90 ? "90% ranges right " + st.ranges90.hit + " of " + st.ranges90.of : null].filter(Boolean);
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
    if (s.game === "defectors") return defectorsGame(s);
    if (s.game === "legal") return legalGame(s);
    if (s.game === "ledger") return ledgerGame(s);
    if (s.game === "docket") return docketGame(s);
    if (s.game === "timeline") return timelineGame(s);
    if (s.game === "beacon_agenda") return agendaGame(s);
    if (s.game === "friday_quiz") return fridayQuiz(s);
    openPuzzles();
  }
  const backBtn = () => el("button", { class: "sbtn wide", text: "‹ Puzzles", onclick: () => openPuzzles() });

  // ---------------------------------------------------------------- Who said it
  // The headline (speaker masked) is shown up front so it's fair cold. Three tries; each miss
  // shows the next hint: date → outlet → role. Then up to three items from earlier, woven in.
  function whoSaidIt(s) {
    const p = s.puzzle;
    const t0 = Date.now();
    let tries = 0, hintN = 0;
    const input = answerInput("Who said it?");
    keepVisible(input);
    const hintBox = el("ul", { class: "gm-hints" });
    const msg = el("p", { class: "fine", text: "" });
    const submit = (cert) => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      tries += 1;
      if (accepts(v, p.answer, p.accept)) return finish(true, cert);
      if (tries >= 3) return finish(false, cert);
      msg.textContent = "Not " + v + ". " + (3 - tries) + " left.";
      input.value = "";
      if (p.hints[hintN]) hintBox.append(el("li", { text: ["Said on ", "Reported by ", "Role: "][hintN] + p.hints[hintN] }));
      hintN += 1;
      input.focus();
    };
    function finish(ok, cert) {
      const score = cbm(ok, cert) - (ok ? Math.max(0, tries - 1) : 0);
      const res = { ok, score, ms: Date.now() - t0, hints: tries - 1, cert };
      send(Object.assign({ slot: s.slot, game: "who_said_it", puzzle: p.id, items: [{ id: p.id, type: "speaker", q: p.quote, a: p.answer, accept: p.accept, hint: p.role || "", link: p.link, story: p.story, thread: p.thread, ok, cert, hinted: tries > 1 }] }, res));
      markDone(s.slot, res);
      openSheet([
        el("h2", { id: "sheet-title", class: "stitle", text: "Who said it" }),
        el("blockquote", { class: "gm-quote", text: "“" + p.quote + "”" }),
        reveal({
          ok, verdict: ok ? (tries === 1 ? "First try" : "Got it") : "It was " + p.answer,
          keep: p.answer + (p.role ? " · " + p.role : ""),
          meta: [p.outlet, p.t ? when(p.t) : null, p.thread_title ? "thread: " + p.thread_title : null].filter(Boolean).join(" · "),
          link: p.link, linkText: "Read where it was said ↗", thread: p.thread,
          back: ok ? (cert === "sure" ? "Back in a few days to make it stick." : "Back soon.") : "Back tomorrow.",
          next: earlierNext(),
        }),
      ], "Who said it");
    }
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit("think"); });
    openSheet([
      el("h2", { id: "sheet-title", class: "stitle", text: "Who said it" }),
      p.context ? el("p", { class: "asrc", text: "Story: " + p.context }) : null,
      el("blockquote", { class: "gm-quote", text: "“" + p.quote + "”" }),
      hintBox, input, msg,
      certButtons(submit, "Answer — how sure?"),
      el("p", { class: "fine", text: "Surname is enough. Sure scores +3 (−6 if wrong), Think so +2/−2, Guess +1/0." }),
      backBtn(),
    ], "Who said it");
    setTimeout(() => input.focus(), 50);
  }

  // ---------------------------------------------------------------- From earlier (callbacks)
  // Due review items, at most three a day, woven in after the news slot: a quote's speaker, or the
  // missing element of a claim. Never a separate review screen.
  function earlierNext() {
    const list = ((G.day && G.day.callbacks) || []).filter((c) => !(G.asked || new Set()).has(c.id));
    return list.length ? { text: "Next: " + list.length + " from earlier ›", fn: () => fromEarlier(list, 0) } : { text: "Done ›", fn: () => openPuzzles() };
  }
  function fromEarlier(list, i) {
    const c = list[i];
    if (!c) return openPuzzles();
    G.asked = G.asked || new Set();
    G.asked.add(c.id);
    const t0 = Date.now();
    const input = answerInput(c.type === "element" ? "The missing element" : "Who said it?");
    keepVisible(input);
    const nextBtn = () => (i + 1 < list.length ? { text: "Next ›", fn: () => fromEarlier(list, i + 1) } : { text: "Done ›", fn: () => openPuzzles() });
    const go = (cert) => {
      const v = input.value.trim();
      if (!v) return input.focus();
      const ok = c.type === "element" ? matchesKeys(v, c.accept) : accepts(v, c.a, c.accept);
      send({ game: "callback", puzzle: c.id, ok, score: cbm(ok, cert), ms: Date.now() - t0, cert, items: [Object.assign({}, c, { ok, cert })] });
      openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "From earlier" }),
        c.type === "speaker" ? el("blockquote", { class: "gm-quote", text: "“" + c.q + "”" }) : el("p", { class: "gm-keep", text: c.q }),
        reveal({ ok, verdict: ok ? "Still there" : "Not quite", keep: c.a, meta: c.hint || null, link: c.link, linkText: c.type === "element" ? "Primary source ↗" : "Source ↗", thread: c.thread, back: ok ? "Spacing it out further." : "Back tomorrow.", next: nextBtn() })], "From earlier");
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") go("think"); });
    const prompt = c.type === "element" ? [el("p", { class: "gm-keep", text: c.q }), el("p", { class: "fine", text: "One element is missing. Which?" })]
      : c.type === "author" ? [el("p", { class: "gm-keep", text: c.q }), el("p", { class: "fine", text: "Which justice?" })]
      : c.type === "roster" ? [el("p", { class: "gm-keep", text: c.q }), el("p", { class: "fine", text: "Who?" })]
      : [el("blockquote", { class: "gm-quote", text: "“" + c.q + "”" }), el("p", { class: "fine", text: "Who said it?" })];
    openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "From earlier · " + (i + 1) + " of " + list.length }), ...prompt, input, certButtons(go, "Answer — how sure?"), backBtn()], "From earlier");
    setTimeout(() => input.focus(), 50);
  }
  function matchesKeys(v, keys) {
    const g = " " + fold(v) + " ";
    return (keys || []).some((k) => { const f = fold(k); return f && g.includes(" " + f + " ") || (f.length >= 6 && g.includes(f)); });
  }

  // ---------------------------------------------------------------- Legal refreshers
  // Three cards; a statute cloze leads (never opens on a type-in). Type the elements one at a time;
  // each element is matched on its key words and becomes its own review item. Cited, with the
  // primary source and "verified" date on every reveal.
  function legalGame(s) {
    const P = s.puzzle;
    const t0 = Date.now();
    const out = { right: 0, total: 0, items: [] };
    const feat = Object.fromEntries((P.featured || []).map((f) => [f.card, f]));
    function card(k) {
      const c = P.cards[k];
      if (!c) return finishAll();
      if (c.cloze && !card.didCloze?.[c.id]) return cloze(c, k);
      return elements(c, k);
    }
    card.didCloze = {};
    const header = (c, k) => [
      el("h2", { id: "sheet-title", class: "stitle", text: "Law · " + (k + 1) + " of " + P.cards.length }),
      feat[c.id] ? el("p", { class: "asrc", text: "From today: " + feat[c.id].title + (feat[c.id].outlet ? " (" + feat[c.id].outlet + ")" : "") }) : null,
      el("p", { class: "gm-keep" }, el("b", { text: c.title }), el("span", { class: "fine", text: " · " + c.jurisdiction })),
    ];
    function cloze(c, k) {
      const input = answerInput("Fill the blank");
      keepVisible(input);
      const go = (cert) => {
        const v = input.value.trim();
        if (!v) return input.focus();
        const ok = (c.cloze.accept || [c.cloze.answer]).some((a) => fold(a) === fold(v)) || matchesKeys(v, c.cloze.accept);
        out.total += 1; if (ok) out.right += 1;
        out.items.push({ id: "cz:" + c.id, type: "element", q: c.cloze.text, a: c.cloze.answer, accept: c.cloze.accept, hint: c.cite, link: c.cloze.source || c.source, ok, cert });
        card.didCloze[c.id] = true;
        openSheet([...header(c, k), el("blockquote", { class: "gm-quote", text: c.cloze.text.replace("___", c.cloze.answer.toUpperCase()) }),
          reveal({ ok, verdict: ok ? "Right" : "It's “" + c.cloze.answer + "”", keep: c.cite, meta: "Verified against the official text " + c.verified, link: c.cloze.source || c.source, linkText: "Official text ↗", next: { text: "Now the elements ›", fn: () => elements(c, k) } })], "Law");
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") go("think"); });
      openSheet([...header(c, k), el("blockquote", { class: "gm-quote", text: c.cloze.text }), input, certButtons(go, "Answer — how sure?"), backBtn()], "Law");
      setTimeout(() => input.focus(), 50);
    }
    function elements(c, k) {
      const got = new Set();
      const input = answerInput("Type an element");
      keepVisible(input);
      const list = el("ol", { class: "gm-hints" });
      const draw = () => list.replaceChildren(...c.elements.map((e, j) => el("li", { text: got.has(j) ? "✓ " + e.text : "▒▒▒" })));
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const j = c.elements.findIndex((x, n) => !got.has(n) && matchesKeys(input.value, x.keys));
        if (j >= 0) { got.add(j); input.value = ""; draw(); if (got.size === c.elements.length) done("sure"); }
        else input.select();
      });
      function done(cert) {
        c.elements.forEach((e, j) => {
          const ok = got.has(j);
          out.total += 1; if (ok) out.right += 1;
          const others = c.elements.map((x, n) => (n === j ? "▒▒▒" : x.text.split(" (")[0])).join(" · ");
          out.items.push({ id: "el:" + c.id + ":" + j, type: "element", q: c.title + ": " + others, a: e.text, accept: e.keys, hint: c.cite, link: c.source, ok, cert: ok ? cert : "think", hinted: false });
        });
        openSheet([...header(c, k), el("ol", { class: "gm-hints" }, ...c.elements.map((e, j) => el("li", { text: (got.has(j) ? "✓ " : "✗ ") + e.text }))),
          c.note ? el("p", { class: "fine", text: "Note: " + c.note }) : null,
          reveal({ ok: got.size === c.elements.length, verdict: got.size + " of " + c.elements.length + " elements", keep: c.cite, meta: "Our wording from the cited authority · verified " + c.verified,
            link: c.source, linkText: "Primary source ↗", thread: feat[c.id] && feat[c.id].thread, next: k + 1 < P.cards.length ? { text: "Next card ›", fn: () => card(k + 1) } : { text: "Finish ›", fn: () => finishAll() } })], "Law");
      }
      draw();
      openSheet([...header(c, k), el("p", { class: "fine", text: c.elements.length + " elements. Type one and press return; key words are enough." }), list, input,
        certButtons(done, "Done — how sure were you?"), backBtn()], "Law");
      setTimeout(() => input.focus(), 50);
    }
    function finishAll() {
      const ok = out.right / Math.max(1, out.total) >= 0.75;
      const res = { ok, score: out.right, ms: Date.now() - t0, hints: 0 };
      send(Object.assign({ slot: s.slot, game: "legal", puzzle: P.id, items: out.items }, res));
      markDone(s.slot, res);
      openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Law" }),
        reveal({ ok, verdict: out.right + " of " + out.total + " recalled", keep: "Missed elements come back tomorrow; the ones you knew, in a few days.",
          meta: "Refreshers, not advice. Elements in our words from statutes and controlling cases, second-checked.", next: earlierNext() })], "Law");
    }
    card(0);
  }

  // ---------------------------------------------------------------- Defectors
  // A crossover roll call: the result and the party split are shown; first call NY members' votes
  // (one tap each), then name who broke ranks. Plain words say what Yea meant. Scored per vote.
  function defectorsGame(s) {
    const p = s.puzzle;
    const t0 = Date.now();
    const PN = { R: "Republicans", D: "Democrats", I: "Independents" };
    const split = Object.entries(p.tally || {}).map(([k, v]) => (PN[k] || k) + " " + v.yea + "–" + v.nay).join(" · ");
    // NY members in play: the local district first (Beacon is NY-18), then one from each party.
    const ny = (p.ny || []).slice();
    const pickNy = [];
    const local = ny.find((m) => String(m.district) === "18");
    if (local) pickNy.push(local);
    for (const party of ["D", "R"]) { const m = ny.find((x) => x.party === party && !pickNy.includes(x)); if (m) pickNy.push(m); }
    for (const m of ny) if (pickNy.length < 3 && !pickNy.includes(m)) pickNy.push(m);
    const guesses = {};
    const byParty = {};
    for (const b of p.defectors) (byParty[b.party] = byParty[b.party] || []).push(b);
    const named = new Set();
    const head = [
      el("h2", { id: "sheet-title", class: "stitle", text: "Defectors" }),
      el("p", { class: "asrc", text: (p.chamber === "senate" ? "Senate" : "House") + " roll call " + p.num + " · " + p.date + (p.bill ? " · " + p.bill : "") }),
      el("p", { class: "gm-keep", text: p.desc }),
      el("p", { class: "fine", text: p.question + " — " + p.yea_meant + "." }),
      el("p", { class: "asrc", text: "Result: " + p.result + " · " + split }),
    ];
    function stage1() {
      if (!pickNy.length) return stage2();
      const rows = pickNy.map((m) => el("div", { class: "gm-vote" },
        el("span", { text: m.name + " (" + m.party + (m.district ? ", NY-" + m.district : ", NY") + ")" }),
        ...["Yea", "Nay"].map((v) => el("button", { class: "chip" + (guesses[m.name] === v ? " on" : ""), text: v, onclick: () => { guesses[m.name] = v; stage1(); } }))));
      openSheet([...head, el("h3", { class: "sh3", text: "How did they vote?" }), ...rows,
        el("button", { class: "sbtn primary wide", text: "Next: who broke ranks ›", onclick: () => stage2() }), backBtn()], "Defectors");
    }
    function stage2() {
      const input = answerInput("Name a defector");
      keepVisible(input);
      const list = el("ul", { class: "gm-hints" });
      const draw = () => list.replaceChildren(...p.defectors.map((b) => el("li", { text: named.has(b) ? "✓ " + b.name + " (" + b.party + "-" + b.state + ") voted " + b.vote : "▒▒▒ (" + b.party + ") voted " + b.vote })));
      const msg = el("p", { class: "fine", text: "" });
      input.addEventListener("input", () => {
        const hit = p.defectors.find((b) => !named.has(b) && accepts(input.value, b.name, b.accept));
        if (hit) { named.add(hit); input.value = ""; draw(); if (named.size === p.defectors.length) finish(); }
      });
      const need = Object.entries(byParty).map(([k, v]) => v.length + " " + (PN[k] || k) + " voted " + v[0].vote).join("; ");
      draw();
      openSheet([...head, el("h3", { class: "sh3", text: "Who broke ranks?" }), el("p", { class: "fine", text: need + ". Type surnames; each match fills in." }),
        list, input, msg, el("div", { class: "sactions" }, el("button", { class: "sbtn", text: "Done naming", onclick: () => finish() })), backBtn()], "Defectors");
      setTimeout(() => input.focus(), 50);
    }
    function finish() {
      const nyRight = pickNy.filter((m) => guesses[m.name] === m.vote).length;
      const total = pickNy.length + p.defectors.length;
      const got = nyRight + named.size;
      const ok = got / Math.max(1, total) >= 0.6;
      const res = { ok, score: got, ms: Date.now() - t0, hints: 0 };
      send(Object.assign({ slot: s.slot, game: "defectors", puzzle: p.id, items: [] }, res));
      markDone(s.slot, res);
      const congressLink = p.bill ? "https://www.congress.gov/search?q=" + encodeURIComponent(JSON.stringify({ search: p.bill })) : null;
      openSheet([...head,
        el("ul", { class: "gm-hints" }, ...pickNy.map((m) => el("li", { text: (guesses[m.name] === m.vote ? "✓ " : "✗ ") + m.name + " voted " + m.vote }))),
        el("ul", { class: "gm-hints" }, ...p.defectors.map((b) => el("li", { text: (named.has(b) ? "✓ " : "· ") + b.name + " (" + b.party + "-" + b.state + ") voted " + b.vote }))),
        reveal({ ok, verdict: got + " of " + total, keep: split, meta: p.in_news && p.news_title ? "In the news: " + p.news_title : "Official roll call",
          link: p.link, linkText: "Official roll call ↗", thread: p.thread, next: earlierNext() }),
        congressLink ? el("a", { class: "linkbtn", href: congressLink, target: "_blank", rel: "noopener", text: "The bill on congress.gov ↗" }) : null,
      ], "Defectors");
    }
    stage1();
  }

  // ---------------------------------------------------------------- Timeline
  // One card at a time: tap the gap where it belongs. Dates are when it happened (the roll call,
  // the decision), from the record. Three lives; every card links to its source.
  function timelineGame(s) {
    const P = s.puzzle;
    const t0 = Date.now();
    const deck = P.cards.slice();
    const placed = [deck.shift()];
    let lives = 3, right = 0;
    const fmtD = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    function draw(msgText) {
      const cur = deck[0];
      if (!cur || !lives) return finish();
      const line = [];
      placed.forEach((c, i) => {
        line.push(el("button", { class: "gm-gap", text: "＋ here", onclick: () => place(i) }));
        line.push(el("div", { class: "gm-card" }, el("span", { class: "gm-date", text: fmtD(c.date) }), el("span", { text: c.text })));
      });
      line.push(el("button", { class: "gm-gap", text: "＋ here", onclick: () => place(placed.length) }));
      openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Timeline · " + "♥".repeat(lives) }),
        el("div", { class: "gm-card gm-next" }, el("span", { class: "gm-date", text: "When?" }), el("span", { text: cur.text })),
        msgText ? el("p", { class: "fine", text: msgText }) : null,
        el("div", { class: "gm-line" }, ...line), backBtn()], "Timeline");
    }
    function place(i) {
      const cur = deck.shift();
      const before = placed[i - 1], after = placed[i];
      const ok = (!before || before.date <= cur.date) && (!after || cur.date <= after.date);
      let pos = placed.findIndex((c) => c.date > cur.date);
      if (pos < 0) pos = placed.length;
      placed.splice(pos, 0, cur);
      if (ok) right += 1; else lives -= 1;
      draw(ok ? "Right: " + fmtD(cur.date) + "." : "Not quite — it was " + fmtD(cur.date) + ". " + lives + " " + (lives === 1 ? "life" : "lives") + " left.");
    }
    function finish() {
      const ok = !deck.length && lives > 0;
      const res = { ok, score: right, ms: Date.now() - t0, hints: 0 };
      send(Object.assign({ slot: s.slot, game: "timeline", puzzle: P.id, items: [] }, res));
      markDone(s.slot, res);
      openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Timeline" }),
        reveal({ ok, verdict: right + " placed right" + (deck.length ? " · out of lives" : ""), next: earlierNext() }),
        el("div", { class: "gm-line" }, ...placed.concat(deck).sort((a, b) => a.date.localeCompare(b.date)).map((c) => el("a", { class: "gm-card", href: c.link, target: "_blank", rel: "noopener" },
          el("span", { class: "gm-date", text: fmtD(c.date) }), el("span", { text: c.text + " ↗" }))))], "Timeline");
    }
    draw("Place each event on the line. Dates are from the official record.");
  }

  // ---------------------------------------------------------------- Beacon Agenda
  // Which board hears this? Items from Beacon's posted agendas, brought by companies or the City.
  function agendaGame(s) {
    const P = s.puzzle;
    const t0 = Date.now();
    let right = 0;
    function q(i) {
      const it = P.items[i];
      if (!it) return finish();
      openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Beacon Agenda · " + (i + 1) + " of " + P.items.length }),
        el("p", { class: "gm-keep", text: it.text }), el("p", { class: "fine", text: "Which board hears it?" }),
        ...it.options.map((o) => el("button", { class: "gm-slot", onclick: () => answer(it, o, i) }, el("span", { class: "gm-txt" }, el("span", { class: "gm-t", text: o })))), backBtn()], "Beacon Agenda");
    }
    function answer(it, o, i) {
      const ok = o === it.answer;
      if (ok) right += 1;
      openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Beacon Agenda · " + (i + 1) + " of " + P.items.length }),
        el("p", { class: "gm-keep", text: it.text }),
        reveal({ ok, verdict: ok ? "Right" : "It's the " + it.answer, keep: it.answer, meta: it.meeting, link: it.link, linkText: "The agenda ↗",
          next: { text: i + 1 < P.items.length ? "Next ›" : "Finish ›", fn: () => q(i + 1) } })], "Beacon Agenda");
    }
    function finish() {
      const ok = right / P.items.length >= 0.6;
      const res = { ok, score: right, ms: Date.now() - t0, hints: 0 };
      send(Object.assign({ slot: s.slot, game: "beacon_agenda", puzzle: P.id, items: [] }, res));
      markDone(s.slot, res);
      openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Beacon Agenda" }), reveal({ ok, verdict: right + " of " + P.items.length, next: earlierNext() })], "Beacon Agenda");
    }
    q(0);
  }

  // ---------------------------------------------------------------- The Docket
  // A decided Supreme Court case: the Court's own one-line holding (party names masked) — which
  // case is it? Then, for a signed opinion, who wrote it? Always after decision; never criminal
  // cases with private defendants. The reveal links the Court's PDF.
  function docketGame(s) {
    const p = s.puzzle;
    const t0 = Date.now();
    let caseOk = false;
    const head = () => [el("h2", { id: "sheet-title", class: "stitle", text: "The Docket" }),
      el("p", { class: "asrc", text: (p.emergency ? "Emergency application " : "Docket ") + p.docket + " · decided " + p.date }),
      el("blockquote", { class: "gm-quote", text: p.holding })];
    function pickCase() {
      openSheet([...head(), el("p", { class: "fine", text: "Which case held this?" }),
        ...p.options.map((o) => el("button", { class: "gm-slot", onclick: () => { caseOk = o === p.name; afterCase(o); } }, el("span", { class: "gm-txt" }, el("span", { class: "gm-t", text: o })))), backBtn()], "The Docket");
    }
    function afterCase(choice) {
      const signed = p.author_code && !["PC", "D"].includes(p.author_code);
      openSheet([...head(), reveal({ ok: caseOk, verdict: caseOk ? "Right case" : "It was " + p.name, keep: p.name,
        meta: "Holding in the Court's words: " + p.holding_full,
        next: signed ? { text: "Who wrote it? ›", fn: author } : { text: "Finish ›", fn: () => finish(null) } })], "The Docket");
    }
    function author() {
      const input = answerInput("Justice's surname");
      keepVisible(input);
      const go = (cert) => {
        const v = input.value.trim();
        if (!v) return input.focus();
        const ok = (p.author_accept || []).some((a) => fold(a) === fold(v) || fold(a).split(" ").pop() === fold(v).split(" ").pop());
        finish({ ok, cert, guess: v });
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") go("think"); });
      openSheet([...head(), el("p", { class: "gm-keep", text: p.name }), el("p", { class: "fine", text: "Who wrote the opinion of the Court?" }), input, certButtons(go, "Answer — how sure?"), backBtn()], "The Docket");
      setTimeout(() => input.focus(), 50);
    }
    function finish(au) {
      const ok = caseOk && (!au || au.ok);
      const score = (caseOk ? 1 : 0) + (au ? cbm(au.ok, au.cert) : 0);
      const items = au ? [{ id: "au:" + p.id, type: "author", q: "Wrote the opinion in " + p.name + " (" + p.date + ")", a: p.author, accept: p.author_accept, hint: p.docket, link: p.pdf, ok: au.ok, cert: au.cert }] : [];
      const res = { ok, score, ms: Date.now() - t0, hints: 0, cert: au && au.cert };
      send(Object.assign({ slot: s.slot, game: "docket", puzzle: p.id, items }, res));
      markDone(s.slot, res);
      openSheet([...head(), reveal({ ok, verdict: (caseOk ? "Case ✓" : "Case ✗") + (au ? " · author " + (au.ok ? "✓" : "✗") : ""), keep: p.name + (p.author ? " · " + p.author : ""),
        meta: "Supreme Court of the United States · " + p.date, link: p.pdf, linkText: "The opinion (PDF) ↗", next: earlierNext() })], "The Docket");
    }
    pickCase();
  }

  // ---------------------------------------------------------------- The Ledger
  // A figure with a named source: give a range you're 90% sure contains it. Estimathon scoring:
  // a hit scores ceil(high/low) − 1 (lower is better); a miss scores 10. Then "which is bigger?"
  const fmtN = (n) => Number(n).toLocaleString("en-US");
  function ledgerGame(s) {
    const p = s.puzzle, f = p.estimate;
    const t0 = Date.now();
    const lo = el("input", { class: "tin gm-in", type: "text", inputmode: "numeric", placeholder: "Low", autocomplete: "off" });
    const hi = el("input", { class: "tin gm-in", type: "text", inputmode: "numeric", placeholder: "High", autocomplete: "off" });
    const msg = el("p", { class: "fine", text: "" });
    let est = null;
    const num = (x) => Number(String(x.value).replace(/[^0-9.]/g, ""));
    function submit() {
      const a = num(lo), b = num(hi);
      if (!(a > 0) || !(b >= a)) { msg.textContent = "Give a low and a high (high ≥ low)."; return; }
      const hit = f.a >= a && f.a <= b;
      const score = hit ? Math.ceil(b / a) - 1 : 10;
      est = { hit, score, a, b };
      openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "The Ledger" }), el("p", { class: "gm-keep", text: f.q }),
        reveal({ ok: hit, verdict: (hit ? "Inside your range" : "Outside your range") + " · score " + score + (hit ? " (lower is better)" : ""),
          keep: fmtN(f.a) + " " + (f.unit || ""), meta: "Your range: " + fmtN(a) + "–" + fmtN(b) + " · source: " + f.source, link: f.link, linkText: "Source ↗",
          next: (p.pairs || []).length ? { text: "Which is bigger? ›", fn: () => pair(0, 0) } : { text: "Done ›", fn: () => finish(0) } })], "The Ledger");
    }
    function pair(k, right) {
      const pr = p.pairs[k];
      if (!pr) return finish(right);
      const pick = (side) => {
        const ok = (side === "a") === (pr.a.v >= pr.b.v);
        openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Which is bigger?" }),
          el("p", { class: "gm-keep", text: pr.a.q + ": " + fmtN(pr.a.v) }), el("p", { class: "gm-keep", text: pr.b.q + ": " + fmtN(pr.b.v) }),
          reveal({ ok, verdict: ok ? "Right" : "Other way round", meta: "Sources: " + [...new Set([pr.a.source, pr.b.source])].join("; "), link: pr.a.link, linkText: "Source ↗",
            next: { text: k + 1 < p.pairs.length ? "Next pair ›" : "Finish ›", fn: () => pair(k + 1, right + (ok ? 1 : 0)) } })], "The Ledger");
      };
      openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Which is bigger? · " + (k + 1) + " of " + p.pairs.length }),
        el("button", { class: "gm-slot", onclick: () => pick("a") }, el("span", { class: "gm-txt" }, el("span", { class: "gm-t", text: pr.a.q }))),
        el("p", { class: "fine", text: "or" }),
        el("button", { class: "gm-slot", onclick: () => pick("b") }, el("span", { class: "gm-txt" }, el("span", { class: "gm-t", text: pr.b.q }))), backBtn()], "The Ledger");
    }
    function finish(right) {
      const ok = !!(est && est.hit);
      const res = { ok, score: est ? est.score : 10, ms: Date.now() - t0, hints: 0, pairs: right };
      send(Object.assign({ slot: s.slot, game: "ledger", puzzle: p.id, items: [] }, res));
      markDone(s.slot, res);
      openPuzzles();
    }
    [lo, hi].forEach((x) => x.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); }));
    openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "The Ledger" }), el("p", { class: "gm-keep", text: f.q }),
      el("p", { class: "fine", text: "Give a range you're 90% sure contains the answer. Narrow and right scores best; a miss scores 10." }),
      el("div", { class: "gm-range" }, lo, el("span", { text: "to" }), hi), msg,
      el("button", { class: "sbtn primary wide", text: "Lock it in", onclick: submit }), backBtn()], "The Ledger");
    setTimeout(() => lo.focus(), 50);
  }

  // ---------------------------------------------------------------- Friday quiz
  // Ten questions from the week's verified data; tap an answer. The last one carries a wager:
  // say how sure you are first (sure +3/−6, think +2/−2, guess +1/0). Every answer shows its source.
  function fridayQuiz(s) {
    const P = s.puzzle;
    const t0 = Date.now();
    let right = 0, wager = 0;
    function q(i) {
      const Q = P.questions[i];
      if (!Q) return finish();
      const last = i === P.questions.length - 1;
      const ask = (cert) => {
        openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Friday quiz · " + (i + 1) + " of " + P.questions.length + (last ? " · wager: " + cert : "") }),
          el("p", { class: "gm-keep", text: Q.q }),
          ...Q.options.map((o) => el("button", { class: "gm-slot", onclick: () => answer(o, cert) }, el("span", { class: "gm-txt" }, el("span", { class: "gm-t", text: o })))), backBtn()], "Friday quiz");
      };
      const answer = (o, cert) => {
        const ok = o === Q.answer;
        if (ok) right += 1;
        if (last) wager = cbm(ok, cert);
        openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Friday quiz · " + (i + 1) + " of " + P.questions.length }),
          el("p", { class: "gm-keep", text: Q.q }),
          reveal({ ok, verdict: ok ? "Right" : "It was " + Q.answer, keep: Q.answer, why: Q.why || null, meta: Q.source ? "Source: " + Q.source : null, link: Q.link, thread: Q.thread,
            next: { text: last ? "Finish ›" : "Next ›", fn: () => q(i + 1) } })], "Friday quiz");
      };
      if (last) openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Last one: the wager" }), el("p", { class: "fine", text: "Before you see it: how sure are you that you'll get the last question?" }),
        certButtons(ask, "Sure +3/−6 · Think so +2/−2 · Guess +1/0"), backBtn()], "Friday quiz");
      else ask("think");
    }
    function finish() {
      const ok = right / P.questions.length >= 0.6;
      const res = { ok, score: right + wager, ms: Date.now() - t0, hints: 0 };
      send(Object.assign({ slot: s.slot, game: "friday_quiz", puzzle: P.id, items: [] }, res));
      markDone(s.slot, res);
      openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Friday quiz" }),
        reveal({ ok, verdict: right + " of " + P.questions.length + (wager ? " · wager " + (wager > 0 ? "+" : "") + wager : ""), keep: "That's the week.", next: earlierNext() })], "Friday quiz");
    }
    q(0);
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
    // Number puzzles need digits; iPhone shows no keyboard for the canvas, so a pad sends them.
    const size = parseInt(p.params, 10) || 0;
    const pad = ["keen", "towers", "unequal"].includes(p.game) && size ? el("div", { class: "gm-pad" },
      ...Array.from({ length: Math.min(9, size) }, (_, i) => String(i + 1)).concat(["Backspace"]).map((k) => el("button", { class: "sbtn", text: k === "Backspace" ? "⌫" : k,
        onclick: () => { try { frame.contentWindow.postMessage({ wireKey: k }, location.origin); } catch (e) { /* not ready */ } } }))) : null;
    openSheet([el("h2", { id: "sheet-title", class: "stitle", text: LOGIC_NAMES[p.game] || "Logic" }),
      el("div", { class: "sactions" }, markBtn, el("span", { class: "fine", text: pad ? "Tap a square, then a number. Mark + number = pencil mark. Rules under the puzzle." : "Rules are under the puzzle." })),
      frame, pad, msg, backBtn()], "Logic");
  }

  // ---------------------------------------------------------------- Library: Name them all, Match
  // Sporcle-style: type names; each match fills its row (surname is enough, no autocomplete). The
  // clock can pause. Give up shows what you missed in another color, and misses come back later.
  // Match is the first-exposure version for short lists. Local lists first; the featured list is
  // the one in the news this week.
  async function openLibrary() {
    let lib = G.lib;
    if (!lib) {
      try { lib = G.lib = await (await fetch("games?library=1", { credentials: "same-origin" })).json(); } catch (e) { lib = { lists: [], who_left: [] }; }
    }
    const lists = (lib.lists || []).slice();
    // Featured: the list the week's news mentions most, relative to its size (two mentions at least).
    const featured = lists.filter((x) => x.mentions >= 2).sort((a, b) => b.mentions / b.n - a.mentions / a.n)[0];
    const nodes = [el("h2", { id: "sheet-title", class: "stitle", text: "Library" }),
      el("p", { class: "fine", text: "Name them all, or match them. Local first. Lists come from sourced rosters and say how current they are." })];
    for (const w of lib.who_left || []) {
      const L = lists.find((x) => x.id === w.list);
      nodes.push(el("section", { class: "ssec" }, el("h3", { class: "sh3", text: "Who left the list · " + (L ? L.title : w.list) }),
        el("p", { class: "fine", text: "Since " + w.since + ": " + w.gone.length + " left, " + w.new.length + " new. Can you name them?" }),
        el("button", { class: "sbtn", text: "Try it ›", onclick: () => whoLeft(w, L) })));
    }
    if (featured && featured.mentions) nodes.push(el("button", { class: "gm-slot", onclick: () => nameAll(featured) },
      el("span", { class: "gm-n", text: "★" }), el("span", { class: "gm-txt" }, el("span", { class: "gm-t", text: featured.title }), el("span", { class: "gm-s", text: "In this week's news · " + featured.n + " names" })), el("span", { class: "gm-mark", text: "›" })));
    let group = null;
    for (const L of lists) {
      if (L.group !== group) { group = L.group; nodes.push(el("h3", { class: "sh3", text: group })); }
      nodes.push(el("div", { class: "gm-libl" },
        el("span", { class: "gm-t", text: L.title + " · " + L.n }),
        el("button", { class: "chip", text: "Name them", onclick: () => nameAll(L) }),
        L.n <= 14 ? el("button", { class: "chip", text: "Match", onclick: () => matchGame(L) }) : null));
    }
    nodes.push(el("button", { class: "sbtn wide", text: "‹ Puzzles", onclick: () => openPuzzles() }));
    openSheet(nodes, "Library");
  }

  function nameAll(L) {
    const t0 = Date.now();
    const limit = (L.minutes || Math.max(2, Math.ceil(L.n / 8))) * 60;
    let used = 0, running = true, last = Date.now(), over = false;
    const got = new Set();
    const input = answerInput("Type a name");
    keepVisible(input);
    const rows = L.items.map((x) => el("li", { class: "gm-row" }, el("span", { class: "gm-clue", text: x.clue || "" }), el("span", { class: "gm-name", text: "" })));
    const list = el("ol", { class: "gm-rows" }, ...rows);
    const clock = el("span", { class: "asrc", text: "" });
    const count = el("span", { class: "asrc", text: "0 / " + L.n });
    const pauseBtn = el("button", { class: "chip", text: "Pause", onclick: () => { running = !running; last = Date.now(); pauseBtn.textContent = running ? "Pause" : "Resume"; input.disabled = !running; if (running) input.focus(); } });
    const tick = setInterval(() => {
      if (!document.body.contains(clock)) return clearInterval(tick);
      if (running && !over) { used += (Date.now() - last) / 1000; last = Date.now(); }
      const left = Math.max(0, limit - used);
      clock.textContent = mmss(Math.ceil(left));
      if (!left && !over) finish();
    }, 250);
    input.addEventListener("input", () => {
      if (over) return;
      const v = input.value;
      const k = L.items.findIndex((x, i) => !got.has(i) && accepts(v, x.answer, x.accept));
      if (k >= 0) {
        got.add(k); rows[k].classList.add("got"); rows[k].lastChild.textContent = L.items[k].answer;
        input.value = ""; count.textContent = got.size + " / " + L.n;
        if (got.size === L.n) finish();
      }
    });
    function finish() {
      if (over) return;
      over = true; clearInterval(tick); input.disabled = true;
      L.items.forEach((x, i) => { if (!got.has(i)) { rows[i].classList.add("miss"); rows[i].lastChild.textContent = x.answer; } });
      const ok = got.size / L.n >= 0.8;
      const items = L.items.map((x, i) => ({ id: "ro:" + L.id + ":" + fold(x.answer).replace(/ /g, "_").slice(0, 24), type: "roster", q: (x.clue ? x.clue + " — " : "") + L.title, a: x.answer, accept: x.accept, hint: L.source, ok: got.has(i), cert: got.has(i) ? "think" : "guess" }))
        .filter((x) => !x.ok).slice(0, 12);                // only misses enter the review schedule
      send({ game: "name_all", puzzle: L.id, ok, score: got.size, ms: Date.now() - t0, hints: 0, items });
      done.replaceChildren(reveal({ ok, verdict: got.size + " of " + L.n + " in " + mmss(Math.round(used)), keep: L.n - got.size ? "Missed names come back in the next few days." : "All of them.",
        meta: "Source: " + L.source + (L.as_of ? " · as of " + L.as_of : ""), next: { text: "‹ Library", fn: openLibrary } }));
    }
    const done = el("div", {});
    openSheet([el("h2", { id: "sheet-title", class: "stitle", text: L.title }),
      el("div", { class: "sactions" }, clock, count, pauseBtn, el("button", { class: "unsave", text: "Give up", onclick: finish })),
      input, list, done, el("button", { class: "sbtn wide", text: "‹ Library", onclick: () => { over = true; clearInterval(tick); openLibrary(); } })], L.title);
    setTimeout(() => input.focus(), 50);
  }

  function matchGame(L) {
    const t0 = Date.now();
    const order = L.items.map((_, i) => i);
    const names = order.slice().sort(() => Math.random() - 0.5);
    let pick = null, right = 0, tries = 0;
    const done = new Set();
    const left = el("div", { class: "gm-col" }), right_ = el("div", { class: "gm-col" });
    function draw() {
      left.replaceChildren(...order.map((i) => el("button", { class: "chip" + (done.has(i) ? " on" : "") + (pick === i ? " sel" : ""), text: L.items[i].clue || "?", disabled: done.has(i), onclick: () => { pick = i; draw(); } })));
      right_.replaceChildren(...names.map((i) => el("button", { class: "chip" + (done.has(i) ? " on" : ""), text: L.items[i].answer, disabled: done.has(i), onclick: () => {
        if (pick == null) return;
        tries += 1;
        if (pick === i) { done.add(i); right += 1; }
        pick = null; draw();
        if (done.size === L.n) {
          send({ game: "match", puzzle: L.id, ok: tries <= L.n + 2, score: right, ms: Date.now() - t0, hints: 0, items: [] });
          msg.replaceChildren(reveal({ ok: tries <= L.n + 2, verdict: "Matched in " + tries + " tries", keep: "Now try Name them.", next: { text: "Name them ›", fn: () => nameAll(L) } }));
        }
      } })));
    }
    const msg = el("div", {});
    draw();
    openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Match · " + L.title }), el("p", { class: "fine", text: "Tap a seat, then the person who holds it." }),
      el("div", { class: "gm-match" }, left, right_), msg, el("button", { class: "sbtn wide", text: "‹ Library", onclick: openLibrary })], "Match");
  }

  function whoLeft(w, L) {
    const people = [...w.gone.map((g) => ({ name: g.name, clue: g.clue, kind: "left" })), ...w.new.map((n) => ({ name: n.name, clue: n.clue, kind: "new" }))];
    const input = answerInput("Name one");
    keepVisible(input);
    const got = new Set();
    const rows = people.map((p) => el("li", { class: "gm-row" }, el("span", { class: "gm-clue", text: (p.kind === "left" ? "Left · " : "New · ") + (p.clue || "") }), el("span", { class: "gm-name", text: "" })));
    input.addEventListener("input", () => {
      const k = people.findIndex((p, i) => !got.has(i) && accepts(input.value, p.name, []));
      if (k >= 0) { got.add(k); rows[k].classList.add("got"); rows[k].lastChild.textContent = people[k].name; input.value = ""; }
    });
    openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Who left the list" }), el("p", { class: "fine", text: (L ? L.title : w.list) + " · since " + w.since }),
      input, el("ol", { class: "gm-rows" }, ...rows),
      el("button", { class: "sbtn", text: "Show them", onclick: () => people.forEach((p, i) => { if (!got.has(i)) { rows[i].classList.add("miss"); rows[i].lastChild.textContent = p.name; } }) }),
      el("button", { class: "sbtn wide", text: "‹ Library", onclick: openLibrary })], "Who left the list");
    setTimeout(() => input.focus(), 50);
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

  window.WireGames = { openPuzzles, openLibrary, homeCard, accepts, flush, play };
  flush();
})();
