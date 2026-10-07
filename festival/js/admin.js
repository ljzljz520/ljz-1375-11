// Review / publish workbench + advisories. Publishing runs the full
// create -> review -> freeze -> publish pipeline so the calendar snapshot
// freezes exact node/edge/announcement versions.

const Admin = (() => {
  async function refresh() {
    const [tasks, advs] = await Promise.all([
      Api.get("/api/publications"), Api.get("/api/advisories"),
    ]);
    document.getElementById("task-list").innerHTML = tasks.map((t) => `
      <li><span><b>${t.title}</b>
        <span class="meta">${t.almanac_year || ""} · ${t.status} · ${t.requested_by}</span></span>
        <span class="mini"><span class="ver">v${t.version}</span></span></li>`).join("")
      || '<li class="hint">暂无任务</li>';
    document.getElementById("adv-list").innerHTML = advs.map((a) => `
      <li><span>${a.severity === "closure" ? "<span class='off'>封闭</span> " : ""}
        <b>${a.title}</b>
        <span class="meta">${a.kind} · ${a.start_local}~${a.end_local}</span></span>
        <span class="mini"><span class="ver">v${a.version}</span></span></li>`).join("");
  }

  function bind() {
    document.getElementById("pub-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const out = document.getElementById("pub-out");
      out.innerHTML = `<p class="hint">建任务 → 审核 → 冻结节点/公告版本 → 发布年历…</p>`;
      try {
        const r = await Api.post("/api/publications",
          { title: f.title.value, year: Number(f.year.value) }, "admin");
        out.innerHTML = `<div class="path ok">发布完成：任务 #${r.task_id}，冻结 ${r.frozen} 项实体。<br>
          <span class="frozen">之后对节点/公告的编辑不会改变本次已发布年历，需再次发布才刷新缓存。</span></div>`;
        toast("已冻结并发布", "ok");
        refresh();
      } catch (err) {
        out.innerHTML = `<div class="path bad">发布失败：${err.message}</div>`;
      }
    };
    document.getElementById("adv-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await Api.post("/api/advisories", {
          slug: f.slug.value, kind: f.kind.value, severity: f.severity.value,
          title: f.title.value,
          scope_edges: f.scope_edges.value.split(",").map((s) => s.trim()).filter(Boolean),
          start_local: f.start_local.value.length === 16
            ? f.start_local.value + ":00" : f.start_local.value,
          end_local: f.end_local.value.length === 16
            ? f.end_local.value + ":00" : f.end_local.value,
        }, "admin");
        toast("通告已发布；仅在相交的连线与时段影响路线", "ok");
        f.reset(); refresh();
      } catch (err) { toast(err.message, "err"); }
    };
  }

  return { bind, refresh };
})();
