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
    followed: Boolean(rp.following ?? legacy.following),
    requested: Boolean(r.follow_request_sent ?? legacy.follow_request_sent),
    blocking: Boolean(rp.blocking),
    protected: Boolean(r.privacy?.protected ?? legacy.protected),
  };
}

function ttLoadSettings() {
  return chrome.storage.sync.get(TT_DEFAULTS);
}
