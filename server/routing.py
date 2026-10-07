"""Directed-graph routing with open windows and travel time.

Two comparisons are produced for every query:
  * earliest-arrival path   -- time-dependent Dijkstra: wait until the edge's
                               next window then traverse; fastest arrival wins
  * preference candidates   -- paths honoring preferences such as
                               max_transfers / allowed_modes / max_walk_seconds;
                               if the preferred path is NOT feasible, the
                               offending edge(s) are reported as conflict edges.

An edge is "in conflict" for time `t` when:
  - the edge or one endpoint is offline,
  - no open window can complete the traversal before its close, or
  - arrival would miss the destination node's own entry window.

Advisories (weather/construction) only affect an edge when the traversal's
space-time segment intersects the advisory's scope AND time interval.
"""
from __future__ import annotations

import heapq
import json
from dataclasses import dataclass, field
from datetime import timedelta

from .timelib import parse_windows, earliest_open, parse_local, overlaps


@dataclass
class GraphNode:
    id: int
    slug: str
    name: str
    kind: str
    status: str
    windows: list
    windows_json: str
    tz: str


@dataclass
class GraphEdge:
    id: int
    slug: str
    name: str
    frm: int
    to: int
    travel_seconds: int
    mode: str
    status: str
    windows: list
    tz: str


@dataclass
class PathStep:
    edge_slug: str
    edge_name: str
    mode: str
    from_slug: str
    to_slug: str
    depart: str           # local wall time
    arrive: str
    tz: str
    waited_seconds: int
    conflict: str | None = None       # reason when this edge is infeasible
    advisories: list = field(default_factory=list)


@dataclass
class Path:
    feasible: bool
    steps: list[PathStep]
    arrival: str | None = None
    total_seconds: int | None = None
    transfers: int = 0
    conflict_edges: list = field(default_factory=list)
    reason: str | None = None

    def to_dict(self) -> dict:
        return {
            "feasible": self.feasible,
            "arrival": self.arrival,
            "total_seconds": self.total_seconds,
            "transfers": self.transfers,
            "reason": self.reason,
            "conflict_edges": self.conflict_edges,
            "steps": [s.__dict__ for s in self.steps],
        }


def build_graph(conn, tz_name: str = "Asia/Shanghai", anchor_local: str | None = None):
    nodes = {}
    for r in conn.execute("SELECT * FROM nodes"):
        d = dict(r)
        wins = parse_windows(json.loads(d["windows_json"]), tz_name, anchor_local)
        nodes[d["id"]] = GraphNode(d["id"], d["slug"], d["name"], d["kind"],
                                   d["status"], wins, d["windows_json"], tz_name)
    adj = {}
    edges = {}
    for r in conn.execute("SELECT * FROM edges"):
        d = dict(r)
        wins = parse_windows(json.loads(d["windows_json"]), tz_name, anchor_local)
        e = GraphEdge(d["id"], d["slug"], d["name"], d["from_node_id"],
                      d["to_node_id"], d["travel_seconds"], d["mode"],
                      d["status"], wins, tz_name)
        edges[d["id"]] = e
        adj.setdefault(e.frm, []).append(e)
    advisories = []
    for r in conn.execute("SELECT * FROM advisories WHERE status='active'"):
        d = dict(r)
        advisories.append(d)
    return nodes, adj, edges, advisories


def _matching_advisories(adv_list, edge, node, depart, arrive, tz_name):
    """Return advisories whose space-time prism intersects this traversal."""
    hits = []
    seg_start = depart.astimezone()
    seg_end = arrive.astimezone()
    for a in adv_list:
        scope_edges = set(json.loads(a["scope_edges_json"]))
        scope_nodes = set(json.loads(a["scope_nodes_json"]))
        if edge.slug not in scope_edges and node.slug not in scope_nodes:
            continue  # different space: advisory does not touch this segment
        a_s = parse_local(a["start_local"], a["tz"])
        a_e = parse_local(a["end_local"], a["tz"])
        if overlaps(seg_start, seg_end, a_s, a_e):
            hits.append({"id": a["id"], "kind": a["kind"],
                         "severity": a["severity"], "title": a["title"]})
    return hits


def _node_admits(windows, instant, max_days: int = 7) -> bool:
    for w in windows:
        offsets = range(0, max_days + 1) if w.repeating else (0,)
        for k in offsets:
            if w.contains(instant, k):
                return True
    return False


def _possible_departures(edge, t_dep, travel, max_days: int = 7,
                         adv_list=None):
    """Yield (depart, arrive) candidates consistent with edge windows.

    The earliest possible departure is yielded first; when advisories overlap
    the window we also yield a departure at each advisory end, so a closure
    covering only a sub-slice can be waited out instead of failing the edge."""
    if not edge.windows:
        yield t_dep, t_dep + travel
        return
    for win in edge.windows:
        offsets = range(0, max_days + 1) if win.repeating else (0,)
        for k in offsets:
            ws = win.start + timedelta(days=k)
            we = win.end + timedelta(days=k)
            dep0 = max(t_dep.astimezone(ws.tzinfo), ws)
            attempts = [dep0]
            if adv_list:
                # A closure/advisory covering [a_s,a_e) inside the window: if
                # the earliest departure's traversal overlaps it, also offer a
                # departure at a_e so the slice can simply be waited out.
                for a in adv_list:
                    if edge.slug not in json.loads(a["scope_edges_json"]):
                        continue
                    a_s = parse_local(a["start_local"], a["tz"]).astimezone(ws.tzinfo)
                    a_e = parse_local(a["end_local"], a["tz"]).astimezone(ws.tzinfo)
                    arr0 = dep0 + travel
                    if a_s < arr0 and dep0 < a_e <= we:
                        attempts.append(max(dep0, a_e))
            for dep in sorted(set(attempts)):
                arr = dep + travel
                if arr <= we:
                    yield dep, arr


def _earliest_traverse(edge, nodes, t_dep, adv_list, tz_name):
    """Earliest feasible traversal of `edge` at/after aware datetime t_dep,
    respecting edge windows AND destination entry windows.

    Returns (step, None, arrival) or (None, conflict_reason, None). The reason
    names the offending edge/node so callers can point at the conflict edge."""
    src = nodes[edge.frm]
    dst = nodes[edge.to]
    if edge.status != "online":
        return None, f"edge-offline:{edge.slug}", None
    if src.status != "online":
        return None, f"node-offline:{src.slug}", None
    if dst.status != "online":
        return None, f"node-offline:{dst.slug}", None

    travel = timedelta(seconds=edge.travel_seconds)
    chosen = None
    candidates = list(_possible_departures(edge, t_dep, travel,
                                           adv_list=adv_list))
    for depart, arrival in candidates:
        if dst.windows and not _node_admits(dst.windows, arrival):
            continue  # too late for destination on this attempt; try later
        adv_hits = _matching_advisories(adv_list, edge, dst, depart, arrival,
                                        tz_name)
        if any(h["severity"] == "closure" for h in adv_hits):
            continue  # closure only on this space-time slice; try a later one
        chosen = (depart, arrival, adv_hits)
        break

    if chosen is None:
        if not candidates:
            return None, f"no-open-window:{edge.slug}", None
        return None, f"arrival-after-close:{dst.slug}|via:{edge.slug}", None

    depart, arrival, adv_hits = chosen
    waited = int((depart - t_dep.astimezone(depart.tzinfo)).total_seconds())

    from .timelib import fmt_local
    step = PathStep(
        edge_slug=edge.slug, edge_name=edge.name, mode=edge.mode,
        from_slug=src.slug, to_slug=dst.slug,
        depart=fmt_local(depart, tz_name), arrive=fmt_local(arrival, tz_name),
        tz=tz_name, waited_seconds=waited, advisories=adv_hits)
    return step, None, arrival


def earliest_arrival_path(conn, origin_slug: str, dest_slug: str,
                          start_local: str, tz_name: str = "Asia/Shanghai",
                          adv_list=None):
    anchor = start_local
    nodes, adj, edges, advisories = build_graph(conn, tz_name, anchor)
    if adv_list is None:
        adv_list = advisories
    by_slug = {n.slug: n for n in nodes.values()}
    if origin_slug not in by_slug or dest_slug not in by_slug:
        return Path(False, [], reason="unknown-node")
    origin, dest = by_slug[origin_slug], by_slug[dest_slug]

    start = parse_local(start_local, tz_name)
    # origin node entry window
    if origin.windows and not _node_admits(origin.windows, start):
        return Path(False, [], reason=f"origin-closed:{origin.slug}")

    # (arrival_instant, node_id)
    pq = [(start, origin.id)]
    best = {origin.id: start}
    prev = {}
    while pq:
        t, nid = heapq.heappop(pq)
        if best.get(nid) and t != best[nid]:
            continue
        if nid == dest.id:
            break
        for edge in adj.get(nid, []):
            step, conflict, arr = _earliest_traverse(
                edge, nodes, t, adv_list, tz_name)
            if conflict:
                continue
            if arr is not None and (edge.to not in best or arr < best[edge.to]):
                best[edge.to] = arr
                prev[edge.to] = (edge, t, step)
                heapq.heappush(pq, (arr, edge.to))

    if dest.id not in best:
        return Path(False, [], reason="unreachable")
    return _reconstruct(prev, origin, dest, best[dest.id], nodes, tz_name)


def _reconstruct(prev, origin, dest, arrival, nodes, tz_name):
    from .timelib import fmt_local
    steps = []
    cur = dest.id
    modes = []
    while cur != origin.id:
        edge, t0, step = prev[cur]
        steps.append(step)
        modes.append(edge.mode)
        cur = edge.frm
    steps.reverse()
    modes.reverse()
    transfers = sum(1 for i in range(1, len(modes)) if modes[i] != modes[i - 1])
    first_dep = parse_local(steps[0].depart, tz_name)
    total = int((arrival.astimezone() - first_dep.astimezone()).total_seconds())
    return Path(True, steps, arrival=fmt_local(arrival, tz_name),
                total_seconds=total, transfers=transfers)


# --- Preference-constrained candidate evaluation -----------------------------

PREFERENCE_KEYS = {"max_transfers", "allowed_modes", "max_walk_seconds",
                   "avoid_edges", "prefer_modes"}


def evaluate_route(conn, ordered_edge_slugs: list[str], start_local: str,
                   preferences: dict | None = None,
                   tz_name: str = "Asia/Shanghai") -> Path:
    """Evaluate a user/editor-supplied ordered chain of edges under the given
    preferences. Unlike earliest_arrival_path this does not detour: it walks the
    chain in order and reports the first conflicting edge."""
    nodes, adj, edges, advisories = build_graph(conn, tz_name, start_local)
    by_slug_node = {n.slug: n for n in nodes.values()}
    by_slug_edge = {e.slug: e for e in edges.values()}
    prefs = preferences or {}

    conflict_edges = []
    steps = []
    t = parse_local(start_local, tz_name)
    transfers = 0
    last_mode = None
    walk_seconds = 0
    cur_node = None
    for i, eslug in enumerate(ordered_edge_slugs):
        edge = by_slug_edge.get(eslug)
        if edge is None:
            conflict_edges.append({"edge_slug": eslug,
                                   "reason": "edge-not-found"})
            return Path(False, steps, conflict_edges=conflict_edges,
                        reason="edge-not-found")
        if cur_node is None:
            cur_node = nodes[edge.frm]
            if cur_node.slug not in by_slug_node:
                pass
        elif edge.frm != cur_node.id:
            conflict_edges.append({
                "edge_slug": eslug,
                "reason": f"disconnected: previous ends at {cur_node.slug}, "
                          f"edge starts at {nodes[edge.frm].slug}"})
            return Path(False, steps, conflict_edges=conflict_edges,
                        reason="disconnected-chain")
        step, conflict, arr = _earliest_traverse(edge, nodes, t, advisories,
                                                 tz_name)
        # preference violations collected but time feasibility decides
        violations = []
        if edge.mode not in prefs.get("allowed_modes", [edge.mode]):
            violations.append("mode-not-allowed")
        if eslug in prefs.get("avoid_edges", []):
            violations.append("explicitly-avoided")
        if edge.mode == "walk":
            walk_seconds += edge.travel_seconds
        if last_mode and edge.mode != last_mode:
            transfers += 1
        last_mode = edge.mode

        if conflict:
            ce = {"edge_slug": eslug, "index": i, "reason": conflict,
                  "depart_after": _fmt(t, tz_name)}
            conflict_edges.append(ce)
            return Path(False, steps, conflict_edges=conflict_edges, reason=conflict)
        if violations:
            conflict_edges.append({"edge_slug": eslug, "index": i,
                                   "reason": ",".join(violations),
                                   "kind": "preference"})
            step.conflict = ",".join(violations)
        steps.append(step)
        t = arr
        cur_node = nodes[edge.to]

    if prefs.get("max_transfers") is not None and transfers > prefs["max_transfers"]:
        conflict_edges.append({"edge_slug": None,
                               "reason": f"transfers {transfers} > "
                                         f"max {prefs['max_transfers']}",
                               "kind": "preference"})
    if prefs.get("max_walk_seconds") is not None and walk_seconds > prefs["max_walk_seconds"]:
        conflict_edges.append({"edge_slug": None,
                               "reason": f"walk {walk_seconds}s > max "
                                         f"{prefs['max_walk_seconds']}s",
                               "kind": "preference"})
    hard = [c for c in conflict_edges if c.get("kind") != "preference"]
    total = None
    if steps:
        first_dep = parse_local(steps[0].depart, tz_name)
        last_arr = parse_local(steps[-1].arrive, tz_name)
        total = int((last_arr.astimezone()
                     - first_dep.astimezone()).total_seconds())
    return Path(not hard, steps, arrival=steps[-1].arrive if steps else None,
                total_seconds=total,
                transfers=transfers, conflict_edges=conflict_edges,
                reason=None if not hard else "preference-or-time-conflict")


def _fmt(dt, z):
    from .timelib import fmt_local
    return fmt_local(dt, z)


def compare(conn, origin_slug, dest_slug, start_local,
            candidate_edge_slugs=None, preferences=None, tz_name="Asia/Shanghai"):
    earliest = earliest_arrival_path(conn, origin_slug, dest_slug,
                                     start_local, tz_name)
    result = {
        "query": {"origin": origin_slug, "dest": dest_slug,
                  "start_local": start_local, "tz": tz_name},
        "earliest_arrival": earliest.to_dict() if earliest else None,
        "candidate": None,
    }
    if candidate_edge_slugs is not None:
        cand = evaluate_route(conn, candidate_edge_slugs, start_local,
                              preferences, tz_name)
        result["candidate"] = cand.to_dict()
        if earliest.feasible and cand.feasible and earliest.arrival and cand.arrival:
            e = parse_local(earliest.arrival, tz_name)
            c = parse_local(cand.arrival, tz_name)
            result["arrival_delta_seconds"] = int(
                (c.astimezone() - e.astimezone()).total_seconds())
    return result
