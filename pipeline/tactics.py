"""Tactics puzzle (GAMES.md, Into the Breach-style): save every building in one turn.

Board 6×6: ground, water (an enemy pushed in drowns), mountains (block; bumping one hurts). Two
units: the Puncher (move up to 3, hit an adjacent tile: 1 damage and push it one tile away) and the
Artillery (move up to 2, fire 2–4 tiles in a straight line: 1 damage to the target and push the four
tiles around it outward). Enemies telegraph an attack on the tile next to them in a fixed direction;
the attack moves with the enemy if it's pushed. After your two units act, surviving enemies attack in
order. You win if no building is hit.

The generator brute-forces every unit order, move and attack (~60k lines), merges lines that end in
the same board, and keeps a board only if 1–3 distinct outcomes win and the greedy line (each unit
hits the most threatening enemy it can reach) loses. The page replays Joe's line with the same rules
(site/games.js, tested against this file in CI).
"""
from __future__ import annotations

import random
from itertools import permutations

N = 6
DIRS = {"N": (0, -1), "E": (1, 0), "S": (0, 1), "W": (-1, 0)}


def inb(x, y):
    return 0 <= x < N and 0 <= y < N


class Board:
    def __init__(self, terrain, buildings, enemies, units):
        self.t = terrain                       # dict (x,y) -> "water" | "mountain"
        self.b = set(buildings)                # building tiles
        self.e = [dict(x) for x in enemies]    # {x,y,hp,dir}
        self.u = [dict(x) for x in units]      # {x,y,kind}
        self.hit = False

    def copy(self):
        c = Board(self.t, self.b, self.e, self.u)
        c.hit = self.hit
        return c

    def occupied(self, x, y):
        return self.t.get((x, y)) == "mountain" or (x, y) in self.b or any(e["x"] == x and e["y"] == y and e["hp"] > 0 for e in self.e) \
            or any(u["x"] == x and u["y"] == y for u in self.u)

    def enemy_at(self, x, y):
        return next((e for e in self.e if e["x"] == x and e["y"] == y and e["hp"] > 0), None)

    def damage(self, x, y, n=1):
        if (x, y) in self.b:
            self.hit = True
        e = self.enemy_at(x, y)
        if e:
            e["hp"] -= n

    def push(self, x, y, d):
        e = self.enemy_at(x, y)
        if not e:
            return
        dx, dy = DIRS[d]
        nx, ny = x + dx, y + dy
        if not inb(nx, ny):
            return                                  # the edge holds it
        if self.occupied(nx, ny):
            e["hp"] -= 1                            # bump: both take 1
            self.damage(nx, ny)
            return
        e["x"], e["y"] = nx, ny
        if self.t.get((nx, ny)) == "water":
            e["hp"] = 0                             # drowned

    def reach(self, u, steps):
        """Tiles a unit can move to (orthogonal steps, not through anything)."""
        seen, frontier = {(u["x"], u["y"])}, [(u["x"], u["y"])]
        for _ in range(steps):
            nxt = []
            for x, y in frontier:
                for dx, dy in DIRS.values():
                    p = (x + dx, y + dy)
                    if inb(*p) and p not in seen and not self.occupied(*p) and self.t.get(p) != "water":
                        seen.add(p)
                        nxt.append(p)
            frontier = nxt
        return sorted(seen)

    def act(self, i, to, attack):
        u = self.u[i]
        u["x"], u["y"] = to
        kind, d = attack[0], attack[1]
        dx, dy = DIRS[d]
        if kind == "punch":
            tx, ty = u["x"] + dx, u["y"] + dy
            if inb(tx, ty):
                self.damage(tx, ty)
                self.push(tx, ty, d)
        else:                                       # artillery: attack = ("shell", dir, range)
            r = attack[2]
            tx, ty = u["x"] + dx * r, u["y"] + dy * r
            if inb(tx, ty):
                self.damage(tx, ty)
                for dd, (ax, ay) in DIRS.items():
                    nx, ny = tx + ax, ty + ay
                    if inb(nx, ny):
                        self.push(nx, ny, dd)

    def enemies_attack(self):
        for e in self.e:
            if e["hp"] <= 0:
                continue
            dx, dy = DIRS[e["dir"]]
            tx, ty = e["x"] + dx, e["y"] + dy
            if inb(tx, ty):
                self.damage(tx, ty)

    def key(self):
        return (tuple(sorted((e["x"], e["y"], max(e["hp"], 0)) for e in self.e)), tuple((u["x"], u["y"]) for u in self.u), self.hit)


def attacks(kind):
    if kind == "punch":
        return [("punch", d) for d in DIRS]
    return [("shell", d, r) for d in DIRS for r in (2, 3, 4)]


def lines(board):
    """Every (order, move, attack) line → final board."""
    for order in permutations(range(len(board.u))):
        b0 = board.copy()
        yield from _lines(b0, list(order), [])


def _lines(b, order, path):
    if not order:
        end = b.copy()
        end.enemies_attack()
        yield path, end
        return
    i = order[0]
    u = b.u[i]
    steps = 3 if u["kind"] == "punch" else 2
    for to in b.reach(u, steps):
        for a in attacks(u["kind"]):
            nb = b.copy()
            nb.act(i, to, a)
            if nb.hit:
                continue                            # we hit a building ourselves
            yield from _lines(nb, order[1:], path + [(i, to, a)])


def greedy(board):
    b = board.copy()
    for i, u in enumerate(b.u):
        best, score = None, -1
        for to in b.reach(u, 3 if u["kind"] == "punch" else 2):
            for a in attacks(u["kind"]):
                nb = b.copy()
                nb.act(i, to, a)
                if nb.hit:
                    continue
                s = sum(1 for e in b.e if e["hp"] > 0) - sum(1 for e in nb.e if e["hp"] > 0)
                s = s * 10 + sum(max(e["hp"], 0) for e in b.e) - sum(max(e["hp"], 0) for e in nb.e)
                if s > score:
                    best, score = (to, a), s
        if best:
            b.act(i, *best)
    b.enemies_attack()
    return not b.hit


def pool(seed, per_tier=2, budget=40):
    """A few boards for the day, by tier (3 winning outcomes = tier 1 … 1 = tier 3)."""
    out, k = {1: [], 2: [], 3: []}, 0
    while k < budget and any(len(v) < per_tier for v in out.values()):
        b = generate(f"{seed}:{k}")
        k += 1
        if b and len(out[b["tier"]]) < per_tier:
            b["id"] = f"tx{seed}{k}"
            out[b["tier"]].append(b)
    return [b for t in (1, 2, 3) for b in out[t]]


def replay(board_json, line):
    """Apply a line ([{unit,to,attack}]) to a pool board; True when no building is hit. For the CI cross-check."""
    terrain = {(x, y): t for x, y, t in board_json["terrain"]}
    b = Board(terrain, [tuple(x) for x in board_json["buildings"]], board_json["enemies"], board_json["units"])
    for st in line:
        b.act(st["unit"], tuple(st["to"]), tuple(st["attack"]))
    b.enemies_attack()
    return not b.hit


def generate(seed, tries=200):
    rng = random.Random(seed)
    for _ in range(tries):
        terrain = {}
        for _ in range(rng.randint(2, 4)):
            terrain[(rng.randrange(N), rng.randrange(N))] = "water"
        for _ in range(rng.randint(1, 3)):
            terrain[(rng.randrange(N), rng.randrange(N))] = "mountain"
        free = [(x, y) for x in range(N) for y in range(N) if (x, y) not in terrain]
        rng.shuffle(free)
        buildings = free[:3]
        rest = free[3:]
        enemies = []
        for (bx, by) in buildings[:2]:              # each of two enemies threatens a building
            for d, (dx, dy) in rng.sample(list(DIRS.items()), 4):
                ex, ey = bx - dx, by - dy
                if inb(ex, ey) and (ex, ey) in rest and not any(e["x"] == ex and e["y"] == ey for e in enemies):
                    enemies.append({"x": ex, "y": ey, "hp": rng.choice([1, 2]), "dir": d})
                    rest.remove((ex, ey))
                    break
        if len(enemies) < 2:
            continue
        third = rng.choice(rest)
        rest.remove(third)
        enemies.append({"x": third[0], "y": third[1], "hp": 1, "dir": rng.choice(list(DIRS))})
        units = [{"x": rest[0][0], "y": rest[0][1], "kind": "punch"}, {"x": rest[1][0], "y": rest[1][1], "kind": "artillery"}]
        board = Board(terrain, buildings, enemies, units)
        start = board.copy()
        start.enemies_attack()
        if not start.hit:
            continue                                # nothing to do: not a puzzle
        wins = {}
        for path, end in lines(board):
            if not end.hit:
                wins.setdefault(end.key(), path)
            if len(wins) > 3:
                break
        if not (1 <= len(wins) <= 3):
            continue
        if greedy(board):
            continue                                # the obvious line works: too easy
        return {
            "terrain": [[x, y, t] for (x, y), t in sorted(terrain.items())],
            "buildings": [list(b) for b in buildings],
            "enemies": enemies,
            "units": units,
            "solutions": [[{"unit": i, "to": list(to), "attack": list(a)} for i, to, a in sol] for sol in wins.values()],
            "outcomes": len(wins),
            "tier": {3: 1, 2: 2, 1: 3}[len(wins)],
        }
    return None
