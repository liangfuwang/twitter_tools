const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup({ query = async () => ({ data: {} }), sleep = async () => {},
  follow = async () => ({ user: {}, status: "done" }),
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
  const api = load("src/userinfo.js", ["ttUiScan", "ttUiQueue", "ttUiArticles", "ttUiHeader", "ttUiCacheUser", "ttUiFresh", "ttUiFollow", "ttUiRender"], {
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
    ttOwnId: viewer,
    ttFollowAndNotifyUser: follow,
    ttParseUser: () => null,
    ttGql: query, ttSleep: sleep, setTimeout: () => 0, clearTimeout,
  });
  function article(handle) {
    return { isConnected: true, querySelector: selector => selector.includes("User-Name") ? { handle, querySelector: () => null } : null };
  }
  return { api, articles, flags, observed, article, intersect: entries => intersect(entries) };
}

function element(tag) {
  let text = "";
  return {
    tagName: tag.toUpperCase(), dataset: {}, children: [],
    set textContent(value) { text = value; this.children = []; },
    get textContent() { return text; },
    append(el) { this.children.push(el); },
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

test("old-schema and other-login cached relationships must be refreshed", async () => {
  let viewer = "first";
  const env = setup({ viewer: () => viewer, cache: { jack: { t: Date.now(), u: { id: "123" } } } });
  await tick();
  assert.equal(env.api.ttUiFresh("jack"), false);
  env.api.ttUiCacheUser("jack", { id: "123" });
  assert.equal(env.api.ttUiFresh("jack"), true);
  viewer = "second";
  assert.equal(env.api.ttUiFresh("jack"), false);
});

test("follow uses the combined operation and deduplicates clicks", async () => {
  const user = { id: "123", followed: false };
  let calls = 0;
  let release;
  const env = setup({ follow: (handle, id) => {
    assert.equal(handle, "Jack");
    assert.equal(id, "123");
    calls++;
    return new Promise(resolve => { release = resolve; });
  } });
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

test("follow renders pending approval and restores notification retry after reload", async () => {
  const user = { id: "123", followed: true };
  const env = setup({ cache: { jack: { v: 2, owner: "viewer", t: Date.now(), u: user, followStatus: "notifyFailed" } } });
  await tick();
  const block = element("div");
  env.api.ttUiRender(block, "Jack", user);
  assert.equal(block.children[0].children[0].textContent, "开启通知");
  assert.match(block.children[0].children[0].title, /已关注，通知未确认/);
  env.api.ttUiRender(block, "Jack", { ...user, followed: false, requested: true });
  assert.equal(block.children[0].children[0].textContent, "已申请 · 待批准");
  assert.equal(block.children[0].children[0].tagName, "BUTTON");
});

test("follow failure keeps a retry button and explains the notification action", async () => {
  const user = { id: "123", followed: false };
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

test("follow failure displays the refusal code without exposing raw server text", async () => {
  const user = { id: "123", followed: false };
  const env = setup({ follow: async () => { throw Object.assign(new Error("private response text"), { status: 403, apiCode: 226 }); } });
  await tick();
  env.api.ttUiCacheUser("jack", user);
  await env.api.ttUiFollow({ dataset: { ttHandle: "Jack" } });
  const block = element("div");
  env.api.ttUiRender(block, "Jack", user);
  assert.match(block.children[1].textContent, /HTTP 403，错误码 226/);
  assert.match(block.children[0].children[0].title, /页面原生关注按钮/);
  assert.doesNotMatch(block.children[1].textContent, /private response/);
});

test("follow rate limits and login failures are distinguished and cleared after success", async () => {
  for (const [status, expected] of [[429, /请求频繁/], [401, /登录状态已失效/]]) {
    let fail = true;
    const user = { id: "123", followed: false };
    const env = setup({ follow: async () => {
      if (fail) throw Object.assign(new Error("HTTP " + status), { status });
      return { user: { ...user, followed: true }, status: "done" };
    } });
    await tick();
    env.api.ttUiCacheUser("jack", user);
    const button = { dataset: { ttHandle: "Jack" } };
    await env.api.ttUiFollow(button);
    const block = element("div");
    env.api.ttUiRender(block, "Jack", user);
    assert.match(block.children[1].textContent, expected);
    fail = false;
    await env.api.ttUiFollow(button);
    env.api.ttUiRender(block, "Jack", { ...user, followed: true });
    assert.equal(block.children.length, 1);
    assert.equal(block.children[0].children[0].textContent, "已关注 · 通知已开启");
  }
});
