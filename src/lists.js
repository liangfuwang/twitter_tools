// List migration tool: copies (or moves) the members of one X list to another, through X's own GraphQL API
// using the logged-in session. Opened from the popup (message "tt-open-lists"). Query ids come from
// lists-bridge.js (main world).

const TT_LIST_DELAY = 400; // ms between write calls

async function ttFetchMembers(listId, onProgress, signal) {
  const users = new Map();
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < 200; page++) {
    const json = await ttGql("ListMembers", { listId, count: 100, ...(cursor && { cursor }) }, false, { signal });
    const instructions = json.data?.list?.members_timeline?.timeline?.instructions;
    if (!Array.isArray(instructions)) throw new Error("X 返回的列表成员格式无效，无法确认完整成员状态");
    const before = users.size;
    let next;
    ttWalk(instructions, (o) => {
      if (o.__typename === "User" && o.rest_id) {
        users.set(o.rest_id, {
          id: o.rest_id,
          name: o.core?.name || o.legacy?.name || "",
          handle: o.core?.screen_name || o.legacy?.screen_name || "",
          following: Boolean(o.relationship_perspectives?.following ?? o.legacy?.following),
        });
      }
      if (o.cursorType === "Bottom" && o.value) next = o.value;
    });
    onProgress?.(users.size);
    if (!next || (next === cursor && users.size === before)) break;
    if (cursors.has(next)) throw new Error("列表成员分页重复，无法确认完整成员状态");
    if (page === 199) throw new Error("列表成员过多，未能完整读取，请缩小列表后重试");
    cursors.add(next);
    cursor = next;
  }
  return [...users.values()];
}

// A DecodeException can describe response serialization after a write. Never
// repeat that write or infer success from partial data: re-read membership.
async function ttVerifiedListMutation(name, listId, userId, signal) {
  let decodeError;
  try {
    await ttGql(name, { listId, userId }, true, { signal, retry: false });
  } catch (err) {
    if (!/\bDecodeException\b/.test(err.message) || signal?.aborted) throw err;
    decodeError = err;
  }
  try {
    const users = await ttFetchMembers(listId, null, signal);
    const present = users.some(user => user.id === userId);
    if (present !== (name === "ListAddMember")) throw new Error("成员状态与操作结果不符");
  } catch (err) {
    if (signal?.aborted) throw err;
    const error = new Error("无法确认" + (name === "ListAddMember" ? "加入目标列表" : "从源列表移除") +
      "是否成功，已停止；请重新加载成员核对。" + (decodeError ? "X 返回接口解码错误。" : err.message));
    error.stopMigration = true;
    throw error;
  }
  return Boolean(decodeError);
}

// ---------- UI ----------

const TT_PANEL_CSS = `
#tt-lists-overlay{position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font:14px/1.4 -apple-system,"Segoe UI",sans-serif}
#tt-lists-panel{box-sizing:border-box;width:520px;max-width:94vw;max-height:88vh;overflow:auto;background:#fff;color:#0f1419;border-radius:16px;padding:20px;box-shadow:0 8px 40px rgba(0,0,0,.35)}
#tt-lists-panel h2{margin:0 0 14px;font-size:20px}
#tt-lists-panel label.tt-field{display:block;margin:10px 0 4px;font-weight:600}
#tt-lists-panel select{width:100%;padding:7px;border:1px solid #cfd9de;border-radius:8px;font-size:14px;background:#fff;color:#0f1419}
#tt-lists-panel button{padding:7px 14px;border:0;border-radius:999px;background:#0f1419;color:#fff;font-size:14px;font-weight:700;cursor:pointer}
#tt-lists-panel button.tt-secondary{background:#eff3f4;color:#0f1419}
#tt-lists-panel button:disabled{opacity:.5;cursor:default}
#tt-lists-panel .tt-row{display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap}
#tt-lists-panel .tt-members{margin-top:10px;max-height:240px;overflow:auto;border:1px solid #eff3f4;border-radius:8px}
#tt-lists-panel .tt-members label{display:flex;gap:8px;align-items:center;padding:5px 10px;cursor:pointer}
#tt-lists-panel .tt-members label:hover{background:#f7f9f9}
#tt-lists-panel .tt-tag{margin-left:auto;font-size:12px;color:#536471}
#tt-lists-panel .tt-status{margin-top:12px;color:#536471;white-space:pre-wrap;word-break:break-all;max-height:140px;overflow:auto}
#tt-lists-panel .tt-bar{height:6px;border-radius:3px;background:#eff3f4;margin-top:10px;overflow:hidden}
#tt-lists-panel .tt-bar>div{height:100%;width:0;background:#1d9bf0;transition:width .2s}
#tt-lists-panel [hidden]{display:none!important}
`;

let ttListsOverlay;

function ttEl(tag, props = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
}

async function ttOpenListsTool() {
  if (ttListsOverlay?.isConnected) return;
  const style = ttEl("style", { textContent: TT_PANEL_CSS });
  const status = ttEl("div", { className: "tt-status" });
  const bar = ttEl("div", { className: "tt-bar" }, ttEl("div"));
  const srcSel = ttEl("select");
  const dstSel = ttEl("select");
  const loadBtn = ttEl("button", { textContent: "加载成员" });
  const closeBtn = ttEl("button", { className: "tt-secondary", textContent: "关闭" });
  const memberBox = ttEl("div", { className: "tt-members", hidden: true });
  const actions = ttEl("div", { className: "tt-row", hidden: true });
  const moveBox = ttEl("input", { type: "checkbox" });
  const moveLabel = ttEl("label", {}, moveBox, " 迁移后从源列表移除（仅限自己创建的列表）");
  const startBtn = ttEl("button", { textContent: "开始迁移" });
  const cancelBtn = ttEl("button", { className: "tt-secondary", textContent: "停止", hidden: true });
  const allBtn = ttEl("button", { className: "tt-secondary", textContent: "全选" });
  const followedBtn = ttEl("button", { className: "tt-secondary", textContent: "仅选已关注" });
  const noneBtn = ttEl("button", { className: "tt-secondary", textContent: "清空" });
  const selectors = ttEl("div", { className: "tt-row" }, allBtn, followedBtn, noneBtn);
  selectors.hidden = true;

  const panel = ttEl(
    "div",
    { id: "tt-lists-panel" },
    ttEl("h2", { textContent: "列表迁移工具" }),
    ttEl("label", { className: "tt-field", textContent: "源列表（从这里取成员）" }),
    srcSel,
    ttEl("label", { className: "tt-field", textContent: "目标列表（只能选自己创建的）" }),
    dstSel,
    ttEl("div", { className: "tt-row" }, loadBtn, closeBtn),
    selectors,
    memberBox,
    moveLabel,
    actions,
    bar,
    status
  );
  actions.append(startBtn, cancelBtn);
  const overlay = ttEl("div", { id: "tt-lists-overlay" }, style, panel);
  ttListsOverlay = overlay;
  document.body.append(overlay);
  let cancelled = false;
  let controller;
  const close = () => {
    cancelled = true;
    controller?.abort();
    overlay.remove();
  };
  closeBtn.onclick = close;
  overlay.addEventListener("mousedown", (e) => e.target === overlay && close());

  const say = (t) => (status.textContent = t);
  const setBar = (pct) => (bar.firstChild.style.width = pct + "%");
  let lists = [];
  let members = [];

  try {
    say("正在读取列表…");
    let partial;
    ({ lists, partial } = await ttFetchLists());
    for (const l of lists) {
      const text = l.name + "（" + l.count + " 人）" + (l.mine ? "" : " · 他人创建");
      srcSel.append(ttEl("option", { value: l.id, textContent: text }));
      if (l.mine) dstSel.append(ttEl("option", { value: l.id, textContent: text }));
    }
    if (dstSel.options.length > 1) dstSel.selectedIndex = 1;
    say((lists.length ? "选择源列表和目标列表，然后点“加载成员”。" : "没有找到列表。") +
      (partial ? "X 返回了部分错误，列表可能不完整。" : ""));
  } catch (err) {
    say("读取列表失败：" + err.message);
    return;
  }

  const sync = () => {
    const src = lists.find((l) => l.id === srcSel.value);
    moveBox.disabled = !src?.mine;
    if (!src?.mine) moveBox.checked = false;
  };
  srcSel.onchange = () => {
    members = [];
    memberBox.hidden = actions.hidden = selectors.hidden = true;
    sync();
  };
  sync();

  const checks = () => [...memberBox.querySelectorAll("input")];
  const refreshCount = () => (startBtn.textContent = "开始迁移（" + checks().filter((c) => c.checked).length + "）");
  allBtn.onclick = () => (checks().forEach((c) => (c.checked = true)), refreshCount());
  noneBtn.onclick = () => (checks().forEach((c) => (c.checked = false)), refreshCount());
  followedBtn.onclick = () => {
    checks().forEach((c) => (c.checked = members.find((m) => m.id === c.value).following));
    refreshCount();
  };

  loadBtn.onclick = async () => {
    if (!srcSel.value || !dstSel.value) return say("请选择源列表和自己创建的目标列表。");
    if (srcSel.value === dstSel.value) return say("源列表和目标列表不能相同。");
    loadBtn.disabled = startBtn.disabled = srcSel.disabled = dstSel.disabled = true;
    controller = new AbortController();
    members = [];
    memberBox.hidden = actions.hidden = selectors.hidden = true;
    setBar(0);
    try {
      members = await ttFetchMembers(srcSel.value, (n) => say("已读取 " + n + " 个成员…"), controller.signal);
      memberBox.replaceChildren(
        ...members.map((m) =>
          ttEl(
            "label",
            {},
            ttEl("input", { type: "checkbox", value: m.id, checked: true, onchange: refreshCount }),
            m.name + " @" + m.handle,
            ttEl("span", { className: "tt-tag", textContent: m.following ? "已关注" : "" })
          )
        )
      );
      memberBox.hidden = actions.hidden = selectors.hidden = false;
      refreshCount();
      say("共 " + members.length + " 个成员，已关注 " + members.filter((m) => m.following).length + " 个。");
    } catch (err) {
      say("读取成员失败：" + err.message);
    }
    loadBtn.disabled = startBtn.disabled = srcSel.disabled = dstSel.disabled = false;
  };

  cancelBtn.onclick = () => {
    cancelled = true;
    controller?.abort();
  };
  startBtn.onclick = async () => {
    const src = lists.find((l) => l.id === srcSel.value);
    const dst = lists.find((l) => l.id === dstSel.value);
    if (!src || !dst?.mine) return say("请选择源列表和自己创建的目标列表。");
    if (src.id === dst.id) return say("源列表和目标列表不能相同。");
    const ids = new Set(checks().filter((c) => c.checked).map((c) => c.value));
    const todo = members.filter((m) => ids.has(m.id));
    if (!todo.length) return say("没有选中任何成员。");
    const move = moveBox.checked && src.mine;
    if (!confirm("从「" + src.name + "」把 " + todo.length + " 个账号加入「" + dst.name + "」" + (move ? "，并从源列表移除" : "") + "？")) return;
    cancelled = false;
    controller = new AbortController();
    startBtn.disabled = loadBtn.disabled = srcSel.disabled = dstSel.disabled = moveBox.disabled = true;
    cancelBtn.hidden = false;
    const failed = [];
    let done = 0;
    let reconciled = 0;
    let stopped = false;
    let destination;
    try {
      say("正在核对目标列表成员…");
      destination = new Set((await ttFetchMembers(dst.id, null, controller.signal)).map(m => m.id));
    } catch (err) {
      if (!cancelled) failed.push("读取目标列表失败，未执行迁移：" + err.message);
      stopped = true;
    }
    for (const m of todo) {
      if (cancelled || stopped) break;
      let inDestination = destination.has(m.id);
      try {
        if (!inDestination) {
          reconciled += Number(await ttVerifiedListMutation("ListAddMember", dst.id, m.id, controller.signal));
          destination.add(m.id);
          inDestination = true;
        }
        if (move) reconciled += Number(await ttVerifiedListMutation("ListRemoveMember", src.id, m.id, controller.signal));
      } catch (err) {
        if (controller.signal.aborted) break;
        failed.push("@" + m.handle + "：" + (inDestination && move ? "已在目标列表，源列表移除未完成。" : "未移除源列表成员。") + err.message);
        stopped = err.stopMigration || /\bDecodeException\b/.test(err.message) ||
          [400, 401, 403, 404, 429].includes(err.status);
      }
      done++;
      setBar((done / todo.length) * 100);
      say("进度 " + done + "/" + todo.length + "，失败 " + failed.length);
      if (stopped) break;
      try {
        await ttSleep(TT_LIST_DELAY, controller.signal);
      } catch {
        break;
      }
    }
    say(
      (cancelled || stopped ? "已停止。" : "完成。") + "处理 " + done + "/" + todo.length + "，成功 " + Math.max(0, done - failed.length) +
        "，失败 " + (done ? failed.length : 0) + (done < todo.length ? "，未处理 " + (todo.length - done) : "") +
        (failed.length ? "\n" + failed.join("\n") : "") +
        (reconciled ? "\n" + reconciled + " 次接口解码报错已通过成员复核确认成功。" : "")
    );
    cancelBtn.hidden = true;
    // A move changes source membership. Require a fresh load before another run.
    members = [];
    memberBox.hidden = actions.hidden = selectors.hidden = true;
    startBtn.disabled = loadBtn.disabled = srcSel.disabled = dstSel.disabled = false;
    sync();
  };
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "tt-open-lists") ttOpenListsTool();
});
