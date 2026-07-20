// Minimal tab controller. Shows/hides <section data-tab> panels and toggles the
// active nav button. No framework — just class toggles.

export function initTabs(onChange) {
  const buttons = [...document.querySelectorAll("[data-tab-btn]")];
  const panels = [...document.querySelectorAll("[data-tab]")];

  function activate(name) {
    for (const b of buttons) b.classList.toggle("active", b.dataset.tabBtn === name);
    for (const p of panels) p.hidden = p.dataset.tab !== name;
    if (onChange) onChange(name);
  }

  for (const b of buttons) {
    b.addEventListener("click", () => activate(b.dataset.tabBtn));
  }

  // Deep-link via hash (#stats etc.)
  const initial = location.hash.replace("#", "") || "monitor";
  activate(buttons.some((b) => b.dataset.tabBtn === initial) ? initial : "monitor");
  return { activate };
}
