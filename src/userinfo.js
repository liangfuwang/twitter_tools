// Author info under each post header: follower/age badges, a quick-follow button and (optionally) the bio.
// Loaded after notes.js (reuses ttNoteHandle) and x-api.js. Data comes from X's UserByScreenName query,
// fetched only for posts near the viewport, one at a time, and cached in chrome.storage.local.
// Feature flags are read from the tt-* classes content.js puts on <html>.

const TT_UI_KEY = "ttUserCache";
const TT_UI_TTL = 12 * 3600 * 1000;
const TT_UI_MAX = 800;
const TT_UI_CACHE_VERSION = 3;

let ttUiCache = Object.create(null); // { <lowercase handle>: { t: fetched at, u: ttParseUser result, or null for "no such user" } }
let ttUiReady = false;
const ttUiOn = (flag) => document.documentElement.classList.contains("tt-" + flag);
const ttUiOwner = () => ttOwnId() || ttUiOwnHandle();
const ttUiFresh = (key) => ttUiCache[key]?.v === TT_UI_CACHE_VERSION &&
  ttUiCache[key]?.owner === ttUiOwner() && Date.now() - (ttUiCache[key]?.t || 0) < TT_UI_TTL;

// An orphaned copy (see ttAlive) shuts down instead of erroring and fetching twice.
const ttUiAlive = ttAlive;
const ttUiObservers = [];

function ttUiStop() {
  ttUiReady = false;
  ttUiQueue.clear();
  ttUiSeen.disconnect();
  for (const observer of ttUiObservers) observer.disconnect();
}

function ttUiCacheUser(key, user) {
  const owner = ttUiOwner();
  const previous = ttUiCache[key];
  const followStatus = previous?.owner === owner && previous?.u?.id === user?.id ? previous.followStatus : undefined;
  ttUiCache[key] = { v: TT_UI_CACHE_VERSION, owner, t: Date.now(), u: user, ...(followStatus && { followStatus }) };
  ttUiSave();
}

let ttUiSaveTimer;
function ttUiSave() {
  clearTimeout(ttUiSaveTimer);
  ttUiSaveTimer = setTimeout(() => {
    if (!ttUiAlive()) return ttUiStop();
    const keys = Object.keys(ttUiCache);
    if (keys.length > TT_UI_MAX) {
      keys.sort((a, b) => ttUiCache[a].t - ttUiCache[b].t);
      for (const k of keys.slice(0, keys.length - TT_UI_MAX)) delete ttUiCache[k];
    }
    chrome.storage.local.set({ [TT_UI_KEY]: ttUiCache }).catch(() => {});
  }, 2000);
}

// --- fetching: one request at a time, only for posts that are (nearly) on screen ---

const ttUiQueue = new Set();
const ttUiArticles = new Map(); // observed article -> lowercase handle
const ttUiVisible = new Set(); // articles within the observer's 400px margin
let ttUiRunning = false;
let ttUiPausedUntil = 0;

function ttUiNeeded() {
  return ttUiOn("userInfoBio") || ttUiOn("quickFollow") || ttUiStatsOn();
}

const ttUiStatsOn = () => ["authorFollowers", "authorLarge", "authorVeteran"].some(ttUiOn);

function ttUiActionsAllowed(handle, own = ttUiOwnHandle()) {
  const key = handle.toLowerCase();
  const [first, second] = location.pathname.split("/").slice(1);
  return key !== own && !(first?.toLowerCase() === key && second !== "status");
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
      if (!ttUiAlive()) return ttUiStop();
      const wait = ttUiPausedUntil - Date.now();
      if (wait > 0) await ttSleep(wait);
      // Scrolling or disabling the feature can empty the queue during a rate-limit wait.
      if (!ttUiQueue.size) break;
      const handle = ttUiQueue.values().next().value;
      ttUiQueue.delete(handle);
      const key = handle.toLowerCase();
      if (ttUiFresh(key) || !ttUiNear(key)) continue;
      const owner = ttUiOwner();
      try {
        const json = await ttGql("UserByScreenName", { screen_name: handle }, false, { retry: false });
        if (owner !== ttUiOwner()) continue;
        ttUiCacheUser(key, ttParseUser(json.data?.user?.result));
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

// Metadata may appear on self/profile posts; follow/bio controls retain their existing exclusions.
function ttUiHandleOf(article, own) {
  const userName = article.querySelector('[data-testid="User-Name"]');
  const handle = userName && ttNoteHandle(userName);
  if (!handle) return null;
  return ttUiStatsOn() || ttUiActionsAllowed(handle, own) ? handle : null;
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

function ttUiRender(block, handle, u) {
  const actions = ttUiActionsAllowed(handle);
  const bio = actions && ttUiOn("userInfoBio");
  const follow = actions && ttUiOn("quickFollow");
  const badges = ttAuthorBadges(u, {
    authorFollowers: ttUiOn("authorFollowers"),
    authorLarge: ttUiOn("authorLarge"),
    authorVeteran: ttUiOn("authorVeteran"),
  });
  const state = ttUiFollowState(handle);
  const busy = ttUiFollowBusy.has(handle.toLowerCase());
  const error = ttUiFollowErrors.get(handle.toLowerCase());
  const sig = [handle, bio, follow, u.bio, state, busy, u.followed, u.requested, u.blocking, error, JSON.stringify(badges)].join("|");
  if (block.dataset.ttSig === sig) return;
  block.dataset.ttSig = sig;
  block.textContent = "";
  const row = ttUiEl("div", "tt-ui-row");
  for (const badge of badges) {
    const el = ttUiEl("span", "tt-author-badge tt-author-" + badge.kind, badge.text);
    el.title = badge.title;
    row.append(el);
  }
  if (follow && !u.blocking && (!u.followed || state || busy)) row.append(ttUiFollowControl(handle, u));
  if (row.children.length) block.append(row);
  if (follow && error) block.append(ttUiEl("div", "tt-ui-error", error));
  if (bio && u.bio) {
    const el = ttUiEl("div", "tt-ui-bio", u.bio.replace(/\s+/g, " "));
    el.title = "点击展开/收起";
    block.append(el);
  }
  block.hidden = !block.children.length;
}

const ttUiFollowStates = new Map();
const ttUiFollowBusy = new Set();
const ttUiFollowErrors = new Map();
let ttUiStateOwner = "";

function ttUiFollowError(error) {
  const status = Number(error?.status);
  const code = Number(error?.apiCode);
  const details = [status >= 400 && "HTTP " + status, Number.isInteger(code) && "错误码 " + code].filter(Boolean).join("，");
  if (status === 429 || code === 88) return "X 请求频繁，请稍后再试" + (details ? "（" + details + "）" : "");
  if (status === 401 || code === 32 || code === 89) return "登录状态已失效，请刷新 X 页面后重试";
  if (status === 403) return "X 拒绝了请求（" + details + "），请尝试页面原生关注按钮";
  if (status === 404) return "X 接口或账号不可用（" + details + "），请刷新页面或使用原生关注按钮";
  if (details) return "X 请求失败（" + details + "），请稍后重试";
  const message = error?.message || "";
  if (/^(登录账号已变化|账号信息已变化|无法读取 X 的接口信息|X 的接口信息格式无效|没有找到接口)/.test(message)) return message;
  return "关注请求未完成，请检查网络或尝试页面原生关注按钮";
}

function ttUiFollowState(handle) {
  const key = handle?.toLowerCase();
  return ttUiFollowStates.get(key) || (key && ttUiFresh(key) ? ttUiCache[key]?.followStatus : undefined);
}

// Progress, pending approval and notification-retry feedback for the follow button.
function ttUiFollowControl(handle, user) {
  const key = handle.toLowerCase();
  const state = ttUiFollowState(handle);
  const busy = ttUiFollowBusy.has(key);
  const requested = user.requested && !user.followed;
  const done = state === "done" && user.followed;
  const text = busy ? "处理中…" : done ? "已关注 · 通知已开启" : requested ? "已申请 · 待批准" :
    state === "notifyFailed" || user.followed ? "开启通知" : state === "unconfirmed" ? "确认关注状态" :
    state === "error" ? "重试关注" : "关注";
  const el = ttUiEl(done ? "span" : "button", done ? "tt-ui-tag" : "tt-ui-follow", text);
  el.dataset.ttHandle = handle;
  if (!done) {
    el.type = "button";
    el.disabled = busy;
  }
  el.title = requested ? "点击检查审批状态；对方批准关注后开启发帖通知" :
    state === "notifyFailed" ? "已关注，通知未确认开启；点击重试" : ttUiFollowErrors.get(key) || "关注并开启对方的发帖通知";
  return el;
}

async function ttUiFollow(btn) {
  if (btn.disabled) return;
  const handle = btn.dataset.ttHandle;
  const key = handle.toLowerCase();
  const owner = ttUiOwnHandle();
  const viewer = ttOwnId();
  const cached = ttUiCache[key]?.u;
  if (!cached || !ttUiFresh(key) || ttUiFollowBusy.has(key)) return;
  ttUiFollowErrors.delete(key);
  ttUiFollowBusy.add(key);
  ttUiScan();
  try {
    const result = await ttFollowAndNotifyUser(handle, cached.id);
    if (ttUiOwnHandle() !== owner || ttOwnId() !== viewer) return;
    ttUiCacheUser(key, result.user);
    ttUiFollowStates.set(key, result.status);
    if (["notifyFailed", "requested", "unconfirmed"].includes(result.status)) ttUiCache[key].followStatus = result.status;
    else delete ttUiCache[key].followStatus;
    ttUiSave();
  } catch (error) {
    if (ttUiOwnHandle() === owner && ttOwnId() === viewer) {
      ttUiFollowStates.set(key, "error");
      ttUiFollowErrors.set(key, ttUiFollowError(error));
    }
  } finally {
    ttUiFollowBusy.delete(key);
    ttUiScan();
  }
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
  if (ttUiStateOwner !== ttUiOwner()) {
    ttUiFollowStates.clear();
    ttUiFollowErrors.clear();
    ttUiStateOwner = ttUiOwner();
  }
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
    const u = handle && ttUiFresh(handle.toLowerCase()) ? ttUiCache[handle.toLowerCase()]?.u : null;
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

// The block sits inside the post, so intercept clicks before X opens the post.
document.addEventListener(
  "click",
  (e) => {
    // Both an orphaned and the new copy listen here; only the live one may send a follow request.
    if (!e.target.closest?.(".tt-ui") || !ttUiAlive()) return;
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
  if (!ttUiAlive()) return ttUiStop();
  if (ttUiQueued) return;
  ttUiQueued = true;
  requestAnimationFrame(() => {
    ttUiQueued = false;
    ttUiScan();
  });
}

chrome.storage.local.get(TT_UI_KEY).then((r) => {
  ttUiCache = Object.assign(Object.create(null), r[TT_UI_KEY], ttUiCache);
}).catch(() => {}).finally(() => {
  ttUiReady = true;
  ttUiQueueScan();
});

ttUiObservers.push(new MutationObserver(ttUiQueueScan), new MutationObserver(ttUiQueueScan));
ttUiObservers[0].observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
ttUiObservers[1].observe(document.documentElement, { childList: true, subtree: true });
