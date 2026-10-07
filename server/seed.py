"""Idempotent demo seed: 2027 Spring Festival / Lantern Festival cultural
station data. Dates are clearly marked source-confirmed vs proposed."""
from __future__ import annotations

import json

from . import schema, services

TZ = "Asia/Shanghai"


def run(path="data/cultural_station.db"):
    conn = services.connect(path)
    schema.init(conn)

    if conn.execute("SELECT COUNT(*) c FROM nodes").fetchone()["c"]:
        return conn

    def node(slug, name, kind, windows=None, lat=None, lng=None):
        services.create_node(conn, {
            "slug": slug, "name": name, "kind": kind, "lat": lat, "lng": lng,
            "windows": windows or []})

    # Ceremony sites & transfer points
    node("east-gate", "东门入口", "entrance",
         [{"start_local": "2027-02-20T08:00", "end_local": "2027-02-21T00:30",
           "tz": TZ}], 34.26, 108.96)
    node("bell-plaza", "钟鼓楼广场·社火主场", "ceremony",
         [{"start_local": "2027-02-20T09:00", "end_local": "2027-02-21T00:00",
           "tz": TZ}], 34.261, 108.941)
    node("lane-stage", "北院门巷·皮影戏台", "ceremony",
         [{"start_local": "2027-02-20T10:00", "end_local": "2027-02-20T22:00",
           "tz": TZ}], 34.265, 108.942)
    node("metro-zhonglou", "地铁钟楼站（换乘）", "transfer",
         [{"start_local": "2027-02-20T06:00", "end_local": "2027-02-21T00:10",
           "tz": TZ}], 34.259, 108.945)
    node("city-wall", "城墙灯会·南门", "ceremony",
         [{"start_local": "2027-02-20T17:00", "end_local": "2027-02-21T01:00",
           "tz": TZ}], 34.25, 108.94)
    node("south-square", "南门广场集散点", "transfer", [], 34.251, 108.94)

    def edge(slug, name, a, b, sec, mode="walk", windows=None):
        services.create_edge(conn, {
            "slug": slug, "name": name, "from_slug": a, "to_slug": b,
            "travel_seconds": sec, "mode": mode,
            "windows": windows or []})

    # edges (directed)
    edge("eg-bp-walk", "东门→钟鼓楼 步行直街", "east-gate", "bell-plaza",
         900, "walk")
    edge("eg-metro-bus", "东门→地铁钟楼站 摆渡车",
         "east-gate", "metro-zhonglou", 420, "shuttle",
         [{"start_local": "2027-02-20T08:00", "end_local": "2027-02-20T22:00",
           "tz": TZ}])
    edge("metro-bp", "地铁钟楼站→钟鼓楼广场", "metro-zhonglou", "bell-plaza",
         300, "walk")
    edge("bp-lane", "钟鼓楼→皮影戏台 巷内步行", "bell-plaza", "lane-stage",
         600, "walk",
         [{"start_local": "2027-02-20T09:30", "end_local": "2027-02-20T21:30",
           "tz": TZ}])
    edge("bp-ss-metro", "钟鼓楼→南门广场 地铁2号线", "bell-plaza",
         "south-square", 480, "metro",
         [{"start_local": "2027-02-20T06:30", "end_local": "2027-02-20T23:30",
           "tz": TZ}])
    edge("bp-ss-walk", "钟鼓楼→南门广场 南大街步行", "bell-plaza",
         "south-square", 1500, "walk")
    edge("ss-cw", "南门广场→城墙灯会", "south-square", "city-wall", 300, "walk",
         [{"start_local": "2027-02-20T17:00", "end_local": "2027-02-21T00:30",
           "tz": TZ}])
    edge("metro-ss", "地铁钟楼站→南门广场 地铁2号线", "metro-zhonglou",
         "south-square", 420, "metro",
         [{"start_local": "2027-02-20T06:30", "end_local": "2027-02-20T23:30",
           "tz": TZ}])

    # routes sharing edges
    services.create_route(conn, {
        "slug": "classic-family", "name": "经典家庭观灯线",
        "description": "东门进，社火、皮影，再下城墙灯会，全程少换乘",
        "edge_slugs": ["eg-metro-bus", "metro-bp", "bp-lane", "bp-ss-metro",
                       "ss-cw"]})
    services.create_route(conn, {
        "slug": "walking-history", "name": "步行历史线",
        "description": "同一节点出发的纯步行替代线，耗时长但无换乘",
        "edge_slugs": ["eg-bp-walk", "bp-ss-walk", "ss-cw"]})
    services.create_route(conn, {
        "slug": "express-lantern", "name": "地铁直达灯会线",
        "description": "钟鼓楼广场集合后地铁直达南门",
        "edge_slugs": ["eg-metro-bus", "metro-ss", "ss-cw"]})

    # recurrence rule: raw lunar expression kept verbatim
    cur = conn.execute(
        """INSERT INTO recurrence_rules
           (slug,title,expression_json,timezone,propose_years,status,
            created_at,updated_at)
           VALUES (?,?,?,?,1,'active',?,?)""",
        ("lantern-festival", "元宵节灯会",
         json.dumps({"calendar": "lunar", "month": 1, "day": 15,
                     "raw": "农历正月十五（前后三日，逐年以组织方公告为准）"},
                    ensure_ascii=False), TZ, services.now_iso(),
         services.now_iso()))
    rule_id = cur.lastrowid
    conn.commit()

    # 2027 is source-confirmed via (simulated) organizer announcement
    services.ingest_announcement(conn, {
        "external_ref": "XWLH-2027-01",
        "title": "西安市文化和旅游局关于2027年元宵节灯会安排的公告",
        "body": "2027年元宵节灯会定于2月20日至22日举办，钟鼓楼社火主场..."
                "城墙登城时间17:00，灯组亮灯至次日1:00。",
        "source_url": "https://example.gov.cn/2027-lantern-notice",
        "announced_at": "2026-12-28T10:00:00",
        "timezone": TZ,
        "occurrences": [{
            "slug": "lantern-festival-2027",
            "rule_slug": "lantern-festival",
            "title": "2027丁未年元宵节灯会",
            "start_local": "2027-02-20T09:00:00",
            "end_local": "2027-02-22T22:00:00",
            "original_expression": "2027年2月20日（正月十三）至2月22日（正月十六）"}]})

    # 2028 NOT announced: recurrence can only propose a dated-less draft
    services.propose_from_rule(conn, rule_id, 2028)

    # historical narrative (append-only after publish)
    services.create_article(conn, {
        "slug": "1983-lantern-memory",
        "title": "一九八三年：城墙上第一次亮起万盏灯",
        "body": "据老站长回忆，1983年灯会恢复那年……（此为已发布历史叙事，"
                "不因后续公告或施工信息改写）",
        "event_year": 1983})

    # advisory: construction hits ONLY one edge and only one time window
    conn.execute(
        """INSERT INTO advisories
           (slug,kind,severity,title,scope_edges_json,scope_nodes_json,tz,
            start_local,end_local,status,created_at)
           VALUES (?,'construction','warning',?,?,?,?,?,?,'active',?)""",
        ("nan-dajie-pipe-2027", "南大街傍晚管线施工，步行段18:00-19:30缓行",
         json.dumps(["bp-ss-walk"]), json.dumps([]), TZ,
         "2027-02-20T18:00:00", "2027-02-20T19:30:00",
         services.now_iso()))
    conn.commit()
    return conn


if __name__ == "__main__":
    run()
    print("seeded")
