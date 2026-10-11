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
      { key: "navGrok", label: "Grok" },
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
      { key: "userNotes", label: "用户备注（个人主页、悬停卡片的备注按钮）", on: true },
      { key: "noteReplaceAt", label: "把推文中的 @用户 替换为备注", on: true },
      { key: "noteToolbarBtn", label: "在推文操作栏显示备注按钮" },
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
function ttNoteMentionText(orig, notes, replace) {
  const m = /^@([A-Za-z0-9_]{1,15})$/.exec(orig);
  const note = replace && m ? notes[m[1].toLowerCase()] : null;
  return note ? "@" + note : orig;
}

// Validates imported JSON ({handle: note}); returns { handle(lowercase, no @): trimmed note } or null if not an object.
function ttNormalizeNotes(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const out = {};
  for (const [handle, note] of Object.entries(data)) {
    const key = handle.replace(/^@/, "").toLowerCase();
    if (TT_HANDLE_RE.test(key) && typeof note === "string" && note.trim()) out[key] = note.trim();
  }
  return out;
}

function ttLoadSettings() {
  return chrome.storage.sync.get(TT_DEFAULTS);
}
