document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".tab").forEach((tab) =>
    tab.onclick = () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
      tab.classList.add("active");
      const v = document.getElementById("view-" + tab.dataset.view);
      v.hidden = false;
      if (tab.dataset.view === "editor") Editor.refresh();
      if (tab.dataset.view === "admin") Admin.refresh();
    });

  Visitor.bind();
  Editor.bind();
  Admin.bind();
  Visitor.load(Filters.fromLocation().year);
});
