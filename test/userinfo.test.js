const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup({ query = async () => ({ data: {} }), sleep = async () => {},
  back = async () => ({ user: {}, status: "done" }), follow = async () => ({ user: {}, status: "done" }),
  viewer = () => "viewer", cache = {} } = {}) {
  const articles = [];
  const flags = new Set(["tt-quickFollow"]);
  const observed = new Set();
  let intersect;
  const document = {
    documentElement: { classList: { contains: key => flags.has(key) } },
    querySelector: () => null,
    querySelectorAll: selector => selector.startsWith("article") ? articles : [],
    createElement: element,
    addEventListener() {},
  };
  const api = load("src/userinfo.js", ["ttUiScan", "ttUiQueue", "ttUiArticles", "ttUiHeader", "ttUiSyncFollowBack", "ttUiCacheUser", "ttUiFresh", "ttUiFollowBack", "ttUiBackState", "ttUiFollow", "ttUiRender"], {
    document, location: { pathname: "/home" },
    chrome: { storage: { local: { get: async () => ({ ttUserCache: cache }), set: async () => {} } } },
    MutationObserver: class { observe() {} },
    IntersectionObserver: class {
      constructor(fn) { intersect = fn; }
      observe(article) { observed.add(article); }
      unobserve(article) { observed.delete(article); }
    },
    requestAnimationFrame: fn => setImmediate(fn),
    ttNoteHandle: box => box.handle,
    ttNoteNameBox: box => box,
    ttOwnId: viewer,
    ttFollowBackUser: back,
    ttFollowAndNotifyUser: follow,
    ttParseUser: () => null,
    ttGql: query, ttSleep: sleep, setTimeout: () => 0, clearTimeout,
  });
  function article(handle) {
    return { isConnected: true, querySelector: selector => selector.includes("User-Name") ? { handle, querySelector: () => null } : null };
  }
  return { api, articles, flags, observed, article, intersect: entries => intersect(entries) };
}

function nameBox() {
  return {
    current: null,
    querySelector() { return this.current; },
    append(el) { this.current = el; el.parent = this; },
  };
}

function element(tag) {
  let text = "";
  return {
    tagName: tag.toUpperCase(), dataset: {}, children: [],
    set textContent(value) { text = value; this.children = []; },
    get textContent() { return text; },
    append(el) { this.children.push(el); el.parent = this; },
    remove() { this.parent.current = null; },
    replaceWith(el) { this.parent.append(el); },
  };
}

test("removed timeline articles are released by the intersection observer", async () => {
  const env = setup();
  await tick();
  const article = env.article("Jack");
  env.articles.push(article);
  env.api.ttUiScan();
  assert.ok(env.observed.has(article));
  env.articles.length = 0;
  article.isConnected = false;
  env.api.ttUiScan();
  assert.equal(env.observed.size, 0);
  assert.equal(env.api.ttUiArticles.size, 0);
});

test("disabling and re-enabling author info re-observes existing posts", async () => {
  const env = setup();
  await tick();
  const article = env.article("Jack");
  env.articles.push(article);
  env.api.ttUiScan();
  env.flags.clear();
  env.api.ttUiScan();
  assert.equal(env.observed.size, 0);
  env.flags.add("tt-quickFollow");
  env.api.ttUiScan();
  assert.ok(env.observed.has(article));
});

test("scrolling away while rate limited drains the queue without a crash or extra fetch", async () => {
  let calls = 0;
  let release;
  const env = setup({
    query: async () => { calls++; throw Object.assign(new Error("limited"), { status: 429 }); },
    sleep: ms => ms > 300 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(),
  });
  await tick();
  const article = env.article("Jack");
  env.articles.push(article);
  env.api.ttUiScan();
  env.intersect([{ target: article, isIntersecting: true }]);
  await tick();
  assert.equal(typeof release, "function");
  env.intersect([{ target: article, isIntersecting: false }]);
  assert.equal(env.api.ttUiQueue.size, 0);
  release();
  await tick();
  assert.equal(calls, 1);
});

test("a missing post header is tolerated during X re-renders", () => {
  const { api } = setup();
  assert.equal(api.ttUiHeader({ querySelector: () => null }), null);
});

test("follow-back is offered beside a follower's name and disappears when disabled", () => {
  const env = setup();
  env.flags.add("tt-followBack");
  const box = nameBox();
  const user = { id: "123", followedBy: true, followed: false };
  env.api.ttUiSyncFollowBack(box, "Jack", user);
  assert.equal(box.current.tagName, "BUTTON");
  assert.equal(box.current.textContent, "回关");
  assert.match(box.current.title, /发帖通知/);
  env.flags.delete("tt-followBack");
  env.api.ttUiSyncFollowBack(box, "Jack", user);
  assert.equal(box.current, null);
});

test("no follow-back action is shown for non-followers, blocked or already-followed users", () => {
  const env = setup();
  env.flags.add("tt-followBack");
  for (const user of [{ followedBy: false }, { followedBy: true, blocking: true }, { followedBy: true, followed: true }]) {
    const box = nameBox();
    env.api.ttUiSyncFollowBack(box, "Jack", user);
    assert.equal(box.current, null);
  }
});

test("partial success offers notification retry and confirmed success has a distinct label", () => {
  const env = setup();
  env.flags.add("tt-followBack");
  const box = nameBox();
  const user = { id: "123", followedBy: true, followed: true };
  env.api.ttUiBackState.set("jack", "notifyFailed");
  env.api.ttUiSyncFollowBack(box, "Jack", user);
  assert.equal(box.current.textContent, "开启通知");
  assert.match(box.current.title, /未确认/);
  env.api.ttUiBackState.set("jack", "done");
  env.api.ttUiSyncFollowBack(box, "Jack", user);
  assert.equal(box.current.tagName, "SPAN");
  assert.equal(box.current.textContent, "已回关 · 通知已开启");
});

test("private-account pending state lets the user check approval before enabling notifications", () => {
  const env = setup();
  env.flags.add("tt-followBack");
  const box = nameBox();
  env.api.ttUiSyncFollowBack(box, "Jack", { followedBy: true, requested: true });
  assert.equal(box.current.tagName, "BUTTON");
  assert.equal(box.current.textContent, "已申请 · 待批准");
  assert.match(box.current.title, /审批/);
});

test("duplicate clicks for the same account start only one operation", async () => {
  let release;
  let calls = 0;
  const env = setup({ back: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  await tick();
  const user = { id: "123", followedBy: true, followed: false };
  env.api.ttUiCacheUser("jack", user);
  const first = env.api.ttUiFollowBack("Jack");
  await env.api.ttUiFollowBack("jack");
  assert.equal(calls, 1);
  release({ user: { ...user, followed: true }, status: "done" });
  await first;
  assert.equal(env.api.ttUiBackState.get("jack"), "done");
});

test("old-schema and other-login cached relationships must be refreshed", async () => {
  let viewer = "first";
  const env = setup({ viewer: () => viewer, cache: { jack: { t: Date.now(), u: { id: "123" } } } });
  await tick();
  assert.equal(env.api.ttUiFresh("jack"), false);
  env.api.ttUiCacheUser("jack", { id: "123", followedBy: true });
  assert.equal(env.api.ttUiFresh("jack"), true);
  viewer = "second";
  assert.equal(env.api.ttUiFresh("jack"), false);
});

test("notification retry survives a page reload for the same signed-in account", async () => {
  const user = { id: "123", followedBy: true, followed: true };
  const env = setup({ cache: { jack: { v: 2, owner: "viewer", t: Date.now(), u: user, backStatus: "notifyFailed" } } });
  env.flags.add("tt-followBack");
  await tick();
  const box = nameBox();
  env.api.ttUiSyncFollowBack(box, "Jack", user);
  assert.equal(box.current.tagName, "BUTTON");
  assert.equal(box.current.textContent, "开启通知");
});

test("ordinary follow uses the combined operation with follow-back disabled and deduplicates clicks", async () => {
  const user = { id: "123", followedBy: false, followed: false };
  let calls = 0;
  let release;
  const env = setup({ follow: (handle, id) => {
    assert.equal(handle, "Jack");
    assert.equal(id, "123");
    calls++;
    return new Promise(resolve => { release = resolve; });
  }, back: () => { throw new Error("wrong operation"); } });
  await tick();
  env.api.ttUiCacheUser("jack", user);
  const button = { dataset: { ttHandle: "Jack" }, disabled: false };
  const first = env.api.ttUiFollow(button);
  await env.api.ttUiFollow(button);
  assert.equal(calls, 1);
  const busyBlock = element("div");
  env.api.ttUiRender(busyBlock, "Jack", user);
  assert.equal(busyBlock.children[0].children[0].textContent, "处理中…");
  assert.equal(busyBlock.children[0].children[0].disabled, true);
  release({ user: { ...user, followed: true }, status: "done" });
  await first;
  const block = element("div");
  env.api.ttUiRender(block, "Jack", { ...user, followed: true });
  assert.equal(block.children[0].children[0].tagName, "SPAN");
  assert.equal(block.children[0].children[0].textContent, "已关注 · 通知已开启");
});

test("ordinary follow renders pending approval and restores notification retry after reload", async () => {
  const user = { id: "123", followedBy: false, followed: true };
  const env = setup({ cache: { jack: { v: 2, owner: "viewer", t: Date.now(), u: user, backStatus: "notifyFailed" } } });
  await tick();
  const block = element("div");
  env.api.ttUiRender(block, "Jack", user);
  assert.equal(block.children[0].children[0].textContent, "开启通知");
  assert.match(block.children[0].children[0].title, /已关注，通知未确认/);
  env.api.ttUiRender(block, "Jack", { ...user, followed: false, requested: true });
  assert.equal(block.children[0].children[0].textContent, "已申请 · 待批准");
  assert.equal(block.children[0].children[0].tagName, "BUTTON");
});

test("ordinary follow failure keeps a retry button and explains the notification action", async () => {
  const user = { id: "123", followedBy: false, followed: false };
  const env = setup({ follow: async () => { throw new Error("denied"); } });
  await tick();
  env.api.ttUiCacheUser("jack", user);
  const block = element("div");
  env.api.ttUiRender(block, "Jack", user);
  assert.match(block.children[0].children[0].title, /关注并开启对方的发帖通知/);
  await env.api.ttUiFollow({ dataset: { ttHandle: "Jack" } });
  env.api.ttUiRender(block, "Jack", user);
  assert.equal(block.children[0].children[0].textContent, "重试关注");
  assert.equal(block.children[0].children[0].disabled, false);
});
