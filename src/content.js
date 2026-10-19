// Applies settings as classes on <html> so CSS does the hiding.
// Runs at document_start, so it must not touch document.body.
let ttSettings = TT_DEFAULTS;

function ttApply(settings) {
  ttSettings = settings;
  for (const key of Object.keys(TT_DEFAULTS)) {
    document.documentElement.classList.toggle("tt-" + key, Boolean(settings[key]));
  }
  ttInject();
  ttStripTitle();
}

// 24x24 icon paths for the links injected into the left nav.
const TT_ICONS = {
  navBookmarks: "M4 4.5C4 3.12 5.12 2 6.5 2h11C18.88 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5zM6.5 4c-.28 0-.5.22-.5.5v14.56l6-4.29 6 4.29V4.5c0-.28-.22-.5-.5-.5h-11z",
  navLists: "M3 4.5C3 3.12 4.12 2 5.5 2h13C19.88 2 21 3.12 21 4.5v15c0 1.38-1.12 2.5-2.5 2.5h-13C4.12 22 3 20.88 3 19.5v-15zM5.5 4c-.28 0-.5.22-.5.5v15c0 .28.22.5.5.5h13c.28 0 .5-.22.5-.5v-15c0-.28-.22-.5-.5-.5h-13zM16 10H8V8h8v2zm-8 2h8v2H8v-2z",
  navJobs: "M9 3h6a2 2 0 012 2v2h3a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V9a2 2 0 012-2h3V5a2 2 0 012-2zm0 2v2h6V5H9zM4 9v10h16V9H4z",
  navCommunities: "M9 11a4 4 0 100-8 4 4 0 000 8zm0-2a2 2 0 110-4 2 2 0 010 4zm8 2a3 3 0 100-6 3 3 0 000 6zM1 21c0-3.9 3.1-7 8-7s8 3.1 8 7H1zm2.2-2h11.6c-.5-2-2.2-3-5.8-3s-5.3 1-5.8 3zM17 14c3 0 6 1.5 6 5v2h-4v-2c0-1.4-.4-2.7-1.2-3.7-.2-.1-.5-.3-.8-.3z",
  navVerifiedOrgs: "M12 2L4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3zm0 2.1l6 2.2V11c0 4-2.6 7.7-6 8.9-3.4-1.2-6-4.9-6-8.9V6.3l6-2.2zm-1 11.4l-3-3 1.4-1.4 1.6 1.6 3.6-3.6L15 10.5l-5 5z",
};

// The clone has no React handlers, so a plain click would reload the page. Push the URL and fire popstate
// so X's router switches views in place; modified clicks (new tab etc.) keep the default behaviour.
function ttNavigate(e, href) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  history.pushState({}, "", href);
  window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
}

// X draws hover/pressed feedback from JS, which the clone lacks. Reproduce it with the label's text colour
// (dark text on light themes, light text on dark ones) at 10% on hover and 20% while pressed.
function ttAddFeedback(link) {
  const inner = link.firstElementChild || link;
  const label = link.querySelector('[dir="ltr"]') || link;
  const set = (pct) => {
    inner.style.backgroundColor = pct
      ? "color-mix(in srgb, " + getComputedStyle(label).color + " " + pct + "%, transparent)"
      : "";
  };
  link.addEventListener("mouseenter", () => set(10));
  link.addEventListener("mouseleave", () => set(0));
  link.addEventListener("mousedown", () => set(20));
  link.addEventListener("mouseup", () => set(10));
}

// Adds or removes the links for options with "inject". Clones a native nav link so X's styling applies.
function ttInject() {
  const nav = document.querySelector('header[role="banner"] nav');
  const template = nav?.querySelector('[data-testid="AppTabBar_Explore_Link"]');
  const more = nav?.querySelector('[data-testid="AppTabBar_More_Menu"]');
  const user = nav?.querySelector('[data-testid="AppTabBar_Profile_Link"]')?.getAttribute("href");
  if (!template || !more || !user) return;
  for (const section of TT_SECTIONS) {
    for (const { key, label, inject } of section.options) {
      if (!inject) continue;
      const existing = nav.querySelector('[data-tt-inject="' + key + '"]');
      if (ttSettings[key]) {
        existing?.remove();
        continue;
      }
      if (existing) continue;
      const link = template.cloneNode(true);
      link.removeAttribute("data-testid");
      link.setAttribute("data-tt-inject", key);
      const href = inject.replace("{user}", user);
      link.setAttribute("href", href);
      link.addEventListener("click", (e) => ttNavigate(e, href));
      ttAddFeedback(link);
      link.setAttribute("aria-label", label);
      link.removeAttribute("aria-current");
      link.querySelector("svg path")?.setAttribute("d", TT_ICONS[key]);
      // X omits label spans entirely in its icon-only nav layout.
      const text = link.querySelector("span");
      if (text) text.textContent = label;
      more.before(link);
    }
  }
}

// The unread count X prefixes to the tab title, e.g. "(3) Home / X".
function ttStripTitle() {
  if (!ttSettings.hideBadges) return;
  const clean = document.title.replace(/^\(\d+\+?\)\s*/, "");
  if (clean !== document.title) document.title = clean;
}

ttLoadSettings().then(ttApply);

// Changes made in the popup apply immediately, without a page reload.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "sync") ttLoadSettings().then(ttApply);
});

// X re-renders the nav (and drops our links), so re-inject after DOM changes. Cheap no-op when nothing is missing.
let ttQueued = false;
new MutationObserver(() => {
  if (ttQueued) return;
  ttQueued = true;
  requestAnimationFrame(() => {
    ttQueued = false;
    ttInject();
    ttStripTitle();
  });
}).observe(document.documentElement, { childList: true, subtree: true });
