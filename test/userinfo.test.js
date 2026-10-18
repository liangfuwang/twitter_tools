const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup({ query = async () => ({ data: {} }), sleep = async () => {} } = {}) {
  const articles = [];
  const flags = new Set(["tt-quickFollow"]);
  const observed = new Set();
  let intersect;
  const document = {
    documentElement: { classList: { contains: key => flags.has(key) } },
    querySelector: () => null,
    querySelectorAll: selector => selector.startsWith("article") ? articles : [],
    addEventListener() {},
  };
  const api = load("src/userinfo.js", ["ttUiScan", "ttUiQueue", "ttUiArticles", "ttUiHeader"], {
    document, location: { pathname: "/home" },
    chrome: { storage: { local: { get: async () => ({}), set: async () => {} } } },
    MutationObserver: class { observe() {} },
    IntersectionObserver: class {
      constructor(fn) { intersect = fn; }
      observe(article) { observed.add(article); }
      unobserve(article) { observed.delete(article); }
    },
    requestAnimationFrame: fn => setImmediate(fn),
    ttNoteHandle: box => box.handle,
    ttParseUser: () => null,
    ttGql: query, ttSleep: sleep, setTimeout, clearTimeout,
  });
  function article(handle) {
    return { isConnected: true, querySelector: selector => selector.includes("User-Name") ? { handle } : null };
  }
  return { api, articles, flags, observed, article, intersect: entries => intersect(entries) };
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
