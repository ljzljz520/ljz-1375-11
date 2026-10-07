"""Domain services: CRUD with optimistic locking, recurrence proposals,
announcement ingestion, publication freeze, almanac assembly.

Hard rule encoded here (no date may silently roll over):
  * a recurrence_rule can only *propose* DRAFT activity_instances;
  * an instance becomes `confirmed` only via a source-confirmed announcement;
  * confirmation checks that the announcement actually names that occurrence.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

from .timelib import now_iso, parse_local
from . import routing

EDITABLE = {
    "node": "nodes",
    "edge": "edges",
    "route": "routes",
    "announcement": "announcements",
    "instance": "activity_instances",
    "article": "historical_articles",
    "advisory": "advisories",
    "rule": "recurrence_rules",
}


def connect(path="data/cultural_station.db"):
    # check_same_thread=False is safe: every use in the HTTP layer is wrapped
    # by app._LOCK, and the process is single-writer.
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# ---------------------------------------------------------------- helpers

def _audit(conn, etype, eid, action, actor, expected, new, ok, detail=""):
    conn.execute(
        """INSERT INTO edit_events
           (entity_type,entity_id,action,actor,expected_version,new_version,ok,detail,at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (etype, eid, action, actor, expected, new, 1 if ok else 0, detail, now_iso()))


def update_versioned(conn, table, entity_id, fields: dict, expected_version: int,
                     actor="editor"):
    """Optimistic-locked update. Raises VersionConflict on stale version."""
    cur = conn.execute(f"SELECT version FROM {table} WHERE id=?", (entity_id,))
    row = cur.fetchone()
    if row is None:
        raise NotFound(table, entity_id)
    if row["version"] != expected_version:
        _audit(conn, table, entity_id, "update_rejected", actor,
               expected_version, row["version"], False,
               "stale version")
        raise VersionConflict(table, entity_id, expected_version, row["version"])
    sets = ", ".join(f"{k}=?" for k in fields)
    conn.execute(
        f"UPDATE {table} SET {sets}, version=version+1, updated_at=? WHERE id=?",
        (*fields.values(), now_iso(), entity_id))
    _audit(conn, table, entity_id, "update", actor, expected_version,
           expected_version + 1, True)
    conn.commit()
    return expected_version + 1


class NotFound(Exception):
    pass


class VersionConflict(Exception):
    def __init__(self, table, eid, expected, actual):
        self.table, self.eid = table, eid
        self.expected, self.actual = expected, actual
        super().__init__(f"version conflict on {table}#{eid}: "
                         f"expected {expected}, current {actual}")


class RuleError(Exception):
    pass


# ---------------------------------------------------------------- nodes

def create_node(conn, payload, actor="editor"):
    cur = conn.execute(
        """INSERT INTO nodes (slug,name,kind,lat,lng,windows_json,status,
                              created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (payload["slug"], payload["name"], payload.get("kind", "ceremony"),
         payload.get("lat"), payload.get("lng"),
         json.dumps(payload.get("windows", []), ensure_ascii=False),
         payload.get("status", "online"), now_iso(), now_iso()))
    conn.commit()
    return cur.lastrowid


def set_node_offline(conn, node_id, expected_version, actor="editor"):
    return update_versioned(conn, "nodes", node_id, {"status": "offline"},
                            expected_version, actor)


# ---------------------------------------------------------------- edges

def create_edge(conn, p, actor="editor"):
    fn = conn.execute("SELECT id FROM nodes WHERE slug=?", (p["from_slug"],)).fetchone()
    tn = conn.execute("SELECT id FROM nodes WHERE slug=?", (p["to_slug"],)).fetchone()
    if not fn or not tn:
        raise RuleError("both endpoint nodes must exist")
    cur = conn.execute(
        """INSERT INTO edges (slug,name,from_node_id,to_node_id,travel_seconds,
                              mode,windows_json,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (p["slug"], p["name"], fn["id"], tn["id"], int(p["travel_seconds"]),
         p.get("mode", "walk"),
         json.dumps(p.get("windows", []), ensure_ascii=False),
         p.get("status", "online"), now_iso(), now_iso()))
    conn.commit()
    return cur.lastrowid


def update_edge_connections(conn, edge_id, from_slug, to_slug, expected_version,
                            actor="editor"):
    """The endpoint-editing operation guarded by optimistic lock.
    Two editors editing the same connection concurrently => one gets 409."""
    fn = conn.execute("SELECT id FROM nodes WHERE slug=?", (from_slug,)).fetchone()
    tn = conn.execute("SELECT id FROM nodes WHERE slug=?", (to_slug,)).fetchone()
    if not fn or not tn:
        raise RuleError("endpoint node missing")
    if fn["id"] == tn["id"]:
        raise RuleError("self-loop forbidden")
    return update_versioned(
        conn, "edges", edge_id,
        {"from_node_id": fn["id"], "to_node_id": tn["id"]},
        expected_version, actor)


# ---------------------------------------------------------------- routes

def create_route(conn, p, actor="editor"):
    cur = conn.execute(
        """INSERT INTO routes (slug,name,description,created_at,updated_at)
           VALUES (?,?,?,?,?)""",
        (p["slug"], p["name"], p.get("description", ""), now_iso(), now_iso()))
    for i, eslug in enumerate(p.get("edge_slugs", [])):
        e = conn.execute("SELECT id FROM edges WHERE slug=?", (eslug,)).fetchone()
        if not e:
            raise RuleError(f"edge {eslug} missing")
        conn.execute("INSERT INTO route_items (route_id,position,edge_id) VALUES (?,?,?)",
                     (cur.lastrowid, i, e["id"]))
    conn.commit()
    return cur.lastrowid


def get_route_edge_slugs(conn, route_id):
    rows = conn.execute(
        """SELECT e.slug FROM route_items ri JOIN edges e ON e.id=ri.edge_id
           WHERE ri.route_id=? ORDER BY ri.position""", (route_id,)).fetchall()
    return [r["slug"] for r in rows]


# ---------------------------------------------------------------- recurrence

def propose_from_rule(conn, rule_id, year, actor="system"):
    """Create a DRAFT instance for `year` from a recurrence rule.
    Never confirmed here. If a confirmed instance for (rule,year) exists the
    proposal is refused — published/confirmed dates are not overwritten."""
    rule = conn.execute("SELECT * FROM recurrence_rules WHERE id=?",
                        (rule_id,)).fetchone()
    if not rule:
        raise NotFound("recurrence_rules", rule_id)
    existing = conn.execute(
        "SELECT id,status FROM activity_instances WHERE rule_id=? AND year=?",
        (rule_id, year)).fetchone()
    if existing:
        if existing["status"] in ("confirmed", "published"):
            raise RuleError(
                f"year {year} already {existing['status']}; recurrence may not "
                "overwrite a source-confirmed date")
        return existing["id"]
    expr = json.loads(rule["expression_json"])
    # We DO NOT compute lunar->solar without a source. Store the proposal with
    # no concrete dates; editors fill them when the organizer publishes.
    raw = expr.get("raw") or json.dumps(expr, ensure_ascii=False)
    slug = f"{rule['slug']}-{year}-proposed"
    cur = conn.execute(
        """INSERT INTO activity_instances
           (slug,rule_id,title,year,timezone,original_expression,
            start_local,end_local,source_confirmed,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,0,'draft',?,?)""",
        (slug, rule_id, f"{rule['title']}（{year}年待公告）", year,
         rule["timezone"], f"[待公告·按周期推算] {raw}", None, None,
         now_iso(), now_iso()))
    conn.commit()
    return cur.lastrowid


def ingest_announcement(conn, p, actor="ingest"):
    """Announcement may arrive BEFORE its activity record exists.
    Occurrences are stored; matching instances are linked/created as DRAFT then
    confirmed because the announcement IS the source."""
    ann = conn.execute("SELECT * FROM announcements WHERE external_ref=?",
                       (p.get("external_ref"),)).fetchone() if p.get("external_ref") else None
    if ann:
        return ann["id"], False
    cur = conn.execute(
        """INSERT INTO announcements
           (external_ref,title,body,source_url,announced_at,received_at,
            timezone,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?, 'approved', ?,?)""",
        (p.get("external_ref"), p["title"], p.get("body", ""),
         p.get("source_url"), p["announced_at"],
         p.get("received_at") or now_iso(), p.get("timezone", "Asia/Shanghai"),
         now_iso(), now_iso()))
    ann_id = cur.lastrowid
    for occ in p.get("occurrences", []):
        conn.execute(
            """INSERT INTO announcement_occurrences
               (announcement_id,occurrence_slug,start_local,end_local,
                original_expression)
               VALUES (?,?,?,?,?)""",
            (ann_id, occ["slug"], occ["start_local"], occ.get("end_local"),
             occ.get("original_expression")))
        inst = conn.execute("SELECT * FROM activity_instances WHERE slug=?",
                            (occ["slug"],)).fetchone()
        rule_id = None
        if occ.get("rule_slug"):
            rr = conn.execute("SELECT id FROM recurrence_rules WHERE slug=?",
                              (occ["rule_slug"],)).fetchone()
            rule_id = rr["id"] if rr else None
        if inst is not None and inst["rule_id"]:
            rule_id = inst["rule_id"]
        if inst is None:
            # "公告先到活动后到": create the instance from the announcement
            year = int(occ["start_local"][:4])
            conn.execute(
                """INSERT INTO activity_instances
                   (slug,rule_id,title,year,timezone,original_expression,start_local,
                    end_local,source_confirmed,source_announcement_id,source_url,
                    status,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,1,?,?, 'confirmed',?,?)""",
                (occ["slug"], rule_id, occ.get("title") or p["title"], year,
                 p.get("timezone", "Asia/Shanghai"),
                 occ.get("original_expression"), occ["start_local"],
                 occ.get("end_local"), ann_id, p.get("source_url"),
                 now_iso(), now_iso()))
        else:
            # confirm a waiting draft — but only if announcement names it
            conn.execute(
                """UPDATE activity_instances
                   SET source_confirmed=1, source_announcement_id=?,
                       start_local=?, end_local=?, original_expression=?,
                       source_url=COALESCE(?,source_url), status='confirmed',
                       version=version+1, updated_at=?
                   WHERE id=? AND status IN ('draft','confirmed')""",
                (ann_id, occ["start_local"], occ.get("end_local"),
                 occ.get("original_expression"), p.get("source_url"),
                 now_iso(), inst["id"]))
    conn.commit()
    return ann_id, True


# ---------------------------------------------------------------- articles

def create_article(conn, p, actor="editor"):
    cur = conn.execute(
        """INSERT INTO historical_articles (slug,title,body,event_year,
               published_at,publication_task_id,created_at,updated_at)
           VALUES (?,?,?,?,NULL,NULL,?,?)""",
        (p["slug"], p["title"], p["body"], p.get("event_year"),
         now_iso(), now_iso()))
    conn.commit()
    return cur.lastrowid


def edit_article_draft(conn, article_id, fields, expected_version, actor="editor"):
    """Edits allowed only BEFORE publication. Published narratives are frozen."""
    art = conn.execute("SELECT * FROM historical_articles WHERE id=?",
                       (article_id,)).fetchone()
    if not art:
        raise NotFound("historical_articles", article_id)
    if art["published_at"]:
        raise RuleError("published historical narrative is append-only and "
                        "must not be rewritten")
    return update_versioned(conn, "historical_articles", article_id,
                            fields, expected_version, actor)


# ---------------------------------------------------------------- publication

FREEZABLE = {
    "node": ("nodes", ["slug", "name", "kind", "lat", "lng",
                       "windows_json", "status"]),
    "edge": ("edges", ["slug", "name", "from_node_id", "to_node_id",
                       "travel_seconds", "mode", "windows_json", "status"]),
    "route": ("routes", ["slug", "name", "description", "version"]),
    "announcement": ("announcements", ["external_ref", "title", "body",
                                       "source_url", "announced_at",
                                       "timezone", "status", "version"]),
    "instance": ("activity_instances", ["slug", "rule_id", "title", "year",
                                        "timezone", "original_expression",
                                        "start_local", "end_local",
                                        "source_confirmed", "status", "version"]),
    "article": ("historical_articles", ["slug", "title", "body", "event_year",
                                        "version"]),
    "advisory": ("advisories", ["kind", "severity", "title",
                                "scope_edges_json", "scope_nodes_json", "tz",
                                "start_local", "end_local", "status", "version"]),
}


def create_publication_task(conn, title, year, requested_by="editor",
                            entity_refs=None):
    cur = conn.execute(
        """INSERT INTO publication_tasks
           (title,status,requested_by,created_at,almanac_year)
           VALUES (?, 'pending_review', ?, ?, ?)""",
        (title, requested_by, now_iso(), year))
    task_id = cur.lastrowid
    refs = entity_refs or _default_publish_set(conn, year)
    for r in refs:
        conn.execute(
            "INSERT OR IGNORE INTO task_refs (task_id,entity_type,entity_id) VALUES (?,?,?)",
            (task_id, r["type"], r["id"]))
    conn.commit()
    return task_id, refs


def get_task_refs(conn, task_id):
    return [{"type": r["entity_type"], "id": r["entity_id"]}
            for r in conn.execute(
                "SELECT entity_type,entity_id FROM task_refs WHERE task_id=?",
                (task_id,))]


def _default_publish_set(conn, year):
    refs = []
    for t, table in (("node", "nodes"), ("edge", "edges"),
                     ("route", "routes"), ("advisory", "advisories")):
        for r in conn.execute(f"SELECT id FROM {table}"):
            refs.append({"type": t, "id": r["id"]})
    for r in conn.execute(
            "SELECT id FROM activity_instances WHERE year=? AND status='confirmed'",
            (year,)):
        refs.append({"type": "instance", "id": r["id"]})
    for r in conn.execute(
            "SELECT id FROM announcements WHERE status='approved'"):
        refs.append({"type": "announcement", "id": r["id"]})
    for r in conn.execute(
            "SELECT id FROM historical_articles WHERE published_at IS NULL"):
        refs.append({"type": "article", "id": r["id"]})
    return refs


def review_task(conn, task_id, approve, reviewer="admin"):
    t = conn.execute("SELECT * FROM publication_tasks WHERE id=?",
                     (task_id,)).fetchone()
    if not t:
        raise NotFound("publication_tasks", task_id)
    if t["status"] != "pending_review":
        raise RuleError(f"task already {t['status']}")
    conn.execute(
        """UPDATE publication_tasks SET status=?, reviewed_by=?, reviewed_at=?
           WHERE id=?""",
        ("approved" if approve else "rejected", reviewer, now_iso(), task_id))
    conn.commit()


def freeze_task(conn, task_id, refs):
    """Snapshot every referenced entity at its CURRENT version. After freeze,
    publication publishes these exact versions regardless of later edits."""
    t = conn.execute("SELECT * FROM publication_tasks WHERE id=?",
                     (task_id,)).fetchone()
    if t["status"] != "approved":
        raise RuleError("only approved tasks can be frozen")
    for ref in refs:
        etype, eid = ref["type"], ref["id"]
        table, cols = FREEZABLE[etype]
        row = conn.execute(f"SELECT * FROM {table} WHERE id=?", (eid,)).fetchone()
        if not row:
            continue
        snap = {c: row[c] for c in cols if c in row.keys()}
        # announcements have no slug column; external_ref is their key
        key = row["slug"] if "slug" in row.keys() else row["external_ref"]
        conn.execute(
            """INSERT OR REPLACE INTO task_freeze_items
               (task_id,entity_type,entity_id,slug,version_at_freeze,
                snapshot_json,frozen_at)
               VALUES (?,?,?,?,?,?,?)""",
            (task_id, etype, eid, key, row["version"],
             json.dumps(snap, ensure_ascii=False), now_iso()))
    conn.execute("UPDATE publication_tasks SET status='frozen', frozen_at=? WHERE id=?",
                 (now_iso(), task_id))
    conn.commit()


def publish_task(conn, task_id):
    t = conn.execute("SELECT * FROM publication_tasks WHERE id=?",
                     (task_id,)).fetchone()
    if t["status"] != "frozen":
        raise RuleError("only frozen tasks can be published")
    # mark the frozen versions live
    for f in conn.execute("SELECT * FROM task_freeze_items WHERE task_id=?",
                         (task_id,)):
        etype = f["entity_type"]
        table = FREEZABLE[etype][0]
        if etype == "instance":
            conn.execute("UPDATE activity_instances SET status='published' WHERE id=?",
                         (f["entity_id"],))
        elif etype == "announcement":
            conn.execute("UPDATE announcements SET status='published' WHERE id=?",
                         (f["entity_id"],))
        elif etype == "article":
            conn.execute(
                "UPDATE historical_articles SET published_at=?, publication_task_id=? WHERE id=?",
                (now_iso(), task_id, f["entity_id"]))
    conn.execute("UPDATE publication_tasks SET status='published', published_at=? WHERE id=?",
                 (now_iso(), task_id))
    year = t["almanac_year"]
    if year:
        snapshot = build_almanac(conn, year)
        conn.execute(
            """INSERT INTO almanac_published (year,snapshot_json,task_id,published_at)
               VALUES (?,?,?,?)
               ON CONFLICT(year) DO UPDATE SET
                 snapshot_json=excluded.snapshot_json,
                 task_id=excluded.task_id,
                 published_at=excluded.published_at""",
            (year, json.dumps(snapshot, ensure_ascii=False), task_id, now_iso()))
    conn.commit()


# ---------------------------------------------------------------- almanac

def build_almanac(conn, year):
    """Published-year almanac: published instances + frozen graph + published
    articles. Current advisories do NOT rewrite history; they ride alongside."""
    instances = [dict(r) for r in conn.execute(
        """SELECT * FROM activity_instances
           WHERE year=? AND status IN ('published','confirmed')
           ORDER BY start_local""", (year,))]
    nodes = [dict(r) for r in conn.execute(
        "SELECT slug,name,kind,lat,lng,windows_json,status FROM nodes")]
    edges = [dict(r) for r in conn.execute(
        """SELECT e.slug,e.name,e.travel_seconds,e.mode,e.windows_json,e.status,
                  n1.slug AS from_slug,n2.slug AS to_slug
           FROM edges e JOIN nodes n1 ON n1.id=e.from_node_id
                        JOIN nodes n2 ON n2.id=e.to_node_id""")]
    routes = []
    for r in conn.execute("SELECT * FROM routes"):
        routes.append({"slug": r["slug"], "name": r["name"],
                       "description": r["description"],
                       "edge_slugs": get_route_edge_slugs(conn, r["id"])})
    articles = [dict(r) for r in conn.execute(
        """SELECT slug,title,body,event_year,published_at
           FROM historical_articles WHERE published_at IS NOT NULL
           ORDER BY published_at""")]
    advisories = [dict(r) for r in conn.execute(
        "SELECT * FROM advisories WHERE status='active'")]
    return {"year": year, "generated_at": now_iso(),
            "instances": instances, "nodes": nodes, "edges": edges,
            "routes": routes, "articles": articles, "advisories": advisories}


def get_published_almanac(conn, year):
    row = conn.execute("SELECT * FROM almanac_published WHERE year=?",
                       (year,)).fetchone()
    if not row:
        return None
    return json.loads(row["snapshot_json"])
