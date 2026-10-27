"""Fixture tests for the Puzzle Page generators (GAMES.md rule 2): every generator must reject
known-bad puzzles. Run: python tests/test_games.py (CI: privacy-check workflow)."""
from __future__ import annotations

import random
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import games  # noqa: E402


def test_guardrails():
    bad = [
        ("Oregon school shooter shares his story", "I heard him fire two shots"),
        ("Many feared trapped under collapsed building", "Eleven shops were occupied"),
        ("Council votes on carriages", "When he was taken from his family, from our city"),
        ("Hostages released", "We waited 400 days"),
        ("Man charged with fraud", "I did nothing wrong"),
        ("Optima Environmental wins contract", "We're proud"),
    ]
    for title, quote in bad:
        assert games.blocked(title, quote), f"should be blocked: {title}"
    assert games.blocked("Senate passes farm bill", "This bill keeps family farms going") is None
    # Known slips (2026-10-19 snapshot): a base fire, "deadly outbreaks", riots.
    assert games.blocked("Canada: Major fire reported at military base in Alberta",
                         "A serious incident creating a major fire has occurred at CFB Wainwright, in Alberta")
    assert games.blocked("NYC Council to consider earlier Legionella reporting after deadly outbreaks",
                         "We're trying to find ways to lower the opportunity for there to be outbreaks")
    assert games.blocked("Riots in Albanian capital enter a fifth day as anti-government protests escalate",
                         "I will not allow anyone to jeopardize the future of this country")
    assert games.blocked("Flames engulf 19th-century City Hall")
    assert games.blocked("Unrest spreads after the vote")
    # … but the fire department, the verb and the fire code are fine.
    for ok in ("Public Hearing for a Proposed Local Law Concerning Penalties for Violations of the City's Zoning, Fire Prevention, and Building Codes",
               "Council approves new truck for the fire department", "President moves to fire the Fed chair",
               "Ceasefire talks resume", "Senator comes under fire over vote"):
        assert games.blocked(ok) is None, ok


def test_institutional_threads():
    assert games.INSTITUTIONAL.search("Russia-Ukraine war")
    assert not games.INSTITUTIONAL.search("Beacon zoning rewrite")
    assert not games.INSTITUTIONAL.search("The tariff trade war heats up")
    # No thread: the item's own title and summary decide.
    assert games.institutional_only({"title": "Trump waives sanctions on Russia", "summary": ""}, None)
    assert not games.institutional_only({"title": "Dutchess votes to cover Flock cameras", "summary": ""}, None)
    assert games.institutional_only({"title": "Dutchess votes", "summary": ""}, "Russia-Ukraine war")


def test_speaker_titles():
    reg = {}
    sp = games.find_speaker(reg, "Interior Minister Laurent Nuñez")
    assert sp and sp["name"] == "Laurent Nuñez" and sp["role"] == "Interior Minister"
    assert games.find_speaker(reg, "Kaylub Giamanco") is None          # private person: never a puzzle
    assert games.find_speaker(reg, "X.\nHe") is None
    sp = games.find_speaker(reg, "State Marco Rubio", "Secretary of State Marco Rubio said on Tuesday")
    assert sp and sp["name"] == "Marco Rubio"


def test_cipher_no_self_map():
    for seed in range(200):
        key = games.derangement(random.Random(seed))
        assert all(k != v for k, v in key.items())
        assert sorted(key.values()) == sorted(key.keys())


def _uni(spec):
    return {name: set(ps) for name, ps in spec.items()}


def test_connections_rejects_two_solutions():
    preds = {f"p{i}": (f"cat {i}", "fact") for i in range(5)}
    # 16 items; p0..p3 are the intended groups, but item a3 and b3 both also fit the other's group,
    # so the board splits two ways.
    spec = {}
    for g, letter in enumerate("abcd"):
        for i in range(4):
            spec[f"{letter}{i}"] = {f"p{g}"}
    spec["a3"] |= {"p1"}
    spec["b3"] |= {"p0"}
    uni = _uni(spec)
    parts = games.partitions(list(uni), uni, preds)
    assert len(parts) == 2, parts


def test_connections_accepts_unique_with_decoy():
    preds = {f"p{i}": (f"cat {i}", "fact") for i in range(4)}
    preds["decoy"] = ("decoy", "decoy")
    spec = {}
    for g, letter in enumerate("abcd"):
        for i in range(4):
            spec[f"{letter}{i}"] = {f"p{g}"}
    for x in ("a0", "b1", "c2"):
        spec[x].add("decoy")
    uni = _uni(spec)
    parts = games.partitions(list(uni), uni, preds)
    assert len(parts) == 1


def test_connections_universe_mixed():
    from datetime import datetime, timezone
    now = datetime(2026, 10, 19, 20, tzinfo=timezone.utc)
    items = [{"id": "a", "t": "2026-10-18T12:00:00Z", "scope": "national", "title": "EPA and FBI brief Canada, France and Japan", "summary": "Justice Kavanaugh wrote."},
             {"id": "b", "t": "2026-10-18T12:00:00Z", "scope": "local", "title": "Newburgh and Beacon split costs", "summary": "Rochester visitors"}]
    reg = {"bob barker": {"name": "Bob Barker", "role": "U.S. Senator", "party": "R", "aliases": [], "kind": "legislator", "state": "NY", "chamber": "senate"}}
    items[0]["summary"] += " Bob Barker said."
    uni, preds = games.connections_universe({"items": items, "threads": [], "stories": []}, reg, None, now)
    assert not any(p.startswith("cmte:") for p in preds)                          # no committee trivia
    assert {"EPA", "FBI", "Canada", "France", "Japan", "Brett Kavanaugh", "Newburgh", "Beacon", "Bob Barker"} <= set(uni), set(uni)
    assert "Rochester" not in uni                                                  # usually means elsewhere
    assert "bloc:G7" in uni["Canada"] and "county:Orange" in uni["Newburgh"] and "court:scotus" in uni["Brett Kavanaugh"]
    assert games.alliterative("Bob Barker, Jr.") and games.alliterative("Bob Barker") and not games.alliterative("Bob Jones")
    assert games.same_ends("Albania") and not games.same_ends("Canada Dry")


def test_crypt_difficulty_monotone():
    easy = games.crypt_features("It's a fine day and I'll be at the shop at ten, so it's all good to go.")
    hard = games.crypt_features("Quickly judging mixed zebras vexes bold nymphs.")
    assert games.crypt_difficulty(easy) <= games.crypt_difficulty(hard)


def test_docket_excludes_minors_and_criminal():
    rows = [{"name": "West Virginia v. B. P. J.", "holding": "Title IX allows separate teams.", "date": "2026-06-30", "docket": "24-43", "author_code": "BK", "author": "Brett Kavanaugh", "emergency": False, "pdf": "x", "term": 25},
            {"name": "United States v. Smith", "holding": "The statute reaches the conduct.", "date": "2026-06-01", "docket": "24-1", "author_code": "R", "author": "John Roberts", "emergency": False, "pdf": "x", "term": 25}]
    rows += [{"name": f"Agency {i} v. Company {i}", "holding": f"Holding {i}.", "date": f"2026-05-0{i}", "docket": f"24-{i}0", "author_code": "EK", "author": "Elena Kagan", "emergency": False, "pdf": "x", "term": 25} for i in range(1, 6)]
    out = games.docket(rows, {"items": []}, "seed", None, [])
    names = {d["name"] for d in out}
    assert "West Virginia v. B. P. J." not in names and "United States v. Smith" not in names and len(out) == 5


def test_keyed_aristocrat():
    for w in games.KEYWORDS:
        assert len(set(w)) == len(w), w
        key = games.k1_key(w, random.Random(w))
        assert key and all(k != v for k, v in key.items())
        assert sorted(key.values()) == list(games.string.ascii_uppercase)
        # Reading the plaintext under ciphertext A–Z (in cipher order, rotated) shows the keyword in sequence.
        inv = {v: k for k, v in key.items()}
        row = "".join(inv[c] for c in games.string.ascii_uppercase)
        assert w in row + row, (w, row)


def test_casefile_unique_and_minimal():
    import collections
    tiers = collections.Counter()
    for k in range(12):
        target = 1 + k % 3
        rng = random.Random(f"fixture{k}")
        got = games._case_once(rng, target)
        if not got:
            continue
        P, T, clues, tier, _ = got
        assert len(games._all_solutions(clues)) == 1                            # one answer
        for c in clues:                                                         # minimal
            assert len(games._all_solutions([x for x in clues if x is not c])) > 1
        assert sum(c["kind"] in ("order", "adjacent") for c in clues) <= games.MAX_ORDER_CLUES
        assert all(games._case_links(clues))                                    # people↔projects, projects↔times
        tiers[tier] += 1
    assert len(tiers) >= 2, tiers
    for k in range(4):
        cf = games.casefile(f"seed{k}", [], 1 + k % 3)
        assert cf and 3 <= len(cf["clues"]) <= 16 and cf["tier"] in (1, 2, 3)
        sol = cf["solution"]
        assert sorted(v["project"] for v in sol.values()) == sorted(cf["projects"])
        assert sorted(v["time"] for v in sol.values()) == sorted(cf["times"])
        assert all(cf["project_times"][v["project"]] == v["time"] for v in sol.values())


def test_casefile_solver_rejects_guessing():
    # Only "before" clues on four people: several orders fit, so no deduction finishes it.
    clues = [{"kind": "order", "refs": (("p", 0), ("p", 1))}, {"kind": "order", "refs": (("p", 2), ("p", 3))}]
    assert len(games._all_solutions(clues)) > 1
    assert games.case_grade(clues)[0] is None
    # Direct facts with cross-grid transfer only: tier 1.
    P, T = (0, 1, 2, 3), (0, 1, 2, 3)
    direct = [{"kind": "pj", "cell": (i, i), "yes": True} for i in range(3)] + [{"kind": "jt", "cell": (i, i), "yes": True} for i in range(3)]
    assert games.case_grade(direct, P, T)[0] == 1


def test_tactics_boards():
    import tactics
    for P in tactics.pool("t-fixture", per_tier=1):
        assert 1 <= len(P["solutions"]) <= 3 and P["tier"] in (1, 2, 3)
        assert all(tactics.replay(P, l) for l in P["solutions"])
        b = tactics.Board({(x, y): t for x, y, t in P["terrain"]}, [tuple(x) for x in P["buildings"]], P["enemies"], P["units"])
        assert not tactics.greedy(b)                     # the obvious line loses
        b.enemies_attack()
        assert b.hit                                     # doing nothing loses


def test_docket_dispositions():
    import pending
    d = pending.disposition
    assert d("Pp. 4-19. 101 F. 4th 22, reversed and remanded. KAGAN, J., delivered the opinion of the Court")[0] == "petitioner"
    assert d("The Court of Appeals reversed. Pp. 3-9. 98 F.4th 1, affirmed. THOMAS, J., delivered the opinion of the Court")[0] == "respondent"
    assert d("55 F.4th 9, affirmed in part, reversed in part, and remanded. ROBERTS, C. J., delivered the opinion of the Court")[0] == "mixed"
    assert d("3 F.4th 2, vacated and remanded. BARRETT, J., delivered the opinion of the Court")[0] == "petitioner"
    assert d("no judgment line") is None


def test_openleg_holds():
    import json
    import tempfile
    import openleg
    card = {"id": "x", "jurisdiction": "NY", "verified": "2026-10-27", "source": "https://www.nysenate.gov/legislation/laws/NAV/181",
            "openleg": ["NAV/181", "NAV/172"], "cloze": {"text": "strictly liable, ___, for all", "answer": "without regard to fault", "source": "https://www.nysenate.gov/legislation/laws/NAV/181"}}
    assert openleg.watched(card) == ["NAV/181", "NAV/172"]
    p = Path(tempfile.mkdtemp()) / "ol.json"
    p.write_text(json.dumps({"NAV/181": {"active": "2014-09-22", "hash": "a", "base": "a", "phrases": {"x": True}}}))
    assert openleg.holds([card], p) == {}
    p.write_text(json.dumps({"NAV/172": {"active": "2027-01-01", "hash": "a", "base": "a"}}))
    assert "changed 2027-01-01" in openleg.holds([card], p)["x"]
    p.write_text(json.dumps({"NAV/181": {"active": "2014-09-22", "hash": "a", "base": "a", "phrases": {"x": False}}}))
    assert "no longer matches" in openleg.holds([card], p)["x"]


def test_pending_term_and_emergency():
    import json
    import tempfile
    from datetime import datetime, timezone
    import pending
    d = Path(tempfile.mkdtemp())
    ts = lambda s: datetime.fromisoformat(s + "T15:00:00+00:00").timestamp()
    case = lambda dk, day, name="Acme Corp. v. Widget Co.": {"docket_number": dk, "name": name, "question": "Whether the statute applies.", "term": "2025",
                                                             "timeline": [{"event": "Argued", "dates": [ts(day)]}]}
    d.joinpath("oyez_2025.json").write_text(json.dumps([case("24-983", "2026-02-23"), case("25A312", "2026-10-08", "Trump v. Cook"),
                                                        case("25-459", "2026-10-14"), case("24-1", "2026-03-02")]))
    now = datetime(2026, 10, 19, 12, tzinfo=timezone.utc)
    got = [x["docket"] for x in pending.pending(d, [], lambda r: None, now)]
    assert got == ["25-459"], got                      # last term's undecided-on-Oyez and the A-docket are out
    got = [x["docket"] for x in pending.pending(d, [], lambda r: None, now, disposed={"24-1"})]
    assert got == ["25-459", "24-1"], got
    assert pending.term_start(datetime(2027, 3, 1, tzinfo=timezone.utc)) == "2026-10-01"


def _wsi_data():
    from datetime import datetime, timezone
    now = datetime(2026, 10, 19, 20, tzinfo=timezone.utc)
    q = lambda by, text: {"by": by, "text": text}
    items = [
        {"id": "i1", "t": "2026-10-18T12:00:00Z", "source": "DW", "scope": "world", "title": "Israel: Trump endorses Netanyahu ahead of elections", "summary": "",
         "quotes": [q("Donald Trump", "If Israel has the wrong leader, which would be anyone other than Bibi, America will have a problem")]},
        {"id": "i2", "t": "2026-10-18T13:00:00Z", "source": "ABC", "scope": "national", "title": "President signs farm bill", "summary": "",
         "quotes": [q("Donald Trump", "This is a great bill for the farmers of this country and for the people who feed us all")]},
        {"id": "i3", "t": "2026-10-16T13:00:00Z", "source": "Highlands Current", "scope": "local", "title": "Dutchess Votes to Cover Flock Cameras", "summary": "",
         "quotes": [q("Chris Drago", "The conversation around Flock is a balancing act between privacy and safety for everyone here")]},
        {"id": "i4", "t": "2026-10-17T13:00:00Z", "source": "ABC", "scope": "national", "title": "Senators split on tariffs", "summary": "",
         "quotes": [q("John Cornyn", "Tariffs are a tax on the people of Texas, and I will keep saying so on the floor")]},
    ]
    reg = {"donald trump": {"name": "Donald Trump", "role": "President of the United States", "party": None, "aliases": [], "kind": "leader", "level": "national", "where": "United States"},
           "chris drago": {"name": "Chris Drago", "role": "Dutchess County Legislator", "party": "Democratic", "aliases": [], "kind": "person", "level": "local", "where": "Dutchess County"},
           "john cornyn": {"name": "John Cornyn", "role": "U.S. Senator", "party": "Republican", "aliases": [], "kind": "legislator", "level": "national", "where": "Texas"}}
    return {"items": items, "threads": [], "stories": []}, reg, now


def test_who_said_it_variety_and_hints():
    data, reg, now = _wsi_data()
    out = games.who_said_it(data, reg, now, [])
    names = [q["answer"] for q in out]
    assert names.count("Donald Trump") == 1, names                 # one quote per speaker
    assert names[0] == "Chris Drago", names                         # local first
    by = {q["answer"]: q for q in out}
    assert by["Chris Drago"]["party"] is None                       # party only from the congress roster
    assert by["John Cornyn"]["party"] == "Republican"
    assert games.leaks("Israel: Trump endorses Netanyahu ahead of elections", reg["donald trump"])   # context dropped
    assert not games.leaks("Dutchess Votes to Cover Flock Cameras", reg["chris drago"])
    data["items"][1]["quotes"] = []
    assert [q["context"] for q in games.who_said_it(data, reg, now, []) if q["answer"] == "Donald Trump"] == [None]
    assert by["Chris Drago"]["hints"] == ["Dutchess County Legislator", "Dutchess County", "C. D."]
    assert not any(h for q in out for h in q["hints"] if "October" in h)   # no date hint
    # A speaker already quoted earlier this ISO week stays out.
    out2 = games.who_said_it(data, reg, now, [], week_speakers={games.speaker_key("Donald Trump")})
    assert "Donald Trump" not in [q["answer"] for q in out2]


def test_quote_budget_two_games():
    data, reg, now = _wsi_data()
    wsi = games.who_said_it(data, reg, now, [])
    b = games.QuoteBudget()
    for q in wsi:
        b.take(q["id"], "who_said_it")
    b.take(wsi[0]["id"], "friday_quiz")
    assert not b.ok(wsi[0]["id"], "meta")
    cq = games.cryptoquotes(wsi, "s", [], b)
    assert wsi[0]["id"] not in [c["source"] for c in cq] and cq
    assert all(len(u) <= 2 for u in b.uses.values())


def test_beacon_agenda_rules():
    from datetime import datetime, timezone
    now = datetime(2026, 10, 19, 20, tzinfo=timezone.utc)
    A = lambda n, text, addr=None, flags=(): {"n": n, "text": text, "addr": addr, "flags": list(flags), "section": ""}
    data = {"items": [
        {"id": "pb1", "title": "Planning Board - Oct 09, 2026", "t": "2026-10-09T13:30:00Z", "link": "x", "agenda": [
            A(1, "Consider request for a one (1) year extension of Site Plan Approval, 300 Main Street, Mixed-Use, submitted by Anthony Hardisty (300 Main St LLC) agenda items and/or topics of interest to the Planning Board. The regular meeting will begin", "300 Main Street"),
            A(2, "Continue public hearing and continue review of application for Subdivision Approval, 108 Liberty Street, Residential, submitted by Stephen Spaccarelli and Claire Tipley", "108 Liberty Street", ["HEARING"]),
            A(3, "Public hearing and continue review application for Amended Site Plan Approval, 248 Tioronda Avenue, Residential, submitted by Beacon 248 Holdings, LLC", "248 Tioronda Avenue", ["HEARING"]),
            A(4, "New Single-Family House: Rombout Avenue (Tax Grid #5954-36-949764) Architectural Review")]},
        {"id": "pb0", "title": "Planning Board - Oct 01, 2026", "t": "2026-10-01T13:30:00Z", "link": "y", "agenda": [
            A(6, "Continue public hearing and continue review application for Amended Site Plan Approval, 248 Tioronda Avenue, Residential, submitted by Beacon 248 Holdings, LLC", "248 Tioronda Avenue", ["HEARING"])]},
        {"id": "pbold", "title": "Planning Board - Sep 10, 2026", "t": "2026-09-10T13:45:00Z", "link": "z", "agenda": [
            A(1, "Review of application for Amended Site Plan Approval, 172 Main Street, Mixed-Use, submitted by Hudson Todd, LLC", "172 Main Street")]},
        {"id": "cc", "title": "City Council - Oct 19, 2026", "t": "2026-10-16T09:47:18Z", "link": "w", "agenda": [
            A(None, "Appointment of David Murphy to the Position of Mechanical Equipment Operator"),
            A(None, "Settlement of Prospect Realty Syndicate Inc. Tax Certiorari"),
            A(4, "Resolution No. 85 - Authorizing Settlement of Prospect Realty Syndicate Inc. Tax Certiorari", None, ["RESOLUTION"])]},
    ]}
    drops = []
    out = games.beacon_agenda(data, "s", drops, now)
    texts = " | ".join(x["text"] for x in out)
    assert "Hardisty" not in texts and "300 Main St LLC" in texts               # person stripped, company kept
    assert "agenda items" not in texts                                          # boilerplate cut
    assert "Spaccarelli" not in texts and "Murphy" not in texts and "Rombout" not in texts
    assert "172 Main" not in texts                                              # meeting over three weeks old
    assert texts.count("248 Tioronda") == 1 and texts.count("Prospect Realty") == 1   # deduped across meetings
    assert not any(re.search(r"site plan|variance|resolution no", x["text"], re.I) for x in out), texts
    pr = next(x for x in out if "Prospect" in x["text"])
    assert pr["status"] == "Up for a vote as Resolution No. 85" and pr["answer"] == "City Council"
    tio = next(x for x in out if "Tioronda" in x["text"])
    assert tio["date"] == "2026-10-09"                                         # the newest meeting wins


def test_ledger_pairs_and_ids():
    from datetime import datetime, timezone
    now = datetime(2026, 10, 22, 12, tzinfo=timezone.utc)
    data = {"items": [{"id": "cc", "title": "City Council - Oct 19, 2026", "t": "2026-10-16T09:00:00Z", "link": "x", "agenda": [
        {"text": "Resolution No. 87 - Authorizing a Bond Issuance of $1,250,000 for the Construction of Mount Beacon Water Storage Tank"}]}]}
    figs = games.ledger_figures([], None, now, data)
    games.lineages(figs)
    money = [f for f in figs if f["subject"] == "Beacon budget"]
    assert money and money[0]["a"] == 1250000 and "Resolution No. 87" in money[0]["q"]
    ward = next(f for f in figs if "Ward 1" in f["q"] and f["unit"] == "voters")
    city = next(f for f in figs if f["q"].startswith("How many active registered voters did the City of Beacon"))
    county = next(f for f in figs if "Dutchess County have" in f["q"])
    assert not games.pairable(ward, city) and not games.pairable(ward, county) and not games.pairable(city, county)
    race = [f for f in figs if f["subject"] == "Beacon elections"]
    tot = next(f for f in race if f.get("pair_only"))
    top = next(f for f in race if f.get("family") == tot["family"] and f is not tot)
    assert not games.pairable(top, tot)                                   # a winner against the race's total
    a = games.ledger([], None, "wire-games-2026-10-22", now, [], data)
    b = games.ledger([], None, "wire-games-2026-10-29", now, [], data)
    assert {x["id"] for x in a} & {x["id"] for x in b}                    # ids follow the figure, not the date
    nsub = len({f["subject"] for f in figs if not f.get("pair_only")})
    first = [x["estimate"]["subject"] for x in a][:nsub]
    assert len(set(first)) == len(first)                                  # round-robin across subjects
    for x in a:
        for p in x["pairs"]:
            hi, lo = max(p["a"]["v"], p["b"]["v"]), min(p["a"]["v"], p["b"]["v"])
            assert hi / lo >= 2
    used = {x["id"] for x in a}
    c = games.ledger([], None, "wire-games-2026-10-22", now, [], data, lambda i: i in used)
    assert not used & {x["id"] for x in c}


def test_friday_quiz_shape():
    import yaml
    data, reg, now = _wsi_data()
    wsi = games.who_said_it(data, reg, now, [])
    cfg = yaml.safe_load((games.ROOT / "legal.yaml").read_text())
    cards = [{k: c.get(k) for k in ("id", "area", "family", "title", "cite", "source", "elements", "cloze")} for c in cfg["cards"] if c.get("status") == "verified"]
    lib = [{"id": "your_reps", "group": "Beacon", "title": "Who represents Beacon", "source": "x",
            "items": [{"answer": "Chris Drago", "accept": ["chris drago", "drago"], "clue": "County Legislature District 17"}]}]
    figs = [{"a": {"q": "A", "v": 10, "source": "s", "link": None}, "b": {"q": "B", "v": 50, "source": "s", "link": None}}]
    ldg = [{"id": "l1", "estimate": {}, "pairs": figs}, {"id": "l2", "estimate": {}, "pairs": [{"a": {"q": "C", "v": 3, "source": "s", "link": None}, "b": {"q": "D", "v": 9, "source": "s", "link": None}}]}]
    tl = [{"id": "t", "cards": [{"text": "X", "date": "2026-09-01"}, {"text": "Y", "date": "2026-10-01"}]}]
    dk = [{"name": "A v. B", "holding": "Holding.", "options": ["A v. B", "C v. D", "E v. F", "G v. H"], "date": "2026-06-01", "pdf": "x",
           "author": "Elena Kagan", "author_code": "EK", "author_accept": ["elena kagan", "kagan"]}]
    fq = games.friday_quiz(wsi, [], {"cards": cards}, data, "s", [], None, dk=dk, ldg=ldg, tl=tl, ba=[], lib=lib)
    qs = fq["questions"]
    assert len(qs) == 10, [q["kind"] for q in qs]
    assert not any(q["kind"] == "first" for q in qs)
    assert sum(q["kind"] == "who" for q in qs) <= 2
    typed = [q for q in qs if q["type"] == "typed"]
    assert 3 <= len(typed) <= 4 and all(q.get("accept") and "options" not in q for q in typed)
    assert all(q["answer"] in q["options"] for q in qs if q["type"] == "choice")
    byid = {c["title"]: c for c in cards}
    for q in qs:
        if q["kind"] == "law":
            c = byid[q["q"].split(": which")[0]]
            assert all("(" not in o and len(o) <= 70 for o in q["options"])
            src = next(x for x in cards if any(games.short_element(e["text"]) == q["answer"] for e in x["elements"]) and x["id"] != c["id"])
            assert src["area"] == c["area"] and src["family"] == c["family"]
    assert games.short_element("The defendant is a discharger (liability is strict (see § 172(8)); more)") == "The defendant is a discharger"


def test_legal_news_matches_statute():
    from datetime import datetime, timezone
    now = datetime(2026, 10, 19, 20, tzinfo=timezone.utc)
    st = lambda title, summary="", scope="national": {"id": title[:8], "t": "2026-10-18T12:00:00Z", "title": title, "summary": summary, "scope": scope, "source": "x", "link": "y"}
    feat = lambda *items: {(f["card"], f["title"][:20]) for f in games.legal({"items": list(items), "stories": [], "threads": []}, now, [])["featured"]}
    got = feat(st("Final rule: Clean Water Act Hazardous Substance Facility Response Plans: Compliance Date Delay"))
    assert not {c for c, _ in got} & {"cercla107", "cercla_prp", "cwa301"}, got
    got = feat(st("Orange County to host free household hazardous waste collection event", scope="local"))
    assert "rcra7002" not in {c for c, _ in got}, got
    assert "cwa301" in {c for c, _ in feat(st("EPA sues plant over NPDES permit violations"))}
    assert "cercla107" in {c for c, _ in feat(st("EPA seeks Superfund cost recovery from former owners"))}
    assert "nav181" in {c for c, _ in feat(st("Heating oil spill reaches Fishkill Creek", scope="local"))}
    assert "nav181" not in {c for c, _ in feat(st("Debate spills over into council meeting", scope="local"))}
    import yaml
    nav = next(c for c in yaml.safe_load((games.ROOT / "legal.yaml").read_text())["cards"] if c["id"] == "nav181")
    assert nav["elements"][1]["text"] == "The defendant is a discharger" and "Green" in nav["note"]


def test_legal_yaml_scalars():
    import yaml
    cards = (yaml.safe_load((games.ROOT / "legal.yaml").read_text()) or {}).get("cards", [])
    for c in cards:
        assert games.card_scalars(c) is None, (c["id"], games.card_scalars(c))
    d = next(c for c in cards if c["id"] == "defamation")
    assert "false" in d["elements"][0]["keys"]
    bad = {"id": "x", "elements": [{"text": "A false statement", "keys": [False, "falsity"]}]}
    assert "not text" in games.card_scalars(bad)


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("ok  ", name)
            except AssertionError as e:
                fails += 1
                print("FAIL", name, e)
    sys.exit(1 if fails else 0)
