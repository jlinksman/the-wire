// "Brief me": an on-demand, radio-style briefing, written only when Joe taps the button.
//
// The build decides what is signal (brief.json in KV: official and primary items, watchlist
// matches, stories carried by two or more outlets, his teams). This function asks Workers AI
// (free plan) to turn the items new since his last visit into a short spoken briefing, then
// checks every sentence against those items: names, numbers and quotes that aren't in the
// cited items are dropped. If the model is unavailable it falls back to reading headlines.
//
// GET /brief?since=<ms>            -> JSON {paragraphs, sources, ...}
// GET /brief?since=<ms>&beat=state  -> one category only (local, state, national, world, or a city beat)
// GET /brief?since=<ms>&format=text -> plain text (for a Siri Shortcut)

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const FALLBACK_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
const CACHE_SECONDS = 900;
const TZ = "America/New_York";
// Capitalized words allowed even if no cited item contains them: places and bodies Joe's
// briefing always uses, titles, and sentence glue. Any other name must come from the items.
const ALLOWED_NAMES = new Set(("Beacon Dutchess Hudson Valley New York Joe Optima Wire Eastern Monday Tuesday Wednesday Thursday Friday Saturday Sunday "
  + "Today Tonight Tomorrow Here That This The It In On At And But Meanwhile Also Elsewhere Locally Nationally Overseas Abroad In Sports "
  + "President Governor Mayor Senator Senators Representative Rep Secretary Judge Justice Police Chief Speaker Leader Minister Prime Pope "
  + "Supreme Court Congress Senate House State States Department County City Council Board Democrats Republicans Democrat Republican "
  + "US U.S American Americans Federal European EU United White Administration Officials Lawmakers "
  + "January February March April May June July August September October November December").split(" "));

const SYSTEM = (target, label) => `You write a short spoken news briefing for one listener, Joe, who lives in Beacon, New York. He owns an environmental remediation and spill-response company and is a New York attorney with a background in environmental law, bankruptcy, anti-money-laundering, commercial real estate and land use.

Write for the ear, like an NPR newscast:
- Use only facts stated in the numbered items. Never add outside knowledge, background, or guesses.
- Order: weather alerts first, then Beacon and Dutchess County, then government and law, then the world. Merge items about the same event. Leave out anything minor; it is fine to skip items.
- Each story is one to three short, plain sentences. Lead with what happened, not with the name of a board or agency. Put attribution before the claim ("Police say...", "CBS reports..."). Prefer present tense.
- Use few numbers and round them. No parentheses, abbreviations, web addresses, or headline fragments.
- Say why something matters to Joe only when an item says it matched his watchlist or it is plainly about Beacon or Dutchess. Never invent a connection.
- You may quote only from an item's Quote line, word for word, and name the speaker.
- About ${target} words in total; fewer when there is little news.${label ? `
- This briefing covers ${label} news only. Stay on that beat.` : ""}
- An item marked "developing" is a big, fast-moving story: lead its section with it.

Reply with JSON only, no other text: {"stories":[{"text":"...","refs":[1,4]}]} in reading order, where refs are the item numbers each story uses.`;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const format = url.searchParams.get("format") === "text" ? "text" : "json";
  const input = env.WIRE && (await env.WIRE.get("brief.json", "json"));
  if (!input) return reply({ error: "The briefing data isn't ready yet. Try again after the next build." }, format, 503);

  const now = Date.now();
  let since = Number(url.searchParams.get("since")) || now - 12 * 3600e3;
  since = Math.min(Math.max(since, now - 30 * 3600e3), now);
  const bucket = Math.floor(since / (15 * 60e3));
  const beats = input.beats || [{ id: "all", label: "All" }];
  const beatId = beats.some((b) => b.id === url.searchParams.get("beat")) ? url.searchParams.get("beat") : "all";
  const beat = beats.find((b) => b.id === beatId) || beats[0];
  const cacheKey = new Request(`https://the-wire.brief/${encodeURIComponent(input.generated_at)}/${bucket}/${beatId}/${format}`);
  const cache = caches.default;
  if (!url.searchParams.has("fresh")) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  // "All" is the signal list; a category uses its own items, including single-outlet ones.
  const items = (input.items || []).filter((it) => beatId === "all" ? it.core !== false
    : it.scope === beatId || (it.beats || []).includes(beatId))
    .sort((a, b) => b.score - a.score);
  const fresh = items.filter((it) => Date.parse(it.t) > since);
  const mode = fresh.length >= 2 ? "new" : "top";
  const use = (mode === "new" ? fresh : items).slice(0, 18);
  const numbered = use.map((it, i) => ({ ...it, n: i + 1 }));

  let stories = [];
  let model = null;
  let dropped = 0;
  let notice = null;
  if (numbered.length && env.AI) {
    const prompt = (mode === "new"
      ? `Items new since ${fmt(since)}:\n\n`
      : `Little has changed since ${fmt(since)}. These are still the most important items today; brief them as a recap:\n\n`)
      + numbered.map(itemBlock).join("\n\n");
    for (const m of [MODEL, FALLBACK_MODEL]) {
      try {
        const out = await env.AI.run(m, {
          messages: [{ role: "system", content: SYSTEM(beatId === "all" ? input.target_words || 260 : 180, beatId === "all" ? null : beat.label) }, { role: "user", content: prompt }],
          max_tokens: 900, temperature: 0.2,
        });
        const parsed = parseStories(out && out.response);
        if (parsed.length) { stories = parsed; model = m; break; }
      } catch (e) {
        notice = "Writing model unavailable (" + String(e.message || e).slice(0, 80) + "); read the headlines instead.";
      }
    }
    const checked = [];
    for (const s of stories) {
      const refs = (s.refs || []).map(Number).filter((r) => numbered[r - 1]);
      const src = refs.map((r) => numbered[r - 1]);
      if (src.length && grounded(s.text, src)) checked.push({ text: clean(s.text), refs: src.map((x) => x.id) });
      else dropped += 1;
    }
    stories = checked;
  }
  if (!stories.length) {
    // Fallback: headlines, read plainly. Always available.
    stories = numbered.slice(0, 8).map((it) => ({ text: `${it.section === "Alert" ? "Weather alert" : it.section}: ${it.title.replace(/\s+/g, " ")}.`, refs: [it.id] }));
    if (!notice && numbered.length) notice = "Read from headlines.";
  }

  const where = beatId === "all" ? "on The Wire" : BEAT_PHRASE[beatId] || `in ${beat.label}`;
  const opener = `It's ${fmtTime(now)}. ` + (!numbered.length
    ? `There's nothing new ${where} in the last day.`
    : mode === "new"
    ? `Here's what's new ${where} since ${fmt(since)}.`
    : `Not much has changed ${where} since ${fmt(since)}. Here's where things stand.`);
  const sports = beatId === "all" && (input.sports || []).length ? [{ text: "In sports: " + input.sports.join(" "), refs: [] }] : [];
  const paragraphs = [{ text: opener, refs: [] }, ...stories, ...sports, { text: "That's The Wire.", refs: [] }];

  const usedIds = [...new Set(stories.flatMap((s) => s.refs))];
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));
  const body = {
    as_of: input.generated_at, written_at: new Date(now).toISOString(), since: new Date(since).toISOString(),
    mode, model, dropped, notice, paragraphs, beat: beatId, beats,
    sources: usedIds.map((id) => byId[id]).filter(Boolean).map((it) => ({ id: it.id, title: it.title, source: it.source, outlets: it.outlets, link: it.link })),
  };
  const res = reply(body, format, 200);
  if (model) await cache.put(cacheKey, res.clone());   // never cache a fallback
  return res;
}

const BEAT_PHRASE = { local: "in Beacon and the Hudson Valley", state: "in New York State", national: "in national news", world: "around the world" };

function itemBlock(it) {
  const age = Math.max(1, Math.round((Date.now() - Date.parse(it.t)) / 60e3));
  const lines = [
    `[${it.n}] ${it.section} · ${age < 60 ? age + " minutes" : Math.round(age / 60) + " hours"} ago · ${it.outlets > 1 ? it.outlets + " outlets" : it.source}${it.reports ? ", " + it.reports + " reports" : ""}${it.developing ? " · developing" : ""}${it.why ? " · " + it.why : ""}`,
    `Headline: ${it.title}`,
  ];
  if (it.summary) lines.push(`Details: ${it.summary}`);
  if (it.quote) lines.push(`Quote: "${it.quote.text}" (${it.quote.by})`);
  return lines.join("\n");
}

function parseStories(text) {
  if (!text) return [];
  if (typeof text === "object") return Array.isArray(text.stories) ? text.stories : [];
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const j = JSON.parse(m[0]);
    return Array.isArray(j.stories) ? j.stories.filter((s) => s && typeof s.text === "string") : [];
  } catch (e) {
    return [];
  }
}

const norm = (s) => String(s).toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/,(?=\d{3})/g, "");

// A sentence stays only if its numbers, names and quotes all appear in the items it cites.
function grounded(text, src) {
  const corpus = norm(src.map((it) => [it.section, it.title, it.summary, it.source, it.why, it.quote ? it.quote.text + " " + it.quote.by : ""].join(" ")).join(" "));
  for (const num of norm(text).match(/\d[\d.]*/g) || []) {
    if (!corpus.includes(num.replace(/\.$/, ""))) return false;
  }
  for (const q of String(text).match(/["“]([^"”]{8,})["”]/g) || []) {
    if (!corpus.includes(norm(q.slice(1, -1)))) return false;
  }
  const sentences = String(text).split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    const words = s.split(/\s+/).slice(1);   // the first word is capitalized anyway
    for (const w of words) {
      const name = w.replace(/[^A-Za-z'’-]/g, "").replace(/['’]s$/, "");
      if (name.length > 2 && /^[A-Z]/.test(name) && !ALLOWED_NAMES.has(name) && !corpus.includes(name.toLowerCase())) return false;
    }
  }
  return true;
}

function clean(t) {
  return String(t).replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
}

function fmt(ms) {
  const d = new Date(ms);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long" }).format(d);
  const today = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long" }).format(new Date());
  return (day === today ? "" : day + " at ") + fmtTime(ms);
}
function fmtTime(ms) {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

function reply(body, format, status) {
  const headers = { "cache-control": `private, max-age=${CACHE_SECONDS}` };
  if (format === "text") {
    const text = body.error || body.paragraphs.map((p) => p.text).join("\n\n");
    return new Response(text, { status, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
  }
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
}
