'use strict';
/**
 * 路线图引擎
 * 节点 = 仪式节点（有开放窗口 window，可跨午夜）或交通换乘点（无 window=全天可达）。
 * 有向边 = 移动，带 travel_minutes 与交通方式 mode。
 * 比较两条结果：
 *   - earliest：时间相关的最短路（可在窗口前等待），即“最早到达路径”；
 *   - preferred：偏好约束（交通方式白/黑名单、节点白名单、必经节点）下的候选路径。
 * 可行性：抵达某节点时其当天窗口已关闭 => 不可行，指出第一条冲突边（含要求抵达时间与窗口）。
 */
const T = require('./time');

function buildGraph(db) {
  const nodes = Object.fromEntries(db.all('content', 'nodes').filter(n => n.status !== 'archived').map(n => [n.id, n]));
  const edges = db.all('content', 'edges').filter(e => e.status === 'active');
  const adj = new Map();
  for (const n of Object.keys(nodes)) adj.set(n, []);
  for (const e of edges) {
    if (!nodes[e.from_id] || !nodes[e.to_id]) continue; // 节点下线/引用悬空边自动剔除
    if (!adj.has(e.from_id)) adj.set(e.from_id, []);
    adj.get(e.from_id).push(e);
  }
  return { nodes, edges, adj };
}

/** 实例级窗口覆盖：节庆当天组织方可公布特殊开放窗口（{date,open,close,tz,raw}）。 */
function effectiveWindow(node, dateOverride) {
  if (dateOverride && dateOverride.node_windows && dateOverride.node_windows[node.id]) {
    return { ...node.window, ...dateOverride.node_windows[node.id] };
  }
  return node.window || null;
}

function arriveTarget(entryMs, edge) {
  return entryMs + edge.travel_minutes * T.MS;
}

/**
 * 沿一条边松弛，返回 {ok, arrivalMs, entryMs, waitMs, conflict}。
 * 规则：到得早(before_open) => 等待至开窗（可行）；当天已关(after_close) => 冲突边（不可行）。
 */
function relaxEdge(graph, edge, startMs, ctx) {
  const target = graph.nodes[edge.to_id];
  const arrivalMs = arriveTarget(startMs, edge);
  const win = effectiveWindow(target, ctx.dateOverride);
  const tz = (win && win.tz) || target.tz || ctx.tz;
  const rw = T.resolveWindow(arrivalMs, tz, win);
  if (!rw) return { ok: true, arrivalMs, enterMs: arrivalMs, waitMs: 0, window: null };
  if (rw.state === 'open') return { ok: true, arrivalMs, enterMs: arrivalMs, waitMs: 0, window: rw };
  if (rw.state === 'before_open') {
    return { ok: true, arrivalMs: rw.openMs, enterMs: rw.openMs, waitMs: rw.openMs - arrivalMs, window: rw, waited: true };
  }
  // after_close：错过当天开放窗口
  return {
    ok: false, arrivalMs, enterMs: null, waitMs: 0, window: rw,
    conflict: {
      edge_id: edge.id,
      from_id: edge.from_id,
      to_id: edge.to_id,
      mode: edge.mode,
      arrival_iso: new Date(arrivalMs).toISOString(),
      arrival_local: T.instantToLocal(new Date(arrivalMs).toISOString(), tz).text,
      window_close_iso: new Date(rw.missed_close_ms || rw.closeMs).toISOString(),
      window_close_local: T.instantToLocal(new Date(rw.missed_close_ms || rw.closeMs).toISOString(), tz).text,
      window_open_local: T.instantToLocal(new Date(rw.openMs).toISOString(), tz).text,
      reason: `沿 ${edge.id}（${edge.mode}）抵达 ${target.name || edge.to_id} 时为 ` +
              `${T.instantToLocal(new Date(arrivalMs).toISOString(), tz).text}，已错过当日开放窗口（截止 ${T.instantToLocal(new Date(rw.missed_close_ms || rw.closeMs).toISOString(), tz).text}）`,
    },
  };
}

/**
 * 时间相关 Dijkstra：以“最早可进入下一节点的绝对时刻”为距离。
 * @param edgeFilter (edge)=>bool 偏好约束过滤
 * @param requireNodes 必须经过的节点（偏好）
 */
function earliestPath(graph, opts) {
  const { originId, destinationId, startIso, edgeFilter = () => true, requireNodes = [], dateOverride = null, tz = 'Asia/Shanghai' } = opts;
  const ctx = { dateOverride, tz };
  if (!graph.nodes[originId]) return { feasible: false, error: `起点 ${originId} 不存在或已下线` };
  if (!graph.nodes[destinationId]) return { feasible: false, error: `终点 ${destinationId} 不存在或已下线` };

  const startMs = new Date(startIso).getTime();
  const dist = new Map();
  const prev = new Map(); // nodeId -> {edge, entryMs, waitMs}
  const visited = new Set();
  dist.set(originId, startMs);

  while (true) {
    let u = null;
    for (const [id, d] of dist) {
      if (!visited.has(id) && (u === null || d < dist.get(u))) u = id;
    }
    if (u === null) break;
    visited.add(u);
    if (u === destinationId) break;
    const du = dist.get(u);
    for (const edge of (graph.adj.get(u) || [])) {
      if (!edgeFilter(edge)) continue;
      const v = edge.to_id;
      if (visited.has(v)) continue;
      const r = relaxEdge(graph, edge, du, ctx);
      if (!r.ok) continue; // 不可行的边不参与最早到达扩展（冲突边由 evaluatePlan 报告）
      const cand = r.enterMs;
      if (!dist.has(v) || cand < dist.get(v)) {
        dist.set(v, cand);
        prev.set(v, { edge, entryMs: cand, waitMs: r.waitMs, waited: r.waited, window: r.window });
      }
    }
  }

  if (!dist.has(destinationId)) {
    return { feasible: false, error: '在约束下不存在可达路径（可能因节点下线、窗口关闭或方式过滤）' };
  }

  const chain = [];
  let cur = destinationId;
  while (cur !== originId) {
    const p = prev.get(cur);
    if (!p) return { feasible: false, error: '路径回溯失败' };
    chain.unshift({ node_id: cur, edge: p.edge, enter_ms: p.entryMs, wait_ms: p.waitMs, waited: p.waited });
    cur = p.edge.from_id;
  }
  const missing = requireNodes.filter(id => id !== originId && id !== destinationId &&
    !chain.some(s => s.node_id === id));
  let departMs = startMs;
  const segments = chain.map((s) => {
    const segDepartMs = departMs;
    const rawArrivalMs = segDepartMs + s.edge.travel_minutes * T.MS;
    const seg = {
      edge_id: s.edge.id,
      from_id: s.edge.from_id,
      to_id: s.edge.to_id,
      mode: s.edge.mode,
      travel_minutes: s.edge.travel_minutes,
      depart_iso: new Date(segDepartMs).toISOString(),
      depart_local: T.instantToLocal(new Date(segDepartMs).toISOString(), tz).text,
      raw_arrival_iso: new Date(rawArrivalMs).toISOString(),
      raw_arrival_local: T.instantToLocal(new Date(rawArrivalMs).toISOString(), tz).text,
      arrive_iso: new Date(s.enter_ms).toISOString(),
      arrive_local: T.instantToLocal(new Date(s.enter_ms).toISOString(), tz).text,
      wait_minutes: Math.round(s.wait_ms / T.MS),
    };
    departMs = s.enter_ms; // 下一跳从“进入本节点”时刻出发
    return seg;
  });
  return {
    feasible: true,
    meets_required: missing.length === 0,
    missing_required: missing,
    arrival_iso: new Date(dist.get(destinationId)).toISOString(),
    arrival_local: T.instantToLocal(new Date(dist.get(destinationId)).toISOString(), tz).text,
    total_minutes: Math.round((dist.get(destinationId) - startMs) / T.MS),
    node_sequence: [originId, ...chain.map(c => c.node_id)],
    segments,
  };
}

/**
 * 可行性判定：按给定边序列（编辑指定的候选路线）逐步模拟，时间不足即报第一条冲突边。
 */
function evaluatePlan(graph, opts) {
  const { originId, startIso, edges: planEdges, dateOverride = null, tz = 'Asia/Shanghai' } = opts;
  const ctx = { dateOverride, tz };
  if (!graph.nodes[originId]) return { feasible: false, conflicts: [{ reason: `起点 ${originId} 不存在或已下线` }] };
  let cur = originId;
  let ms = new Date(startIso).getTime();
  const trace = [];
  const conflicts = [];
  for (const edgeId of planEdges) {
    const edge = (graph.adj.get(cur) || []).find(e => e.id === edgeId);
    if (!edge) {
      const raw = { id: edgeId };
      conflicts.push({ edge_id: edgeId, from_id: cur, reason: `边 ${edgeId} 不存在、方向不符，或其端点节点已下线` });
      break;
    }
    const r = relaxEdge(graph, edge, ms, ctx);
    trace.push({
      edge_id: edge.id, from_id: edge.from_id, to_id: edge.to_id, mode: edge.mode,
      travel_minutes: edge.travel_minutes,
      raw_arrival_local: T.instantToLocal(new Date(r.arrivalMs).toISOString(), tz).text,
      enter_local: r.enterMs ? T.instantToLocal(new Date(r.enterMs).toISOString(), tz).text : null,
      wait_minutes: Math.round((r.waitMs || 0) / T.MS),
    });
    if (!r.ok) {
      conflicts.push(r.conflict);
      break;
    }
    ms = r.enterMs;
    cur = edge.to_id;
  }
  return {
    feasible: conflicts.length === 0,
    conflicts,
    trace,
    end_node_id: cur,
    end_local: T.instantToLocal(new Date(ms).toISOString(), tz).text,
  };
}

/**
 * 比较“最早到达路径”与“偏好约束下的候选路径”。
 * 偏好：allowModes/denyModes/allowNodes/requireNodes。
 */
function comparePaths(graph, opts) {
  const earliest = earliestPath(graph, opts);
  const { allowModes, denyModes, allowNodes, requireNodes = [] } = opts;
  const edgeFilter = (e) =>
    (!allowModes || allowModes.includes(e.mode)) &&
    !(denyModes || []).includes(e.mode) &&
    (!allowNodes || (allowNodes.includes(e.from_id) && allowNodes.includes(e.to_id)));
  const preferred = earliestPath(graph, { ...opts, edgeFilter, requireNodes });
  return {
    earliest,
    preferred,
    preference: { allowModes, denyModes, allowNodes, requireNodes },
    preferred_is_earliest: earliest.feasible && preferred.feasible &&
      earliest.arrival_iso === preferred.arrival_iso &&
      JSON.stringify(earliest.node_sequence) === JSON.stringify(preferred.node_sequence),
    extra_delay_minutes: earliest.feasible && preferred.feasible
      ? preferred.total_minutes - earliest.total_minutes : null,
  };
}

/**
 * 天气/施工公告只影响“时空相交”的片段：
 * notice: {edge_ids?|node_ids?|area, start_iso, end_iso, effect:{block?:bool, delay_minutes?:n}}
 * 返回每段是否受影响；不相交片段不标注，叙事不重写。
 */
function intersectNotices(segments, notices) {
  return segments.map((seg) => {
    const enterMs = new Date(seg.depart_iso || seg.arrive_iso).getTime();
    const arriveMs = new Date(seg.arrive_iso).getTime();
      const hit = [];
      for (const n of notices) {
        if (n.status && n.status !== 'published') continue;
        const s = new Date(n.start_iso).getTime();
        const e = new Date(n.end_iso).getTime();
        const space = (!n.edge_ids && !n.node_ids) ||
          (n.edge_ids || []).includes(seg.edge_id) ||
          (n.node_ids || []).includes(seg.to_id) ||
          (n.node_ids || []).includes(seg.from_id);
        const time = arriveMs > s && enterMs < e; // 时间区间相交
        if (space && time) hit.push({ announcement_id: n.id, kind: n.kind, title: n.title, effect: n.effect });
      }
      return { ...seg, notices: hit };
    });
}

module.exports = { buildGraph, effectiveWindow, relaxEdge, earliestPath, evaluatePlan, comparePaths, intersectNotices };
