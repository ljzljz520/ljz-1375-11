'use strict';
/**
 * 领域服务层：
 *  1) 年度活动实例必须来源确认，禁止从去年日期静默复制；
 *  2) 周期规则只是“待确认草案”，展开结果默认 unverified，不能直接进已发布年历；
 *  3) 公告可以先于活动到达，活动后到再挂接；
 *  4) 发布任务冻结当时的节点/公告/路线/文章版本（快照）；
 *  5) 历史文章发布后冻结，不随当前公告重写；
 *  6) 年历带版本号，内容发布后缓存版本递增；
 */
const graph = require('./graph');
const T = require('./time');

class DomainError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

/* ---------------- 年度活动实例（instances 库） ---------------- */

function createInstance(db, input) {
  const { year, title, rule_id, start_date, start_time, tz = 'Asia/Shanghai', date_raw, source, node_id, node_windows } = input;
  if (!year || !title) throw new DomainError(400, '缺少 year/title');
  if (!start_date || !start_time) throw new DomainError(400, '缺少活动日期/时间（节庆日期须逐年提供）');
  if (!source || !source.url_text) {
    throw new DomainError(422, '缺少来源：节庆日期必须由组织方逐年公布并确认，不能沿用去年日期');
  }
  const startIso = T.localDateToInstant(start_date, start_time, tz);
  return db.insert('instances', 'event_instances', {
    year, title, rule_id: rule_id || null, node_id: node_id || null,
    start_date, start_time, tz, start_iso: startIso,
    date_raw: date_raw || `${start_date} ${start_time}`, // 保留原始表达
    source: { url_text: source.url_text, published_at: source.published_at || null, confidence: source.confidence || 'official' },
    verified: false, // 未经确认不得对外发布
    node_windows: node_windows || null,
    status: 'proposed',
    announcement_id: input.announcement_id || null, // 公告先到时可先挂公告
  });
}

/**
 * 来源确认。显式动作：编辑核对组织方公告后确认。
 * 不提供任何“复制上一年”的确认途径。
 */
function confirmInstance(db, id, reviewer, confirmSource) {
  const inst = db.get('instances', 'event_instances', id);
  if (!inst) throw new DomainError(404, '活动实例不存在');
  if (!confirmSource || !confirmSource.url_text) throw new DomainError(422, '确认时必须给出核对来源');
  return db.update('instances', 'event_instances', id, {
    verified: true,
    status: 'confirmed',
    verification: { reviewer, confirmed_at: new Date().toISOString(), source: confirmSource },
  });
}

/**
 * 依据周期规则展开某年度候选日期——仅生成“未确认草案”，并强制标注 needs_confirmation。
 * 算法仅把规则表达翻译成候选，绝不标记为已确认。
 */
function expandRule(db, ruleId, year) {
  const rule = db.get('rules', 'recurrence_rules', ruleId);
  if (!rule) throw new DomainError(404, '周期规则不存在');
  let candidate;
  if (rule.rule_type === 'lunar_floating' && rule.provisional_dates && rule.provisional_dates[String(year)]) {
    candidate = rule.provisional_dates[String(year)]; // 组织方逐年公布的临时日期
  } else if (rule.rule_type === 'gregorian_fixed') {
    candidate = { start_date: `${year}-${rule.month.padStart(2, '0')}-${String(rule.day).padStart(2, '0')}`, start_time: rule.time };
  } else {
    throw new DomainError(422, `规则 ${rule.name} 是浮动节庆，${year} 年日期尚未由组织方公布，无法安全展开（禁止沿用去年日期）`);
  }
  return {
    rule_id: ruleId, year, ...candidate, tz: rule.tz,
    date_raw: rule.expression_raw,
    needs_confirmation: true,
    warning: '该日期由周期规则推导，必须经组织方来源确认后方可发布',
  };
}

/* ---------------- 公告（content 库）：公告先到、活动后到 ---------------- */

function createAnnouncement(db, input) {
  const { title, body, source_url, published_at, kind = 'notice', effect } = input;
  if (!title || !source_url) throw new DomainError(400, '公告需要标题与来源链接');
  return db.insert('content', 'announcements', {
    title, body: body || '', source_url,
    published_at: published_at || new Date().toISOString(),
    kind, // notice | weather | construction | festival
    effect: effect || null,
    status: 'draft',
    linked_instance_id: input.linked_instance_id || null,
  });
}

/** 活动后到：把年度实例挂到先前到达的公告上。 */
function linkInstanceToAnnouncement(db, announcementId, instanceId) {
  const an = db.get('content', 'announcements', announcementId);
  if (!an) throw new DomainError(404, '公告不存在');
  const inst = db.get('instances', 'event_instances', instanceId);
  if (!inst) throw new DomainError(404, '活动实例不存在');
  db.update('content', 'announcements', announcementId, { linked_instance_id: instanceId });
  return db.update('instances', 'event_instances', instanceId, { announcement_id: announcementId });
}

/* ---------------- 历史文章（articles 库）：发布即冻结 ---------------- */

function createArticle(db, input) {
  return db.insert('articles', 'articles', {
    slug: input.slug, title: input.title, body: input.body,
    narrative_year: input.narrative_year || null,
    status: 'draft',
    frozen_at: null,
    snapshot: null,
  });
}

function updateArticle(db, id, patch, expectedVersion) {
  const art = db.get('articles', 'articles', id);
  if (!art) throw new DomainError(404, '文章不存在');
  if (art.status === 'published') {
    // 已发布历史叙事不随当前公告重写；需另起修订稿
    throw new DomainError(409, '已发布的历史叙事已冻结，不能改写；请基于它新建修订稿');
  }
  return db.update('articles', 'articles', id, patch, expectedVersion);
}

function publishArticle(db, id) {
  const art = db.get('articles', 'articles', id);
  if (!art) throw new DomainError(404, '文章不存在');
  if (art.status === 'published') return art;
  const frozen = JSON.parse(JSON.stringify(art));
  return db.update('articles', 'articles', id, {
    status: 'published',
    frozen_at: new Date().toISOString(),
    snapshot: frozen, // 冻结正文快照
  });
}

/* ---------------- 发布任务：冻结节点/公告/路线/文章版本 ---------------- */

function publishRelease(db, input) {
  const { name, year, route_ids = [], article_ids = [], announcement_ids = [], node_ids = [] } = input;
  // 活动实例必须已确认才可被年历发布引用
  const instances = db.find('instances', 'event_instances', i => i.year === year);
  const unconfirmed = instances.filter(i => !i.verified);
  const freezeOne = (dbName, table, id) => {
    const rec = db.get(dbName, table, id);
    if (!rec) throw new DomainError(404, `${table}.${id} 不存在，无法冻结`);
    return { id, version: rec.version, data: JSON.parse(JSON.stringify(rec)) };
  };
  const frozenRoutes = route_ids.map(id => {
    const route = freezeOne('content', 'routes', id);
    const steps = db.find('content', 'route_steps', s => s.route_id === id)
      .sort((a, b) => a.seq - b.seq)
      .map(s => JSON.parse(JSON.stringify(s)));
    return { ...route, steps };
  });
  const frozen = {
    nodes: node_ids.map(id => freezeOne('content', 'nodes', id)),
    announcements: announcement_ids.map(id => freezeOne('content', 'announcements', id)),
    articles: article_ids.map(id => freezeOne('articles', 'articles', id)),
    routes: frozenRoutes,
    instances: instances.filter(i => i.verified).map(i => JSON.parse(JSON.stringify(i))),
  };
  const release = db.insert('content', 'releases', {
    name: name || `${year} 年历发布`,
    year,
    status: 'published',
    published_at: new Date().toISOString(),
    frozen_versions: {
      nodes: frozen.nodes.map(n => ({ id: n.id, version: n.version })),
      announcements: frozen.announcements.map(a => ({ id: a.id, version: a.version })),
      articles: frozen.articles.map(a => ({ id: a.id, version: a.version })),
      routes: frozen.routes.map(r => ({ id: r.id, version: r.version })),
    },
    snapshot: frozen,
    unconfirmed_instances: unconfirmed.map(i => ({ id: i.id, title: i.title, reason: '日期未经来源确认，不纳入发布' })),
  });
  // 年历缓存版本递增，使前端旧缓存失效
  bumpCalendarVersion(db, year, { reason: 'release', release_id: release.id });
  return release;
}

function latestRelease(db, year) {
  const rows = db.find('content', 'releases', r => r.status === 'published' && (!year || r.year === year));
  return rows.sort((a, b) => (b.published_at || '').localeCompare(a.published_at || ''))[0] || null;
}

/* ---------------- 年历版本/缓存（rules 库） ---------------- */

function bumpCalendarVersion(db, year, meta) {
  let row = db.findOne('rules', 'calendar_versions', r => r.year === year);
  const now = new Date().toISOString();
  if (!row) {
    row = db.insert('rules', 'calendar_versions', { year, version: 1, updated_at: now, last_meta: meta });
  } else {
    row = db.replace('rules', 'calendar_versions', row.id, r => ({ ...r, version: r.version + 1, updated_at: now, last_meta: meta }));
  }
  return row;
}

function getCalendarVersion(db, year) {
  return db.findOne('rules', 'calendar_versions', r => r.year === year) || { year, version: 0 };
}

/**
 * 组装对外年历：优先读最新发布快照；未发布时退回已确认实例，但标注没有正式发布。
 * 访客筛选（年份、节点、标签、仅确认）可深链；deep-link 参数由 HTTP 层处理。
 */
function assembleCalendar(db, year, filter = {}) {
  const release = latestRelease(db, year);
  let items = [];
  let fromRelease = false;
  if (release) {
    fromRelease = true;
    items = release.snapshot.instances.map(i => ({ ...i, _frozen: true, release_id: release.id }));
  } else {
    items = db.find('instances', 'event_instances', i => i.year === year && i.verified)
      .map(i => ({ ...i, _frozen: false }));
  }
  if (filter.node_id) items = items.filter(i => i.node_id === filter.node_id);
  if (filter.tag) items = items.filter(i => Array.isArray(i.tags) && i.tags.includes(filter.tag));
  return {
    year,
    calendar_version: getCalendarVersion(db, year).version,
    source: fromRelease ? 'release_snapshot' : 'live_confirmed',
    release_id: release ? release.id : null,
    count: items.length,
    items,
  };
}

/* ---------------- 节点下线 ---------------- */

function takeNodeOffline(db, id, reason) {
  const node = db.get('content', 'nodes', id);
  if (!node) throw new DomainError(404, '节点不存在');
  return db.update('content', 'nodes', id, { status: 'archived', offline_reason: reason || '' });
}

/** 找出引用某节点的路线（验收：同一节点被多路线引用）。 */
function routesReferencingNode(db, nodeId) {
  return db.find('content', 'route_steps', s => s.node_id === nodeId)
    .map(s => s.route_id)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .map(rid => db.get('content', 'routes', rid))
    .filter(Boolean);
}

/** 路线结构 -> 边 id 序列（route_steps 顺序）。同节点可被多条路线引用。 */
function routeEdgeSequence(db, routeId) {
  return db.find('content', 'route_steps', s => s.route_id === routeId).sort((a, b) => a.seq - b.seq);
}

module.exports = {
  DomainError,
  createInstance, confirmInstance, expandRule,
  createAnnouncement, linkInstanceToAnnouncement,
  createArticle, updateArticle, publishArticle,
  publishRelease, latestRelease,
  bumpCalendarVersion, getCalendarVersion, assembleCalendar,
  takeNodeOffline, routesReferencingNode, routeEdgeSequence,
};
