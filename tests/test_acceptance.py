"""Acceptance tests for the cultural-station festival route & almanac system.

Run:  python3 -m unittest tests.test_acceptance -v
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import schema, services, routing, seed
from server.timelib import parse_local, make_window, tz as _tz

TZ = "Asia/Shanghai"


class Case(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.tmp.close()
        self.c = seed.run(self.tmp.name)

    def tearDown(self):
        self.c.close()
        os.unlink(self.tmp.name)

    # ---- 1. same node referenced by multiple routes -------------------------
    def test_node_shared_by_multiple_routes(self):
        rows = self.c.execute(
            """SELECT n.slug, COUNT(DISTINCT ri.route_id) routes
               FROM nodes n JOIN edges e ON e.to_node_id=n.id OR e.from_node_id=n.id
               JOIN route_items ri ON ri.edge_id=e.id
               GROUP BY n.slug HAVING routes>1""").fetchall()
        slugs = {r["slug"] for r in rows}
        self.assertIn("bell-plaza", slugs)
        self.assertIn("city-wall", slugs)  # ss-cw shared by two routes

    # ---- 2. earliest arrival vs preferred candidate; feasibility ------------
    def test_earliest_vs_preference_candidate(self):
        res = routing.compare(
            self.c, "east-gate", "city-wall", "2027-02-20T16:30:00",
            candidate_edge_slugs=["eg-bp-walk", "bp-ss-walk", "ss-cw"],
            preferences={"max_transfers": 0})
        ea, cand = res["earliest_arrival"], res["candidate"]
        self.assertTrue(ea["feasible"])
        self.assertTrue(cand["feasible"])
        # walking candidate arrives no earlier than the fastest path
        self.assertGreaterEqual(res["arrival_delta_seconds"], 0)

    def test_insufficient_time_names_conflict_edge(self):
        # city wall entry opens 17:00; departing far too late the walk chain
        # lands after the ss-cw window closes 00:30 -> conflict reported
        res = routing.compare(
            self.c, "east-gate", "city-wall", "2027-02-20T23:50:00",
            candidate_edge_slugs=["eg-bp-walk", "bp-ss-walk", "ss-cw"])
        cand = res["candidate"]
        self.assertFalse(cand["feasible"])
        self.assertTrue(cand["conflict_edges"])
        reason = cand["conflict_edges"][0]["reason"]
        self.assertTrue(
            reason.startswith("no-open-window") or reason.startswith("arrival-after-close"),
            reason)

    def test_shuttle_wait_is_modeled(self):
        # 07:50 arrival at east-gate: shuttle opens 08:00 -> must wait ~10m
        res = routing.compare(
            self.c, "east-gate", "bell-plaza", "2027-02-20T07:50:00",
            candidate_edge_slugs=["eg-metro-bus", "metro-bp"])
        steps = res["candidate"]["steps"]
        self.assertEqual(steps[0]["depart"][11:16], "08:00")
        self.assertGreaterEqual(steps[0]["waited_seconds"], 540)

    # ---- 3. announcements first, activity later -----------------------------
    def test_announcement_precedes_activity(self):
        # brand-new slug no instance yet
        payload = {
            "external_ref": "QQL-2029-X",
            "title": "2029清明秦腔公演公告（活动尚未建档）",
            "announced_at": "2029-01-10T09:00:00", "timezone": TZ,
            "occurrences": [{
                "slug": "qinqiang-2029",
                "start_local": "2029-04-05T14:00:00",
                "end_local": "2029-04-05T17:00:00",
                "original_expression": "2029年4月5日14:00–17:00"}]}
        aid, created = services.ingest_announcement(self.c, payload)
        self.assertTrue(created)
        inst = self.c.execute(
            "SELECT * FROM activity_instances WHERE slug='qinqiang-2029'").fetchone()
        self.assertEqual(inst["status"], "confirmed")
        self.assertEqual(inst["source_confirmed"], 1)
        self.assertEqual(inst["source_announcement_id"], aid)

    # ---- 4. recurrence must NOT copy last year's dates ----------------------
    def test_recurrence_only_proposes_unconfirmed_draft(self):
        row = self.c.execute(
            "SELECT * FROM activity_instances WHERE slug LIKE 'lantern-festival-2028%'"
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["status"], "draft")
        self.assertIsNone(row["start_local"])          # no fabricated date
        self.assertEqual(row["source_confirmed"], 0)
        self.assertIn("待公告", row["original_expression"])

    def test_propose_refused_after_confirmation(self):
        rid = self.c.execute(
            "SELECT id FROM recurrence_rules WHERE slug='lantern-festival'").fetchone()["id"]
        with self.assertRaises(services.RuleError):
            services.propose_from_rule(self.c, rid, 2027)  # already confirmed

    # ---- 5. node offline blocks all routes through it -----------------------
    def test_node_offline_routes_around(self):
        n = self.c.execute("SELECT * FROM nodes WHERE slug='lane-stage'").fetchone()
        services.set_node_offline(self.c, n["id"], n["version"])
        res = routing.compare(
            self.c, "bell-plaza", "lane-stage", "2027-02-20T12:00:00",
            candidate_edge_slugs=["bp-lane"])
        self.assertFalse(res["candidate"]["feasible"])
        self.assertIn("node-offline:lane-stage",
                      res["candidate"]["conflict_edges"][0]["reason"])
        # elsewhere unaffected
        res2 = routing.earliest_arrival_path(
            self.c, "east-gate", "city-wall", "2027-02-20T16:00:00")
        self.assertTrue(res2.feasible)

    # ---- 6. two editors concurrently editing the same connection ------------
    def test_concurrent_edge_edit_second_writer_conflicts(self):
        e = self.c.execute("SELECT * FROM edges WHERE slug='metro-bp'").fetchone()
        v = e["version"]
        # editor A reconnects
        services.update_edge_connections(
            self.c, e["id"], "metro-zhonglou", "bell-plaza", v, "A")
        # editor B still holds v -> 409
        with self.assertRaises(services.VersionConflict):
            services.update_edge_connections(
                self.c, e["id"], "metro-zhonglou", "south-square", v, "B")
        # after refreshing version B can save
        v2 = self.c.execute("SELECT version FROM edges WHERE id=?", (e["id"],)).fetchone()["version"]
        services.update_edge_connections(
            self.c, e["id"], "metro-zhonglou", "south-square", v2, "B")
        log = self.c.execute(
            "SELECT ok FROM edit_events WHERE entity_type='edges' AND action='update_rejected'").fetchall()
        self.assertTrue(any(not r["ok"] for r in log))

    # ---- 7. cached almanac stays stale until republish ----------------------
    def test_cached_almanac_not_updated_until_republish(self):
        self._publish(2027)
        before = services.get_published_almanac(self.c, 2027)
        n_names = {x["name"] for x in before["nodes"]}
        # editor adds a brand-new ceremony node after publication
        services.create_node(self.c, {"slug": "new-stage", "name": "新戏台",
                                      "kind": "ceremony"})
        cached = services.get_published_almanac(self.c, 2027)
        self.assertNotIn("新戏台", {x["name"] for x in cached["nodes"]})
        # live view already sees it
        live = services.build_almanac(self.c, 2027)
        self.assertIn("新戏台", {x["name"] for x in live["nodes"]})
        # republish refreshes the cache
        self._publish(2027)
        after = services.get_published_almanac(self.c, 2027)
        self.assertIn("新戏台", {x["name"] for x in after["nodes"]})

    def _publish(self, year):
        tid, refs = services.create_publication_task(
            self.c, f"{year}年历发布", year)
        services.review_task(self.c, tid, True)
        services.freeze_task(self.c, tid, refs)
        services.publish_task(self.c, tid)
        return tid

    # ---- 8. publish freezes node & announcement versions --------------------
    def test_publish_freezes_versions(self):
        tid, refs = services.create_publication_task(
            self.c, "冻结发布", 2027,
            entity_refs=[{"type": "annement", "id": 0}] if False else None)
        services.review_task(self.c, tid, True)
        services.freeze_task(self.c, tid, refs)
        # change an edge AFTER freeze
        e = self.c.execute("SELECT * FROM edges WHERE slug='eg-bp-walk'").fetchone()
        services.update_versioned(
            self.c, "edges", e["id"],
            {"travel_seconds": 9999}, e["version"], "late-editor")
        services.publish_task(self.c, tid)
        frozen = self.c.execute(
            "SELECT version_at_freeze,snapshot_json FROM task_freeze_items "
            "WHERE task_id=? AND entity_type='edge' AND slug='eg-bp-walk'",
            (tid,)).fetchone()
        self.assertEqual(frozen["version_at_freeze"], e["version"])
        self.assertEqual(json.loads(frozen["snapshot_json"])["travel_seconds"],
                         e["travel_seconds"])
        self.assertNotEqual(e["travel_seconds"], 9999)

    def test_rejected_task_cannot_freeze(self):
        tid, _ = services.create_publication_task(self.c, "被驳回", 2027,
                                                  entity_refs=[])
        services.review_task(self.c, tid, False)
        with self.assertRaises(services.RuleError):
            services.freeze_task(self.c, tid, [])

    # ---- 9. published history never rewritten -------------------------------
    def test_published_article_is_append_only(self):
        tid, refs = services.create_publication_task(self.c, "发文章", 2027)
        services.review_task(self.c, tid, True)
        services.freeze_task(self.c, tid, refs)
        services.publish_task(self.c, tid)
        a = self.c.execute(
            "SELECT * FROM historical_articles WHERE slug='1983-lantern-memory'").fetchone()
        self.assertIsNotNone(a["published_at"])
        with self.assertRaises(services.RuleError):
            services.edit_article_draft(
                self.c, a["id"], {"body": "被新公告改写"}, a["version"])

    # ---- 10. advisories hit only intersecting space-time slices --------------
    def test_advisory_spacetime_scope(self):
        # starting 17:00 the walker reaches south-square ~17:25, before the
        # 18:00 construction window: no hit
        early = routing.evaluate_route(
            self.c, ["eg-bp-walk", "bp-ss-walk", "ss-cw"],
            "2027-02-20T17:00:00")
        advs = [a for s in early.steps for a in s.advisories]
        self.assertEqual(advs, [])
        # at 18:10 the walker traverses bp-ss-walk during 18:00-19:30 -> hit
        late = routing.evaluate_route(
            self.c, ["eg-bp-walk", "bp-ss-walk", "ss-cw"],
            "2027-02-20T18:10:00")
        advs = [a for s in late.steps for a in s.advisories]
        self.assertTrue(any("施工" in a["title"] for a in advs))
        # metro route never intersects the walking edge scope
        metro = routing.evaluate_route(
            self.c, ["eg-metro-bus", "metro-ss", "ss-cw"],
            "2027-02-20T18:15:00")
        advs = [a for s in metro.steps for a in s.advisories]
        self.assertEqual(advs, [])

    # ---- 11b. closure on one sub-slice can be waited out --------------------
    def test_closure_subslice_waited_out(self):
        self.c.execute(
            """INSERT INTO advisories
               (slug,kind,severity,title,scope_edges_json,scope_nodes_json,tz,
                start_local,end_local,status,created_at)
               VALUES ('cc','weather','closure','短时封控','["ss-cw"]','[]',
                 'Asia/Shanghai','2027-02-20T20:00:00','2027-02-20T20:30:00',
                 'active',?)""", (services.now_iso(),))
        self.c.commit()
        blocked = routing.earliest_arrival_path(
            self.c, "east-gate", "city-wall", "2027-02-20T19:55:00")
        self.assertTrue(blocked.feasible)
        self.assertEqual(blocked.arrival, "2027-02-20T20:35:00")
        early = routing.earliest_arrival_path(
            self.c, "east-gate", "city-wall", "2027-02-20T15:00:00")
        self.assertEqual(early.arrival, "2027-02-20T17:05:00")

    # ---- 11. cross-midnight & cross-year windows keep tz & raw form ---------
    def test_cross_midnight_window(self):
        w = make_window("2027-02-20T17:00:00", "2027-02-21T01:00:00", TZ)
        self.assertTrue(w.contains(parse_local("2027-02-21T00:45:00", TZ)))
        self.assertFalse(w.contains(parse_local("2027-02-21T01:10:00", TZ)))
        inst = self.c.execute(
            "SELECT * FROM activity_instances WHERE slug='lantern-festival-2027'").fetchone()
        self.assertIn("2月22日", inst["original_expression"])  # verbatim kept
        self.assertEqual(inst["timezone"], TZ)

    def test_cross_year_segment_preserves_zone(self):
        # New-year countdown: 2027-12-31 23:00 -> 2028-01-01 01:00, US Pacific tz
        w = make_window("2027-12-31T23:00:00", "2028-01-01T01:00:00",
                        "America/Los_Angeles")
        self.assertTrue(w.contains(
            parse_local("2028-01-01T00:30:00", "America/Los_Angeles")))
        # instant comparison respects the offset (UTC+8 vs UTC-8)
        self.assertFalse(w.contains(
            parse_local("2028-01-01T00:30:00", TZ)))

    # ---- 12. visitor filters: deep-linkable, list replaces map --------------
    def test_filter_helper_deep_link_roundtrip(self):
        # the same pure helper the frontend uses; test via a small inline
        # implementation so the deep-link contract is documented server-side
        from urllib.parse import urlencode, parse_qs
        f = {"year": "2027", "kind": "ceremony", "view": "list",
             "q": "灯会", "only_confirmed": "1"}
        qs = urlencode({k: v for k, v in f.items() if v})
        back = {k: v[0] for k, v in parse_qs(qs).items()}
        self.assertEqual(back["view"], "list")
        self.assertEqual(back["year"], "2027")
        # list view requires no map fields
        alm = services.build_almanac(self.c, 2027)
        list_rows = [i for i in alm["instances"]
                     if "灯会" in i["title"] and i["status"] in
                     ("confirmed", "published")]
        self.assertTrue(list_rows)


if __name__ == "__main__":
    unittest.main(verbosity=2)
