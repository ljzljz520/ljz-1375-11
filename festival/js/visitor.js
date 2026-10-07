// Visitor almanac: published snapshot (cached until republish), list/map,
// deep-linked filters, route comparison, and a stale-response guard.

const Visitor = (() => {
  let snapshot = null;
  let activeFilter = Filters.fromLocation();
  // Monotonic token: a slow response from an OLDER request must never overwrite
  // the view for the date the visitor has since selected.
  let loadSeq = 0;
  let selectedYear = activeFilter.year;

  async function load(year, { force = false } = {}) {
    const mySeq = ++loadSeq;
    selectedYear = year;
    setBadge("加载中…", true);
    try {
      const url = `/api/almanac/${year}` + (force ? "?live=1" : "");
      const data = await Api.get(url);
      // stale guard: visitor switched year while the request was in flight
      if (mySeq !== loadSeq || selectedYear !== String(year)) {
        console.info("丢弃迟到的年历响应", year, "seq", mySeq);
        return;
      }
      snapshot = data;
      render();
      setBadge(force ? "实时（未发布缓存）" : "已发布版", false);
    } catch (e) {
      if (e.status === 404) {
        snapshot = { year, instances: [], nodes: [], edges: [], articles: [],
                     routes: [], advisories: [] };
        setBadge("该年尚无发布年历", true);
        render();
      } else toast("年历加载失败：" + e.message, "err");
    }
  }

  function setBadge(text, stale) {
    const b = document.getElementById("cache-badge");
    b.textContent = text;
    b.className = "badge" + (stale ? " stale" : "");
  }

  function render() {
    activeFilter = Filters.fromLocation();
    Filters.applyToForm(document.getElementById("filter-form"), activeFilter);
    const list = document.getElementById("visitor-list");
    const mapWrap = document.getElementById("visitor-map");
    const isMap = activeFilter.view === "map";
    list.hidden = isMap;
    mapWrap.hidden = !isMap;

    const rows = Filters.filterInstances(snapshot.instances || [], activeFilter)
      .filter((i) => {
        if (!activeFilter.kind) return true;
        return (snapshot.nodes || []).some((n) => n.slug === i.slug && n.kind === activeFilter.kind);
      });

    list.innerHTML = rows.length
      ? rows.map(instanceCard).join("")
      : `<p class="hint">没有匹配的活动。未公布年份（如周期提案）不会出现具体日期。</p>`;

    document.getElementById("article-list").innerHTML =
      (snapshot.articles || []).map((a) =>
        `<div class="article"><h3>${esc(a.title)}</h3>
         <small>${a.event_year || ""} · 发布于 ${a.published_at.slice(0, 10)}</small>
         <p>${esc(a.body)}</p></div>`).join("") ||
      '<p class="hint">暂无已发布历史叙事。</p>';

    if (isMap) drawMap(snapshot, rows);
  }

  function instanceCard(i) {
    const cls = i.source_confirmed ? i.status : "draft unconfirmed";
    const label = { draft: "待公告·草稿", confirmed: "公告已确认",
                    published: "已发布", cancelled: "已取消" }[i.status] || i.status;
    return `<div class="instance">
      <h3>${esc(i.title)} <span class="tag ${cls}">${label}</span></h3>
      <div class="meta">
        ${i.start_local ? `🕒 ${esc(i.start_local)} → ${esc(i.end_local || "")}`
                        : "🕒 日期待组织方逐年公告（不沿用去年日期）"}
        &nbsp;·&nbsp;时区 ${esc(i.timezone)}
      </div>
      <div class="meta">原始表达：${esc(i.original_expression || "")}</div>
    </div>`;
  }

  function drawMap(snap) {
    const svg = document.getElementById("map-svg");
    const nodes = snap.nodes || [];
    if (!nodes.length) { svg.innerHTML = "<text x='40' y='60'>暂无节点</text>"; return; }
    const lats = nodes.map((n) => n.lat).filter(Boolean);
    const lngs = nodes.map((n) => n.lng).filter(Boolean);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const pos = (n) => [
      40 + ((n.lng - minLng) / (maxLng - minLng || 1)) * 720,
      360 - ((n.lat - minLat) / (maxLat - minLat || 1)) * 320,
    ];
    const bySlug = Object.fromEntries(nodes.map((n) => [n.slug, n]));
    const lines = (snap.edges || []).map((e) => {
      const a = bySlug[e.from_slug], b = bySlug[e.to_slug];
      if (!a || !b) return "";
      const [x1, y1] = pos(a), [x2, y2] = pos(b);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
        stroke="${e.status === "offline" ? "#b3261e" : "#9c2b23"}"
        stroke-width="2" marker-end="url(#arrow)"/>`;
    }).join("");
    const dots = nodes.map((n) => {
      const [x, y] = pos(n);
      return `<g><circle cx="${x}" cy="${y}" r="7"
        fill="${n.status === "offline" ? "#b3261e" : "#c9a45c"}"
        stroke="#7a1f1f"/><text x="${x + 10}" y="${y + 4}"
        font-size="13">${esc(n.name)}${n.status === "offline" ? "（已下线）" : ""}</text></g>`;
    }).join("");
    svg.innerHTML = `<defs><marker id="arrow" markerWidth="8" markerHeight="8"
        refX="7" refY="3" orient="auto">
        <path d="M0,0 L7,3 L0,6 Z" fill="#9c2b2b"/></marker></defs>${lines}${dots}`;
  }

  // ---- route comparison ---------------------------------------------------
  let compareSeq = 0;
  async function compare(form) {
    const origin = form.origin.value.trim();
    const dest = form.dest.value.trim();
    const start = form.start.value.length === 16
      ? form.start.value + ":00" : form.start.value;
    const pref = form.pref.value;
    const body = { origin, dest, start_local: start };
    let cand = null;
    if (snapshot && snapshot.routes) {
      const r = snapshot.routes.find((r) =>
        r.edge_slugs.length &&
        nodeOf(snapshot, r.edge_slugs[0])?.slug === origin &&
        edgeTail(snapshot, r.edge_slugs) === dest);
      if (r) cand = r.edge_slugs;
    }
    if (cand) body.candidate_edges = cand;
    if (pref === "notransfer") body.preferences = { max_transfers: 0 };
    if (pref === "noshuttle") body.preferences = { allowed_modes: ["walk", "bus", "metro", "ferry"] };

    const mySeq = ++compareSeq;
    const out = document.getElementById("route-out");
    out.innerHTML = `<p class="hint">计算中…（出发 ${esc(start)}）</p>`;
    let res;
    try {
      res = await Api.post("/api/routes/compare", body);
    } catch (e) {
      out.innerHTML = `<p class="hint">计算失败：${esc(e.message)}</p>`;
      return;
    }
    // stale guard for late route computation: if the visitor has since changed
    // the chosen date (a newer request exists), this answer must not overwrite.
    if (mySeq !== compareSeq) {
      console.info("丢弃迟到的路径计算结果 seq", mySeq);
      return;
    }
    out.innerHTML = renderCompare(res);
  }

  function nodeOf(snap, edgeSlug) {
    const e = (snap.edges || []).find((x) => x.slug === edgeSlug);
    return e && (snap.nodes || []).find((n) => n.slug === e.from_slug);
  }
  function edgeTail(snap, slugs) {
    const e = (snap.edges || []).find((x) => x.slug === slugs[slugs.length - 1]);
    return e && e.to_slug;
  }

  function renderCompare(res) {
    const ea = res.earliest_arrival;
    let html = `<div class="path ${ea.feasible ? "ok" : "bad"}">
      <b>最早到达路径</b>：${ea.feasible
        ? `到达 ${esc(ea.arrival)} · 换乘 ${ea.transfers} 次`
        : `不可行（${esc(ea.reason || "")}）`}`;
    html += (ea.steps || []).map(stepHtml).join("");
    html += `</div>`;
    if (res.candidate) {
      const c = res.candidate;
      const hard = (c.conflict_edges || []).filter((x) => x.kind !== "preference");
      html += `<div class="path ${c.feasible ? "ok" : "bad"}">
        <b>偏好候选路径</b>：${c.feasible
          ? `到达 ${esc(c.arrival)} · 换乘 ${c.transfers} 次` +
            (res.arrival_delta_seconds != null
              ? `（比最早到达晚 ${Math.round(res.arrival_delta_seconds / 60)} 分钟）` : "")
          : "不可行"}`;
      html += (c.steps || []).map(stepHtml).join("");
      if (hard.length) {
        html += `<p class="hint" style="color:#b3261e">时间不足/关闭的冲突边：${
          hard.map((h) => `<span class="conflict">${esc(h.edge_slug || "—")}（${esc(h.reason)}）</span>`).join("，")
        }</p>`;
      }
      html += `</div>`;
    }
    return html;
  }

  function stepHtml(s) {
    return `<div class="step">→ <span class="edge">${esc(s.edge_name)}</span>
      [${esc(s.mode)}] ${esc(s.from_slug)} → ${esc(s.to_slug)}
      <span class="meta">${esc(s.depart.slice(11, 16))} 发 / ${esc(s.arrive.slice(11, 16))} 到</span>
      ${s.waited_seconds ? `<span class="wait">等待开放 ${Math.round(s.waited_seconds / 60)} 分钟</span>` : ""}
      ${s.conflict ? `<span class="conflict">${esc(s.conflict)}</span>` : ""}
      ${(s.advisories || []).map((a) => `<span class="adv">${esc(a.title)}</span>`).join("")}
    </div>`;
  }

  function esc(x) {
    return String(x ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function bind() {
    const form = document.getElementById("filter-form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const f = {
        year: form.year.value, kind: form.kind.value, q: form.q.value,
        only_confirmed: form.only_confirmed.checked, view: form.view.value,
      };
      history.replaceState(null, "", "?" + Filters.toQuery(f));
      loadSeq++; // any in-flight older load is now stale
      selectedYear = f.year;
      load(f.year);
    });
    document.getElementById("deep-link").addEventListener("click", async (e) => {
      e.preventDefault();
      const url = location.origin + location.pathname + "?" +
        Filters.toQuery({
          year: form.year.value, kind: form.kind.value, q: form.q.value,
          only_confirmed: form.only_confirmed.checked, view: form.view.value,
        });
      try { await navigator.clipboard.writeText(url); toast("深链已复制：" + url, "ok"); }
      catch { history.replaceState(null, "", url); toast("已写入地址栏", "ok"); }
    });
    document.getElementById("route-form").addEventListener("submit", (e) => {
      e.preventDefault();
      compareSeq++; // invalidate previous comparison before starting new one
      compare(e.target);
    });
    window.addEventListener("popstate", () => { load(Filters.fromLocation().year); });
  }

  return { bind, load, render, get snapshot() { return snapshot; } };
})();
