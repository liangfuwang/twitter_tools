// Author info under each post header: a quick-follow button and (optionally) the bio, so there is no need to open
// the profile. Loaded after notes.js (reuses ttNoteHandle) and x-api.js. Data comes from X's UserByScreenName query,
// fetched only for posts near the viewport, one at a time, and cached in chrome.storage.local.
// Feature flags are read from the tt-* classes content.js puts on <html>.

const TT_UI_KEY = "ttUserCache";
const TT_UI_TTL = 12 * 3600 * 1000;
const TT_UI_MAX = 800;

let ttUiCache = {}; // { <lowercase handle>: { t: fetched at, u: ttParseUser result, or null for "no such user" } }
let ttUiReady = false;
const ttUiOn = (flag) => document.documentElement.classList.contains("tt-" + flag);
const ttUiFresh = (key) => Date.now() - (ttUiCache[key]?.t || 0) < TT_UI_TTL;

let ttUiSaveTimer;
function ttUiSave() {
  clearTimeout(ttUiSaveTimer);
  ttUiSaveTimer = setTimeout(() => {
    const keys = Object.keys(ttUiCache);
    if (keys.length > TT_UI_MAX) {
      keys.sort((a, b) => ttUiCache[a].t - ttUiCache[b].t);
      for (const k of keys.slice(0, keys.length - TT_UI_MAX)) delete ttUiCache[k];
    }
    chrome.storage.local.set({ [TT_UI_KEY]: ttUiCache });
  }, 2000);
}

// --- fetching: one request at a time, only for posts that are (nearly) on screen ---

const ttUiQueue = new Set();
const ttUiArticles = new Map(); // observed article -> lowercase handle
const ttUiVisible = new Set(); // articles within the observer's 400px margin
let ttUiRunning = false;
let ttUiPausedUntil = 0;

function ttUiNeeded() {
  return ttUiOn("userInfoBio") || ttUiOn("quickFollow");
}

function ttUiWant(handle) {
  const key = handle.toLowerCase();
  if (!ttUiNeeded() || ttUiFresh(key)) return;
  ttUiQueue.add(key);
  ttUiRun();
}

function ttUiNear(handle) {
  return ttUiNeeded() && [...ttUiVisible].some((article) => article.isConnected && ttUiArticles.get(article) === handle);
}

async function ttUiRun() {
  if (ttUiRunning) return;
  ttUiRunning = true;
  try {
    while (ttUiQueue.size) {
      const wait = ttUiPausedUntil - Date.now();
      if (wait > 0) await ttSleep(wait);
      // Scrolling or disabling the feature can empty the queue during a rate-limit wait.
      if (!ttUiQueue.size) break;
      const handle = ttUiQueue.values().next().value;
      ttUiQueue.delete(handle);
      const key = handle.toLowerCase();
      if (ttUiFresh(key) || !ttUiNear(key)) continue;
      try {
        const json = await ttGql("UserByScreenName", { screen_name: handle }, false, { retry: false });
        ttUiCache[key] = { t: Date.now(), u: ttParseUser(json.data?.user?.result) };
        ttUiSave();
        ttUiQueueScan();
      } catch (e) {
        if (e.status === 429) {
          // Rate limited: wait for the reset (at most 15 minutes) and try this handle again.
          const reset = e.resetAt ? e.resetAt * 1000 - Date.now() : 5 * 60 * 1000;
          ttUiPausedUntil = Date.now() + Math.min(Math.max(reset, 10000), 15 * 60 * 1000);
          ttUiQueue.add(handle);
        } else {
          ttUiPausedUntil = Date.now() + 30000;
        }
      }
      await ttSleep(300);
    }
  } finally {
    ttUiRunning = false;
  }
}

// --- the block ---

function ttUiOwnHandle() {
  const href = document.querySelector('header[role="banner"] nav [data-testid="AppTabBar_Profile_Link"]')?.getAttribute("href");
  return href ? href.slice(1).toLowerCase() : "";
}

// The post's author handle, or null when the block should not be shown (own posts, posts on the author's own profile).
function ttUiHandleOf(article, own) {
  const userName = article.querySelector('[data-testid="User-Name"]');
  const handle = userName && ttNoteHandle(userName);
  if (!handle) return null;
  const key = handle.toLowerCase();
  if (key === own) return null;
  const [first, second] = location.pathname.split("/").slice(1);
  if (first?.toLowerCase() === key && second !== "status") return null;
  return handle;
}

// The block goes right under the post header (name row): the header is the child of the content column
// (highest ancestor of the name that does not also hold the avatar) that holds the name.
function ttUiHeader(article) {
  const userName = article.querySelector('[data-testid="User-Name"]');
  const avatar = article.querySelector('[data-testid="Tweet-User-Avatar"]');
  if (!userName) return null;
  let col = userName;
  while (col.parentElement && col.parentElement !== article && !(avatar && col.parentElement.contains(avatar))) col = col.parentElement;
  let header = userName;
  while (header.parentElement !== col && header.parentElement) header = header.parentElement;
  return col === userName ? userName : header;
}

function ttUiEl(tag, cls, text) {
  const el = document.createElement(tag);
  el.className = cls;
  if (text) el.textContent = text;
  return el;
}

// Already-followed authors get no block content (it would be noise on most posts); handles followed from a block
// in this page session keep a "已关注" tag as feedback.
const ttUiJustFollowed = new Set();

function ttUiRender(block, handle, u) {
  const bio = ttUiOn("userInfoBio");
  const follow = ttUiOn("quickFollow");
  const justFollowed = ttUiJustFollowed.has(handle.toLowerCase());
  const sig = [handle, bio, follow, u.bio, justFollowed, u.followed, u.requested, u.blocking].join("|");
  if (block.dataset.ttSig === sig) return;
  block.dataset.ttSig = sig;
  block.textContent = "";
  const row = ttUiEl("div", "tt-ui-row");
  if (follow && !u.blocking) {
    if (u.followed) {
      if (justFollowed) row.append(ttUiEl("span", "tt-ui-tag", "已关注"));
    }
    else if (u.requested) row.append(ttUiEl("span", "tt-ui-tag", "已申请"));
    else {
      const btn = ttUiEl("button", "tt-ui-follow", "关注");
      btn.type = "button";
      btn.dataset.ttHandle = handle;
      row.append(btn);
    }
  }
  if (row.children.length) block.append(row);
  if (bio && u.bio) {
    const el = ttUiEl("div", "tt-ui-bio", u.bio.replace(/\s+/g, " "));
    el.title = "点击展开/收起";
    block.append(el);
  }
  block.hidden = !block.children.length;
}

const ttUiSeen = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const handle = ttUiArticles.get(e.target);
      if (!handle) continue;
      if (e.isIntersecting) {
        ttUiVisible.add(e.target);
        ttUiWant(handle);
      } else ttUiVisible.delete(e.target);
    }
    for (const handle of ttUiQueue) if (!ttUiNear(handle)) ttUiQueue.delete(handle);
  },
  { rootMargin: "400px 0px" }
);

function ttUiScan() {
  if (!ttUiReady) return;
  const enabled = ttUiNeeded();
  const own = ttUiOwnHandle();
  const articles = new Set(document.querySelectorAll('article[data-testid="tweet"]'));
  for (const article of ttUiArticles.keys()) {
    if (!enabled || !articles.has(article)) {
      ttUiSeen.unobserve(article);
      ttUiArticles.delete(article);
      ttUiVisible.delete(article);
    }
  }
  for (const article of articles) {
    let block = article.querySelector(".tt-ui");
    const handle = enabled ? ttUiHandleOf(article, own) : null;
    const u = handle && ttUiCache[handle.toLowerCase()]?.u;
    const key = handle?.toLowerCase();
    if (ttUiArticles.get(article) !== key) {
      ttUiSeen.unobserve(article);
      ttUiVisible.delete(article);
      ttUiArticles.delete(article);
      if (key) {
        ttUiArticles.set(article, key);
        ttUiSeen.observe(article);
      }
    }
    if (key && ttUiVisible.has(article)) ttUiWant(key);
    if (!u) {
      block?.remove();
      continue;
    }
    if (!block) block = ttUiEl("div", "tt-ui");
    const header = ttUiHeader(article);
    if (!header) continue;
    if (header.nextElementSibling !== block) header.after(block);
    ttUiRender(block, handle, u);
  }
  for (const handle of ttUiQueue) if (!ttUiNear(handle)) ttUiQueue.delete(handle);
  if (!enabled) for (const el of document.querySelectorAll(".tt-ui")) el.remove();
}

async function ttUiFollow(btn) {
  const u = ttUiCache[btn.dataset.ttHandle.toLowerCase()]?.u;
  if (!u || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = "关注中…";
  try {
    const res = await ttRestPost("friendships/create.json", { user_id: u.id });
    u.requested = Boolean(res.follow_request_sent);
    u.followed = !u.requested;
    ttUiJustFollowed.add(btn.dataset.ttHandle.toLowerCase());
    ttUiSave();
    ttUiScan();
  } catch {
    btn.disabled = false;
    btn.textContent = "失败，重试";
  }
}

// The block sits inside the post, so intercept clicks before X opens the post.
document.addEventListener(
  "click",
  (e) => {
    if (!e.target.closest?.(".tt-ui")) return;
    e.preventDefault();
    e.stopPropagation();
    const follow = e.target.closest(".tt-ui-follow");
    if (follow) ttUiFollow(follow);
    else e.target.closest(".tt-ui-bio")?.classList.toggle("tt-ui-open");
  },
  true
);

let ttUiQueued = false;
function ttUiQueueScan() {
  if (ttUiQueued) return;
  ttUiQueued = true;
  requestAnimationFrame(() => {
    ttUiQueued = false;
    ttUiScan();
  });
}

chrome.storage.local.get(TT_UI_KEY).then((r) => {
  ttUiCache = { ...r[TT_UI_KEY], ...ttUiCache };
}).catch(() => {}).finally(() => {
  ttUiReady = true;
  ttUiQueueScan();
});

new MutationObserver(ttUiQueueScan).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
new MutationObserver(ttUiQueueScan).observe(document.documentElement, { childList: true, subtree: true });
