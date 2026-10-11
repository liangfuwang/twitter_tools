// User notes (alias/tag): shows a pill with the note next to a user's display name and lets the user edit it.
// Runs after content.js. Notes live in chrome.storage.local under TT_NOTES_KEY as { <lowercase handle>: note }.
// Feature flags are read from the tt-* classes content.js puts on <html>.

const TT_NOTE_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M19 14v8H3V4h10"/><path d="M17.5 4a1.8 1.8 0 012.5 0l.7.7a1.8 1.8 0 010 2.5l-9.4 9.4a1.5 1.5 0 01-1 .4H7.5v-2.7c0-.4.2-.8.4-1.1L17.5 4z"/></svg>';

let ttNotes = {};
const ttNoteOn = (flag) => document.documentElement.classList.contains("tt-" + flag);

function ttNoteIcon() {
  const span = document.createElement("span");
  span.innerHTML = TT_NOTE_ICON;
  return span.firstChild;
}

// The handle of the user a container (post header, profile header, user cell, hover card) is about.
function ttNoteHandle(box) {
  for (const a of box.querySelectorAll("a[href]")) {
    const handle = ttNoteHandleFromHref(a.getAttribute("href"));
    if (handle) return handle;
  }
  for (const s of box.querySelectorAll("span")) {
    const m = s.textContent.match(/^@([A-Za-z0-9_]{1,15})$/);
    if (m) return m[1];
  }
  return null;
}

// The element holding the display name: first text block that is not the "@handle" line.
function ttNoteNameBox(box) {
  for (const d of box.querySelectorAll("div[dir]")) {
    const text = d.textContent.trim();
    if (text && !text.startsWith("@") && !d.closest(".tt-note-pill")) return d;
  }
  return null;
}

function ttNoteSyncPill(box) {
  const handle = ttNoteHandle(box);
  const note = handle && ttNoteOn("userNotes") ? ttNotes[handle.toLowerCase()] : null;
  const pill = box.querySelector(".tt-note-pill");
  if (!note) return pill?.remove();
  if (pill && pill.dataset.ttHandle === handle && pill.textContent === note) return;
  pill?.remove();
  const nameBox = ttNoteNameBox(box);
  if (!nameBox) return;
  const el = document.createElement("span");
  el.className = "tt-note-pill";
  el.dataset.ttHandle = handle;
  el.textContent = note;
  el.title = "点击编辑备注";
  nameBox.append(el);
}

// Buttons that open the editor: profile header, hover card, and (optionally) a post's action bar.
function ttNoteSyncButton(host, handle, place) {
  const existing = host.querySelector(".tt-note-btn");
  if (!handle || !ttNoteOn("userNotes")) return existing?.remove();
  if (existing?.dataset.ttHandle === handle) return;
  existing?.remove();
  const btn = document.createElement("div");
  btn.className = "tt-note-btn";
  btn.setAttribute("role", "button");
  btn.dataset.ttHandle = handle;
  btn.title = "添加备注";
  btn.append(ttNoteIcon());
  place(btn);
}

function ttNoteScan() {
  const boxes = '[data-testid="User-Name"], [data-testid="UserName"], [data-testid="UserCell"], [data-testid="HoverCard"]';
  for (const box of document.querySelectorAll(boxes)) ttNoteSyncPill(box);
  if (!ttNoteOn("userNotes")) for (const el of document.querySelectorAll(".tt-note-btn")) el.remove();

  // Profile header.
  const profile = document.querySelector('[data-testid="UserName"]');
  const anchor = document.querySelector('[data-testid="placementTracking"], [data-testid="editProfileButton"]');
  if (profile && anchor) {
    const row = anchor.parentElement;
    ttNoteSyncButton(row, ttNoteHandle(profile), (btn) => {
      btn.classList.add("tt-note-btn-profile");
      row.prepend(btn);
    });
  }

  // Hover card: button after the avatar.
  for (const card of document.querySelectorAll('[data-testid="HoverCard"]')) {
    const avatar = card.querySelector('[data-testid^="UserAvatar-Container-"]');
    if (!avatar) continue;
    ttNoteSyncButton(card, ttNoteHandle(card), (btn) => {
      btn.classList.add("tt-note-btn-card");
      avatar.after(btn);
    });
  }

  // Post action bar (off by default).
  for (const article of document.querySelectorAll("article")) {
    const bar = article.querySelector('[data-testid="reply"]')?.closest('[role="group"]');
    if (!bar) continue;
    const handle = ttNoteOn("noteToolbarBtn") ? ttNoteHandle(article.querySelector('[data-testid="User-Name"]') || article) : null;
    ttNoteSyncButton(bar, handle, (btn) => {
      btn.classList.add("tt-note-btn-bar");
      bar.append(btn);
    });
  }

  ttNoteReplaceMentions();
}

// Replaces "@handle" link text inside post text with the note. Edits the existing text node so React keeps working.
function ttNoteReplaceMentions() {
  const replace = ttNoteOn("userNotes") && ttNoteOn("noteReplaceAt");
  for (const a of document.querySelectorAll('[data-testid="tweetText"] a[href^="/"]')) {
    const node = [...a.childNodes].find((n) => n.nodeType === 3) || a.querySelector("span")?.firstChild;
    if (!node || node.nodeType !== 3) continue;
    const orig = a.dataset.ttOrig ?? node.nodeValue;
    if (!/^@[A-Za-z0-9_]{1,15}$/.test(orig)) continue;
    const want = ttNoteMentionText(orig, ttNotes, replace);
    if (want !== orig) a.dataset.ttOrig = orig;
    else delete a.dataset.ttOrig;
    if (node.nodeValue !== want) node.nodeValue = want;
  }
}

async function ttNoteSave(handle, note) {
  const key = handle.toLowerCase();
  if (note) ttNotes[key] = note;
  else delete ttNotes[key];
  await chrome.storage.local.set({ [TT_NOTES_KEY]: ttNotes });
}

function ttNoteEdit(handle) {
  const old = ttNotes[handle.toLowerCase()] || "";
  const cs = getComputedStyle(document.body);
  const overlay = document.createElement("div");
  overlay.className = "tt-note-overlay";
  const dialog = document.createElement("div");
  dialog.className = "tt-note-dialog";
  dialog.style.cssText = "background:" + cs.backgroundColor + ";color:" + cs.color;
  const title = document.createElement("div");
  title.className = "tt-note-title";
  title.textContent = "为 @" + handle + " 添加备注";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 60;
  input.value = old;
  input.placeholder = "备注 / 别名 / 标签";
  const actions = document.createElement("div");
  actions.className = "tt-note-actions";
  const close = () => overlay.remove();
  const save = async () => {
    await ttNoteSave(handle, input.value.trim());
    close();
    ttNoteScan();
  };
  const button = (text, cls, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.className = cls;
    b.addEventListener("click", fn);
    return b;
  };
  if (old) actions.append(button("删除", "tt-note-danger", async () => { input.value = ""; await save(); }));
  actions.append(button("取消", "", close), button("保存", "tt-note-primary", save));
  dialog.append(title, input, actions);
  overlay.append(dialog);
  overlay.addEventListener("mousedown", (e) => e.target === overlay && close());
  dialog.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.isComposing) save();
    else if (e.key === "Escape") close();
  });
  dialog.addEventListener("keyup", (e) => e.stopPropagation());
  dialog.addEventListener("keypress", (e) => e.stopPropagation());
  document.body.append(overlay);
  input.focus();
  input.select();
}

// Pills and buttons sit inside links, so intercept the click before X navigates.
document.addEventListener(
  "click",
  (e) => {
    const el = e.target.closest?.(".tt-note-pill, .tt-note-btn");
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    ttNoteEdit(el.dataset.ttHandle);
  },
  true
);

let ttNoteQueued = false;
function ttNoteQueue() {
  if (ttNoteQueued) return;
  ttNoteQueued = true;
  requestAnimationFrame(() => {
    ttNoteQueued = false;
    ttNoteScan();
  });
}

chrome.storage.local.get(TT_NOTES_KEY).then((r) => {
  ttNotes = r[TT_NOTES_KEY] || {};
  ttNoteQueue();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[TT_NOTES_KEY]) {
    ttNotes = changes[TT_NOTES_KEY].newValue || {};
    ttNoteQueue();
  }
});

// Setting toggles show up as class changes on <html>; page content changes as DOM mutations.
new MutationObserver(ttNoteQueue).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
new MutationObserver(ttNoteQueue).observe(document.documentElement, { childList: true, subtree: true });
