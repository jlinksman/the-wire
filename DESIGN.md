# DESIGN.md — How The Wire looks, and why

Research done 2026-10-16: iPhone-size screenshots of Techmeme, Memeorandum, Drudge, Hacker News, text.npr.org, lite.cnn.com, Semafor, 404 Media, the Highlands Current, Hell Gate and The Marshall Project, plus written analysis of Axios, Punchbowl, Bloomberg's terminal and Ground News. (AP, Rest of World and The City blocked automated visits.)

## Core idea: an audience of one
Mass-audience sites sort by recency or popularity and explain everything to strangers. The Wire has one reader with stated interests, one phone and a known routine (a morning catch-up, then glances). So it ranks by his priorities, uses shorthand, skips anything meant for newcomers, and is tuned for a 428px iPhone screen.

## Rules
- **Type.** Headlines in the system sans font, 16–17px, line height about 1.3. Monospace only where it carries meaning: times, desk tags, counts, metadata, the terminal chrome. (Monospace headlines fit about 46 characters per line on the phone; sans fits about 60, and reads faster.)
- **Rows.** A gray meta line (time · desk · source · type), then the headline on its own line (Hacker News, Techmeme).
- **Color is a signal, never decoration.** Amber means new or matched: fresh times under 30 minutes, new counts, watchlist hits. Red means weather alerts and failures only (Drudge's siren works because it's rare). Desk colors are muted so they don't compete.
- **Priority beats recency.** Beacon is pinned above the feed (last 48 hours, up to 5 items).
- **Respect the routine.** Items seen on the last visit are dimmed; desk buttons count what's new; a "new only" toggle exists.
- **Say what's coming.** A TODAY / TOMORROW line for meetings and games (Punchbowl's "what to expect").
- **Label the kind of item.** ▶ VIDEO, DOC, “ QUOTE, following his preference order: quotes, video, primary documents, then summaries (Semafor, Axios).
- **Quiet when healthy.** Source health is one line; a warning shows at the top only when something is down.
- **Fast beats dense.** The page opens instantly from a local copy, then refreshes.
- **Now is literal.** Clocks for Beacon, Paris and Tel Aviv (Semafor's world clocks).
- **Tap targets** at least 36–44px; 14px side gutters; nothing under 11px.

## Navigation and reading (UX pass, 2026-10-16)
Research: Apple HIG (tab bars, typography, layout), NN/g (hidden navigation, scrolling and attention, infinite scroll, dark mode), Hoober's thumb-zone study, NetNewsWire and Reeder.
- **Bottom tab bar, five tabs:** Today · Beacon · Gov (Government | Law & courts) · World (World | Sports) · Live. Always visible; single-word labels; amber badges count new items; tapping the current tab scrolls to top. On desktop (≥900px) it becomes a left sidebar.
- **Today ends.** Alerts, a one-line source warning, Ahead, the written edition, top 3 Beacon items, top 6 multi-source stories, last hour, recent scores, then "You're caught up." About three screens.
- **Feeds stop.** 30 rows at a time with "Show more", sticky day dividers, the "since you last opened" line, and an end line. Background refreshes never move the list: a "N new" pill waits at the top.
- **Detail sheet, not inline expansion.** Tapping an item opens a bottom sheet (summary, quotes, other outlets, agenda, blotter, Open / Share / Save); swipe down or ✕ to close.
- **One player.** Live plays at the top of the Live tab and docks as a mini-player above the tab bar elsewhere, without reloading.
- **Top bar:** brand (taps to top), as-of time, a source-health dot (green, or amber with a count), refresh, settings.
- **Text follows the iPhone's Text Size setting** (rem units on the system body font), with S/M/L/XL overrides in Settings. Tap targets 44pt or larger. Monospace only for times, labels and counts.
- **Settings (per device):** text size, world clocks, new-only default, saved items, muted words, sources shown, source health.

## Palette (dark)
Background #0b0d10 · panel #12161b · lines #20262d · text #e6e6e6 · meta #8a9099 · faint #5c636b · amber #ffb000 · red #ff5d5d · green #5be38f · desks: Beacon #7fd1a0, Gov #8fb6e8, Law #c9a2e0, World #b8a98a, Sports #6fc7c7.

## Backlog from the research
- **Story grouping** (Techmeme): one entry per story, other outlets' coverage indented beneath it with a "+3 sources" count. Planned for V5.
- **Flash tier** (Drudge, AP's urgency levels): a rare siren for the one story that truly matters, for example five or more outlets on the same event within an hour. Needs grouping first.
- **Running items** (the Highlands Current's "Planning Board Updates"): follow a specific application or project across meetings. Planned with V2's agenda work.

## Sources
- https://techcrunch.com/2011/10/31/techmeme-opens-the-kimono-on-how-it-chooses-headlines-and-sources/amp/
- https://signalvnoise.com/svn3/why-the-drudge-report-is-one-of-the-best-designed-sites-on-the-web/
- https://practicaltypography.com/monospaced-fonts.html
- https://mattstromawn.com/writing/ui-density/
- https://www.bloomberg.com/company/stories/how-bloomberg-terminal-ux-designers-conceal-complexity
- https://uxmag.com/articles/the-impossible-bloomberg-makeover
- https://www.semafor.com/article/10/18/2022/what-is-a-semaform-anyway-and-why-should-you-care
- https://www.journalism.co.uk/how-axios-is-reinventing-text-journalism-with-smart-brevity/
- https://www.cjr.org/special_report/punchbowl-dc-newsletter.php
- https://ground.news/bias-bar
- https://www.404media.co/
