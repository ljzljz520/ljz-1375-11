'use strict';
/** 初始化演示数据（幂等：数据目录为空时执行）。 */
const fs = require('fs');
const path = require('path');
const { createApp } = require('./app');
const svc = require('./services');
const T = require('./time');

function seed(dataDir) {
  if (fs.existsSync(path.join(dataDir, 'db_content.json'))) {
    if (fs.statSync(path.join(dataDir, 'db_content.json')).size > 5) return false;
  }
  const server = createApp(dataDir);
  const db = server.db;

  // 仪式节点（含跨午夜窗口）与交通换乘点（无窗口=全天）
  const tower = db.insert('content', 'nodes', { name: '钟楼集散点', kind: 'hub', tz: 'Asia/Shanghai', window: null });
  const temple = db.insert('content', 'nodes', {
    name: '城隍庙法会', kind: 'ritual', tz: 'Asia/Shanghai',
    window: { open: '18:00', close: '23:30', tz: 'Asia/Shanghai', raw: '正月十五 18:00 起，法会至 23:30（庙方公告原文）' },
    window_raw: '18:00–23:30',
  });
  const wall = db.insert('content', 'nodes', {
    name: '城墙灯会', kind: 'ritual', tz: 'Asia/Shanghai',
    window: { open: '19:00', close: '02:00', tz: 'Asia/Shanghai', raw: '灯会跨夜开放至次日凌晨 02:00' },
    window_raw: '19:00–次日02:00（跨午夜）',
  });
  const gate = db.insert('content', 'nodes', { name: '永宁门地铁站', kind: 'transfer', tz: 'Asia/Shanghai', window: null });
  const square = db.insert('content', 'nodes', {
    name: '钟鼓楼广场社火', kind: 'ritual', tz: 'Asia/Shanghai',
    window: { open: '09:00', close: '17:00', tz: 'Asia/Shanghai', raw: '社火巡游白天场 09:00–17:00' },
  });

  // 有向边：步行 / 地铁 / 摆渡车，含移动耗时
  const eDefs = [
    [tower.id, temple.id, 'walk', 25], [temple.id, wall.id, 'walk', 35],
    [tower.id, gate.id, 'metro', 8], [gate.id, wall.id, 'walk', 12],
    [tower.id, wall.id, 'shuttle', 40], [wall.id, square.id, 'metro', 18],
    [tower.id, square.id, 'walk', 30], [temple.id, gate.id, 'walk', 20],
    [gate.id, square.id, 'metro', 10],
  ];
  const edges = {};
  for (const [f, t, mode, min] of eDefs) {
    const e = db.insert('content', 'edges', { from_id: f, to_id: t, mode, travel_minutes: min, status: 'active' });
    edges[`${f}->${t}:${mode}`] = e;
  }

  // 两条路线引用同一节点（验收：同节点多路线引用）
  const r1 = db.insert('content', 'routes', { name: '法会—灯会夜游线', status: 'published' });
  [temple.id, wall.id].forEach((nid, i) => db.insert('content', 'route_steps', {
    route_id: r1.id, seq: i, node_id: nid,
    edge_id: i === 0 ? edges[`${tower.id}->${temple.id}:walk`].id : edges[`${temple.id}->${wall.id}:walk`].id,
  }));
  const r2 = db.insert('content', 'routes', { name: '地铁赏灯快线', status: 'published' });
  [gate.id, wall.id].forEach((nid, i) => db.insert('content', 'route_steps', {
    route_id: r2.id, seq: i, node_id: nid,
    edge_id: i === 0 ? edges[`${tower.id}->${gate.id}:metro`].id : edges[`${gate.id}->${wall.id}:walk`].id,
  }));

  // 周期规则：公历固定（清明）与农历浮动（元宵，逐年公布）
  db.insert('rules', 'recurrence_rules', {
    name: '清明公祭轩辕黄帝（公历固定）', rule_type: 'gregorian_fixed',
    month: '04', day: '05', time: '09:30', tz: 'Asia/Shanghai',
    expression_raw: '每年公历 4 月 5 日 09:30', provisional_dates: {},
  });
  const yuanxiaoRule = db.insert('rules', 'recurrence_rules', {
    name: '元宵节城隍庙会（农历浮动）', rule_type: 'lunar_floating',
    tz: 'Asia/Shanghai', expression_raw: '农历正月十五（公历日期逐年由庙方公布）',
    provisional_dates: {
      2026: { start_date: '2026-03-03', start_time: '18:00' }, // 去年公布值，仅供参考
      // 2027 尚未公布 —— 展开必须失败，禁止复制 2026
    },
  });

  // 公告先到（节庆公告到达时活动实例尚未建立）
  const an = svc.createAnnouncement(db, {
    title: '庙方公告：2027 元宵法会日期待定', kind: 'festival',
    body: '本庙 2027 年元宵法会具体公历日期待主管部门批复后另行公告，请勿按往年日期安排。',
    source_url: 'https://example-chenghuang.cn/notice/2027-pending',
  });
  db.update('content', 'announcements', an.id, { status: 'approved' });
  db.update('content', 'announcements', an.id, { status: 'published' });

  // 天气与施工公告（只影响相交时空片段）
  svc.createAnnouncement(db, {
    title: '灯会期间永宁门至城墙段夜间大风提示', kind: 'weather',
    source_url: 'https://weather.example.cn/2027-lantern-wind',
    published_at: '2027-02-20T04:00:00Z',
    effect: { delay_minutes: 10 },
  });
  const wind = db.all('content', 'announcements').find(a => a.kind === 'weather');
  db.update('content', 'announcements', wind.id, {
    status: 'published',
    edge_ids: [edges[`${gate.id}->${wall.id}:walk`].id],
    start_iso: T.localDateToInstant('2027-02-20', '18:30', 'Asia/Shanghai'),
    end_iso: T.localDateToInstant('2027-02-21', '02:00', 'Asia/Shanghai'),
  });
  svc.createAnnouncement(db, {
    title: '钟楼地下通道施工（白天封闭）', kind: 'construction',
    source_url: 'https://chengshi.example.cn/2027-bell-construction',
    effect: { block: true },
  });
  const con = db.all('content', 'announcements').find(a => a.kind === 'construction');
  db.update('content', 'announcements', con.id, {
    status: 'published',
    edge_ids: [edges[`${tower.id}->${square.id}:walk`].id],
    start_iso: T.localDateToInstant('2027-02-20', '08:00', 'Asia/Shanghai'),
    end_iso: T.localDateToInstant('2027-02-20', '18:00', 'Asia/Shanghai'),
  });

  // 2027 已确认的活动实例（城墙灯会，跨午夜）——模拟组织方已正式公布
  const inst = svc.createInstance(db, {
    year: 2027, title: '2027 西安城墙元宵灯会', rule_id: yuanxiaoRule.id, node_id: wall.id,
    start_date: '2027-02-20', start_time: '19:00', tz: 'Asia/Shanghai',
    date_raw: '农历丙午年正月十五 晚七时（庙方/城墙管委会 2026-12-01 公告原文）',
    source: { url_text: 'https://example-citywall.cn/notice/2027-lantern', published_at: '2026-12-01', confidence: 'official' },
    tags: ['灯会', '夜游'],
  });
  svc.confirmInstance(db, inst.id, 'curator-wang', { url_text: 'https://example-citywall.cn/notice/2027-lantern' });
  // 公告（待定那条）在活动正式确认后挂接 —— 公告先到、活动后到
  svc.linkInstanceToAnnouncement(db, an.id, inst.id);

  // 一篇已发布历史文章（用于验证冻结、不被公告改写）
  const art = svc.createArticle(db, {
    slug: 'yuanxiao-2026-review', narrative_year: 2026,
    title: '丙午上元灯会纪盛（2026 年纪实）',
    body: '正月十五夜，城墙灯火连绵……（2026 年的历史叙事，按当时公告与实况记录）',
  });
  svc.publishArticle(db, art.id);

  // 发布 2027 年历（冻结节点/路线/公告/文章版本）
  svc.publishRelease(db, {
    name: '2027 上元节年历（首版）', year: 2027,
    route_ids: [r1.id, r2.id], article_ids: [art.id],
    announcement_ids: [an.id, wind.id], node_ids: [tower.id, temple.id, wall.id, gate.id, square.id],
  });

  db.flushAll();
  server.close();
  return true;
}

if (require.main === module) {
  const dir = process.argv[2] || path.join(__dirname, '..', 'data');
  const did = seed(dir);
  console.log(did ? `已写入种子数据 -> ${dir}` : '数据已存在，跳过');
}
module.exports = { seed };
