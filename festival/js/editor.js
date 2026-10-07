// Editor workbench: nodes, edges (optimistic-lock reconnect), rules,
// announcements. Every list item shows its current version so a concurrent
// editor can detect someone else saved first.

const Editor = (() => {
  async function refresh() {
    const [nodes, edges, rules, anns, routes] = await Promise.all([
      Api.get("/api/nodes"), Api.get("/api/edges"),
      Api.get("/api/rules"), Api.get("/api/announcements"),
      Promise.all((await Api.get("/api/routes")).map(async (r) =>
        Object.assign(r, await Api.get(`/api/routes/${r.id}`)))),
    ]);
    window._cache = { nodes, edges, rules, anns, routes };

    document.getElementById("route-list").innerHTML = routes.map((r) => `
      <li><span><b>${r.name}</b>
        <span class="meta">${r.slug} · ${(r.edge_slugs || []).join(" → ")}</span></span>
        <span class="mini"><span class="ver">v${r.version}</span></span></li>`).join("");

    document.getElementById("node-list").innerHTML = nodes.map((n) => `
      <li><span>${n.status === "offline" ? "<span class='off'>已下线</span> " : ""}
        <b>${n.name}</b> <span class="meta">${n.slug} · ${n.kind}</span></span>
      <span class="mini">
        <span class="ver">v${n.version}</span>
        ${n.status === "online"
          ? `<button data-off="${n.id}" data-v="${n.version}">下线</button>` : ""}
      </span></li>`).join("");

    document.getElementById("edge-list").innerHTML = edges.map((e) => `
      <li><span><b>${e.name}</b>
        <span class="meta">${e.slug}: ${fromName(e.from_node_id)} → ${toName(e.to_node_id)}
        · ${Math.round(e.travel_seconds / 60)}分 · ${e.mode}
        ${e.status === "offline" ? "<span class='off'>已下线</span>" : ""}</span></span>
      <span class="mini"><span class="ver">v${e.version}</span>
        <button data-edit-edge="${e.id}" data-v="${e.version}">改连线</button>
      </span></li>`).join("");

    document.getElementById("rule-list").innerHTML = rules.map((r) => `
      <li><span><b>${r.title}</b> <span class="meta">${r.slug} · ${JSON.parse(r.expression_json).raw || r.expression_json}</span></span>
      <span class="mini"><span class="ver">v${r.version}</span>
        <button data-propose="${r.id}" data-year="2028">提案2028草稿</button></span></li>`).join("");

    document.getElementById("ann-list").innerHTML = anns.map((a) => `
      <li><span><b>${a.title}</b>
        <span class="meta">${a.external_ref || ""} · ${a.announced_at} · ${a.status}</span></span></li>`).join("");

    bindRowActions();

    function fromName(id) { return (nodes.find((n) => n.id === id) || {}).slug; }
    function toName(id) { return (nodes.find((n) => n.id === id) || {}).slug; }
  }

  function bindRowActions() {
    document.querySelectorAll("[data-off]").forEach((b) =>
      b.onclick = async () => {
        try {
          await Api.put(`/api/nodes/${b.dataset.off}/offline`, {},
                        Number(b.dataset.v), "editor");
          toast("节点已下线：所有经过它的路线将不可行", "ok");
          refresh();
        } catch (e) {
          if (e.status === 409) toast("版本冲突：该节点刚被他人修改，请刷新", "err");
          else toast(e.message, "err");
        }
      });

    document.querySelectorAll("[data-edit-edge]").forEach((b) =>
      b.onclick = async () => {
        const from = prompt("新起点节点 slug");
        if (from === null) return;
        const to = prompt("新终点节点 slug");
        if (to === null) return;
        try {
          // If-Match uses the version visible to this editor
          const r = await Api.put(`/api/edges/${b.dataset.editEdge}/reconnect`,
            { from_slug: from, to_slug: to }, Number(b.dataset.v),
            prompt("操作者?", "editor-A") || "editor-A");
          toast(`连线已保存（新版本 v${r.version}）`, "ok");
          refresh();
        } catch (e) {
          if (e.status === 409)
            toast("409：另一位编辑已先保存该连线，请刷新获取新版本再改", "err");
          else toast(e.message, "err");
        }
      });

    document.querySelectorAll("[data-propose]").forEach((b) =>
      b.onclick = async () => {
        try {
          await Api.post(`/api/rules/${b.dataset.propose}/propose`,
            { year: Number(b.dataset.year) });
          toast("已生成待公告草稿（不含具体日期）", "ok");
        } catch (e) {
          toast("提案被拒绝：" + e.message + "（已确认日期不可被周期覆盖）", "err");
        }
      });
  }

  function parseWindows(t) { try { return t.trim() ? JSON.parse(t) : []; }
    catch { throw new Error("窗口JSON格式错误"); } }

  function bind() {
    document.getElementById("node-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await Api.post("/api/nodes", {
          slug: f.slug.value, name: f.name.value, kind: f.kind.value,
          lat: f.lat.value ? Number(f.lat.value) : null,
          lng: f.lng.value ? Number(f.lng.value) : null,
          windows: parseWindows(f.windows.value),
        });
        toast("节点已创建", "ok"); f.reset(); refresh();
      } catch (err) { toast(err.message, "err"); }
    };
    document.getElementById("edge-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await Api.post("/api/edges", {
          slug: f.slug.value, name: f.name.value,
          from_slug: f.from_slug.value, to_slug: f.to_slug.value,
          travel_seconds: Number(f.travel_seconds.value), mode: f.mode.value,
          windows: parseWindows(f.windows.value),
        });
        toast("连线已创建", "ok"); f.reset(); refresh();
      } catch (err) { toast(err.message, "err"); }
    };
    document.getElementById("rule-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await Api.post("/api/rules", {
          slug: f.slug.value, title: f.title.value,
          expression: JSON.parse(f.expression.value),
        });
        toast("周期规则已建立；只允许提案草稿", "ok"); f.reset(); refresh();
      } catch (err) { toast(err.message, "err"); }
    };
    document.getElementById("route-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await Api.post("/api/routes", {
          slug: f.slug.value, name: f.name.value,
          description: f.description.value,
          edge_slugs: JSON.parse(f.edge_slugs.value || "[]"),
        });
        toast("路线已创建（可与其他路线共用连线）", "ok"); f.reset(); refresh();
      } catch (err) { toast(err.message, "err"); }
    };
    document.getElementById("ann-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await Api.post("/api/announcements", {
          external_ref: f.external_ref.value || null,
          title: f.title.value, announced_at: f.announced_at.value,
          source_url: f.source_url.value,
          occurrences: JSON.parse(f.occurrences.value || "[]"),
        }, "ingest");
        toast("公告已录入；所列场次已按来源确认", "ok"); f.reset(); refresh();
      } catch (err) { toast(err.message, "err"); }
    };
  }

  return { bind, refresh };
})();
