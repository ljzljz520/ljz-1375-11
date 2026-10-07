'use strict';
/**
 * 端到端验收测试（零依赖，直接起 HTTP 服务 + 临时数据目录）。
 * 覆盖：
 *  A. 年度实例必须来源确认；浮动节庆禁止沿用去年日期；原始表达/时区保留；跨年跨午夜
 *  B. 有向图：最早到达 vs 偏好候选；可行性与冲突边；同节点多路线引用；节点下线
 *  C. 天气/施工只影响相交时空片段；已发布历史叙事不被公告改写
 *  D. 公告先到、活动后到挂接
 *  E. 两个编辑并发改连线 -> 409
 *  F. 发布任务冻结节点/公告版本；年历版本递增；缓存年历不更新只提示
 *  G. 访客深链筛选 + 列表替代地图
 *  H. 迟到的前端计算结果不覆盖当前所选日期（纯逻辑）
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { createApp } = require('../server/app');
const { seed } = require('../server/seed');
const Core = require('../public/js/calendar-core');
const T = require('../server/time');

let server, base, db;
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-acc-'));
}
function request(method, p, body, role = 'editor') {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: base + p, method,
      headers: { 'Content-Type': 'application/json', 'X-Role': role, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : {}; } catch { json = { _raw: raw }; }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    if (data) req.end(data); else req.end();
  });
}

const passed = [];
async function test(name, fn) {
  try { await fn(); passed.push(['PASS', name]); }
  catch (e) { passed.push(['FAIL', name + ' :: ' + (e.message || e)]); console.error('✗', name, e); }
}

async function boot() {
  const dir = tmpDir();
  seed(dir);
  await new Promise((res) => { server = createApp(dir); server.listen(0, res); });
  base = '';
  db = server.db;
}

async function main() {
  await boot();
  const { json: nj } = await request('GET', '/api/nodes');
  const byName = Object.fromEntries(nj.nodes.map(n => [n.name, n.id]));
  const tower = byName['钟楼集散点'], temple = byName['城隍庙法会'], wall = byName['城墙灯会'],
        gate = byName['永宁门地铁站'], square = byName['钟鼓楼广场社火'];

  /* ---------- A. 来源确认 / 禁止复制旧日期 / 时区原文 / 跨年跨夜 ---------- */
  await test('A1 无来源的年度实例被拒绝(422)', async () => {
    const r = await request('POST', '/api/instances', { year: 2028, title: 'X', start_date: '2028-02-09', start_time: '19:00' });
    assert.strictEqual(r.status, 422);
    assert.match(r.json.error, /来源/);
  });

  await test('A2 浮动节庆未公布年份展开失败，绝不复制去年日期', async () => {
    const { json: rj } = await request('GET', '/api/rules');
    const yuanxiao = rj.rules.find(r => r.rule_type === 'lunar_floating');
    const r = await request('POST', `/api/rules/${yuanxiao.id}/expand`, { year: 2027 });
    assert.strictEqual(r.status, 422);
    assert.match(r.json.error, /尚未由组织方公布/);
    // 去年日期仍可作为“草案”，但强标 needs_confirmation
    const r2 = await request('POST', `/api/rules/${yuanxiao.id}/expand`, { year: 2026 });
    assert.strictEqual(r2.json.candidate.needs_confirmation, true);
  });

  await test('A3 公历固定规则可展开但仍是待确认草案', async () => {
    const { json: rj } = await request('GET', '/api/rules');
    const qingming = rj.rules.find(r => r.rule_type === 'gregorian_fixed');
    const r = await request('POST', `/api/rules/${qingming.id}/expand`, { year: 2027 });
    assert.strictEqual(r.json.candidate.start_date, '2027-04-05');
    assert.strictEqual(r.json.candidate.needs_confirmation, true);
  });

  await test('A4 实例保存绝对时刻、IANA 时区与原始表达，跨年/跨午夜往返一致', async () => {
    const iso = T.localDateToInstant('2026-12-31', '23:30', 'Asia/Shanghai');
    const back = T.instantToLocal(iso, 'Asia/Shanghai');
    assert.strictEqual(back.date, '2026-12-31');
    assert.strictEqual(back.time, '23:30');
    const iso2 = T.localDateToInstant('2027-01-01', '00:30', 'Asia/Shanghai');
    assert.strictEqual(T.durationMinutes(iso, iso2), 60);
    assert.strictEqual(T.instantToLocal(iso2, 'Asia/Shanghai').date, '2027-01-01');
    const { json: cal } = await request('GET', '/api/calendar/2027', null, 'visitor');
    assert.match(cal.items[0].date_raw, /庙方/); // 原始表达保留
    assert.strictEqual(cal.items[0].tz, 'Asia/Shanghai');
  });

  /* ---------- B. 图：最早/偏好/冲突/引用/下线 ---------- */
  await test('B1 最早到达路径：18:00出发赶19:00灯会，可等待开窗', async () => {
    const r = await request('GET', `/api/graph/earliest?origin=${tower}&destination=${wall}&date=2027-02-20&time=18:00`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.feasible, true);
    assert.match(r.json.arrival_local, /2027-02-20 19:00/);
    assert.ok(r.json.total_minutes >= 60);
  });

  await test('B2 偏好(只坐地铁+步行)给出不同候选，且可与最早路径同时到达', async () => {
    const r = await request('POST', '/api/graph/compare', {
      origin_id: tower, destination_id: wall, start_date: '2027-02-20', start_time: '18:00',
      allow_modes: ['metro', 'walk'],
    });
    assert.strictEqual(r.json.earliest.node_sequence.join(','), [tower, wall].join(',')); // 摆渡直达
    assert.deepStrictEqual(r.json.preferred.node_sequence, [tower, gate, wall]); // 地铁绕行
    assert.strictEqual(r.json.preferred.feasible, true);
    assert.strictEqual(r.json.extra_delay_minutes, 0);
  });

  await test('B3 时间不足：23:20出发赶23:30关的法会，指出第一条冲突边并给当日关窗时间', async () => {
    const { json: ej } = await request('GET', '/api/edges');
    const e1 = ej.edges.find(e => e.from_id === tower && e.to_id === temple).id;
    const e2 = ej.edges.find(e => e.from_id === temple && e.to_id === wall).id;
    const r = await request('POST', '/api/graph/evaluate', {
      origin_id: tower, start_date: '2027-02-20', start_time: '23:20', edge_ids: [e1, e2],
    });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.feasible, false);
    assert.strictEqual(r.json.conflicts[0].edge_id, e1); // 第一条冲突边
    assert.match(r.json.conflicts[0].window_close_local, /2027-02-20 23:30/); // 当日窗口
  });

  await test('B4 同一节点被多条路线引用', async () => {
    const r = await request('GET', `/api/nodes/${wall}/references`);
    const names = r.json.routes.map(x => x.name);
    assert.ok(names.length >= 2);
    assert.ok(names.includes('法会—灯会夜游线') && names.includes('地铁赏灯快线'));
  });

  await test('B5 节点下线：悬空边剔除、求路不可行、引用清单仍可见', async () => {
    // 先建一条引用社火广场的路线（同节点多路线引用的又一例）
    const { json: ej0 } = await request('GET', '/api/edges');
    const toSquare = ej0.edges.find(e => e.to_id === square);
    await request('POST', '/api/routes', { name: '白天社火线', steps: [{ node_id: gate }, { node_id: square, edge_id: toSquare.id }] });
    const r = await request('POST', `/api/nodes/${square}/offline`, { reason: '取消' });
    assert.strictEqual(r.json.node.status, 'archived');
    assert.ok(r.json.referenced_by_routes.length >= 1);
    const path_ = await request('GET', `/api/graph/earliest?origin=${tower}&destination=${square}&date=2027-02-20&time=10:00`);
    assert.strictEqual(path_.status, 409);
    assert.match(path_.json.error, /下线/);
  });

  /* ---------- C. 公告时空相交；历史叙事冻结 ---------- */
  await test('C1 夜间大风只命中相交片段，白天行程不命中', async () => {
    const night = await request('GET', `/api/graph/earliest?origin=${tower}&destination=${wall}&date=2027-02-20&time=18:50`);
    const segHit = night.json.segments.find(s => s.from_id === gate && s.to_id === wall);
    assert.ok(segHit.notices.some(n => n.kind === 'weather'));
    // 白天去已下线社火不可行了，改用法会：白天路径不应有夜间天气公告
    const day = await request('GET', `/api/graph/earliest?origin=${tower}&destination=${temple}&date=2027-02-20&time=10:00`);
    // 10:00 法会未开(18:00) -> before_open 等待，片段上不会有夜间公告
    for (const s of day.json.segments) assert.ok(!s.notices.some(n => n.kind === 'weather'));
  });

  await test('C2 已发布历史文章不随当前公告改写(409)，正文快照冻结', async () => {
    const { json: aj } = await request('GET', '/api/articles?status=published');
    const art = aj.articles[0];
    const originalBody = art.body;
    const r = await request('PUT', `/api/articles/${art.id}`, { version: art.version, body: '被新公告改写' });
    assert.strictEqual(r.status, 409);
    const again = (await request('GET', '/api/articles?status=published')).json.articles[0];
    assert.strictEqual(again.body, originalBody);
    assert.ok(again.snapshot && again.snapshot.body === originalBody);
  });

  /* ---------- D. 公告先到、活动后到 ---------- */
  await test('D1 先建公告（无实例），活动后到再挂接', async () => {
    const an = await request('POST', '/api/announcements', {
      title: '2028 社火预告（日期待批）', kind: 'festival', source_url: 'http://a/2028',
    });
    assert.strictEqual(an.json.announcement.linked_instance_id, null);
    const inst = await request('POST', '/api/instances', {
      year: 2028, title: '2028 社火巡游', start_date: '2028-02-24', start_time: '09:00',
      tz: 'Asia/Shanghai', date_raw: '农历正月廿八（街办公告原文）', source: { url_text: 'http://a/2028/date' },
      node_id: temple,
    });
    const link = await request('POST', `/api/announcements/${an.json.announcement.id}/link`, { instance_id: inst.json.instance.id });
    assert.strictEqual(link.json.instance.announcement_id, an.json.announcement.id);
    // 未确认实例不进年历
    const cal = (await request('GET', '/api/calendar/2028', null, 'visitor')).json;
    assert.strictEqual(cal.count, 0);
  });

  /* ---------- E. 并发改连线 ---------- */
  await test('E1 两个编辑并发修改同一连线，后保存者 409 且不覆盖', async () => {
    const { json: ej } = await request('GET', '/api/edges');
    const edge = ej.edges.find(e => e.from_id === tower && e.to_id === temple);
    const a = await request('PUT', `/api/edges/${edge.id}`, { version: edge.version, travel_minutes: 26 });
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.json.edge.version, edge.version + 1);
    const b = await request('PUT', `/api/edges/${edge.id}`, { version: edge.version, mode: 'metro' });
    assert.strictEqual(b.status, 409);
    assert.strictEqual(b.json.current.version, edge.version + 1);
    // A 的修改保留，B 未生效
    const now = (await request('GET', '/api/edges')).json.edges.find(e => e.id === edge.id);
    assert.strictEqual(now.travel_minutes, 26);
    assert.strictEqual(now.mode, 'walk');
  });

  /* ---------- F. 发布冻结 + 年历版本/缓存 ---------- */
  await test('F1 发布冻结版本；发布后改节点不影响已发布快照；年历版本递增', async () => {
    const v0 = (await request('GET', '/api/calendar/2027/version')).json.version;
    const before = (await request('GET', `/api/nodes/${wall}`));
    // 改活动节点名称（发布之后）
    await request('PUT', `/api/nodes/${wall}`, { version: before.json.nodes ? 1 : 1, name: '改名不应进快照' });
    const nodeVer = db.get('content', 'nodes', wall).version;
    const releases = (await request('GET', '/api/releases?year=2027')).json.releases;
    const frozenWall = releases[0].frozen_versions.nodes.find(n => n.id === wall);
    assert.strictEqual(frozenWall.version, 1); // 冻结在发布时版本
    assert.ok(nodeVer >= 2);
    // 重新发布 -> 年历版本 +1
    const r2 = await request('POST', '/api/releases', {
      year: 2027, name: '二版', node_ids: db.all('content', 'nodes').map(n => n.id),
      route_ids: db.all('content', 'routes').map(x => x.id),
      announcement_ids: db.all('content', 'announcements').filter(a => a.status === 'published').map(a => a.id),
      article_ids: db.all('articles', 'articles').filter(a => a.status === 'published').map(a => a.id),
    }, 'publisher');
    assert.strictEqual(r2.status, 201);
    const v1 = (await request('GET', '/api/calendar/2027/version')).json.version;
    assert.strictEqual(v1, v0 + 1);
    // ETag 含版本号 -> 旧缓存可被识别
    const etag = (await request('GET', `/api/calendar/2027?node=${wall}`)).headers.etag;
    assert.match(etag, new RegExp(`v${v1}`));
  });

  await test('F2 发布任务拒绝纳入未确认实例并在发布单中列出', async () => {
    await request('POST', '/api/instances', {
      year: 2027, title: '未确认彩排', start_date: '2027-02-19', start_time: '20:00',
      source: { url_text: 'http://x/rehearsal' }, node_id: temple,
    });
    const r = await request('POST', '/api/releases', {
      year: 2027, name: '三版', node_ids: [temple, wall], route_ids: [], announcement_ids: [], article_ids: [],
    }, 'publisher');
    assert.strictEqual(r.status, 201);
    assert.ok(r.json.release.unconfirmed_instances.some(x => x.title === '未确认彩排'));
    const cal = (await request('GET', '/api/calendar/2027')).json;
    assert.ok(!cal.items.some(i => i.title === '未确认彩排'));
  });

  /* ---------- G. 访客深链 + 列表替代地图 ---------- */
  await test('G1 深链筛选参数解析与回链一致；默认列表视图', async () => {
    const s = Core.parseDeepLink(`?year=2027&node=${wall}&view=list`);
    assert.deepStrictEqual(s, { year: 2027, node: wall, tag: '', view: 'list' });
    assert.ok(!Core.toDeepLink(s).includes('view=')); // list 是默认，省略更干净
    const sMap = Core.parseDeepLink(`?year=2027&node=${wall}&view=map`);
    assert.match(Core.toDeepLink(sMap), /view=map/);
    const r = await request('GET', `/api/calendar/2027?node=${wall}&view=list`, null, 'visitor');
    assert.strictEqual(r.json.view, 'list');
    assert.ok(r.json.items.every(i => i.node_id === wall));
    const empty = await request('GET', '/api/calendar/2027?node=nodes_999', null, 'visitor');
    assert.strictEqual(empty.json.count, 0);
  });

  /* ---------- H. 迟到响应不覆盖当前所选日期 ---------- */
  await test('H1 前端：用户先选2027再快速切到2026，迟到的2027响应不覆盖当前视图', () => {
    const store = Core.createStore({ year: 2027, node: '', tag: '', view: 'list' });
    const seq2027 = store.select({ year: 2027, node: '', tag: '', view: 'list' });
    const seq2026 = store.select({ year: 2026, node: '', tag: '', view: 'list' });
    // 2026 的响应先回来
    const r26 = store.resolve(seq2026, { year: 2026 }, { items: [{ title: '2026 only', start_date: '2026-03-03' }], calendar_version: 5 });
    assert.strictEqual(r26.applied, true);
    assert.strictEqual(store.getState().items[0].title, '2026 only');
    // 迟到的 2027 响应再回来 —— 必须被拒绝
    const r27 = store.resolve(seq2027, { year: 2027 }, { items: [{ title: '2027 late', start_date: '2027-02-20' }], calendar_version: 5 });
    assert.strictEqual(r27.applied, false);
    assert.strictEqual(store.getState().items[0].title, '2026 only'); // 未被覆盖
    assert.strictEqual(store.getState().selected.year, 2026);
    assert.strictEqual(store.lateResponses().length, 1);
  });

  await test('H2 前端：后台发现年历新版本只标记缓存过期，不覆盖当前 items', () => {
    const store = Core.createStore({ year: 2027, node: '', tag: '', view: 'list' });
    const seq = store.select({ year: 2027, node: '', tag: '', view: 'list' });
    store.resolve(seq, { year: 2027 }, { items: [{ title: 'cached', start_date: '2027-02-20' }], calendar_version: 1 });
    const stale = store.noteServerVersion(2);
    assert.strictEqual(stale, true);
    assert.strictEqual(store.getState().cacheStale, true);
    assert.strictEqual(store.getState().items[0].title, 'cached'); // 不覆盖
  });

  /* ---------- I. 权限：审核-发布工作流 ---------- */
  await test('I1 草稿→审核→发布；未审核不能发布；访客不能写', async () => {
    const an = await request('POST', '/api/announcements', { title: '管制', source_url: 'http://a' });
    assert.strictEqual(an.json.announcement.status, 'draft');
    assert.strictEqual((await request('POST', `/api/announcements/${an.json.announcement.id}/publish`, {}, 'publisher')).status, 409);
    assert.strictEqual((await request('POST', `/api/announcements/${an.json.announcement.id}/review`, { approve: true }, 'reviewer')).status, 200);
    assert.strictEqual((await request('POST', `/api/announcements/${an.json.announcement.id}/publish`, {}, 'publisher')).status, 200);
    assert.strictEqual((await request('POST', '/api/nodes', { name: 'x' }, 'visitor')).status, 403);
  });

  /* ---------- 汇总 ---------- */
  let fails = 0;
  for (const [st, name] of passed) {
    console.log(`${st === 'PASS' ? '✅' : '❌'} ${st}  ${name}`);
    if (st === 'FAIL') fails++;
  }
  console.log(`\n${passed.length - fails}/${passed.length} 通过`);
  server.close();
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
