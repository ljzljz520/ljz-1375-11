"""SQLite schema for the cultural-station festival route & almanac system.

Three data families are deliberately kept in separate tables, as required:

1. activity_instances      -- *annual* occurrences of a festival (year-specific,
                              source-confirmed dates only)
2. recurrence_rules        -- *recurring* patterns (e.g. "15th of lunar N");
                              these NEVER overwrite an annual instance and only
                              *propose* draft dates pending confirmation
3. historical_articles     -- published narratives, append-only; once published
                              they are never rewritten by later announcements

Supporting tables:
  nodes                    -- ceremony / transit-transfer nodes
  edges                    -- directed connections: travel time + open windows
  routes                   -- named ordered references to edges (one edge may be
                              referenced by many routes)
  route_items              -- ordered edge membership of a route
  announcements            -- source notices ("festival dates announced for 2027")
  announcement_occurrences -- dates carried by an announcement
  advisories               -- weather / construction notices with space-time scope
  publication_tasks        -- review -> freeze(snapshot) -> publish workflow
  task_freeze_items        -- frozen versions of nodes/edges/announcements/...
  edit_events              -- audit log for concurrent edits
"""

SCHEMA = r"""
PRAGMA foreign_keys = ON;

-- Recurring rule (pattern), e.g. lunar calendar expression kept verbatim ----
CREATE TABLE IF NOT EXISTS recurrence_rules (
    id              INTEGER PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    -- original expression exactly as the organizer tradition states it,
    -- e.g. {"calendar":"lunar","month":1,"day":15,"raw":"农历正月十五"}
    expression_json TEXT NOT NULL,
    -- IANA tz for interpreting the rule, e.g. Asia/Shanghai
    timezone        TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    -- how far ahead drafts may be proposed
    propose_years   INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended')),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1
);

-- Annual instance: one concrete festival in one concrete year ----------------
CREATE TABLE IF NOT EXISTS activity_instances (
    id              INTEGER PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,          -- e.g. lantern-festival-2027
    rule_id         INTEGER REFERENCES recurrence_rules(id),
    title           TEXT NOT NULL,
    year            INTEGER NOT NULL,
    timezone        TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    -- original text expression as announced (verbatim), e.g. "2027年2月20日（正月十三）至2月22日"
    original_expression TEXT,
    -- ISO8601 local wall time; instant derived with `timezone`
    start_local     TEXT,          -- 'YYYY-MM-DDTHH:MM[:SS]' no offset
    end_local       TEXT,          -- inclusive segment end; may cross midnight
    -- true ONLY when dates came from a source-confirmed announcement
    source_confirmed INTEGER NOT NULL DEFAULT 0,
    source_announcement_id INTEGER REFERENCES announcements(id),
    source_url      TEXT,
    -- draft  -> confirmed (announcement arrived) -> published (via task)
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','confirmed','published','cancelled')),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1,
    UNIQUE (title, year)
);

-- Historical narrative, append-only once published ---------------------------
CREATE TABLE IF NOT EXISTS historical_articles (
    id              INTEGER PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    body            TEXT NOT NULL,
    event_year      INTEGER,                        -- the year the story is about
    published_at    TEXT,                           -- NULL = not yet published
    publication_task_id INTEGER,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1
);

-- Nodes (ceremony sites, transit transfer points) ----------------------------
CREATE TABLE IF NOT EXISTS nodes (
    id              INTEGER PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'ceremony'
                    CHECK (kind IN ('ceremony','transfer','entrance','exit')),
    lat             REAL,
    lng             REAL,
    -- window(s) during which the node itself is open for entry
    -- [{"start_local":"2027-02-20T09:00","end_local":"2027-02-20T22:30","tz":"Asia/Shanghai"}]
    windows_json    TEXT NOT NULL DEFAULT '[]',
    status          TEXT NOT NULL DEFAULT 'online'
                    CHECK (status IN ('online','offline')),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1
);

-- Directed edges between nodes ----------------------------------------------
CREATE TABLE IF NOT EXISTS edges (
    id              INTEGER PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    from_node_id    INTEGER NOT NULL REFERENCES nodes(id),
    to_node_id      INTEGER NOT NULL REFERENCES nodes(id),
    travel_seconds  INTEGER NOT NULL,              -- movement duration
    mode            TEXT NOT NULL DEFAULT 'walk'
                    CHECK (mode IN ('walk','bus','metro','shuttle','ferry')),
    -- open window(s) of the edge itself; crossing midnight => end < start
    -- within same segment, or next-day marker "end_local" with full date.
    windows_json    TEXT NOT NULL DEFAULT '[]',
    status          TEXT NOT NULL DEFAULT 'online'
                    CHECK (status IN ('online','offline')),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1,
    CHECK (from_node_id <> to_node_id)
);

-- Named routes reference edges by id; the same edge can belong to many routes
CREATE TABLE IF NOT EXISTS routes (
    id              INTEGER PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS route_items (
    route_id        INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    position        INTEGER NOT NULL,
    edge_id         INTEGER NOT NULL REFERENCES edges(id),
    PRIMARY KEY (route_id, position)
);

-- Announcements from organizers ("公告先到，活动后到" support) -----------------
CREATE TABLE IF NOT EXISTS announcements (
    id              INTEGER PRIMARY KEY,
    external_ref    TEXT UNIQUE,                    -- idempotency key
    title           TEXT NOT NULL,
    body            TEXT NOT NULL DEFAULT '',
    source_url      TEXT,
    announced_at    TEXT NOT NULL,                  -- as stated by source
    received_at     TEXT NOT NULL,                  -- when WE got it
    timezone        TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    -- draft -> approved (review) -> published (via publication task)
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','approved','published','rejected')),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS announcement_occurrences (
    announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    occurrence_slug TEXT NOT NULL,                  -- links to activity_instance slug
    start_local     TEXT NOT NULL,
    end_local       TEXT,
    original_expression TEXT,
    PRIMARY KEY (announcement_id, occurrence_slug)
);

-- Weather / construction advisories: affect only intersecting space-time -----
CREATE TABLE IF NOT EXISTS advisories (
    id              INTEGER PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE DEFAULT 'adv',
    kind            TEXT NOT NULL CHECK (kind IN ('weather','construction','other')),
    severity        TEXT NOT NULL DEFAULT 'info'
                    CHECK (severity IN ('info','warning','closure')),
    title           TEXT NOT NULL,
    -- scope: list of node/edge slugs; empty => advisory not applied to routing
    scope_edges_json TEXT NOT NULL DEFAULT '[]',
    scope_nodes_json TEXT NOT NULL DEFAULT '[]',
    tz              TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    start_local     TEXT NOT NULL,
    end_local       TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','expired','revoked')),
    created_at      TEXT NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1
);

-- Publication: review, then FREEZE versions of everything, then publish ------
CREATE TABLE IF NOT EXISTS publication_tasks (
    id              INTEGER PRIMARY KEY,
    title           TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending_review'
                    CHECK (status IN ('pending_review','approved','frozen',
                                      'published','rejected')),
    requested_by    TEXT NOT NULL DEFAULT 'editor',
    reviewed_by     TEXT,
    created_at      TEXT NOT NULL,
    reviewed_at     TEXT,
    frozen_at       TEXT,
    published_at    TEXT,
    almanac_year    INTEGER,
    version         INTEGER NOT NULL DEFAULT 1
);
-- one frozen item per (task, entity type, entity id): an immutable snapshot
CREATE TABLE IF NOT EXISTS task_freeze_items (
    id              INTEGER PRIMARY KEY,
    task_id         INTEGER NOT NULL REFERENCES publication_tasks(id) ON DELETE CASCADE,
    entity_type     TEXT NOT NULL
                    CHECK (entity_type IN ('node','edge','route','announcement',
                                           'instance','article','advisory')),
    entity_id       INTEGER NOT NULL,
    slug            TEXT NOT NULL,
    version_at_freeze INTEGER NOT NULL,
    snapshot_json   TEXT NOT NULL,                  -- full verbatim copy
    frozen_at       TEXT NOT NULL,
    UNIQUE (task_id, entity_type, entity_id)
);

-- entities selected for a publication task (so freeze can happen in a later
-- HTTP call than creation)
CREATE TABLE IF NOT EXISTS task_refs (
    task_id         INTEGER NOT NULL REFERENCES publication_tasks(id) ON DELETE CASCADE,
    entity_type     TEXT NOT NULL,
    entity_id       INTEGER NOT NULL,
    PRIMARY KEY (task_id, entity_type, entity_id)
);

-- Published almanac snapshot used by cached calendars -------------------------
CREATE TABLE IF NOT EXISTS almanac_published (
    year            INTEGER PRIMARY KEY,
    snapshot_json   TEXT NOT NULL,
    task_id         INTEGER,
    published_at    TEXT NOT NULL
);

-- Audit log for concurrency debugging ----------------------------------------
CREATE TABLE IF NOT EXISTS edit_events (
    id              INTEGER PRIMARY KEY,
    entity_type     TEXT NOT NULL,
    entity_id       INTEGER NOT NULL,
    action          TEXT NOT NULL,
    actor           TEXT NOT NULL DEFAULT 'editor',
    expected_version INTEGER,
    new_version     INTEGER,
    ok              INTEGER NOT NULL,
    detail          TEXT NOT NULL DEFAULT '',
    at              TEXT NOT NULL
);
"""


def init(conn):
    conn.executescript(SCHEMA)
    conn.commit()
