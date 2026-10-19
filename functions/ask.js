// Ask a thread a question (BRIEF.md, stage 3): the answer is written only from that thread's
// numbered sources (evidence.json, written by the build to KV) and every sentence cites them.
// Numbers and quotations that aren't in the cited sources fail the check, and the reader is
// told so rather than shown an unverified answer. Nothing here uses outside knowledge.
//
// POST /ask {thread: "t_...", question: "..."}  -> {answer:[{text, refs:[n]}], sources:[...], model, notice}
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const FALLBACK_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
const CACHE_SECONDS = 900;
const TZ = "America/New_York";
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

const SYSTEM = `You answer one reader's question about a news thread. The reader is Joe, a New York attorney in Beacon, NY, who runs an environmental remediation company. He wants evidence, not opinion.

Rules:
- Use only what the numbered sources say. No outside knowledge, no background you weren't given, no guesses. If the sources don't answer the question, say "The sources don't say" and then say what they do establish that is closest to it.
- Every sentence ends with the numbers of the sources it rests on, like [2] or [1][4].
- Quote only word for word from a source's text, in quotation marks, and say who said it.
- Where sources disagree or report different numbers, say so and name them.
- Prefer documents (court opinions, rules, notices) over reports about them; say when you are quoting the document itself.
- Plain, exact, short: 60 to 160 words. No preamble, no "according to the sources" filler.

Reply with JSON only: {"answer":[{"text":"one sentence or two","refs":[2]}]} in reading order.`;

export async function onRequestPost({ request, env }) {
  if (!env.WIRE) return json({ error: "KV binding WIRE is not configured" }, 500);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad JSON" }, 400); }
  const tid = String(body.thread || "").slice(0, 40);
  const question = String(body.question || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!tid || question.length < 3) return json({ error: "a thread and a question are required" }, 400);

  const ev = await env.WIRE.get("evidence.json", "json");
  const t = ev && ev.threads && ev.threads[tid];
  if (!t) return json({ error: "No evidence for this thread yet. The build writes it every 15 minutes for followed threads and the liveliest ones; follow the thread and ask again after the next build." }, 404);

  const cacheKey = new Request(`https://the-wire.ask/${encodeURIComponent(ev.generated_at)}/${tid}/${encodeURIComponent(question.toLowerCase())}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const sources = t.sources || [];
  const prompt = `Thread: ${t.title} (${t.kind || "thread"}, opened ${fmt(t.opened)}, last report ${fmt(t.last)})\n`
    + (t.what ? `Where it stands, as written by the desk earlier: ${t.what}\n` : "")
    + (t.developments && t.developments.length ? `Developments: ${t.developments.map((d) => `${fmt(d.t)} ${d.text} (${d.source})`).join("; ")}\n` : "")
    + `\nSources:\n\n${sources.map(block).join("\n\n")}\n\nQuestion: ${question}`;

  let answer = [];
  let model = null;
  let notice = null;
  let dropped = 0;
  if (env.AI) {
    for (const m of [MODEL, FALLBACK_MODEL]) {
      try {
        const out = await env.AI.run(m, { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }], max_tokens: 700, temperature: 0.1 });
        const parsed = parse(out && out.response);
        if (parsed.length) { answer = parsed; model = m; break; }
      } catch (e) {
        notice = "Writing model unavailable (" + String(e.message || e).slice(0, 80) + ").";
      }
    }
  } else notice = "Workers AI isn't bound to this site.";

  // Verify: refs must exist; numbers and quotations must appear in the cited sources (or the question).
  const checked = [];
  for (const a of answer) {
    const refs = [...new Set((a.refs || []).map(Number).filter((n) => sources[n - 1]))];
    const inline = [...String(a.text).matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])).filter((n) => sources[n - 1]);
    const all = [...new Set([...refs, ...inline])];
    const text = String(a.text).replace(/\s*\[\d+\]/g, "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const saysNothing = /sources don['’]t say|sources do not say|not (?:stated|addressed|covered) in the sources/i.test(text);
    if (!all.length && !saysNothing) { dropped += 1; continue; }
    if (!grounded(text, all.map((n) => sources[n - 1]).concat([{ title: question }]), sources)) { dropped += 1; continue; }
    checked.push({ text, refs: all });
  }
  if (!checked.length && model) notice = (notice ? notice + " " : "") + "The model's answer couldn't be verified against the sources, so it isn't shown. Try a narrower question.";
  const used = [...new Set(checked.flatMap((a) => a.refs))].sort((a, b) => a - b);
  const res = json({
    thread: tid, question, as_of: ev.generated_at, written_at: new Date().toISOString(), model, notice, dropped,
    answer: checked,
    sources: (used.length ? used : sources.slice(0, 6).map((s) => s.n)).map((n) => sources[n - 1]).map((s) => ({ n: s.n, id: s.id, title: s.title, source: s.source, t: s.t, link: s.link, kind: s.kind })),
    n_sources: sources.length,
  }, 200, model && checked.length ? `private, max-age=${CACHE_SECONDS}` : "no-store");
  if (model && checked.length) await cache.put(cacheKey, res.clone());
  return res;
}

function block(s) {
  const lines = [`[${s.n}] ${s.kind === "document" ? "DOCUMENT" : "Report"} · ${s.source} · ${fmt(s.t)}${s.note ? " · " + s.note : ""}`, `Headline: ${s.title}`];
  if (s.summary) lines.push(`Description: ${s.summary}`);
  for (const q of s.quotes || []) lines.push(`Quote: "${q.text}"${q.by ? " — " + q.by : ""}`);
  if (s.excerpt) lines.push(`Text: ${s.excerpt}`);
  return lines.join("\n");
}

function parse(text) {
  if (!text) return [];
  if (typeof text === "object") return Array.isArray(text.answer) ? text.answer : [];
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const j = JSON.parse(m[0]);
    return Array.isArray(j.answer) ? j.answer.filter((a) => a && typeof a.text === "string") : [];
  } catch (e) {
    return [];
  }
}

const norm = (s) => String(s || "").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ");

// Every number and every quotation in a sentence must appear in the sources it cites. Names
// (capitalized words) must appear somewhere in the thread's sources.
function grounded(text, cited, all) {
  const corpus = norm(cited.map(src => [src.title, src.summary, src.source, src.excerpt, (src.quotes || []).map((q) => q.text + " " + (q.by || "")).join(" ")].join(" ")).join(" "));
  const wide = norm(all.map(src => [src.title, src.summary, src.source, src.excerpt, (src.quotes || []).map((q) => q.text + " " + (q.by || "")).join(" ")].join(" ")).join(" "));
  for (const num of norm(text).match(/\d[\d,.]*\d|\d/g) || []) {
    const n = num.replace(/[.,]$/, "");
    if (!corpus.includes(n) && !corpus.includes(n.replace(/,/g, ""))) return false;
  }
  for (const q of String(text).match(/["“]([^"”]{8,})["”]/g) || []) {
    if (!corpus.includes(norm(q.slice(1, -1)).replace(/[.,;:!?]$/, ""))) return false;
  }
  for (const s of String(text).split(/(?<=[.!?])\s+/)) {
    for (const w of s.split(/\s+/).slice(1)) {
      const name = w.replace(/[^A-Za-z'’-]/g, "").replace(/['’]s$/, "");
      if (name.length > 2 && /^[A-Z]/.test(name) && !ALLOWED.has(name) && !wide.includes(name.toLowerCase())) return false;
    }
  }
  return true;
}

const ALLOWED = new Set(("Beacon Dutchess Hudson Valley New York Joe Wire Eastern Monday Tuesday Wednesday Thursday Friday Saturday Sunday "
  + "Today Tonight Tomorrow Here That This The It In On At But Meanwhile Also However Yes No None Both Neither "
  + "President Governor Mayor Senator Representative Secretary Judge Justice Court Police Chief Speaker Minister "
  + "Supreme Congress Senate House State States Department County City Council Board Democrats Republicans Democrat Republican "
  + "US U.S American Americans Federal EU United White Administration Officials Lawmakers Article Section Part Chapter "
  + "January February March April May June July August September October November December").split(" "));

function fmt(iso) {
  if (!iso) return "unknown time";
  const d = new Date(iso);
  if (isNaN(d)) return "unknown time";
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
}

function json(body, status, cacheControl) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "cache-control": cacheControl || "no-store" } });
}
