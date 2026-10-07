"""Zero-dependency HTTP API for the cultural-station festival system.

Run:  python3 -m server.app   (serves API + static frontend on :8000)

Auth is deliberately simple for the demo: X-Actor header names the editor,
X-Reviewer the admin. Optimistic locking uses If-Match: <version>.
"""
from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from . import schema, services, routing

DB_PATH = os.environ.get("CS_DB", "data/cultural_station.db")
STATIC_ROOT = os.path.join(os.path.dirname(__file__), "..", "festival")
_LOCK = threading.RLock()

_conn = None


def conn():
    global _conn
    if _conn is None:
        os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
        _conn = services.connect(DB_PATH)
        schema.init(_conn)
    return _conn


class ApiError(Exception):
    def __init__(self, code, msg):
        self.code, self.msg = code, msg


def body(handler):
    n = int(handler.headers.get("Content-Length") or 0)
    if not n:
        return {}
    raw = handler.rfile.read(n)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise ApiError(400, "invalid JSON")


def actor(h):
    return h.headers.get("X-Actor", "editor")


def expected_version(h):
    v = h.headers.get("If-Match")
    if v is None:
        raise ApiError(428, "If-Match version required for updates")
    try:
        return int(v)
    except ValueError:
        raise ApiError(400, "bad If-Match")


# ------------------------------------------------------------ API endpoints

def api_list(table):
    c = conn()
    with _LOCK:
        rows = [dict(r) for r in c.execute(f"SELECT * FROM {table} ORDER BY id")]
    return rows


def api_create(kind, payload, h):
    c = conn()
    with _LOCK:
        if kind == "node":
            i = services.create_node(c, payload, actor(h))
        elif kind == "edge":
            i = services.create_edge(c, payload, actor(h))
        elif kind == "route":
            i = services.create_route(c, payload, actor(h))
        elif kind == "article":
            i = services.create_article(c, payload, actor(h))
        elif kind == "rule":
            cur = c.execute(
                """INSERT INTO recurrence_rules
                   (slug,title,expression_json,timezone,propose_years,status,
                    created_at,updated_at)
                   VALUES (?,?,?,?,?, 'active', ?,?)""",
                (payload["slug"], payload["title"],
                 json.dumps(payload["expression"], ensure_ascii=False),
                 payload.get("timezone", "Asia/Shanghai"),
                 payload.get("propose_years", 1),
                 services.now_iso(), services.now_iso()))
            c.commit()
            i = cur.lastrowid
        elif kind == "advisory":
            cur = c.execute(
                """INSERT INTO advisories
                   (slug,kind,severity,title,scope_edges_json,scope_nodes_json,tz,
                    start_local,end_local,status,created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,'active',?)""",
                (payload["slug"], payload["kind"],
                 payload.get("severity", "info"), payload["title"],
                 json.dumps(payload.get("scope_edges", []), ensure_ascii=False),
                 json.dumps(payload.get("scope_nodes", []), ensure_ascii=False),
                 payload.get("tz", "Asia/Shanghai"),
                 payload["start_local"], payload["end_local"],
                 services.now_iso()))
            c.commit()
            i = cur.lastrowid
        else:
            raise ApiError(404, "unknown kind")
    return {"id": i}


def api_update(kind, eid, payload, h):
    table = services.EDITABLE.get(kind)
    if not table:
        raise ApiError(404, "unknown kind")
    ver = expected_version(h)
    allowed = {
        "node": {"name", "kind", "lat", "lng", "windows", "status"},
        "edge": {"name", "travel_seconds", "mode", "windows", "status"},
        "announcement": {"title", "body", "status"},
        "instance": {"title", "status"},
        "rule": {"title", "status", "propose_years", "expression"},
        "advisory": {"status", "severity", "title", "end_local"},
    }.get(kind, set())
    fields = {}
    for k, v in payload.items():
        if k not in allowed:
            continue
        if k == "windows":
            fields["windows_json"] = json.dumps(v, ensure_ascii=False)
        elif k == "expression":
            fields["expression_json"] = json.dumps(v, ensure_ascii=False)
        else:
            fields[k] = v
    if not fields:
        raise ApiError(400, "no updatable fields")
    c = conn()
    with _LOCK:
        try:
            new_ver = services.update_versioned(c, table, eid, fields, ver,
                                                actor(h))
        except services.NotFound:
            raise ApiError(404, "not found")
        except services.VersionConflict as e:
            raise ApiError(409, str(e))
        except services.RuleError as e:
            raise ApiError(422, str(e))
    return {"id": eid, "version": new_ver}


def api_edge_reconnect(eid, payload, h):
    ver = expected_version(h)
    c = conn()
    with _LOCK:
        try:
            new_ver = services.update_edge_connections(
                c, eid, payload["from_slug"], payload["to_slug"], ver, actor(h))
        except services.NotFound:
            raise ApiError(404, "not found")
        except services.VersionConflict as e:
            raise ApiError(409, str(e))
        except services.RuleError as e:
            raise ApiError(422, str(e))
    return {"id": eid, "version": new_ver}


def api_node_offline(eid, payload, h):
    ver = expected_version(h)
    c = conn()
    with _LOCK:
        try:
            new_ver = services.set_node_offline(c, eid, ver, actor(h))
        except services.NotFound:
            raise ApiError(404, "not found")
        except services.VersionConflict as e:
            raise ApiError(409, str(e))
    return {"id": eid, "version": new_ver, "status": "offline"}


def api_announce(payload, h):
    for k in ("title", "announced_at", "occurrences"):
        if k not in payload:
            raise ApiError(400, f"missing {k}")
    c = conn()
    with _LOCK:
        ann_id, created = services.ingest_announcement(c, payload, actor(h))
    return {"id": ann_id, "created": created}


def api_propose(rule_id, payload, h):
    year = int(payload.get("year"))
    c = conn()
    with _LOCK:
        try:
            i = services.propose_from_rule(c, rule_id, year, actor(h))
        except services.NotFound:
            raise ApiError(404, "rule not found")
        except services.RuleError as e:
            raise ApiError(422, str(e))
    return {"id": i, "status": "draft",
            "note": "draft proposal only; awaits source-confirmed announcement"}


def api_route_compare(q, payload):
    origin = (payload.get("origin") or q.get("origin", [None])[0])
    dest = (payload.get("dest") or q.get("dest", [None])[0])
    start = (payload.get("start_local") or q.get("start", [None])[0])
    tz = payload.get("tz") or q.get("tz", ["Asia/Shanghai"])[0]
    if not (origin and dest and start):
        raise ApiError(400, "origin, dest, start_local required")
    c = conn()
    with _LOCK:
        return routing.compare(c, origin, dest, start,
                               payload.get("candidate_edges"),
                               payload.get("preferences"), tz)


def api_publication(payload, h):
    c = conn()
    with _LOCK:
        task_id, refs = services.create_publication_task(
            c, payload["title"], payload.get("year"),
            actor(h), payload.get("refs"))
        services.review_task(c, task_id, True, h.headers.get("X-Reviewer", "admin"))
        services.freeze_task(c, task_id, refs)
        services.publish_task(c, task_id)
    return {"task_id": task_id, "status": "published", "frozen": len(refs)}


def api_publication_review(payload, h):
    """Separately exposed steps for tests of review/freeze/publish."""
    c = conn()
    step = payload["step"]
    with _LOCK:
        tid = payload["task_id"]
        if step == "create":
            tid, refs = services.create_publication_task(
                c, payload["title"], payload.get("year"), actor(h),
                payload.get("refs"))
            return {"task_id": tid, "refs": refs}
        if step == "review":
            services.review_task(c, tid, payload.get("approve", True),
                                 h.headers.get("X-Reviewer", "admin"))
        elif step == "freeze":
            refs = payload.get("refs") or services.get_task_refs(c, tid)
            services.freeze_task(c, tid, refs)
        elif step == "publish":
            services.publish_task(c, tid)
        else:
            raise ApiError(400, "bad step")
    return {"task_id": tid, "ok": True}


def api_almanac(year, q):
    c = conn()
    with _LOCK:
        if q.get("live", ["0"])[0] == "1":
            return services.build_almanac(c, year)
        snap = services.get_published_almanac(c, year)
    if snap is None:
        raise ApiError(404, "no published almanac for this year")
    return snap


# ------------------------------------------------------------ HTTP plumbing

class Handler(BaseHTTPRequestHandler):
    server_version = "CulturalStation/1.0"

    def _send(self, code, obj, ctype="application/json; charset=utf-8"):
        data = json.dumps(obj, ensure_ascii=False).encode() if not isinstance(obj, bytes) else obj
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        p, q = u.path, parse_qs(u.query)
        try:
            if p.startswith("/api/"):
                return self._route_get(p, q)
            return self._static(p)
        except ApiError as e:
            self._send(e.code, {"error": e.msg})
        except Exception as e:  # pragma: no cover
            self._send(500, {"error": repr(e)})

    def do_POST(self):
        u = urlparse(self.path)
        p = u.path
        try:
            payload = body(self)
            with _LOCK:
                if p == "/api/announcements":
                    return self._send(201, api_announce(payload, self))
                if p == "/api/routes/compare":
                    return self._send(200, api_route_compare(parse_qs(u.query), payload))
                if p == "/api/publications":
                    return self._send(201, api_publication(payload, self))
                if p == "/api/publications/step":
                    return self._send(200, api_publication_review(payload, self))
                m = {"/api/nodes": "node", "/api/edges": "edge",
                     "/api/routes": "route", "/api/articles": "article",
                     "/api/rules": "rule", "/api/advisories": "advisory"}
                if p in m:
                    return self._send(201, api_create(m[p], payload, self))
                if p.startswith("/api/rules/") and p.endswith("/propose"):
                    rid = int(p.split("/")[3])
                    return self._send(201, api_propose(rid, payload, self))
            self._send(404, {"error": "not found"})
        except ApiError as e:
            self._send(e.code, {"error": e.msg})
        except Exception as e:
            self._send(500, {"error": repr(e)})

    def do_PUT(self):
        u = urlparse(self.path)
        parts = [x for x in u.path.split("/") if x]
        try:
            payload = body(self)
            # /api/edges/{id}/reconnect, /api/nodes/{id}/offline
            if len(parts) == 4 and parts[1] == "edges" and parts[3] == "reconnect":
                return self._send(200, api_edge_reconnect(int(parts[2]), payload, self))
            if len(parts) == 4 and parts[1] == "nodes" and parts[3] == "offline":
                return self._send(200, api_node_offline(int(parts[2]), payload, self))
            if len(parts) == 3 and parts[1] in services.EDITABLE:
                return self._send(200, api_update(parts[1], int(parts[2]),
                                                  payload, self))
            self._send(404, {"error": "not found"})
        except ApiError as e:
            self._send(e.code, {"error": e.msg})
        except Exception as e:
            self._send(500, {"error": repr(e)})

    def _route_get(self, p, q):
        table_map = {"nodes": "nodes", "edges": "edges", "routes": "routes",
                     "announcements": "announcements", "instances": "activity_instances",
                     "articles": "historical_articles", "rules": "recurrence_rules",
                     "advisories": "advisories",
                     "publications": "publication_tasks",
                     "events": "edit_events"}
        parts = [x for x in p.split("/") if x]
        # /api/almanac/<year>
        if len(parts) == 3 and parts[1] == "almanac":
            return self._send(200, api_almanac(int(parts[2]), q))
        # /api/routes/<id>
        if len(parts) == 3 and parts[1] == "routes" and parts[2].isdigit():
            rid = int(parts[2])
            c = conn()
            r = c.execute("SELECT * FROM routes WHERE id=?", (rid,)).fetchone()
            if not r:
                raise ApiError(404, "no route")
            d = dict(r)
            d["edge_slugs"] = services.get_route_edge_slugs(c, rid)
            return self._send(200, d)
        if len(parts) == 2 and parts[1] in table_map:
            return self._send(200, api_list(table_map[parts[1]]))
        if p == "/api/routes/compare":
            return self._send(200, api_route_compare(q, {}))
        raise ApiError(404, "unknown api path")

    def _static(self, p):
        if p == "/":
            p = "/index.html"
        rel = os.path.normpath(p.lstrip("/"))
        full = os.path.join(STATIC_ROOT, rel)
        if not full.startswith(os.path.abspath(STATIC_ROOT)) or not os.path.isfile(full):
            # fall back to the festival index
            full = os.path.join(STATIC_ROOT, "index.html")
        ctype = {"html": "text/html; charset=utf-8", "js": "text/javascript",
                 "css": "text/css", "json": "application/json"}.get(
            full.rsplit(".", 1)[-1], "application/octet-stream")
        with open(full, "rb") as f:
            data = f.read()
        self._send(200, data, ctype)

    def log_message(self, fmt, *args):
        if os.environ.get("CS_QUIET"):
            return
        super().log_message(fmt, *args)


def main(port=None):
    schema.init(conn())
    port = port or int(os.environ.get("PORT", "8000"))
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"cultural station on http://0.0.0.0:{port}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
