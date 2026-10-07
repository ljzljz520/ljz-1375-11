// Frontend-contract tests (pure logic, no browser):
//  - visitor filters deep-link roundtrip + list-mode filtering
//  - stale response must not overwrite the currently selected date

const assert = require("assert");

// --- mirror of Filters (kept in sync with festival/js/api.js) ---------------
function makeFilters() {
  return {
    fromLocation(search) {
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
}

// --- stale guard mirroring Visitor.load's compareSeq logic ------------------
function makeLoader() {
  let seq = 0, selected = "2027", rendered = null;
  function request(year, delay) {
    const my = ++seq;
    return new Promise((resolve) => setTimeout(() => {
      if (my !== seq || selected !== String(year)) {
        resolve({ stale: true, year, my });      // dropped, no render
      } else {
        rendered = year;
        resolve({ stale: false, year, my });
      }
    }, delay));
  }
  function select(year) { selected = year; seq++; }
  return { request, select, get rendered() { return rendered; } };
}

async function main() {
  const F = makeFilters();

  // 1. deep link round trip
  const qs = F.toQuery({ year: "2027", q: "灯会", only_confirmed: true,
                         view: "list", kind: "" });
  const back = F.fromLocation("?" + qs);
  assert.equal(back.year, "2027");
  assert.equal(back.q, "灯会");
  assert.equal(back.only_confirmed, true);
  assert.equal(back.view, "list"); // list replaces map, not the reverse

  // 2. list filtering hides unconfirmed drafts
  const inst = [
    { slug: "a", title: "元宵节灯会", status: "published",
      original_expression: "2027年2月20日" },
    { slug: "b", title: "2028待公告", status: "draft",
      original_expression: "待公告" },
  ];
  assert.equal(F.filterInstances(inst, back).length, 1);
  assert.equal(F.filterInstances(inst, { ...back, q: "社火" }).length, 0);
  assert.equal(
    F.filterInstances(inst, { year: "2027", q: "", only_confirmed: false,
                              view: "list" }).length, 2);

  // 3. late response must not overwrite the currently selected year
  const L = makeLoader();
  const slow = L.request("2026", 30);   // started first, slow
  const fast = L.request("2027", 5);    // user then picked 2027
  const [rSlow, rFast] = await Promise.all([slow, fast]);
  assert.equal(rFast.stale, false);
  assert.equal(rSlow.stale, true);      // 2026 answer arrives late -> dropped
  assert.equal(L.rendered, "2027");     // current selection preserved

  // 4. explicit select() invalidates in-flight, as app.js does on submit
  const L2 = makeLoader();
  const p1 = L2.request("2027", 30);
  L2.select("2028");
  const p2 = L2.request("2028", 5);
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a.stale, true);
  assert.equal(b.stale, false);
  assert.equal(L2.rendered, "2028");

  console.log("frontend.test.js: all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
