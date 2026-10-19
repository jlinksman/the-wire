"""Places, scope and beats for items, and event-level merging of stories.

Headline grouping (stories.group) finds reports with near-identical headlines. A big
event produces many differently worded headlines ("Fires and clashes rock France",
"Looters seize on French protests"), which that pass leaves as separate fragments. This
pass merges fragments that name the same foreign place and the same kind of event
within a day, so the event ranks as one story with all its outlets.

Kinds of event are deliberately narrow (unrest, quakes, storms, fires, elections,
shootings, crashes, coups). War and diplomacy are left to headline grouping, because a
day of coverage of an ongoing war is many separate stories, not one.
"""

from __future__ import annotations

import re

# Place key -> words that name it (country, demonym, capital and major cities).
# The United States is not a place here: almost every national story would share it.
PLACES = {
    "france": "France French Paris Marseille Lyon Toulouse Nantes Bordeaux Lille Macron Élysée Elysee",
    "israel": "Israel Israeli Israelis Tel Aviv Jerusalem Haifa Knesset Netanyahu IDF",
    "palestine": "Gaza Gazan Gazans West Bank Palestinian Palestinians Hamas Ramallah Rafah",
    "lebanon": "Lebanon Lebanese Beirut Hezbollah",
    "iran": "Iran Iranian Iranians Tehran",
    "syria": "Syria Syrian Syrians Damascus Aleppo",
    "iraq": "Iraq Iraqi Iraqis Baghdad",
    "yemen": "Yemen Yemeni Houthi Houthis Sanaa",
    "saudi": "Saudi Riyadh",
    "turkey": "Turkey Turkish Türkiye Ankara Istanbul Erdogan Erdoğan",
    "egypt": "Egypt Egyptian Cairo",
    "ukraine": "Ukraine Ukrainian Ukrainians Kyiv Kiev Kharkiv Odesa Zelensky Zelenskyy",
    "russia": "Russia Russian Russians Moscow Kremlin Putin",
    "uk": "Britain British UK England Scotland Scottish Wales Welsh London Starmer",
    "ireland": "Ireland Irish Dublin",
    "germany": "Germany German Germans Berlin Munich Hamburg Merz",
    "italy": "Italy Italian Italians Rome Milan Naples Meloni",
    "spain": "Spain Spanish Madrid Barcelona Catalonia",
    "portugal": "Portugal Portuguese Lisbon",
    "belgium": "Belgium Belgian Brussels",
    "netherlands": "Netherlands Dutch Amsterdam",
    "poland": "Poland Polish Warsaw",
    "greece": "Greece Greek Athens",
    "serbia": "Serbia Serbian Belgrade",
    "hungary": "Hungary Hungarian Budapest Orban Orbán",
    "romania": "Romania Romanian Bucharest",
    "georgia_country": "Tbilisi Georgian",
    "china": "China Chinese Beijing Shanghai Xi Jinping",
    "hongkong": "Hong Kong",
    "taiwan": "Taiwan Taiwanese Taipei",
    "japan": "Japan Japanese Tokyo Osaka",
    "korea": "Korea Korean Koreans Seoul Pyongyang",
    "india": "India Indian Indians Delhi Mumbai Modi",
    "pakistan": "Pakistan Pakistani Islamabad Karachi Lahore",
    "afghanistan": "Afghanistan Afghan Kabul Taliban",
    "bangladesh": "Bangladesh Bangladeshi Dhaka",
    "nepal": "Nepal Nepali Kathmandu",
    "indonesia": "Indonesia Indonesian Jakarta",
    "philippines": "Philippines Philippine Filipino Manila",
    "thailand": "Thailand Thai Bangkok",
    "myanmar": "Myanmar Burma Burmese",
    "vietnam": "Vietnam Vietnamese Hanoi",
    "australia": "Australia Australian Sydney Melbourne",
    "canada": "Canada Canadian Canadians Ottawa Toronto Montreal Carney",
    "mexico": "Mexico Mexican Mexicans Sheinbaum",
    "venezuela": "Venezuela Venezuelan Caracas Maduro",
    "colombia": "Colombia Colombian Bogotá Bogota",
    "brazil": "Brazil Brazilian Brasília Lula",
    "argentina": "Argentina Argentine Buenos Aires Milei",
    "chile": "Chile Chilean Santiago",
    "peru": "Peru Peruvian Lima",
    "ecuador": "Ecuador Ecuadorian Quito",
    "haiti": "Haiti Haitian Port-au-Prince",
    "cuba": "Cuba Cuban Havana",
    "nigeria": "Nigeria Nigerian Abuja Lagos",
    "kenya": "Kenya Kenyan Nairobi",
    "ethiopia": "Ethiopia Ethiopian Addis Ababa",
    "sudan": "Sudan Sudanese Khartoum Darfur",
    "congo": "Congo Congolese Kinshasa Goma",
    "southafrica": "South Africa South African Johannesburg Cape Town",
    "morocco": "Morocco Moroccan Rabat",
    "madagascar": "Madagascar Malagasy Antananarivo",
    "mali": "Mali Malian Bamako",
}
EVENTS = {
    "unrest": r"protest\w*|riot\w*|clashes|clash(?:ed)? with (?:police|security|riot|protesters|demonstrators)|loot\w*|demonstrat\w*|unrest|yellow vests?|tear gas|curfew|uprising|marches|marched|strikers|general strike|mass strike|barricade\w*|police (?:fire|charge)",
    "quake": r"earthquake\w*|quake\w*|aftershock\w*|tsunami\w*",
    "storm": r"hurricane\w*|typhoon\w*|cyclone\w*|tropical storm|flood\w*|landslide\w*|monsoon",
    "fire": r"wildfire\w*|bushfire\w*|forest fire\w*",
    "election": r"election\w*|vote\w*|voting|ballot\w*|polls? (?:open|close)|runoff|referendum|exit poll\w*",
    "shooting": r"shooting\w*|gunman|gunmen|mass shooting",
    "crash": r"plane crash|crash\w* (?:kills|killed)|derail\w*|ferry (?:sinks|capsiz\w*)|capsiz\w*|collapse\w*",
    "coup": r"\bcoup\b|junta|ousted|toppled",
    "outbreak": r"outbreak\w*|epidemic|cholera|ebola|mpox",
}

def _forms(spec: str) -> list[str]:
    """Split a place spec into names, keeping two-word names (Tel Aviv, West Bank) together."""
    words = spec.split()
    multi = {"Tel Aviv", "West Bank", "Hong Kong", "South Africa", "South African", "Cape Town", "Addis Ababa",
             "Buenos Aires", "Port-au-Prince", "Xi Jinping"}
    out, i = [], 0
    while i < len(words):
        pair = " ".join(words[i:i + 2])
        if pair in multi:
            out.append(pair)
            i += 2
        else:
            out.append(words[i])
            i += 1
    return out


PLACE_RE = {k: re.compile(r"(?<![\w-])(?:" + "|".join(re.escape(w) for w in sorted(_forms(v), key=len, reverse=True)) + r")(?:['’]s)?(?![\w-])")
            for k, v in PLACES.items()}
EVENT_RE = {k: re.compile(r"\b(?:" + v + r")", re.IGNORECASE) for k, v in EVENTS.items()}


def places(text: str) -> set[str]:
    return {k for k, rx in PLACE_RE.items() if rx.search(text)}


def kinds(text: str) -> set[str]:
    return {k for k, rx in EVENT_RE.items() if rx.search(text)}


# ---------------------------------------------------------------- scope and beats

SECTION_SCOPE = {
    "beacon": "local", "regional": "local", "dutchess": "local",
    "new_york": "state", "courts": "national", "federal": "national", "law": "national",
    "national_world": "mixed", "paris": "world", "tel_aviv": "world", "osint": "world", "sports": "sports",
}


PEOPLE_INFO: dict = {}


def tag(data: dict, src_by_id: dict, beats_cfg: dict) -> None:
    """Add quiet, scope and beats to each item in data.json (computed every build, so
    config changes apply to stored items too)."""
    beat_re = {k: re.compile(v["pattern"], re.IGNORECASE) for k, v in (beats_cfg or {}).items()}
    PEOPLE_INFO["map"] = {p["id"]: p for p in data.get("people", [])}
    for it in data["items"]:
        src = src_by_id.get(it["source_id"], {})
        if src.get("quiet") or src.get("person_feed"):
            it["quiet"] = True          # person feeds show in Following and inside stories, not as desk rows
        if it.get("people"):
            pmap = PEOPLE_INFO.get("map", {})
            persp = [pmap[p]["perspective"] for p in it["people"] if p in pmap and pmap[p].get("perspective")]
            if persp:
                it["perspective"] = persp[0]
        if src.get("no_ai"):
            it["no_ai"] = True
        if src.get("no_brief"):
            it["no_brief"] = True
        scope = src.get("scope") or SECTION_SCOPE.get(src.get("_section", ""), "mixed")
        if it.get("alert"):
            scope = "local"
        if scope == "mixed":
            scope = "world" if places(it["title"]) else "national"
        it["scope"] = scope
        text = f"{it['title']} {it.get('summary', '')[:200]}"
        b = [k for k, rx in beat_re.items() if rx.search(it["title"]) or (scope == "world" and rx.search(text))]
        b += [k for k in src.get("beats") or [] if k not in b]      # a city outlet is always on its beat
        if it.get("people") and it.get("kind") != "POST":
            b.append("following")
        if b:
            it["beats"] = b


# ---------------------------------------------------------------- event merging

EVENT_WINDOW_H = 30


def merge_events(clusters: list[list[dict]], ms) -> list[list[dict]]:
    """Merge headline clusters that share a foreign place and a kind of event.

    A cluster's places are those named in at least half its headlines (so a passing
    mention doesn't pull it in); its kinds are those named in any headline. Two clusters
    merge when they share a place and a kind and their reports fall within EVENT_WINDOW_H.
    Sports never merges.
    """
    def profile(c):
        n = len(c)
        pc: dict[str, int] = {}
        kc: dict[str, int] = {}
        for m in c:
            for p in places(m["title"]):
                pc[p] = pc.get(p, 0) + 1
            for k in kinds(m["title"]):
                kc[k] = kc.get(k, 0) + 1
        main = {p for p, k in pc.items() if k * 2 >= n}
        # Kinds count only when at least half the headlines name them (a passing "election" doesn't).
        ks = {k for k, v in kc.items() if v * 2 >= n}
        return main, set(pc), ks

    news = sorted([c for c in clusters if c[0]["desk"] != "SPORTS"], key=len, reverse=True)
    other = [c for c in clusters if c[0]["desk"] == "SPORTS"]
    # Greedy, largest first, against each group's whole profile: a cluster joins a group only
    # when it shares a main place and a kind with the group as it stands. No chaining, so a
    # Sydney protest about an Israeli visit can't reach French protests through a Haaretz
    # headline that mentions both.
    groups: list[list[dict]] = []
    gprof: list[tuple] = []
    gspan: list[tuple] = []
    for c in news:
        mi, ai, ki = profile(c)
        lo_c, hi_c = min(ms(m) for m in c), max(ms(m) for m in c)
        target = None
        if ki and mi:
            for gi, g in enumerate(groups):
                mg, ag, kg = gprof[gi]
                if not (ki & kg) or not (mi & mg):
                    continue
                lo, hi = min(gspan[gi][0], lo_c), max(gspan[gi][1], hi_c)
                if (hi - lo).total_seconds() > EVENT_WINDOW_H * 3600:
                    continue
                target = gi
                break
        if target is None:
            groups.append(list(c)); gprof.append((mi, ai, ki)); gspan.append((lo_c, hi_c))
        else:
            groups[target].extend(c)
            gprof[target] = profile(groups[target])
            gspan[target] = (min(gspan[target][0], lo_c), max(gspan[target][1], hi_c))
    return [sorted(g, key=ms) for g in groups] + other
