"""Who holds the seat now (2026-11-04): officials games refresh with each election.

A race in elections.yaml that has a recorded result, `holds` (the seat's name as the Library and
local_politics.yaml label it, e.g. "State Senate District 39") and `term_start` produces a change:

- From the election until 60 days after the term starts, the Library has a "Who won on <date>" list
  (name them all, match): each winner with the seat, marked "new" when the seat changed hands.
- On the term's first day the seat's holder switches in every Library list that has that seat (Who
  represents Beacon, Beacon's mayor and council), or is added if no list had it. "Who left the list"
  then picks up whoever left, from the daily snapshots, with no hand edit.
- `map: "<map id>|<shape id>"` puts the new holder on that map's shape from the term's first day, and
  the map lists the seats that changed hands.

Only public facts: recorded results with who called them and a source (pipeline/calls.py checks them).
"""
from __future__ import annotations

from datetime import date, timedelta

NEW_LIST_DAYS = 60


def _winners(r: dict) -> list[str]:
    res = r.get("result") or {}
    w = res.get("winner") or []
    w = [w] if isinstance(w, str) else list(w)
    names = {c.get("name") for c in r.get("candidates") or []}
    if not res.get("called") or not res.get("source") or not w or any(x not in names for x in w):
        return []
    return w


def changes(cfg: dict) -> list[dict]:
    out = []
    for e in cfg.get("elections") or []:
        for r in e.get("races") or []:
            win = _winners(r)
            if not win or not r.get("holds") or not r.get("term_start"):
                continue
            inc = [c["name"] for c in r.get("candidates") or [] if c.get("incumbent")]
            out.append({"race": f"{e['id']}:{r['id']}", "office": r["holds"], "winners": win, "incumbents": inc,
                        "changed": (set(win) != set(inc)) if inc else bool(r.get("open_seat")),
                        "term_start": str(r["term_start"]), "election": e.get("title"), "date": str(e["date"]),
                        "map": r.get("map"), "source": r["result"]["source"]})
    return out


def apply(lists: list[dict], ch: list[dict], today: date, acc) -> dict:
    """Edit the Library lists in place; return what the maps need. `acc(name)` builds accepted answers."""
    started = [c for c in ch if date.fromisoformat(c["term_start"]) <= today]
    for c in started:
        hit = False
        for L in lists:
            idx = [i for i, x in enumerate(L["items"]) if x.get("clue") == c["office"]]
            if not idx:
                continue
            hit = True
            for i, name in zip(idx, c["winners"]):
                L["items"][i] = dict(L["items"][i], answer=name, accept=acc(name))
            for i in idx[len(c["winners"]):][::-1]:
                del L["items"][i]
        if not hit:
            reps = next((L for L in lists if L["id"] == "your_reps"), None)
            if reps is not None:
                reps["items"] += [{"answer": n, "accept": acc(n), "clue": c["office"]} for n in c["winners"]]
    # Incumbents re-elected to a seat no list carried yet (Governor, Attorney General...) join now.
    reps = next((L for L in lists if L["id"] == "your_reps"), None)
    if reps is not None:
        have = {x.get("clue") for L in lists for x in L["items"]}
        for c in ch:
            if c not in started and not c["changed"] and c["office"] not in have:
                reps["items"] += [{"answer": n, "accept": acc(n), "clue": c["office"]} for n in c["winners"]]
    # The "who won" list, while it's news.
    by_date: dict[str, list[dict]] = {}
    for c in ch:
        if date.fromisoformat(c["date"]) <= today <= date.fromisoformat(c["term_start"]) + timedelta(days=NEW_LIST_DAYS):
            by_date.setdefault(c["date"], []).append(c)
    for d, cs in sorted(by_date.items()):
        items = [{"answer": n, "accept": acc(n), "clue": c["office"] + (" · new" if c["changed"] else " · re-elected" if c["incumbents"] else "")}
                 for c in cs for n in c["winners"]]
        when = date.fromisoformat(d)
        lists.append({"id": "won_" + d.replace("-", ""), "group": "Beacon", "title": f"Who won on {when.strftime('%B')} {when.day}, {when.year}",
                      "items": items, "source": "elections.yaml results (official counts and called races, each sourced)", "as_of": d,
                      "mentions": 5})
    seats = []
    for c in ch:
        if c.get("map") and "|" in c["map"]:
            m, shape = c["map"].split("|", 1)
            seats.append({"map": m, "shape": shape, "who": " and ".join(c["winners"]), "office": c["office"], "from": c["term_start"],
                          "changed": c["changed"], "election": c["date"], "live": date.fromisoformat(c["term_start"]) <= today})
    return {"seats": seats}
