// Shared by the content script and the popup (loaded as a classic script, no modules).
// Each option key maps to a CSS class "tt-<key>" toggled on <html>; see content.css.
const TT_SECTIONS = [
  {
    title: "左侧菜单（勾选 = 隐藏）",
    options: [
      { key: "navHome", label: "首页" },
      { key: "navExplore", label: "探索" },
      { key: "navNotifications", label: "通知" },
      { key: "navMessages", label: "私信" },
      { key: "navCalls", label: "呼叫" },
      { key: "navGrok", label: "Grok" },
      { key: "navPremium", label: "订阅" },
      { key: "navCreatorStudio", label: "创作者工作室" },
      { key: "navArticles", label: "文章" },
      { key: "navHistory", label: "历史", hidden: true },
      { key: "navBookmarks", label: "书签", inject: "/i/bookmarks" },
      { key: "navLists", label: "列表", inject: "{user}/lists" },
      { key: "navJobs", label: "招聘", inject: "/jobs" },
      { key: "navCommunities", label: "社群", inject: "{user}/communities" },
      { key: "navVerifiedOrgs", label: "认证组织", inject: "/i/verified-orgs-signup" },
      { key: "navProfile", label: "个人资料" },
      { key: "navMore", label: "更多" },
    ],
  },
  {
    title: "时间线（勾选 = 隐藏）",
    options: [
      { key: "hideSidebar", label: "隐藏右侧栏（推荐关注、趋势）" },
      { key: "hideMetrics", label: "隐藏推文下方的数据指标" },
      { key: "hideBadges", label: "隐藏未读通知/私信数字（左栏徽标、标签页标题）", hidden: true },
    ],
  },
  {
    title: "作者信息（勾选 = 启用）",
    options: [
      { key: "userInfoBio", label: "在帖子下方显示作者简介" },
      { key: "quickFollow", label: "快速关注按钮（关注并开启对方的发帖通知）", on: true },
      { key: "authorFollowers", label: "显示作者粉丝数", on: true },
      { key: "authorLarge", label: "大V 标签（粉丝不少于 10 万）", on: true },
      { key: "authorVeteran", label: "老号标签（注册满 5 年）", on: true },
    ],
  },
  {
    title: "帖子热度（勾选 = 启用）",
    options: [
      { key: "postViewRate", label: "每小时平均浏览量（总浏览量 ÷ 发布时长）", on: true },
    ],
  },
  {
    title: "右下角浮窗（勾选 = 隐藏）",
    options: [
      { key: "hideGrokDrawer", label: "Grok 浮窗", hidden: true },
      { key: "hideChatDrawer", label: "聊天浮窗", hidden: true },
    ],
  },
  {
    title: "帖子分享菜单（勾选 = 启用）",
    options: [
      { key: "exportImage", label: "导出为图片", on: true },
      { key: "exportMd", label: "导出为 Markdown", on: true },
    ],
  },
  {
    title: "用户备注（勾选 = 启用）",
    options: [
      { key: "userNotes", label: "用户备注（个人主页的备注按钮、名字后的备注标签）", on: true },
      { key: "noteReplaceAt", label: "把推文中的 @用户 替换为备注", on: true },
    ],
  },
  {
    title: "外观（勾选 = 启用）",
    options: [
      { key: "claudeTheme", label: "Claude 风格（暖色背景、衬线正文）" },
      { key: "compactNav", label: "紧凑左侧栏（更窄，字号适中）", on: true },
      { key: "widenTimeline", label: "加宽时间线（最宽 900px）", on: true },
      { key: "bigTabs", label: "顶部标签字号与左栏一致（17px）" },
    ],
  },
];

// A checked box means "hide". Options with inject are not in X's left nav natively: content.js adds a link to that
// path ({user} = own profile path, e.g. /name) while the box is unchecked, so they default to checked (hidden).
// Options with hidden: true (or on: true, for the 外观 section) also default to checked.
const TT_DEFAULTS = Object.fromEntries(
  TT_SECTIONS.flatMap((s) => s.options.map((o) => [o.key, Boolean(o.inject || o.hidden || o.on)]))
);

// User notes are stored in chrome.storage.local (too large for sync's 8KB per-item quota) as { handle: note }.
const TT_NOTES_KEY = "ttNotes";

// Pure helpers for user notes (shared by notes.js and the popup, unit-tested in test/).
const TT_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

// "/name" -> "name"; anything else (status links, "/home/x", "") -> null.
function ttNoteHandleFromHref(href) {
  const m = /^\/([^/?#]+)$/.exec(href || "");
  return m && TT_HANDLE_RE.test(m[1]) ? m[1] : null;
}

// Text a post mention should show: "@note" when replacing and a note exists, else the original "@handle".
function ttNoteForHandle(notes, handle) {
  const key = handle.toLowerCase();
  return Object.hasOwn(notes, key) && typeof notes[key] === "string" ? notes[key] : "";
}

function ttNoteMentionText(orig, notes, replace) {
  const m = /^@([A-Za-z0-9_]{1,15})$/.exec(orig);
  const note = replace && m ? ttNoteForHandle(notes, m[1]) : null;
  return note ? "@" + note : orig;
}

// Validates imported JSON ({handle: note}); returns { handle(lowercase, no @): trimmed note } or null if not an object.
function ttNormalizeNotes(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const out = Object.create(null);
  for (const [handle, note] of Object.entries(data)) {
    const key = handle.replace(/^@/, "").toLowerCase();
    if (TT_HANDLE_RE.test(key) && typeof note === "string" && note.trim()) out[key] = note.trim();
  }
  return out;
}

// Reduces a UserByScreenName result to what the author info block needs; null if it is not a normal user.
// Reads the current schema (relationship_counts, profile_bio) and falls back to the older legacy fields.
function ttParseUser(r) {
  if (!r || r.__typename !== "User" || !r.rest_id) return null;
  const legacy = r.legacy || {};
  const rp = r.relationship_perspectives || {};
  let bio = r.profile_bio?.description ?? legacy.description ?? "";
  const urls = r.profile_bio?.entities?.description?.urls ?? legacy.entities?.description?.urls ?? [];
  for (const u of urls) if (u.url && u.display_url) bio = bio.split(u.url).join(u.display_url);
  return {
    id: r.rest_id,
    bio: bio.trim(),
    followers: ttMetricNumber(r.relationship_counts?.followers ?? legacy.followers_count),
    createdAt: ttValidDate(r.core?.created_at ?? legacy.created_at ?? r.created_at),
    followed: Boolean(rp.following ?? legacy.following),
    requested: Boolean(r.follow_request_sent ?? legacy.follow_request_sent),
    blocking: Boolean(rp.blocking),
    protected: Boolean(r.privacy?.protected ?? legacy.protected),
  };
}

function ttLoadSettings() {
  return chrome.storage.sync.get(TT_DEFAULTS);
}

// Missing or malformed counts must not be presented as zero followers.
function ttMetricNumber(value) {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value))) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function ttValidDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function ttFormatFollowers(value) {
  const count = ttMetricNumber(value);
  if (count === null) return null;
  if (count >= 1e8) return Number((count / 1e8).toFixed(1)) + "亿";
  if (count >= 1e4) return Number((count / 1e4).toFixed(1)) + "万";
  return count.toLocaleString("zh-CN");
}

function ttAuthorBadges(user, flags, now = Date.now()) {
  const badges = [];
  const count = ttMetricNumber(user.followers);
  if (flags.authorFollowers && count !== null) badges.push({ kind: "followers", text: ttFormatFollowers(count) + "粉丝", title: "粉丝数：" + count.toLocaleString("zh-CN") });
  if (flags.authorLarge && count !== null && count >= 100000) badges.push({ kind: "large", text: "大V", title: "粉丝不少于 10 万；不代表 X 官方认证" });
  const joined = ttValidDate(user.createdAt);
  if (flags.authorVeteran && joined && Date.parse(joined) <= now) {
    const anniversary = new Date(joined);
    anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 5);
    if (anniversary.getTime() <= now) badges.push({ kind: "veteran", text: "老号", title: "注册满 5 年 · 注册于 " + joined.slice(0, 10) });
  }
  return badges;
}

// Prefer the native analytics link's exact aria-label; compact labels remain estimates.
function ttParseViewCount(text) {
  if (typeof text !== "string") return null;
  const match = text.trim().match(/^(\d[\d.,\s\u00a0\u202f]*)([kKmMbB](?![A-Za-z])|[万萬亿億])?/);
  if (!match) return null;
  let numeric = match[1].replace(/[\s\u00a0\u202f]/g, "");
  const suffix = match[2]?.toLowerCase();
  if (suffix) {
    if (/^\d+,\d{1,2}$/.test(numeric)) numeric = numeric.replace(",", ".");
    else numeric = numeric.replace(/,/g, "");
  } else {
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(numeric)) numeric = numeric.replace(/[.,]/g, "");
    else if (!/^\d+$/.test(numeric)) return null;
  }
  const factor = { k: 1e3, m: 1e6, b: 1e9, "万": 1e4, "萬": 1e4, "亿": 1e8, "億": 1e8 }[suffix] || 1;
  return ttMetricNumber(Number(numeric) * factor);
}

function ttAverageViewsPerHour(views, createdAt, now = Date.now()) {
  const count = ttMetricNumber(views);
  const time = ttValidDate(createdAt);
  const elapsed = time ? now - Date.parse(time) : 0;
  if (count === null || !Number.isFinite(elapsed) || elapsed < 60000) return null;
  return count * 3600000 / elapsed;
}

function ttFormatViewRate(rate) {
  if (!Number.isFinite(rate) || rate < 0) return null;
  if (rate >= 1e6) return Number((rate / 1e6).toFixed(1)) + "m/h";
  if (rate >= 1e3) return Number((rate / 1e3).toFixed(1)) + "k/h";
  return Math.round(rate) + "/h";
}
