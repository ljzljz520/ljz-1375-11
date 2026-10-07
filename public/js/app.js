'use strict';
/* 编辑后台：零依赖原生 JS。所有写操作带上 version 做乐观锁；409 时展示冲突。 */
(function () {
  const $ = (id) => document.getElementById(id);
  const state = { role: 'editor', nodes: [], edges: [], instances: [], announcements: [], articles: [] };

  async function api(method, path, body) {
    const opt = { method, headers: { 'X-Role': state.role, 'Content-Type': 'application/json' } };
    if (body) opt.body = JSON.stringify(body);
    const res = await fetch(path, opt);
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data.error || ('HTTP ' + res.status));
      err.status = res.status; err.data = data; throw err;
    }
    return data;
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const winText = (n) => n.window ? `${n.window.open}–${n.window.close}${n.window.close <= n.window.open ? '（跨午夜）' : ''}` : '全天';

  async function refresh() {
    const [nodes, edges, inst, ann, art] = await Promise.all([
      api('GET', '/api/nodes'), api('GET', '/api/edges'),
      api('GET', '/api/instances'), api('GET', '/api/announcements'), api('GET', '/api/articles'),
    ]);
    state.nodes = nodes.nodes; state.edges = edges.edges;
    state.instances = inst.instances; state.announcements = ann.announcements; state.articles = art.articles;
    renderNodes(); renderEdges(); renderSelects(); renderInstances(); renderAnnouncements(); renderArticles();
  }

  function renderSelects() {
    const opts = state.nodes.map(n => `<option value="${n.id}">${esc(n.name)}</option>`).join('');
    ['eFrom', 'eTo', 'pOrigin', 'pDest', 'iNode'].forEach(id => { $(id).innerHTML = '<option value="">—</option>' + opts; });
    $('pRequire').innerHTML = '<option value="">无</option>' + opts;
  }

  function renderNodes() {
    $('nodesBody').innerHTML = state.nodes.map(n => `
      <tr>
        <td><code>${n.id}</code><br><b>${esc(n.name)}</b><br><span class="mut">${esc(n.kind)}</span></td>
        <td>${winText(n)}<br><span class="mut">${esc(n.window_raw || (n.window && n.window.raw) || '')}</span></td>
        <td>v${n.version}</td>
        <td><span class="pill ${n.status}">${n.status}</span></td>
        <td><button onclick="App.editNode('${n.id}')">改名</button>
            <button onclick="App.offline('${n.id}')">下线</button></td>
      </tr>`).join('');
  }

  function renderEdges() {
    const nm = (id) => (state.nodes.find(n => n.id === id) || {}).name || id;
    $('edgesBody').innerHTML = state.edges.map(e => `
      <tr>
        <td><code>${e.id}</code><br>${esc(nm(e.from_id))} → ${esc(nm(e.to_id))}</td>
        <td>${esc(e.mode)}</td>
        <td><input style="width:5rem" id="min-${e.id}" value="${e.travel_minutes}"></td>
        <td>v${e.version}<input type="hidden" id="ver-${e.id}" value="${e.version}"></td>
        <td><button onclick="App.saveEdge('${e.id}')">保存耗时</button></td>
      </tr>`).join('');
  }

  function renderInstances() {
    $('instBody').innerHTML = state.instances.map(i => `
      <tr>
        <td>${i.year} <b>${esc(i.title)}</b></td>
        <td>${esc(i.date_raw)}<br><span class="mut">${i.start_iso} · ${i.tz}</span></td>
        <td class="mut">${esc(i.source && i.source.url_text)}</td>
        <td>${i.verified ? '<span class="pill published">已确认</span>' : '<span class="pill">待确认</span>'}</td>
        <td>${i.verified ? '' : `<button onclick="App.confirmInstance('${i.id}')">来源确认</button>`}</td>
      </tr>`).join('');
  }

  function renderAnnouncements() {
    $('annBody').innerHTML = state.announcements.map(a => `
      <tr>
        <td>${esc(a.title)}${a.linked_instance_id ? ` <span class="pill">实例 ${a.linked_instance_id}</span>` : ''}</td>
        <td>${esc(a.kind)}</td><td><span class="pill ${a.status}">${a.status}</span></td>
        <td>
          ${a.status === 'draft' ? `<button onclick="App.review('${a.id}',true)">通过</button>` : ''}
          ${a.status === 'approved' ? `<button onclick="App.publishAnn('${a.id}')">发布</button>` : ''}
          ${!a.linked_instance_id ? `<button onclick="App.link('${a.id}')">挂接活动</button>` : ''}
        </td>
      </tr>`).join('');
  }

  function renderArticles() {
    $('artBody').innerHTML = state.articles.map(a => `
      <tr>
        <td>${esc(a.title)}<br><span class="mut">${esc(a.slug)}</span></td>
        <td><span class="pill ${a.status}">${a.status}</span></td>
        <td class="mut">${a.frozen_at ? new Date(a.frozen_at).toLocaleString() : '—'}</td>
        <td>${a.status === 'draft'
          ? `<button onclick="App.publishArticle('${a.id}')">发布并冻结</button>`
          : '<span class="mut">已冻结，不可改写</span>'}</td>
      </tr>`).join('');
  }

  function alertErr(e, where) {
    const box = $(where || 'edgeConflict');
    if (e.status === 409 && e.data && e.data.current) {
      box.innerHTML = `<div class="conflict"><b>并发冲突 409：</b>${esc(e.message)}
        <br>服务器当前版本为 <b>v${e.data.current.version}</b>（${e.data.current.id}）。请刷新后基于最新版本重试，你的修改未覆盖他人改动。</div>`;
    } else {
      box.innerHTML = `<div class="conflict"><b>${e.status || '错误'}：</b>${esc(e.message)}</div>`;
    }
  }

  const App = {
    async createNode() {
      const win = $('nOpen').value ? {
        open: $('nOpen').value, close: $('nClose').value || '23:59', tz: $('nTz').value, raw: $('nRaw').value,
      } : null;
      await api('POST', '/api/nodes', {
        name: $('nName').value, kind: $('nKind').value, tz: $('nTz').value,
        window: win, window_raw: $('nRaw').value || null,
      });
      await refresh();
    },
    async editNode(id) {
      const n = state.nodes.find(x => x.id === id);
      const name = prompt('节点新名称（基于 v' + n.version + '）', n.name);
      if (name == null) return;
      await api('PUT', '/api/nodes/' + id, { version: n.version, name });
      await refresh();
    },
    async offline(id) {
      const reason = prompt('下线原因', '活动取消');
      const r = await api('POST', `/api/nodes/${id}/offline`, { reason });
      alert(`已下线。引用该节点的路线：${r.referenced_by_routes.map(x => x.name).join('、') || '无'}`);
      await refresh();
    },

    async createEdge() {
      await api('POST', '/api/edges', {
        from_id: $('eFrom').value, to_id: $('eTo').value, mode: $('eMode').value,
        travel_minutes: Number($('eMin').value),
      });
      await refresh();
    },
    async saveEdge(id) {
      const version = Number($('ver-' + id).value);
      try {
        const r = await api('PUT', '/api/edges/' + id, { version, travel_minutes: Number($('min-' + id).value) });
        $('ver-' + id).value = r.edge.version;
        $('edgeConflict').innerHTML = '<p class="ok">已保存，版本更新为 v' + r.edge.version + '</p>';
      } catch (e) {
        if (e.status === 409) { await refresh(); }
        alertErr(e);
      }
    },

    async earliest() {
      const q = new URLSearchParams({
        origin: $('pOrigin').value, destination: $('pDest').value,
        date: $('pDate').value, time: $('pTime').value,
      });
      try {
        const r = await api('GET', '/api/graph/earliest?' + q);
        showPlan({ earliest: r }, false);
      } catch (e) {
        $('planOut').innerHTML = planConflict(e.data || { error: e.message });
      }
    },
    async compare() {
      try {
        const r = await api('POST', '/api/graph/compare', {
          origin_id: $('pOrigin').value, destination_id: $('pDest').value,
          start_date: $('pDate').value, start_time: $('pTime').value,
          allow_modes: $('pModes').value ? $('pModes').value.split(',').map(s => s.trim()) : undefined,
          require_nodes: $('pRequire').value ? [$('pRequire').value] : [],
        });
        showPlan(r, true);
      } catch (e) { $('planOut').innerHTML = planConflict(e.data || { error: e.message }); }
    },

    async createInstance() {
      $('iWarn').textContent = '';
      try {
        await api('POST', '/api/instances', {
          year: Number($('iYear').value), title: $('iTitle').value, node_id: $('iNode').value || null,
          start_date: $('iDate').value, start_time: $('iTime').value, tz: $('iTz').value,
          date_raw: $('iRaw').value || '', source: { url_text: $('iSrc').value },
        });
        await refresh();
      } catch (e) { $('iWarn').textContent = e.message; }
    },
    async confirmInstance(id) {
      const src = prompt('请粘贴你核对的组织方公告 URL（确认动作显式留痕）');
      if (!src) return;
      await api('POST', `/api/instances/${id}/confirm`, { source: { url_text: src } });
      await refresh();
    },

    async createAnn() {
      await api('POST', '/api/announcements', { title: $('aTitle').value, kind: $('aKind').value, source_url: $('aSrc').value });
      await refresh();
    },
    async review(id, approve) {
      await api('POST', `/api/announcements/${id}/review`, { approve, note: '' });
      await refresh();
    },
    async publishAnn(id) { await api('POST', `/api/announcements/${id}/publish`, {}); await refresh(); },
    async link(id) {
      const instance_id = prompt('输入要挂接的年度实例 ID', state.instances[0] && state.instances[0].id);
      if (instance_id) { await api('POST', `/api/announcements/${id}/link`, { instance_id }); await refresh(); }
    },

    async createArticle() {
      await api('POST', '/api/articles', { slug: $('arSlug').value, title: $('arTitle').value, body: $('arBody').value });
      await refresh();
    },
    async publishArticle(id) { await api('POST', `/api/articles/${id}/publish`, {}); await refresh(); },

    async publish() {
      const node_ids = state.nodes.map(n => n.id);
      const routes = await api('GET', '/api/routes');
      try {
        const r = await api('POST', '/api/releases', {
          name: $('relName').value, year: Number($('relYear').value),
          node_ids, route_ids: routes.routes.map(x => x.id),
          announcement_ids: state.announcements.filter(a => a.status === 'published').map(a => a.id),
          article_ids: state.articles.filter(a => a.status === 'published').map(a => a.id),
        });
        const rel = r.release;
        $('relOut').innerHTML = `<div class="ok">已发布 ${esc(rel.name)}：年历版本已推进。
          <br>冻结节点 ${rel.frozen_versions.nodes.length}、路线 ${rel.frozen_versions.routes.length}、公告 ${rel.frozen_versions.announcements.length}、文章 ${rel.frozen_versions.articles.length}。
          ${rel.unconfirmed_instances.length ? `<div class="conflict">未纳入（未经来源确认）：${rel.unconfirmed_instances.map(x => esc(x.title)).join('、')}</div>` : ''}
        </div>`;
      } catch (e) { $('relOut').innerHTML = planConflict({ error: e.message }); }
      await refresh();
    },
  };

  function segTable(p) {
    if (!p || !p.segments) return '<p class="mut">无路径</p>';
    return `<table><thead><tr><th>边/方式</th><th>出发</th><th>实际到达</th><th>等待</th><th>天气/施工</th></tr></thead><tbody>
      ${p.segments.map(s => `<tr>
        <td><code>${s.edge_id}</code> ${esc(s.mode)}（${s.travel_minutes}分）</td>
        <td>${esc(s.depart_local || '')}</td>
        <td>${esc(s.arrive_local)}${s.wait_minutes ? `<div class="mut">早到，等窗 ${s.wait_minutes} 分</div>` : ''}</td>
        <td>${s.wait_minutes || 0}</td>
        <td>${(s.notices || []).map(n => esc(n.title)).join('<br>') || '—'}</td></tr>`).join('')}
    </tbody></table>`;
  }
  function showPlan(r, cmp) {
    const e = cmp ? '' : '';
    $('planOut').innerHTML = `
      <h4>最早到达路径 ${r.earliest.feasible ? '' : '（不可行）'}</h4>
      <p>到达：<b>${esc(r.earliest.arrival_local || r.earliest.error)}</b> ${r.earliest.total_minutes != null ? `总耗时 ${r.earliest.total_minutes} 分` : ''}</p>
      ${segTable(r.earliest)}
      ${cmp ? `<h4>偏好约束路径</h4>
        <p>到达：<b>${esc(r.preferred.arrival_local || r.preferred.error)}</b>；相对最早 ${r.extra_delay_minutes === 0 ? '同时到达' : '增加 ' + r.extra_delay_minutes + ' 分'}；
        ${r.preferred.meets_required ? '满足必经节点' : `<span class="err">未满足必经：${(r.preferred.missing_required||[]).join(',')}</span>`}</p>
        ${segTable(r.preferred)}` : ''}`;
  }
  function planConflict(d) {
    if (d.conflicts && d.conflicts.length) {
      return d.conflicts.map(c => `<div class="conflict"><b>冲突边 <code>${esc(c.edge_id)}</code>（${esc(c.mode || '')}）</b><br>
        抵达 ${esc(c.arrival_local || '')}，${esc(c.reason)}</div>`).join('') + (d.trace ? `<div class="mut">已走片段：${d.trace.map(t => t.edge_id).join(' → ') || '（第一步即冲突）'}</div>` : '');
    }
    return `<div class="conflict">${esc(d.error || '不可行')}</div>`;
  }

  // tabs
  document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach(x => x.classList.remove('on'));
    document.querySelectorAll('.panel').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    $('panel-' + b.dataset.tab).classList.add('on');
  }));
  $('roleSel').addEventListener('change', e => { state.role = e.target.value; });
  window.App = App;
  refresh().catch(e => console.error(e));
})();
