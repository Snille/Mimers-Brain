// A list of the projects that exist, under a project field: the memory
// editor's (one project) and a context's (a comma-separated list). Typing a
// new name still works; the list only saves remembering how an old one was
// spelled, which is how "skattjakt" and "skattjakt-2026" ended up apart.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const SHOWN = 12;
let known = null;
let loading = null;

// The Memories page already has the counts from /api/stats and hands them on.
export function setProjects(counts) {
  if (counts && typeof counts === "object") known = counts;
}

function loadProjects() {
  if (known) return Promise.resolve(known);
  loading ||= fetch("/api/stats").then((r) => (r.ok ? r.json() : {}))
    .then((s) => { known = s.projects || {}; return known; })
    .catch(() => ({}))
    .finally(() => { loading = null; });
  return loading;
}

const split = (value) => value.split(",").map((x) => x.trim());

// Chips under `input`, most used first, narrowed by what is being typed. With
// `multiple`, a click completes the name being typed after the last comma;
// without it, a click replaces the value.
export async function attachProjectPicker(input, { multiple = false } = {}) {
  const box = document.createElement("div");
  box.className = "project-picker";
  input.after(box);
  const counts = await loadProjects();
  const all = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  function draw() {
    const parts = (multiple ? split(input.value) : [input.value.trim()]).map((x) => x.toLowerCase());
    let typed = parts[parts.length - 1] || "";
    const chosen = new Set(parts.filter(Boolean));
    // A whole name that exists is a choice, not a search: show the others.
    if (all.some(([name]) => name.toLowerCase() === typed)) typed = "";
    const list = all.filter(([name]) => !chosen.has(name.toLowerCase())
      && name.toLowerCase().includes(typed)).slice(0, SHOWN);
    box.innerHTML = list.map(([name, n]) =>
      `<button type="button" class="chip" data-project="${esc(name)}">📁 ${esc(name)} <b>${n}</b></button>`).join("");
    box.hidden = !list.length;
  }

  // mousedown, not click: it fires before the input loses focus.
  box.addEventListener("mousedown", (event) => {
    const chip = event.target.closest("[data-project]");
    if (!chip) return;
    event.preventDefault();
    if (multiple) {
      const parts = split(input.value).filter(Boolean);
      const last = (parts[parts.length - 1] || "").toLowerCase();
      // Replace a half-typed name; keep a whole one and add after it.
      if (last && !all.some(([name]) => name.toLowerCase() === last)) parts.pop();
      parts.push(chip.dataset.project);
      input.value = `${parts.join(", ")}, `;
    } else {
      input.value = chip.dataset.project;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  });
  input.addEventListener("input", draw);
  draw();
}
