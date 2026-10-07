'use strict';
/* 访客年历：
 *  - 深链筛选（year/node/view）；
 *  - 默认列表（地图为可选/替代）；
 *  - 用 CalendarCore 的序号+令牌守卫，保证“迟到的年历计算结果不覆盖用户当前所选日期”；
 *  - 年历版本号缓存校验，新版本只提示“缓存未更新”，不打断当前视图。
 */
(function () {
  const Core = window.CalendarCore;
  const $ = (id) => document.getElementById(id);
  const years = [2026, 2027, 2028];

  const initial = Core.parseDeepLink(location.search);
  const store = Core.createStore(initial);

  // 模拟网络：偶发高延迟（演示迟到响应不会覆盖当前所选）
  function fetchJSON(url, { min = 120, max = 500 } = {}) {
    const delay = min + Math.floor(Math.random() * (max - min));
    return new Promise((resolve) => setTimeout(() => fetch(url).then(r => r.json()).then(resolve), delay));
  }

  async function loadNodes() {
    const { nodes } = await fetch('/api/nodes').then(r => r.json());
    const sel = $('nodeSel');
    for (const n of nodes.filter(n => n.status !== 'archived')) {
      const o = document.createElement('option');
      o.value = n.id; o.textContent = n.name;
      sel.appendChild(o);
    }
    sel.value = initial.node || '';
  }

  function render(state) {
    const sel = state.selected;
    $('yearSel').value = String(sel.year);
    $('nodeSel').value = sel.node || '';
    $('viewSel').value = sel.view;
    $('shareLink').href = Core.toDeepLink(sel);

    // 深链同步（可收藏/分享），不触发额外加载循环
    history.replaceState(null, '', Core.toDeepLink(sel));

    const list = Core.toListModel(state.items);
    const lv = $('listView'), mv = $('mapView');
    if (sel.view === 'map') { lv.classList.add('hidden'); mv.classList.remove('hidden'); }
    else { lv.classList.remove('hidden'); mv.classList.add('hidden'); }

    lv.innerHTML = '';
    for (const g of list) {
      const card = document.createElement('div');
      card.className = 'day-group';
      card.innerHTML = `<div class="day-head">${g.date}</div>` +
        g.events.map(e => `<div class="event">
            <div><div class="t">${e.title}</div>
              <div class="meta">${e.time_text}（${e.tz}） · 节点 ${e.node_id || '—'}</div></div>
            <div style="text-align:right">
              <span class="tag-ver">来源已确认</span>
              <div class="src">来源：${e.source}</div>
            </div>
          </div>`).join('');
      lv.appendChild(card);
    }
    $('emptyTip').classList.toggle('hidden', state.items.length !== 0);
    $('mapCanvas').innerHTML = state.items.length
      ? state.items.map(i => `📍 ${i.title}`).join('<br>')
      : '（无活动）';

    $('verLabel').textContent = 'v' + state.calendarVersion + (state.loadedToken ? '（已加载）' : '（加载中…）');
    const badge = $('cacheBadge');
    if (state.cacheStale) {
      badge.textContent = `年历已更新到 v${state.serverVersion}，当前为缓存 v${state.calendarVersion}（不会覆盖你正在看的日期）`;
      badge.className = 'badge stale';
    } else {
      badge.classList.add('hidden');
    }
  }

  async function requestCalendar() {
    const sel = store.getState().selected;
    const mySeq = store.select(sel); // 登记最新请求
    const q = new URLSearchParams({ year: String(sel.year) });
    if (sel.node) q.set('node', sel.node);
    q.set('view', sel.view);
    const payload = await fetchJSON(`/api/calendar/${sel.year}?${q.toString()}`, { min: 80, max: 900 });
    const r = store.resolve(mySeq, sel, payload); // 迟到则 applied=false，不覆盖
    if (!r.applied) console.warn('丢弃迟到年历响应（用户已切换日期）', sel);
  }

  // 控件：改变选择即重新请求
  $('yearSel').innerHTML = years.map(y => `<option>${y}</option>`).join('');
  $('yearSel').addEventListener('change', e => change({ year: Number(e.target.value) }));
  $('nodeSel').addEventListener('change', e => change({ node: e.target.value }));
  $('viewSel').addEventListener('change', e => change({ view: e.target.value }));

  function change(patch) {
    const next = { ...store.getState().selected, ...patch };
    store.select(next);
    requestCalendar();
  }

  // 周期性校验年历版本：仅提示缓存过期，不覆盖当前视图
  setInterval(async () => {
    const y = store.getState().selected.year;
    const v = await fetch(`/api/calendar/${y}/version`).then(r => r.json());
    store.noteServerVersion(v.version);
  }, 15000);

  store.subscribe(render);
  loadNodes().then(() => { render(store.getState()); requestCalendar(); });
})();
