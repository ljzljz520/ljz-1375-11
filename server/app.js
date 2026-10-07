'use strict';
/** 零依赖 HTTP 服务：REST API + 静态站点。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { DB } = require('./db');
const svc = require('./services');
const graphMod = require('./graph');
const T = require('./time');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

function createApp(dataDir = path.join(ROOT, 'data')) {
  const db = new DB(dataDir);

  const send = (res, code, body, headers = {}) => {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(payload);
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 2e6) reject(new svc.DomainError(413, '请求过大')); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new svc.DomainError(400, 'JSON 解析失败')); }
    });
    req.on('error', reject);
  });

  const requireRole = (req, roles) => {
    const role = req.headers['x-role'] || 'visitor';
    if (!roles.includes(role)) {
      throw new svc.DomainError(403, `需要角色之一: ${roles.join('/')}（当前 ${role}）`);
    }
    return role;
  };

  /* ---------- 图计算公共参数 ---------- */
  const parsePlan = (q, body) => {
    const originId = q.origin || body.origin_id;
    const startDate = q.date || body.start_date;
    const startTime = q.time || body.start_time || '00:00';
    const tz = q.tz || body.tz || 'Asia/Shanghai';
    if (!originId) throw new svc.DomainError(400, '缺少 origin');
    const dateOverride = startDate
      ? { node_windows: (body.node_windows || {}) }
      : null;
    return {
      originId,
      destinationId: q.destination || body.destination_id,
      startIso: T.localDateToInstant(startDate || new Date().toISOString().slice(0, 10), startTime, tz),
      tz,
      dateOverride,
      allowModes: q.modes ? q.modes.split(',') : (body.allow_modes || undefined),
      denyModes: body.deny_modes,
      allowNodes: body.allow_nodes,
      requireNodes: body.require_nodes || (q.require ? q.require.split(',') : []),
    };
  };

  const routes = [];
  const on = (method, pattern, roles, handler) => routes.push({ method, pattern, roles, handler });

  /* ===== 节点（仪式节点 / 换乘点） ===== */
  on('GET', /^\/api\/nodes$/, null, async (req, res, m, q) => {
    let nodes = db.all('content', 'nodes');
    if (q.status) nodes = nodes.filter(n => n.status === q.status);
    send(res, 200, { nodes });
  });
  on('POST', '/api/nodes', ['editor'], async (req, res) => {
    const b = await readBody(req);
    const node = db.insert('content', 'nodes', {
      name: b.name, kind: b.kind || 'ritual', tz: b.tz || 'Asia/Shanghai',
      window: b.window || null, // {open:'08:30',close:'22:00',tz,raw}
      window_raw: b.window_raw || null, // 保留原始开放表达
      location: b.location || null, status: 'active',
    });
    send(res, 201, { node });
  });
  on('PUT', /^\/api\/nodes\/([\w-]+)$/, ['editor'], async (req, res, m) => {
    const b = await readBody(req);
    const expected = b.version ?? Number(req.headers['if-match'] || NaN);
    const allowed = Object.fromEntries(['name', 'kind', 'tz', 'window', 'window_raw', 'location', 'status']
      .filter(k => k in b).map(k => [k, b[k]]));
    const node = db.update('content', 'nodes', m[0], allowed, Number.isFinite(expected) ? expected : undefined);
    send(res, 200, { node });
  });
  on('POST', /^\/api\/nodes\/([\w-]+)\/offline$/, ['editor'], async (req, res, m) => {
    const b = await readBody(req).catch(() => ({}));
    const node = svc.takeNodeOffline(db, m[0], b.reason);
    const refs = svc.routesReferencingNode(db, m[0]);
    send(res, 200, { node, referenced_by_routes: refs.map(r => ({ id: r.id, name: r.name })) });
  });
  on('GET', /^\/api\/nodes\/([\w-]+)\/references$/, null, async (req, res, m) => {
    send(res, 200, { node_id: m[0], routes: svc.routesReferencingNode(db, m[0]) });
  });

  /* ===== 有向边（交通换乘连线） ===== */
  on('GET', /^\/api\/edges$/, null, async (req, res, mm, q) => {
    send(res, 200, { edges: db.all('content', 'edges') });
  });
  on('POST', '/api/edges', ['editor'], async (req, res) => {
    const b = await readBody(req);
    if (!b.from_id || !b.to_id) throw new svc.DomainError(400, '边需要 from_id/to_id');
    if (!db.get('content', 'nodes', b.from_id) || !db.get('content', 'nodes', b.to_id)) {
      throw new svc.DomainError(422, '边端点节点不存在');
    }
    const edge = db.insert('content', 'edges', {
      from_id: b.from_id, to_id: b.to_id,
      mode: b.mode || 'walk',
      travel_minutes: Number(b.travel_minutes || 0),
      note: b.note || '', status: 'active',
    });
    send(res, 201, { edge });
  });
  on('PUT', /^\/api\/edges\/([\w-]+)$/, ['editor'], async (req, res, m) => {
    const b = await readBody(req);
    const expected = b.version ?? Number(req.headers['if-match'] || NaN);
    const allowed = Object.fromEntries(['from_id', 'to_id', 'mode', 'travel_minutes', 'note', 'status']
      .filter(k => k in b).map(k => [k, b[k]]));
    const edge = db.update('content', 'edges', m[0], allowed, Number.isFinite(expected) ? expected : undefined);
    send(res, 200, { edge });
  });

  /* ===== 路线（步骤引用节点/边；同节点允许多路线引用） ===== */
  on('GET', /^\/api\/routes$/, null, async (req, res) => {
    send(res, 200, { routes: db.all('content', 'routes'), steps: db.all('content', 'route_steps') });
  });
  on('POST', '/api/routes', ['editor'], async (req, res) => {
    const b = await readBody(req);
    const route = db.insert('content', 'routes', { name: b.name, description: b.description || '', status: 'draft' });
    const steps = [];
    (b.steps || []).forEach((s, i) => {
      steps.push(db.insert('content', 'route_steps', {
        route_id: route.id, seq: s.seq ?? i, node_id: s.node_id, edge_id: s.edge_id || null,
      }));
    });
    send(res, 201, { route, steps });
  });

  /* ===== 图：最早到达 / 偏好比较 / 可行性（含冲突边） ===== */
  on('GET', /^\/api\/graph\/earliest$/, null, async (req, res, mm, q) => {
    const g = graphMod.buildGraph(db);
    const opts = parsePlan(q, {});
    if (!opts.destinationId) throw new svc.DomainError(400, '缺少 destination');
    const result = graphMod.earliestPath(g, opts);
    const notices = db.all('content', 'announcements').filter(a => a.status === 'published' && ['weather', 'construction'].includes(a.kind));
    if (result.segments) result.segments = graphMod.intersectNotices(result.segments, notices);
    send(res, result.feasible ? 200 : 409, result);
  });
  on('POST', '/api/graph/compare', ['editor', 'reviewer'], async (req, res) => {
    const b = await readBody(req);
    const g = graphMod.buildGraph(db);
    const opts = parsePlan({}, b);
    if (!opts.destinationId) throw new svc.DomainError(400, '缺少 destination_id');
    send(res, 200, graphMod.comparePaths(g, opts));
  });
  on('POST', '/api/graph/evaluate', ['editor', 'reviewer'], async (req, res) => {
    const b = await readBody(req);
    const g = graphMod.buildGraph(db);
    if (!b.origin_id || !Array.isArray(b.edge_ids)) throw new svc.DomainError(400, '需要 origin_id 与 edge_ids[]');
    const tz = b.tz || 'Asia/Shanghai';
    const startIso = T.localDateToInstant(b.start_date, b.start_time || '00:00', tz);
    const result = graphMod.evaluatePlan(g, {
      originId: b.origin_id, startIso, edges: b.edge_ids, tz,
      dateOverride: { node_windows: b.node_windows || {} },
    });
    send(res, result.feasible ? 200 : 409, result);
  });

  /* ===== 年度活动实例（逐年、来源确认） ===== */
  on('GET', /^\/api\/instances$/, null, async (req, res, mm, q) => {
    let items = db.all('instances', 'event_instances');
    if (q.year) items = items.filter(i => String(i.year) === String(q.year));
    if (q.node) items = items.filter(i => i.node_id === q.node);
    send(res, 200, { instances: items });
  });
  on('POST', '/api/instances', ['editor'], async (req, res) => {
    const b = await readBody(req);
    const inst = svc.createInstance(db, b);
    send(res, 201, { instance: inst });
  });
  on('POST', /^\/api\/instances\/([\w-]+)\/confirm$/, ['reviewer'], async (req, res, m) => {
    const b = await readBody(req);
    send(res, 200, { instance: svc.confirmInstance(db, m[0], requireRole(req, ['reviewer']), b.source) });
  });

  /* ===== 周期规则与“草案展开”（绝不静默复制旧日期） ===== */
  on('GET', /^\/api\/rules$/, null, async (req, res) => {
    send(res, 200, { rules: db.all('rules', 'recurrence_rules') });
  });
  on('POST', '/api/rules', ['editor'], async (req, res) => {
    const b = await readBody(req);
    const rule = db.insert('rules', 'recurrence_rules', {
      name: b.name, rule_type: b.rule_type, // gregorian_fixed | lunar_floating
      month: b.month || null, day: b.day || null, time: b.time || null, tz: b.tz || 'Asia/Shanghai',
      expression_raw: b.expression_raw || '',
      provisional_dates: b.provisional_dates || {}, // 组织方逐年公布
    });
    send(res, 201, { rule });
  });
  on('POST', /^\/api\/rules\/([\w-]+)\/expand$/, ['editor'], async (req, res, m) => {
    const b = await readBody(req);
    if (!b.year) throw new svc.DomainError(400, '缺少 year');
    send(res, 200, { candidate: svc.expandRule(db, m[0], b.year) });
  });

  /* ===== 公告（天气/施工/节庆；公告先到活动后到） ===== */
  on('GET', /^\/api\/announcements$/, null, async (req, res, mm, q) => {
    let items = db.all('content', 'announcements');
    if (q.status) items = items.filter(a => a.status === q.status);
    send(res, 200, { announcements: items });
  });
  on('POST', '/api/announcements', ['editor'], async (req, res) => {
    const b = await readBody(req);
    const an = svc.createAnnouncement(db, b);
    send(res, 201, { announcement: an });
  });
  on('POST', /^\/api\/announcements\/([\w-]+)\/link$/, ['editor'], async (req, res, m) => {
    const b = await readBody(req);
    send(res, 200, { instance: svc.linkInstanceToAnnouncement(db, m[0], b.instance_id) });
  });
  on('POST', /^\/api\/announcements\/([\w-]+)\/review$/, ['reviewer'], async (req, res, m) => {
    const b = await readBody(req);
    const an = db.update('content', 'announcements', m[0], {
      status: b.approve ? 'approved' : 'rejected',
      review: { reviewer: req.headers['x-user'] || 'reviewer', at: new Date().toISOString(), note: b.note || '' },
    });
    send(res, 200, { announcement: an });
  });
  on('POST', /^\/api\/announcements\/([\w-]+)\/publish$/, ['publisher'], async (req, res, m) => {
    const an = db.get('content', 'announcements', m[0]);
    if (!an) throw new svc.DomainError(404, '公告不存在');
    if (an.status !== 'approved') throw new svc.DomainError(409, '公告须先通过审核才能发布');
    send(res, 200, { announcement: db.update('content', 'announcements', m[0], { status: 'published' }) });
  });

  /* ===== 历史文章（发布后冻结） ===== */
  on('GET', /^\/api\/articles$/, null, async (req, res, mm, q) => {
    let items = db.all('articles', 'articles');
    if (q.status) items = items.filter(a => a.status === q.status);
    send(res, 200, { articles: items });
  });
  on('POST', '/api/articles', ['editor'], async (req, res) => {
    const b = await readBody(req);
    send(res, 201, { article: svc.createArticle(db, b) });
  });
  on('PUT', /^\/api\/articles\/([\w-]+)$/, ['editor'], async (req, res, m) => {
    const b = await readBody(req);
    const art = svc.updateArticle(db, m[0], { title: b.title, body: b.body, slug: b.slug }, b.version);
    send(res, 200, { article: art });
  });
  on('POST', /^\/api\/articles\/([\w-]+)\/publish$/, ['publisher'], async (req, res, m) => {
    send(res, 200, { article: svc.publishArticle(db, m[0]) });
  });

  /* ===== 发布任务（冻结节点/公告/文章/路线版本 + 年历版本递增） ===== */
  on('GET', /^\/api\/releases$/, null, async (req, res, mm, q) => {
    let rows = db.all('content', 'releases');
    if (q.year) rows = rows.filter(r => String(r.year) === String(q.year));
    send(res, 200, { releases: rows.map(r => ({ ...r, snapshot: undefined })) });
  });
  on('POST', '/api/releases', ['publisher'], async (req, res) => {
    const b = await readBody(req);
    if (!b.year) throw new svc.DomainError(400, '缺少 year');
    send(res, 201, { release: svc.publishRelease(db, b) });
  });

  /* ===== 访客年历（可深链筛选；返回 calendar_version 供缓存校验） ===== */
  on('GET', /^\/api\/calendar\/(\d{4})$/, null, async (req, res, m, q) => {
    const filter = { node_id: q.node, tag: q.tag };
    const cal = svc.assembleCalendar(db, Number(m[0]), filter);
    const headers = { ETag: `"cal-${m[0]}-v${cal.calendar_version}-${cal.count}"` };
    if (q.view === 'list') cal.view = 'list'; // 列表替代地图
    send(res, 200, cal, headers);
  });
  on('GET', /^\/api\/calendar\/(\d{4})\/version$/, null, async (req, res, m) => {
    send(res, 200, svc.getCalendarVersion(db, Number(m[0])));
  });

  /* ---------- 静态文件 ---------- */
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
  const serveApp = (res) => {
    fs.readFile(path.join(PUBLIC, 'app.html'), (e, d) => {
      if (e) return send(res, 404, 'not found');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(d);
    });
  };
  const serveStatic = (req, res, pathname) => {
    let rel = decodeURIComponent(pathname);
    if (rel === '/') rel = '/index.html';
    if (rel === '/app' || rel === '/app/') return serveApp(res);
    const base = rel.startsWith('/app') ? PUBLIC : ROOT;
    const fp = path.normalize(path.join(base, rel));
    if (!fp.startsWith(base)) return send(res, 403, { error: 'forbidden' });
    fs.stat(fp, (err, st) => {
      if (err || !st.isFile()) {
        // 前端路由回退：/app/* -> public/app.html
        if (rel.startsWith('/app')) return serveApp(res);
        return send(res, 404, { error: 'not found' });
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      fs.createReadStream(fp).pipe(res);
    });
  };

  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;
    try {
      if (pathname.startsWith('/api/')) {
        for (const r of routes) {
          const isRegex = r.pattern instanceof RegExp;
          const m = isRegex ? r.pattern.exec(pathname) : (r.pattern === pathname ? [] : null);
          if (!m || r.method !== req.method) continue;
          if (r.roles) requireRole(req, r.roles);
          await r.handler(req, res, isRegex ? m.slice(1).map(g => g) : [], parsed.query);
          return;
        }
        return send(res, 404, { error: `无此接口: ${req.method} ${pathname}` });
      }
      return serveStatic(req, res, pathname);
    } catch (e) {
      const httpCode = (typeof e.code === 'number') ? e.code : (e instanceof svc.DomainError ? (e.code || 400) : 500);
      if (e instanceof svc.DomainError || typeof e.code === 'number') {
        return send(res, httpCode, {
          error: e.message,
          extra: e.extra || null,
          current: e.current ? { id: e.current.id, version: e.current.version } : undefined,
        });
      }
      console.error(e);
      send(res, 500, { error: '服务器内部错误', detail: String(e && e.message || e) });
    }
  });

  server.db = db;
  return server;
}

module.exports = { createApp };
