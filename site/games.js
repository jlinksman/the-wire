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

  const NAMES = { keyed: "Keyed cipher", patristocrat: "Patristocrat", meta: "Saturday meta", casefile: "Case file", timeline: "Timeline", beacon_agenda: "Beacon Agenda", docket: "The Docket", ledger: "The Ledger", friday_quiz: "Friday quiz", legal: "Law refresher", defectors: "Defectors", who_said_it: "Who said it", cryptoquote: "Cryptoquote", chess: "Chess", logic: "Logic", connections: "Connections", tactics: "Tactics" };
  const LOGIC_NAMES = { loopy: "Loopy", keen: "Keen", towers: "Towers", galaxies: "Galaxies", signpost: "Signpost", dominosa: "Dominosa", unequal: "Unequal", slant: "Slant", range: "Range", pattern: "Pattern" };
  function slotLine(s) {
    const p = s.puzzle || {};
    if (s.game === "logic") return (LOGIC_NAMES[p.game] || p.game) + " · tier " + p.tier;
    if (s.game === "tactics") return "Save every building in one turn · tier " + p.tier;
    if (s.game === "chess") { const th = (p.themes || []).filter((t) => !/^(short|long|veryLong|oneMove|middlegame|endgame|opening|master|masterVsMaster|crushing|advantage|equality)$/.test(t)).slice(0, 2); return "Puzzle rated " + p.rating + (th.length ? " · " + th.join(", ") : ""); }
    if (s.game === "keyed") return "Friday cipher · the keyword feeds the meta";
    if (s.game === "connections") return "Sixteen names from the week, four groups";
    if (s.game === "casefile") return "Logic grid · tier " + p.tier + " · " + (p.clues || []).length + " clues";
    if (s.game === "meta") return (p.feeders || []).length + " feeders from the week · " + p.category;
    if (s.game === "patristocrat") return "Sunday long cipher · five-letter groups";
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
      ...["logic", "chess", "tactics"].map((b) => el("button", { class: "chip" + ((D.pick || "logic") === b ? " on" : ""), text: b[0].toUpperCase() + b.slice(1), onclick: async () => {
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
    if (s.game === "cryptoquote" || s.game === "keyed" || s.game === "patristocrat") return cryptoquote(s);
    if (s.game === "chess") return chess(s);
    if (s.game === "logic") return logic(s);
    if (s.game === "defectors") return defectorsGame(s);
    if (s.game === "legal") return legalGame(s);
    if (s.game === "ledger") return ledgerGame(s);
    if (s.game === "docket") return docketGame(s);
    if (s.game === "timeline") return timelineGame(s);
    if (s.game === "meta") return metaGame(s);
    if (s.game === "casefile") return caseFile(s);
    if (s.game === "connections") return connections(s);
    if (s.game === "beacon_agenda") return agendaGame(s);
    if (s.game === "friday_quiz") return fridayQuiz(s);
    if (s.game === "tactics") return tacticsGame(s);
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

  // ---------------------------------------------------------------- Saturday meta
  // Each feeder answer gives one letter (at the position shown); the letters, in order, spell the
  // answer: a Hudson Valley place. It's built so you can still get it with a quarter of the feeders
  // missing. Partial guesses get "keep going"; hints reveal a feeder, one at a time.
  function metaGame(s) {
    const P = s.puzzle;
    const t0 = Date.now();
    const S = get(PKEY + P.id, null) || { got: {}, hints: 0 };
    const kw = get("wire.games.keyword", null);
    P.feeders.forEach((f, i) => { if (f.src === "keyed" && kw && kw.word === f.answer) S.got[i] = true; });
    const slots = el("div", { class: "gm-metaslots" });
    const rows = el("ol", { class: "gm-feeders" });
    const final = answerInput("The answer");
    keepVisible(final);
    const msg = el("p", { class: "fine", text: "" });
    const save = () => put(PKEY + P.id, S);
    function draw() {
      slots.replaceChildren(...P.feeders.map((f, i) => el("span", { class: "gm-mslot" + (S.got[i] ? " got" : ""), text: S.got[i] ? f.answer[f.index - 1] : "_" })));
      rows.replaceChildren(...P.feeders.map((f, i) => {
        const inp = answerInput("Answer");
        inp.value = S.got[i] ? f.answer : "";
        inp.disabled = !!S.got[i];
        inp.addEventListener("input", () => {
          if (fold(inp.value).replace(/ /g, "").toUpperCase() === f.answer) { S.got[i] = true; save(); draw(); }
        });
        return el("li", { class: "gm-feeder" + (S.got[i] ? " got" : "") }, el("span", { class: "fine", text: f.clue + " · letter " + f.index }), inp);
      }));
    }
    const check = () => {
      const g = fold(final.value).replace(/ /g, "").toUpperCase();
      if (!g) return;
      if (g === P.answer) return finish(true);
      const same = [...g].filter((c, i) => P.answer[i] === c).length;
      msg.textContent = g.length === P.answer.length && same >= P.answer.length / 2 ? "Keep going — you're close." : "Not it.";
    };
    final.addEventListener("keydown", (e) => { if (e.key === "Enter") check(); });
    function finish(ok) {
      store.removeItem(PKEY + P.id);
      const n = Object.keys(S.got).length;
      const res = { ok, score: ok ? Math.max(1, 10 - S.hints * 2) : 0, ms: Date.now() - t0, hints: S.hints };
      send(Object.assign({ slot: s.slot, game: "meta", puzzle: P.id, items: [] }, res));
      markDone(s.slot, res);
      openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Saturday meta" }),
        reveal({ ok, verdict: ok ? "Solved with " + n + " of " + P.feeders.length + " feeders" : "It was " + P.answer, keep: P.answer + " — " + P.category,
          meta: "Feeders: " + P.feeders.map((f) => f.answer + "[" + f.index + "]=" + f.answer[f.index - 1]).join(" · "), next: { text: "Done ›", fn: () => openPuzzles() } })], "Saturday meta");
    }
    draw();
    openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Saturday meta" }),
      el("p", { class: "gm-keep", text: "The answer is " + P.category + ", " + P.length + " letters (spaces dropped)." }),
      el("p", { class: "fine", text: "Each answer below gives one letter, at the position shown, in order. You can get it with " + P.solvable_missing + " feeder" + (P.solvable_missing > 1 ? "s" : "") + " missing." }),
      slots, final, msg,
      el("div", { class: "sactions" },
        el("button", { class: "sbtn primary", text: "Check", onclick: check }),
        el("button", { class: "sbtn", text: "Hint: reveal a feeder", onclick: () => { const i = P.feeders.findIndex((_, k) => !S.got[k]); if (i >= 0) { S.got[i] = true; S.hints += 1; save(); draw(); } } }),
        el("button", { class: "unsave", text: "Give up", onclick: () => finish(false) })),
      rows, backBtn()], "Saturday meta");
  }

  // ---------------------------------------------------------------- Case file (Sunday logic grid)
  // Tap a cell: blank → ✗ → ● → blank. A ● crosses out the rest of its row and column. Tap a clue to
  // strike it. Every case has exactly one answer, reachable by deduction alone.
  function caseFile(s) {
    const P = s.puzzle;
    const t0 = Date.now();
    const S = get(PKEY + P.id, null) || { m: {}, checks: 0, hints: 0, struck: {} };
    const save = () => put(PKEY + P.id, S);
    const grids = [["project", P.projects], ["time", P.times]];
    const wrap = el("div", {});
    const msg = el("p", { class: "fine", text: "" });
    const key = (g, r, c) => g + "|" + r + "|" + c;
    function tap(g, r, c, cols) {
      const k = key(g, r, c);
      const v = S.m[k] || "";
      const nv = v === "" ? "x" : v === "x" ? "o" : "";
      S.m[k] = nv;
      if (nv === "o") {                                // cross out the rest of the row and column
        P.people.forEach((p, rr) => { if (rr !== r && S.m[key(g, rr, c)] !== "o") S.m[key(g, rr, c)] = "x"; });
        cols.forEach((_, cc) => { if (cc !== c && S.m[key(g, r, cc)] !== "o") S.m[key(g, r, cc)] = "x"; });
      }
      save(); draw();
      if (solved()) finish(true);
    }
    function solved() {
      return P.people.every((p, r) => grids.every(([g, cols]) => cols.every((c, ci) => (S.m[key(g, r, ci)] === "o") === (P.solution[p][g] === c))));
    }
    function wrong() {
      let n = 0;
      P.people.forEach((p, r) => grids.forEach(([g, cols]) => cols.forEach((c, ci) => {
        const v = S.m[key(g, r, ci)], truth = P.solution[p][g] === c;
        if ((v === "o" && !truth) || (v === "x" && truth)) n += 1;
      })));
      return n;
    }
    function draw() {
      wrap.replaceChildren(...grids.map(([g, cols]) => el("table", { class: "gm-grid" },
        el("tr", {}, el("th", {}), ...cols.map((c) => el("th", { text: c }))),
        ...P.people.map((p, r) => el("tr", {}, el("th", { text: p }), ...cols.map((c, ci) => {
          const v = S.m[key(g, r, ci)] || "";
          return el("td", {}, el("button", { class: "gm-cell2 " + v, "aria-label": p + " " + c, text: v === "o" ? "●" : v === "x" ? "✗" : "", onclick: () => tap(g, r, ci, cols) }));
        }))))));
    }
    function finish(ok) {
      store.removeItem(PKEY + P.id);
      const res = { ok, score: ok ? Math.max(1, 10 - S.checks - S.hints * 2) : 0, ms: Date.now() - t0, hints: S.hints + S.checks };
      send(Object.assign({ slot: s.slot, game: "casefile", puzzle: P.id, items: [] }, res));
      markDone(s.slot, res);
      msg.replaceChildren(reveal({ ok, verdict: ok ? "Case closed in " + mmss(Math.round((Date.now() - t0) / 1000)) : "Here's the answer",
        keep: P.people.map((p) => p + ": " + P.solution[p].project + " at " + P.solution[p].time).join(" · "), meta: "Every step could be deduced; no guessing needed.", next: { text: "Done ›", fn: () => openPuzzles() } }));
    }
    const clues = el("ol", { class: "gm-clues" }, ...P.clues.map((c, i) => {
      const li = el("li", { class: S.struck[i] ? "struck" : "", text: c, onclick: () => { S.struck[i] = !S.struck[i]; li.classList.toggle("struck", !!S.struck[i]); save(); } });
      return li;
    }));
    draw();
    openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Case file · tier " + P.tier }), el("p", { class: "fine", text: P.story }),
      clues, wrap, msg,
      el("div", { class: "sactions" },
        el("button", { class: "sbtn", text: "Check (−1)", onclick: () => { S.checks += 1; save(); const w = wrong(); msg.textContent = w ? w + " mark" + (w > 1 ? "s are" : " is") + " wrong." : "Everything marked so far is right."; } }),
        el("button", { class: "sbtn", text: "Hint (−2)", onclick: () => {
          const p = P.people.find((pp, r) => grids.some(([g, cols]) => S.m[key(g, r, cols.indexOf(P.solution[pp][g]))] !== "o"));
          if (!p) return;
          const r = P.people.indexOf(p);
          const [g, cols] = grids.find(([g2, cols2]) => S.m[key(g2, r, cols2.indexOf(P.solution[p][g2]))] !== "o");
          S.hints += 1; tap(g, r, cols.indexOf(P.solution[p][g]), cols);
          if (S.m[key(g, r, cols.indexOf(P.solution[p][g]))] !== "o") tap(g, r, cols.indexOf(P.solution[p][g]), cols);
        } }),
        el("button", { class: "unsave", text: "Give up", onclick: () => finish(false) })),
      backBtn()], "Case file");
  }

  // ---------------------------------------------------------------- Connections
  // Sixteen names from the week; find the four groups. Four mistakes, "one away", repeat guesses
  // are free, shuffle and deselect. Group names are facts and double as the reveal; the "Your
  // herring" card names the decoy that caught you.
  function connections(s) {
    const P = s.puzzle;
    const t0 = Date.now();
    const S = get(PKEY + P.id, null) || { solved: [], mistakes: 0, tried: [], order: shuffle(P.board, Date.now()) };
    let sel = new Set();
    const save = () => put(PKEY + P.id, S);
    const groupOf = (x) => P.groups.find((g) => g.members.includes(x));
    const grid = el("div", { class: "gm-conn" });
    const done = el("div", {});
    const msg = el("p", { class: "fine", text: "" });
    const dots = el("span", { class: "asrc", text: "" });
    function draw() {
      done.replaceChildren(...S.solved.map((c) => { const g = P.groups.find((x) => x.color === c); return el("div", { class: "gm-group " + c }, el("b", { text: g.name }), el("span", { text: g.members.join(" · ") })); }));
      const left = S.order.filter((x) => !S.solved.some((c) => P.groups.find((g) => g.color === c).members.includes(x)));
      grid.replaceChildren(...left.map((x) => el("button", { class: "gm-tile" + (sel.has(x) ? " sel" : ""), text: x, onclick: () => { if (sel.has(x)) sel.delete(x); else if (sel.size < 4) sel.add(x); draw(); } })));
      dots.textContent = "Mistakes left: " + "●".repeat(4 - S.mistakes) + "○".repeat(S.mistakes);
    }
    function submit() {
      if (sel.size !== 4) return;
      const pick = [...sel].sort();
      const sig = pick.join("|");
      if (S.tried.includes(sig)) { msg.textContent = "Already tried that one (no penalty)."; return; }
      S.tried.push(sig);
      const counts = {};
      pick.forEach((x) => { const g = groupOf(x); counts[g.color] = (counts[g.color] || 0) + 1; });
      const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (best[1] === 4) { S.solved.push(best[0]); sel = new Set(); msg.textContent = ""; }
      else { S.mistakes += 1; msg.textContent = best[1] === 3 ? "One away…" : "Not a group."; }
      save(); draw();
      if (S.solved.length === 4) finish(true);
      else if (S.mistakes >= 4) finish(false);
    }
    function finish(ok) {
      store.removeItem(PKEY + P.id);
      const res = { ok, score: ok ? 4 - S.mistakes : S.solved.length, ms: Date.now() - t0, hints: S.mistakes, purple_first: S.solved[0] === "purple" || S.solved[0] === "blue" };
      send(Object.assign({ slot: s.slot, game: "connections", puzzle: P.id, items: [] }, res));
      markDone(s.slot, res);
      S.solved = P.groups.map((g) => g.color);
      draw();
      grid.replaceChildren();
      const herring = (P.decoys || [])[0];
      msg.replaceChildren(reveal({ ok, verdict: ok ? (S.mistakes ? "Solved with " + S.mistakes + " mistake" + (S.mistakes > 1 ? "s" : "") : "Perfect") : "Out of mistakes",
        keep: herring ? "Your herring: " + herring + " — a real pattern, but not one of the four." : null, meta: "Groups come from complete public rosters and committee lists.", next: earlierNext() }));
    }
    draw();
    openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Connections" }), el("p", { class: "fine", text: "Find four groups of four. Group names are facts." }),
      done, grid, el("div", { class: "sactions" }, dots,
        el("button", { class: "chip", text: "Shuffle", onclick: () => { S.order = shuffle(S.order, Date.now()); save(); draw(); } }),
        el("button", { class: "chip", text: "Deselect", onclick: () => { sel = new Set(); draw(); } }),
        el("button", { class: "sbtn primary", text: "Submit", onclick: submit })), msg, backBtn()], "Connections");
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
    const cl = cipher.replace(/[^A-Z]/g, ""), pl = plain.replace(/[^A-Z]/g, "");   // letter by letter (Patristocrat groups too)
    for (let i = 0; i < cl.length; i++) truth[cl[i]] = pl[i];
    const kind = s.game === "keyed" ? "Keyed cipher" : s.game === "patristocrat" ? "Patristocrat" : "Cryptoquote";
    if (p.give && !saved) { const c = Object.keys(truth).find((k) => truth[k] === p.given); if (c) S.map[c] = p.given; }
    let sel = null;
    const input = el("input", { class: "gm-hidden", type: "text", autocomplete: "off", autocorrect: "off", autocapitalize: "characters", spellcheck: "false", maxlength: "1", "aria-label": "Letter" });
    const board = el("div", { class: "gm-crypt" });
    const strip = el("div", { class: "gm-strip" });
    const msg = el("p", { class: "fine", text: "" });
    const sheetRow = el("div", { class: "gm-sheetrow" });
    const cribAt = () => (s.game === "patristocrat" ? p.crib.at : cipher.slice(0, p.crib.at).replace(/[^A-Z]/g, "").length) + 1;
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
      // Keyed cipher worksheet: ciphertext A–Z with what you've recovered beneath; the keyword shows up here.
      if (s.game === "keyed") sheetRow.replaceChildren(
        el("div", { class: "gm-ws" }, ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((c) => el("span", { text: c }))),
        el("div", { class: "gm-ws plain" }, ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((c) => el("span", { text: S.map[c] || "·" }))));
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
      send(Object.assign({ slot: s.slot, game: s.game, puzzle: p.id, items: [] }, res));
      markDone(s.slot, res);
      store.removeItem(PKEY + p.id);
      if (p.keyword) put("wire.games.keyword", { day: nyDay(), word: p.keyword });
      openSheet([
        el("h2", { id: "sheet-title", class: "stitle", text: kind }),
        p.keyword ? el("p", { class: "gm-keep" }, el("b", { text: "The keyword: " + p.keyword }), el("span", { class: "fine", text: " — read it in the worksheet's bottom row. It feeds Saturday's meta." })) : null,
        el("blockquote", { class: "gm-quote", text: p.quote || plain }),
        reveal({ ok, verdict: !ok && S.hints ? "Mostly revealed" : ok ? "Solved in " + Math.max(1, Math.round(ms / 60000)) + " min" + (S.hints ? " · " + S.hints + " hint" + (S.hints > 1 ? "s" : "") : "") : "Revealed",
          keep: "— " + p.speaker + (p.role ? ", " + p.role : ""), meta: [p.outlet, p.t ? when(p.t) : null].filter(Boolean).join(" · "),
          link: p.link, thread: p.thread, next: { text: "Done ›", fn: () => openPuzzles() } }),
      ], kind);
    }
    const hintRow = el("div", { class: "sactions" },
      el("button", { class: "sbtn", text: "Reveal a letter", onclick: () => {
        const c = sel && S.map[sel] !== truth[sel] ? sel : Object.keys(truth).find((k) => S.map[k] !== truth[k]);
        if (!c) return;
        for (const k of Object.keys(S.map)) if (S.map[k] === truth[c]) delete S.map[k];
        S.map[c] = truth[c]; S.hints += 1; save();
        if (solved()) return done(true);
        draw(); } }),
      el("button", { class: "sbtn", text: "Crib", onclick: () => { S.crib = true; S.hints += 1; save(); msg.textContent = "Crib: the word " + p.crib.word + " starts at letter " + cribAt() + "."; } }),
      el("button", { class: "sbtn", text: "Speaker", onclick: () => { S.speaker = true; S.hints += 1; save(); msg.textContent = "Said by " + p.speaker + (p.role ? ", " + p.role : "") + "."; } }),
      el("button", { class: "sbtn", text: "Check", onclick: () => { S.checks += 1; save(); const wrong = Object.keys(S.map).filter((k) => S.map[k] !== truth[k]).length; msg.textContent = wrong ? wrong + " letter" + (wrong > 1 ? "s are" : " is") + " wrong." : "Everything so far is right."; } }),
      el("button", { class: "unsave", text: "Give up", onclick: () => { for (const k of Object.keys(truth)) S.map[k] = truth[k]; done(false); } }));
    if (S.crib) msg.textContent = "Crib: the word " + p.crib.word + " starts at letter " + cribAt() + ".";
    sel = nextOpen(null);
    draw();
    const intro = s.game === "keyed" ? "Friday · a keyed cipher: solve the quote, and the worksheet's bottom row spells a keyword."
      : s.game === "patristocrat" ? "Sunday · a Patristocrat: no spaces, letters in groups of five. Long and hard on purpose."
      : ["", "Easy", "Medium", "Hard"][p.tier] + " · a quote from this week's news, letters swapped. Speaker hidden." + (p.give ? " One letter is given." : "");
    openSheet([
      el("h2", { id: "sheet-title", class: "stitle", text: kind }),
      el("p", { class: "asrc", text: intro }),
      board, strip, sheetRow, input, msg, hintRow,
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

  // ---------------------------------------------------------------- Tactics (one turn, Into the Breach-style)
  // Same rules as pipeline/tactics.py (CI replays the generator's lines through this engine).
  const TX_N = 6;
  const TX_DIRS = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
  const txIn = (x, y) => x >= 0 && x < TX_N && y >= 0 && y < TX_N;
  function txBoard(P) {
    const t = {};
    for (const [x, y, k] of P.terrain) t[x + "," + y] = k;
    return { t, b: new Set(P.buildings.map(([x, y]) => x + "," + y)), e: P.enemies.map((e) => Object.assign({}, e)), u: P.units.map((u) => Object.assign({}, u)), hit: false };
  }
  const txCopy = (B) => ({ t: B.t, b: B.b, e: B.e.map((e) => Object.assign({}, e)), u: B.u.map((u) => Object.assign({}, u)), hit: B.hit });
  const txEnemy = (B, x, y) => B.e.find((e) => e.x === x && e.y === y && e.hp > 0) || null;
  const txOcc = (B, x, y) => B.t[x + "," + y] === "mountain" || B.b.has(x + "," + y) || !!txEnemy(B, x, y) || B.u.some((u) => u.x === x && u.y === y);
  function txDamage(B, x, y) { if (B.b.has(x + "," + y)) B.hit = true; const e = txEnemy(B, x, y); if (e) e.hp -= 1; }
  function txPush(B, x, y, d) {
    const e = txEnemy(B, x, y);
    if (!e) return;
    const nx = x + TX_DIRS[d][0], ny = y + TX_DIRS[d][1];
    if (!txIn(nx, ny)) return;
    if (txOcc(B, nx, ny)) { e.hp -= 1; txDamage(B, nx, ny); return; }
    e.x = nx; e.y = ny;
    if (B.t[nx + "," + ny] === "water") e.hp = 0;
  }
  function txReach(B, u, steps) {
    const seen = new Set([u.x + "," + u.y]);
    let frontier = [[u.x, u.y]];
    for (let i = 0; i < steps; i++) {
      const nxt = [];
      for (const [x, y] of frontier) for (const [dx, dy] of Object.values(TX_DIRS)) {
        const px = x + dx, py = y + dy, k = px + "," + py;
        if (txIn(px, py) && !seen.has(k) && !txOcc(B, px, py) && B.t[k] !== "water") { seen.add(k); nxt.push([px, py]); }
      }
      frontier = nxt;
    }
    return [...seen].map((k) => k.split(",").map(Number));
  }
  function txAct(B, i, to, a) {
    const u = B.u[i];
    u.x = to[0]; u.y = to[1];
    const [dx, dy] = TX_DIRS[a[1]];
    if (a[0] === "punch") {
      const tx = u.x + dx, ty = u.y + dy;
      if (txIn(tx, ty)) { txDamage(B, tx, ty); txPush(B, tx, ty, a[1]); }
    } else if (a[0] === "shell") {
      const tx = u.x + dx * a[2], ty = u.y + dy * a[2];
      if (txIn(tx, ty)) {
        txDamage(B, tx, ty);
        for (const [dd, [ax, ay]] of Object.entries(TX_DIRS)) if (txIn(tx + ax, ty + ay)) txPush(B, tx + ax, ty + ay, dd);
      }
    }
  }
  function txAttack(B) {
    for (const e of B.e) {
      if (e.hp <= 0) continue;
      const tx = e.x + TX_DIRS[e.dir][0], ty = e.y + TX_DIRS[e.dir][1];
      if (txIn(tx, ty)) txDamage(B, tx, ty);
    }
  }
  function txReplay(P, line) { const B = txBoard(P); for (const st of line) txAct(B, st.unit, st.to, st.attack); txAttack(B); return !B.hit; }
  const txSq = (x, y) => "ABCDEF"[x] + (y + 1);
  const txDescribe = (P, line) => line.map((st) => (P.units[st.unit].kind === "punch" ? "Puncher" : "Artillery") + " to " + txSq(...st.to) + ", " +
    (st.attack[0] === "hold" ? "hold fire" : (st.attack[0] === "punch" ? "punch " : "shell " + st.attack[2] + " tiles ") + { N: "north", E: "east", S: "south", W: "west" }[st.attack[1]])).join("; then ");

  function tacticsGame(s) {
    const P = s.puzzle;
    const t0 = Date.now();
    let B = txBoard(P), line = [], sel = null, moved = null, over = false;
    const ARROW = { N: "↑", E: "→", S: "↓", W: "←" };
    const grid = el("div", { class: "gm-board gm-tx" });
    const msg = el("p", { class: "fine" });
    const tools = el("div", { class: "sactions" });
    const threats = () => new Set(B.e.filter((e) => e.hp > 0).map((e) => [e.x + TX_DIRS[e.dir][0], e.y + TX_DIRS[e.dir][1]]).filter(([x, y]) => txIn(x, y)).map(([x, y]) => x + "," + y));
    function targets(u) {
      const out = [];
      for (const [d, [dx, dy]] of Object.entries(TX_DIRS)) {
        if (u.kind === "punch") { if (txIn(u.x + dx, u.y + dy)) out.push([u.x + dx, u.y + dy, ["punch", d]]); }
        else for (const r of [2, 3, 4]) if (txIn(u.x + dx * r, u.y + dy * r)) out.push([u.x + dx * r, u.y + dy * r, ["shell", d, r]]);
      }
      return out;
    }
    function draw() {
      const th = threats();
      const reach = sel != null && !moved ? new Set(txReach(B, B.u[sel], B.u[sel].kind === "punch" ? 3 : 2).map(([x, y]) => x + "," + y)) : new Set();
      const tg = sel != null && moved ? targets(B.u[sel]) : [];
      const cells = [];
      for (let y = 0; y < TX_N; y++) for (let x = 0; x < TX_N; x++) {
        const k = x + "," + y, e = txEnemy(B, x, y), ui = B.u.findIndex((u) => u.x === x && u.y === y);
        const terr = B.t[k];
        let txt = "", cls = "gm-sq gm-txs" + (terr ? " " + terr : "") + (th.has(k) ? " threat" : "") + (reach.has(k) ? " reach" : "") + (tg.some((q) => q[0] === x && q[1] === y) ? " target" : "") + (ui === sel && sel != null ? " sel" : "");
        if (B.b.has(k)) { txt = "▣"; cls += " bldg"; }
        else if (e) { txt = ARROW[e.dir] + e.hp; cls += " foe"; }
        else if (ui >= 0) { txt = B.u[ui].kind === "punch" ? "P" : "A"; cls += " mine" + (line.some((l) => l.unit === ui) ? " spent" : ""); }
        else if (terr === "water") txt = "≈";
        else if (terr === "mountain") txt = "▲";
        cells.push(el("button", { class: cls, "aria-label": txSq(x, y) + " " + (txt || "ground"), onclick: () => tap(x, y) }, el("span", { text: txt }),
          y === 0 || x === 0 ? el("i", { class: "gm-co", text: (y === 0 ? "ABCDEF"[x] : "") + (x === 0 ? String(y + 1) : "") }) : null));
      }
      grid.replaceChildren(...cells);
      const left = B.u.map((u, i) => i).filter((i) => !line.some((l) => l.unit === i));
      if (!over) msg.textContent = sel == null ? (left.length ? "Tap a unit (P punches and pushes; A shells 2–4 tiles away and pushes the four tiles around the hit). Red tiles get hit at the end of the turn." : "")
        : !moved ? "Tap where " + (B.u[sel].kind === "punch" ? "the Puncher" : "the Artillery") + " moves (its own tile to stay)." : "Tap a target.";
      tools.replaceChildren(...[
        sel != null && moved ? el("button", { class: "sbtn", text: "Hold fire", onclick: () => fire(["hold", "N"]) }) : null,
        !over && (line.length || sel != null) ? el("button", { class: "sbtn", text: "Reset turn", onclick: () => { B = txBoard(P); line = []; sel = null; moved = null; draw(); } }) : null].filter(Boolean));
    }
    let before = null;
    function tap(x, y) {
      if (over) return;
      const ui = B.u.findIndex((u) => u.x === x && u.y === y);
      if (sel == null || (!moved && ui >= 0)) {
        if (ui >= 0 && !line.some((l) => l.unit === ui)) { sel = ui; moved = null; draw(); }
        return;
      }
      if (!moved) {
        if (!txReach(B, B.u[sel], B.u[sel].kind === "punch" ? 3 : 2).some(([a, b]) => a === x && b === y)) return;
        before = txCopy(B);
        B.u[sel].x = x; B.u[sel].y = y; moved = [x, y]; draw();
        return;
      }
      const q = targets(B.u[sel]).find((t) => t[0] === x && t[1] === y);
      if (q) fire(q[2]);
    }
    function fire(a) {
      const to = moved;
      B = before; before = null;
      if (a[0] !== "hold") txAct(B, sel, to, a); else { B.u[sel].x = to[0]; B.u[sel].y = to[1]; }
      line.push({ unit: sel, to, attack: a });
      sel = null; moved = null;
      if (line.length === B.u.length || B.hit) return end();
      draw();
    }
    function end() {
      over = true;
      txAttack(B);
      const ok = !B.hit;
      draw();
      const res = { ok, score: ok ? 1 : 0, ms: Date.now() - t0, hints: 0 };
      send(Object.assign({ slot: s.slot, game: "tactics", puzzle: P.id, items: [] }, res));
      markDone(s.slot, res);
      const sols = (P.solutions || []).map((l, i) => (P.solutions.length > 1 ? (i + 1) + ". " : "") + txDescribe(P, l));
      msg.replaceChildren(reveal({ ok, verdict: ok ? "Every building stands" : "A building was hit",
        keep: ok ? "Your line: " + txDescribe(P, line) : null,
        why: (sols.length > 1 ? "The " + sols.length + " winning outcomes: " : "The winning line: ") + sols.join(" · "),
        meta: "Columns A–F, rows 1–6 from the top · generated board, tier " + P.tier,
        next: { text: "Done ›", fn: () => openPuzzles() } }));
    }
    draw();
    openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Tactics" }),
      el("p", { class: "fine", text: "▣ building · ↑2 enemy (attacks the way it points; number is health) · ≈ water drowns · ▲ mountain blocks. Pushing an enemy into something hurts both." }),
      grid, msg, tools, backBtn()], "Tactics");
  }
  window.wireTactics = { replay: txReplay };

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
    nodes.push(el("h3", { class: "sh3", text: "Maps" }));
    for (const id of Object.keys(MAPS)) nodes.push(el("div", { class: "gm-libl" },
      el("span", { class: "gm-t", text: MAPS[id].title }),
      el("button", { class: "chip", text: "Find it", onclick: () => mapGame(id, "find") }),
      el("button", { class: "chip", text: "Name it", onclick: () => mapGame(id, "name") })));
    nodes.push(el("div", { class: "gm-libl" }, el("span", { class: "gm-t", text: "Outline: today's country" }), el("button", { class: "chip", text: "Play", onclick: outlineGame })));
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

  // ---------------------------------------------------------------- Maps and geography
  // Two directions: find it (tap; first tap highlights, a second confirms, so a fat finger never
  // costs you) and name it (a shape is highlighted; type its name). Zoom buttons for small targets.
  // Shapes are public domain (Census, Natural Earth); disputed borders follow Natural Earth's de facto view.
  const MAPS = {
    "us-states": { title: "U.S. states", noun: "state" },
    "world": { title: "Countries of the world", noun: "country" },
    "ny-districts": { title: "New York's congressional districts", noun: "district" },
    "dutchess": { title: "Dutchess County towns and cities", noun: "town" },
  };
  const ALIASES = { "United States of America": ["usa", "us", "united states", "america"], "United Kingdom": ["uk", "britain", "great britain"],
    "Dem. Rep. Congo": ["drc", "democratic republic of the congo", "congo kinshasa"], "Congo": ["republic of the congo", "congo brazzaville"],
    "Central African Rep.": ["central african republic", "car"], "Dominican Rep.": ["dominican republic"], "Bosnia and Herz.": ["bosnia", "bosnia and herzegovina"],
    "S. Sudan": ["south sudan"], "Eq. Guinea": ["equatorial guinea"], "eSwatini": ["eswatini", "swaziland"], "Solomon Is.": ["solomon islands"],
    "Falkland Is.": ["falkland islands", "falklands"], "N. Cyprus": ["northern cyprus"], "W. Sahara": ["western sahara"], "Côte d'Ivoire": ["ivory coast", "cote divoire"],
    "Czechia": ["czech republic"], "Macedonia": ["north macedonia"], "Timor-Leste": ["east timor"], "Myanmar": ["burma"], "Fr. S. Antarctic Lands": ["french southern lands"],
    "Somaliland": [], "Palestine": ["palestinian territories"], "Taiwan": [], "Kosovo": [], "Turkey": ["turkiye"] };
  const mapCache = {};
  async function loadMap(id) {
    if (mapCache[id]) return mapCache[id];
    const r = await fetch("vendor/maps/" + id + ".json");
    if (!r.ok) throw new Error("the maps arrive with the next site deploy");
    return (mapCache[id] = await r.json());
  }
  const NS = "http://www.w3.org/2000/svg";
  function svgMap(M, onTap) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", M.viewBox);
    svg.setAttribute("class", "gm-map");
    const vb0 = M.viewBox.split(" ").map(Number);
    let vb = vb0.slice();
    const paths = {};
    for (const sh of M.shapes) {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", sh.d);
      p.setAttribute("class", "gm-shape");
      p.addEventListener("click", (e) => { e.stopPropagation(); onTap && onTap(sh, p); });
      svg.appendChild(p);
      paths[sh.id] = p;
    }
    let pinchAt = 0;
    svg.addEventListener("touchstart", (e) => { if (e.touches.length > 1) pinchAt = Date.now(); }, { passive: true });
    svg.addEventListener("click", (e) => { if (Date.now() - pinchAt < 400) e.stopPropagation(); }, true);   // ignore taps during a pinch
    const set = () => svg.setAttribute("viewBox", vb.join(" "));
    const zoom = (f, cx, cy) => {
      const w = Math.min(vb0[2], vb[2] / f), h = Math.min(vb0[3], vb[3] / f);
      cx = cx == null ? vb[0] + vb[2] / 2 : cx; cy = cy == null ? vb[1] + vb[3] / 2 : cy;
      vb = [Math.max(vb0[0], Math.min(cx - w / 2, vb0[0] + vb0[2] - w)), Math.max(vb0[1], Math.min(cy - h / 2, vb0[1] + vb0[3] - h)), w, h];
      set();
    };
    const pan = (dx, dy) => { vb[0] = Math.max(vb0[0], Math.min(vb[0] + dx * vb[2] * 0.3, vb0[0] + vb0[2] - vb[2])); vb[1] = Math.max(vb0[1], Math.min(vb[1] + dy * vb[3] * 0.3, vb0[1] + vb0[3] - vb[3])); set(); };
    const controls = el("div", { class: "gm-zoom" },
      el("button", { class: "chip", text: "＋", onclick: () => zoom(2) }), el("button", { class: "chip", text: "－", onclick: () => zoom(0.5) }),
      el("button", { class: "chip", text: "←", onclick: () => pan(-1, 0) }), el("button", { class: "chip", text: "→", onclick: () => pan(1, 0) }),
      el("button", { class: "chip", text: "↑", onclick: () => pan(0, -1) }), el("button", { class: "chip", text: "↓", onclick: () => pan(0, 1) }),
      el("button", { class: "chip", text: "Fit", onclick: () => { vb = vb0.slice(); set(); } }));
    return { svg, paths, controls, zoomTo: (c, f) => { vb = vb0.slice(); zoom(f, c[0], c[1]); } };
  }
  function shuffle(a, seed) { const r = a.slice(); let h = 0; for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; for (let i = r.length - 1; i > 0; i--) { h = (h * 1103515245 + 12345) >>> 0; const j = h % (i + 1); [r[i], r[j]] = [r[j], r[i]]; } return r; }

  async function mapGame(id, mode) {
    let M;
    try { M = await loadMap(id); } catch (e) { openSheet([el("h2", { id: "sheet-title", class: "stitle", text: MAPS[id].title }), el("p", { class: "fine", text: e.message }), el("button", { class: "sbtn wide", text: "‹ Library", onclick: openLibrary })], "Maps"); return; }
    const t0 = Date.now();
    const shapes = M.shapes.filter((s) => s.d && (id !== "world" || s.area > 0.00005));
    const deck = shuffle(shapes, Date.now()).slice(0, 10);
    let k = 0, right = 0, pending = null;
    const missed = [];
    const msg = el("p", { class: "fine", text: "" });
    const prompt = el("p", { class: "gm-keep", text: "" });
    const input = answerInput("Name the highlighted " + MAPS[id].noun);
    keepVisible(input);
    const confirm = el("button", { class: "sbtn primary", text: "That one", hidden: true });
    const m = svgMap(M, (sh, p) => {
      if (mode !== "find" || !deck[k]) return;
      Object.values(m.paths).forEach((x) => x.classList.remove("pick"));
      p.classList.add("pick");
      pending = sh;
      confirm.hidden = false;
      confirm.textContent = "That one" + (id === "world" || id === "us-states" ? "" : "");
    });
    const next = () => {
      Object.values(m.paths).forEach((x) => x.classList.remove("pick", "target", "right", "wrong"));
      pending = null; confirm.hidden = true;
      const cur = deck[k];
      if (!cur) return finish();
      if (mode === "find") prompt.textContent = (k + 1) + " of " + deck.length + " · Find: " + cur.name;
      else {
        prompt.textContent = (k + 1) + " of " + deck.length + " · Name the highlighted " + MAPS[id].noun;
        m.paths[cur.id].classList.add("target"); input.value = "";
        try {                                    // small targets (NYC districts, tiny states): zoom in on them
          const bb = m.paths[cur.id].getBBox(), vbw = Number(M.viewBox.split(" ")[2]);
          m.zoomTo([bb.x + bb.width / 2, bb.y + bb.height / 2], bb.width < vbw * 0.06 ? Math.min(6, (vbw * 0.25) / Math.max(bb.width, 1)) : 1);
        } catch (e) { /* not laid out yet */ }
      }
    };
    const judge = (ok, cur, shown) => {
      if (ok) right += 1; else missed.push(cur);
      m.paths[cur.id].classList.add(ok ? "right" : "wrong");
      msg.textContent = ok ? "✓ " + cur.name : "✗ That was " + (shown ? shown.name : "—") + ". It's " + cur.name + " (shown in red).";
      k += 1;
      setTimeout(next, ok ? 600 : 1600);
    };
    confirm.addEventListener("click", () => { const cur = deck[k]; if (cur && pending) judge(pending.id === cur.id, cur, pending); });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const cur = deck[k];
      if (!cur) return;
      const extra = id === "ny-districts" ? [cur.name.replace("NY-", ""), "district " + cur.name.replace("NY-", "")] : ALIASES[cur.name] || [];
      judge(accepts(input.value, cur.name, extra) || (id === "ny-districts" && input.value.replace(/\D/g, "") === cur.name.replace("NY-", "")), cur, null);
    });
    function finish() {
      const ok = right / deck.length >= 0.8;
      const items = missed.map((s) => ({ id: "pl:" + id + ":" + fold(s.name).replace(/ /g, "_").slice(0, 24), type: "roster", q: "On the map of " + MAPS[id].title.toLowerCase() + ": the " + MAPS[id].noun + " at this spot? (" + (mode === "find" ? "find " : "name ") + s.name + ")", a: s.name, accept: ALIASES[s.name] || [], hint: M.source, ok: false, cert: "guess" }));
      send({ game: "map", puzzle: id + ":" + mode, ok, score: right, ms: Date.now() - t0, hints: 0, items: [] });
      msg.replaceChildren(reveal({ ok, verdict: right + " of " + deck.length, keep: missed.length ? "Missed: " + missed.map((s) => s.name).join(", ") : "Clean sweep.", meta: "Shapes: " + M.source,
        next: { text: "Again ›", fn: () => mapGame(id, mode) } }));
    }
    openSheet([el("h2", { id: "sheet-title", class: "stitle", text: MAPS[id].title }), prompt, m.svg, m.controls,
      mode === "find" ? confirm : input, msg, el("button", { class: "sbtn wide", text: "‹ Library", onclick: openLibrary })], "Maps");
    next();
  }

  // Outline: a country's silhouette; type guesses. Each miss shows the distance and direction from
  // your guess to the answer (Worldle-style). A fixed daily rotation (never drawn from tragedy stories).
  async function outlineGame() {
    let M;
    try { M = await loadMap("world"); } catch (e) { openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Outline" }), el("p", { class: "fine", text: e.message }), el("button", { class: "sbtn wide", text: "‹ Library", onclick: openLibrary })], "Outline"); return; }
    const t0 = Date.now();
    const pool = M.shapes.filter((s) => s.area > 0.0004);
    const day = nyDay();
    const target = shuffle(pool, "outline" + day.slice(0, 7))[Number(day.slice(8)) % pool.length];
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "gm-outline");
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", target.d);
    svg.appendChild(p);
    const tries = [];
    const list = el("ul", { class: "gm-hints" });
    const input = answerInput("Guess a country");
    keepVisible(input);
    const rad = (x) => x * Math.PI / 180;
    function km(a, b) { const [l1, p1] = a.map(rad), [l2, p2] = b.map(rad); const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2; return Math.round(12742 * Math.asin(Math.sqrt(h))); }
    function arrow(a, b) { const [l1, p1] = a.map(rad), [l2, p2] = b.map(rad); const y = Math.sin(l2 - l1) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(l2 - l1); const br = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360; return ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"][Math.round(br / 45) % 8]; }
    const end = (ok) => {
      send({ game: "outline", puzzle: "ol" + day, ok, score: ok ? 7 - tries.length : 0, ms: Date.now() - t0, hints: 0, items: [] });
      input.disabled = true;
      list.after(reveal({ ok, verdict: ok ? "In " + tries.length : "It was " + target.name, keep: target.name, meta: "Natural Earth (public domain); de facto borders", next: { text: "‹ Library", fn: openLibrary } }));
    };
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || input.disabled) return;
      const g = M.shapes.find((s) => accepts(input.value, s.name, ALIASES[s.name] || []));
      if (!g) { input.select(); return; }
      input.value = "";
      tries.push(g);
      if (g.id === target.id) { list.append(el("li", { text: "✓ " + g.name })); return end(true); }
      list.append(el("li", { text: "✗ " + g.name + " · " + km(g.ll, target.ll).toLocaleString() + " km " + arrow(g.ll, target.ll) }));
      if (tries.length >= 6) end(false);
    });
    // Fit the silhouette into its own box.
    requestAnimationFrame(() => { try { const b = p.getBBox(); const pad = Math.max(b.width, b.height) * 0.08; svg.setAttribute("viewBox", [b.x - pad, b.y - pad, b.width + 2 * pad, b.height + 2 * pad].join(" ")); } catch (e) { /* hidden */ } });
    openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Outline · today's country" }), svg, el("p", { class: "fine", text: "Six guesses. Each miss shows how far and which way." }), input, list, el("button", { class: "sbtn wide", text: "‹ Library", onclick: openLibrary })], "Outline");
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
