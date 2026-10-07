// Tiny fetch wrapper. Every mutating request carries the optimistic-lock
// version in If-Match. Stale writes surface as HTTP 409.
const Api = (() => {
  async function req(method, url, body, headers = {}) {
    const opt = { method, headers: { ...headers } };
    if (body !== undefined) {
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(body);
    }
    const r = await fetch(url, opt);
    const text = await r.text();
    const data = text ? JSON.parse(text) : {};
    if (!r.ok) {
      const e = new Error(data.error || r.statusText);
      e.status = r.status;
      throw e;
    }
    return data;
  }
  return {
    get: (u) => req("GET", u),
    post: (u, b, actor = "editor") => req("POST", u, b, { "X-Actor": actor }),
    put: (u, b, version, actor = "editor") =>
      req("PUT", u, b, { "If-Match": String(version), "X-Actor": actor }),
  };
})();

function toast(msg, kind = "") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3200);
}

// ---- deep-link filter helpers (pure; unit-tested in tests/filters.test.js) ---
const Filters = {
  fromLocation(search = location.search) {
    const p = new URLSearchParams(search);
    return {
      year: p.get("year") || "2027",
      kind: p.get("kind") || "",
      q: p.get("q") || "",
      only_confirmed: p.get("only_confirmed") === "1",
      view: p.get("view") === "map" ? "map" : "list",
    };
  },
  toQuery(f) {
    const p = new URLSearchParams();
    Object.entries(f).forEach(([k, v]) => {
      if (v === true) p.set(k, "1");
      else if (v !== "" && v !== false && v != null) p.set(k, v);
    });
    return p.toString();
  },
  applyToForm(form, f) {
    if (!form) return;
    form.year.value = f.year;
    form.kind.value = f.kind;
    form.q.value = f.q;
    form.only_confirmed.checked = f.only_confirmed;
    form.view.value = f.view;
  },
  // visitor-side filtering over the published almanac snapshot
  filterInstances(instances, f) {
    const q = f.q.trim();
    return instances.filter((i) => {
      if (f.only_confirmed && !["confirmed", "published"].includes(i.status))
        return false;
      if (q && !(i.title.includes(q) || (i.original_expression || "").includes(q)))
        return false;
      return true;
    });
  },
};
