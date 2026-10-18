# DESIGN.md — How The Wire looks, and why

Research done 2026-10-16: iPhone-size screenshots of Techmeme, Memeorandum, Drudge, Hacker News, text.npr.org, lite.cnn.com, Semafor, 404 Media, the Highlands Current, Hell Gate and The Marshall Project, plus written analysis of Axios, Punchbowl, Bloomberg's terminal and Ground News. (AP, Rest of World and The City blocked automated visits.)

## Core idea: an audience of one
Mass-audience sites sort by recency or popularity and explain everything to strangers. The Wire has one reader with stated interests, one phone and a known routine (a morning catch-up, then glances). So it ranks by his priorities, uses shorthand, skips anything meant for newcomers, and is tuned for a 428px iPhone screen.

## Principles (design pass 2, 2026-10-17)
Research: Apple HIG (dark mode, typography, layout), Material's dark-theme guidance (soft surfaces, desaturated accents, no pure white), Level Access on halation for readers with astigmatism, Particle and Artifact for calm news layouts. These rules govern every new feature.
1. **Content is the brightest thing on screen.** Labels, lines and buttons stay quiet.
2. **One color, one meaning.** Amber = new or unread. Coral = live video and alerts. Sage = where you are. Desk colors appear only as small dots. A new feature doesn't get a new color.
3. **Hierarchy from size, weight and space,** not capitals, color or outlines. Sentence case everywhere except the wordmark.
4. **Serif for reading, sans for using.** Headlines, the edition, quotes: New York (`ui-serif`). Labels, buttons, metadata: San Francisco. Monospace only for the THE WIRE wordmark.
5. **Calm by default, loud by exception.** Motion and strong color only for live video and alerts.
6. **Every screen ends and fits a thumb.** Lists stop; choices come in short sets (segments, pills, regions); actions sit in the bottom half.
7. **Same thing, same piece.** Row, card, section header, sheet, pill, segmented control. Build new features from these before inventing a seventh.
8. **One gesture each.** Tap opens, swipe down closes, the tab bar goes home.
9. **Respect the phone.** Follow the iPhone's text size and its Light/Dark setting (lockable in Settings). Tap targets 44pt or larger.
10. **Glanceable in three seconds.** The top of Today answers: anything urgent, what's next, what's new.

## Components
- **Row:** headline (serif, 18pt regular) first; one gray line beneath: time (amber only if new) · source · kind · source count · watch tags (amber pill).
- **Card:** soft surface, 16pt corners, no outline. Story cards: "N sources · desk dot", serif semibold headline, machine summary in secondary gray, one italic quote, "Updated N ago".
- **Section header:** sentence case, 20pt semibold, with a quiet "See all".
- **Sheet:** slides up for any detail or setting; title in serif; one green primary button.
- **Segmented control:** Beacon | Region · Government | Law & courts · World | Sports.
- **Brief me:** a card near the top of Today. Tapping it writes a fresh spoken briefing of what's new since the last visit (Workers AI, only on tap, cached 15 minutes) and reads it aloud with the iPhone's own voice. Radio rules from NPR's newscast desk and broadcast writing guides: lead with what happened and why it matters, attribution before the claim, short present-tense sentences, few rounded numbers, about 90 seconds. Signal comes from the build: official and primary items, watchlist matches, and stories carried by two or more outlets; single-outlet national items, regional items, opinion and features stay out. Every sentence is checked against its cited items; untraceable lines are dropped and counted. A row of category pills (All · Local · State · National · World · Paris · Israel) rewrites the briefing for one beat; categories also draw on single-outlet items from that scope.
- **Developing:** a story with six or more reports from three or more outlets in the last six hours is labeled "Developing" in coral (coral already means live or alert) and ranks higher. Quiet sources never add lone rows; they appear inside stories.
- **Pills:** Live regions (★ Pinned · Beacon · US · World · France · Israel); each region is a short list of channel rows with ▶ (or ↗ for sites) and a ☆ to pin.

## Palette
Dark: background #141619 · surface #1c1f23 · raised #252a2f · text #e8e5df / #aaaba7 / #7b7f82 · amber #e2b66a · coral #e98d7f · sage #93cfa8.
Light: background #f5f3ee · surface #ffffff · raised #ebe8e2 · text #1d1f22 / #575b60 / #82868a · amber #9a6510 · coral #c0473a · sage #2f7a52.

## Navigation and reading (UX pass, 2026-10-16)
Research: Apple HIG (tab bars, typography, layout), NN/g (hidden navigation, scrolling and attention, infinite scroll, dark mode), Hoober's thumb-zone study, NetNewsWire and Reeder.
- **Bottom tab bar, five tabs:** Today · Beacon (Beacon | Region) · Gov (Government | Law & courts) · World (World | Sports) · Live. Always visible; single-word labels; an amber dot marks new items; tapping the current tab scrolls to top. On desktop (≥900px) it becomes a left sidebar.
- **Today ends.** Alerts, a one-line source warning, Ahead, the written edition, top 3 Beacon items, top 6 multi-source stories, last hour, recent scores, then "You're caught up." About three screens.
- **Feeds stop.** 30 rows at a time with "Show more", sticky day dividers, the "since you last opened" line, and an end line. Background refreshes never move the list: a "N new" pill waits at the top.
- **Detail sheet, not inline expansion.** Tapping an item opens a bottom sheet (summary, quotes, other outlets, agenda, blotter, Open / Share / Save); swipe down or ✕ to close.
- **One player.** Live plays at the top of the Live tab and docks as a mini-player above the tab bar elsewhere, without reloading.
- **Top bar:** brand (taps to top), as-of time, a source-health dot (green, or amber with a count), refresh, settings.
- **Text follows the iPhone's Text Size setting** (rem units on the system body font), with S/M/L/XL overrides in Settings. Tap targets 44pt or larger.
- **Settings (per device):** appearance (match iPhone, dark, light), text size, world clocks, new-only default, saved items, muted words, sources shown, source health.

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
