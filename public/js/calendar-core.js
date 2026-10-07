/* 纯逻辑（可被 node 直接单测）：
 *  - 解析深链筛选参数；
 *  - 处理年历响应与本地缓存版本；
 *  - “迟到的异步计算结果不得覆盖用户当前所选日期”：用请求序号 + 日期令牌守卫。
 */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CalendarCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  function parseDeepLink(search) {
    const p = new URLSearchParams(search || '');
    return {
      year: p.get('year') ? Number(p.get('year')) : new Date().getFullYear(),
      node: p.get('node') || '',
      tag: p.tag ? p.get('tag') : '',
      view: p.get('view') === 'map' ? 'map' : 'list', // 默认列表，可深链切 map
    };
  }

  function toDeepLink(state) {
    const p = new URLSearchParams();
    p.set('year', String(state.year));
    if (state.node) p.set('node', state.node);
    if (state.tag) p.set('tag', state.tag);
    if (state.view === 'map') p.set('view', 'map');
    return '?' + p.toString();
  }

  /**
   * 年历状态机。selectDate/setFilter 立即推进 selectedToken；
   * 迟到的旧响应若 token/seq 不匹配，则只进入 stale 队列，绝不覆盖当前视图。
   */
  function createStore(initial) {
    let state = {
      selected: initial,            // {year,node,tag,view}
      items: [],
      calendarVersion: 0,
      loadedToken: null,            // 已渲染数据对应的令牌
      pending: null,
    };
    const listeners = [];
    let seq = 0;
    const inflight = new Map();     // seq -> token
    const lateQueue = [];           // 迟到但未采用的响应

    const tokenOf = (sel) => JSON.stringify(sel);
    const emit = () => listeners.forEach(fn => fn(state));

    return {
      subscribe(fn) { listeners.push(fn); },
      getState() { return state; },

      select(next) {
        state = { ...state, selected: next, pending: tokenOf(next) };
        seq += 1;
        const mySeq = seq;
        inflight.set(mySeq, tokenOf(next));
        emit();
        return mySeq;
      },

      /** 异步响应到达。返回 {applied:boolean}；迟到/过期响应 applied=false 且不改 state。 */
      resolve(mySeq, requestedSel, payload, nowVersion) {
        const wantToken = inflight.get(mySeq);
        const currentToken = tokenOf(state.selected);
        inflight.delete(mySeq);
        // 请求不是最新的，或用户在此期间改了所选日期 => 迟到结果，拒绝覆盖
        if (wantToken === undefined || mySeq !== seq || wantToken !== currentToken) {
          lateQueue.push({ mySeq, requestedSel, payload } );
          emit();
          return { applied: false, reason: 'stale_selection' };
        }
        state = {
          ...state,
          items: payload.items || [],
          calendarVersion: payload.calendar_version || nowVersion || 0,
          loadedToken: wantToken,
          pending: null,
        };
        emit();
        return { applied: true };
      },

      /** 后台轮询发现年历版本号比缓存新：仅提示“缓存年历未更新”，不强制覆盖。 */
      noteServerVersion(v) {
        const stale = v > state.calendarVersion;
        state = { ...state, serverVersion: v, cacheStale: stale };
        emit();
        return stale;
      },

      lateResponses() { return lateQueue.slice(); },
    };
  }

  /** 列表视图模型：把活动按日期分组（替代地图），保留原始表达与时区。 */
  function toListModel(items) {
    const groups = new Map();
    for (const it of items) {
      const key = it.start_date || '日期待定';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        id: it.id, title: it.title, node_id: it.node_id,
        time_text: it.date_raw || `${it.start_date} ${it.start_time}`,
        tz: it.tz, source: it.source && it.source.url_text, verified: it.verified,
      });
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, events]) => ({ date, events }));
  }

  return { parseDeepLink, toDeepLink, createStore, toListModel };
});
