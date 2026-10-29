const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");
const helpers = load("src/settings.js", ["ttMetricNumber", "ttParseUser", "ttAuthorBadges", "ttParseViewCount", "ttAverageViewsPerHour", "ttFormatViewRate"]);
const now = Date.parse("2026-10-24T12:00:00Z");

const flags = { authorFollowers: true, authorLarge: true, authorVeteran: true };
test("author labels use exact thresholds and calendar anniversaries", () => {
  const user = { followers: 99999, createdAt: "2021-10-24T12:00:00Z" };
  assert.deepEqual(Array.from(helpers.ttAuthorBadges(user, flags, now), b => b.kind), ["followers", "veteran"]);
  assert.deepEqual(Array.from(helpers.ttAuthorBadges({ ...user, followers: 100000 }, flags, now - 1), b => b.kind), ["followers", "large"]);
  assert.equal(helpers.ttAuthorBadges(user, {}, now).length, 0);
  assert.equal(helpers.ttAuthorBadges({ followers: null, createdAt: null }, flags, now).length, 0);
  assert.equal(helpers.ttAuthorBadges({ createdAt: "2030-01-01" }, flags, now).length, 0);
  assert.equal(helpers.ttAuthorBadges({ followers: 0 }, flags, now)[0].text, "0粉丝");
});

test("new and legacy profiles expose follower counts and registration date without inventing missing data", () => {
  for (const profile of [
    { relationship_counts: { followers: 379000 }, core: { created_at: "Mon Oct 24 12:00:00 +0000 2016" } },
    { legacy: { followers_count: "379000", created_at: "2016-10-24T12:00:00Z" } },
  ]) {
    const user = helpers.ttParseUser({ __typename: "User", rest_id: "123", ...profile });
    assert.equal(user.followers, 379000);
    assert.equal(user.createdAt, "2016-10-24T12:00:00.000Z");
    assert.equal(helpers.ttAuthorBadges(user, flags, now)[0].text, "37.9万粉丝");
  }
  const user = helpers.ttParseUser({ __typename: "User", rest_id: "123", legacy: { followers_count: -1, created_at: "bad date" } });
  assert.equal(user.followers, null);
  assert.equal(user.createdAt, null);
  for (const bad of [null, "", " ", false, -1, 1.2, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(helpers.ttMetricNumber(bad), null);
});

test("view counts accept native exact labels and compact Chinese/English labels", () => {
  for (const [input, expected] of [["881494 次查看。查看帖子分析", 881494], ["1,234 Views", 1234], ["1.234 Mal angezeigt", 1234], ["20万", 200000], ["1.2M", 1200000], ["1,2 M", 1200000], ["1\u202f234", 1234], ["2.5億", 250000000], ["0", 0]]) {
    assert.equal(helpers.ttParseViewCount(input), expected, input);
  }
  for (const input of ["", null, "查看分析", "-1", "1.23 views", "1.2.3K"]) assert.equal(helpers.ttParseViewCount(input), null, String(input));
});

test("average rate uses elapsed time, never substitutes missing views or new/future timestamps", () => {
  assert.equal(helpers.ttAverageViewsPerHour(197400, "2026-10-24T05:00:00Z", now), 28200);
  assert.equal(helpers.ttFormatViewRate(28200), "28.2k/h");
  assert.equal(helpers.ttFormatViewRate(1200000), "1.2m/h");
  assert.equal(helpers.ttFormatViewRate(0), "0/h");
  for (const [views, date] of [[null, "2026-10-24T05:00:00Z"], [100, "bad"], [100, "2026-10-24T12:01:00Z"], [100, "2026-10-24T11:59:30Z"]]) assert.equal(helpers.ttAverageViewsPerHour(views, date, now), null);
});

class Element {
  constructor(tag, attrs = {}, text = "") { this.tagName = tag.toUpperCase(); this.attrs = attrs; this.textContent = text; this.children = []; this.parentElement = null; this.className = ""; }
  append(...nodes) { for (const node of nodes) { node.remove(); this.children.push(node); node.parentElement = this; } }
  remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
  insertBefore(node, next) { node.remove(); this.children.splice(this.children.indexOf(next), 0, node); node.parentElement = this; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  contains(node) { return !!node && (this === node || this.children.some(c => c.contains(node))); }
  get nextElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
  matches(selector) {
    if (selector.startsWith(".")) return this.className.split(" ").includes(selector.slice(1));
    const attr = selector.match(/^(\w+)?\[([^=*]+)(\*?=)"([^"]*)"\]$/);
    if (attr) return (!attr[1] || this.tagName === attr[1].toUpperCase()) && (attr[3] === "*=" ? this.attrs[attr[2]]?.includes(attr[4]) : this.attrs[attr[2]] === attr[4]);
    return this.tagName === selector.toUpperCase();
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function fixture() {
  const article = new Element("article", { "data-testid": "tweet" });
  const header = new Element("div");
  const name = new Element("div", { "data-testid": "User-Name" });
  const status = new Element("a", { href: "/example/status/123" });
  status.append(new Element("time", { datetime: new Date(Date.now() - 7 * 3600000).toISOString() }));
  name.append(status);
  const controls = new Element("div");
  controls.append(new Element("button", { "data-testid": "caret" }));
  header.append(name, controls);
  const views = new Element("a", { href: "/example/status/123/analytics", "aria-label": "197400 次查看" }, "20万");
  article.append(header, views);
  return { article, header, views, controls };
}
function setup(articles) {
  const enabled = new Set(["tt-postViewRate"]);
  const observed = new Set();
  const runtime = { id: "test" };
  const stopped = { mutations: false, interval: false, visibility: false };
  let intersect, refresh, mutate;
  const document = { documentElement: { classList: { contains: k => enabled.has(k) } }, hidden: false,
    querySelectorAll: () => articles, createElement: tag => new Element(tag), addEventListener() {},
    removeEventListener: () => { stopped.visibility = true; } };
  const api = load("src/insights.js", ["ttRateMetrics", "ttRateRender", "ttRateScan", "ttRateArticles", "ttRateVisible"], {
    ...helpers, document, requestAnimationFrame: fn => fn(), setInterval: fn => { refresh = fn; return 1; },
    clearInterval: () => { stopped.interval = true; },
    ttAlive: load("src/settings.js", ["ttAlive"], { chrome: { runtime } }).ttAlive,
    MutationObserver: class { constructor(fn) { mutate = fn; } observe() {} disconnect() { stopped.mutations = true; } },
    IntersectionObserver: class { constructor(fn) { intersect = fn; } observe(a) { observed.add(a); } unobserve(a) { observed.delete(a); } disconnect() { observed.clear(); } },
  });
  return { api, enabled, observed, document, runtime, stopped, mutate: () => mutate(), refresh: () => refresh(), intersect: a => intersect([{ target: a, isIntersecting: true }]) };
}

test("rate pills use the matching post's exact views, update in place and never duplicate", () => {
  const { article, header, views, controls } = fixture();
  const env = setup([article]);
  env.intersect(article);
  const badge = article.querySelector(".tt-post-rate");
  assert.equal(badge.textContent, "🔥 28.2k/h");
  assert.equal(badge.nextElementSibling, controls);
  env.api.ttRateScan();
  assert.equal(header.querySelectorAll(".tt-post-rate").length, 1);
  views.attrs["aria-label"] = "394800 次查看";
  env.refresh();
  assert.equal(badge.textContent, "🔥 56.4k/h");
  env.enabled.clear();
  env.api.ttRateScan();
  assert.equal(article.querySelector(".tt-post-rate"), null);
  assert.equal(env.observed.size, 0);
});

test("quoted timestamps and metrics from other posts cannot generate a wrong rate", () => {
  const { article, header, views } = fixture();
  const quote = new Element("div", { role: "link" });
  const link = new Element("a", { href: "/other/status/999" });
  link.append(new Element("time", { datetime: "2000-01-01T00:00:00Z" }));
  quote.append(link);
  article.insertBefore(quote, header);
  const env = setup([article]);
  assert.equal(env.api.ttRateMetrics(article).count, 197400);
  views.attrs.href = "/other/status/999/analytics";
  assert.equal(env.api.ttRateMetrics(article), null);
});

test("removed or hidden posts release observers and do not refresh in the background", () => {
  const { article } = fixture();
  const articles = [article];
  const env = setup(articles);
  env.intersect(article);
  env.document.hidden = true;
  article.querySelector(".tt-post-rate").textContent = "unchanged";
  env.refresh();
  assert.equal(article.querySelector(".tt-post-rate").textContent, "unchanged");
  articles.length = 0;
  env.api.ttRateScan();
  assert.equal(env.api.ttRateArticles.size, 0);
  assert.equal(env.api.ttRateVisible.size, 0);
  assert.equal(env.observed.size, 0);
});

test("an orphaned copy after an extension reload stops observing and refreshing", () => {
  const { article } = fixture();
  const env = setup([article]);
  env.intersect(article);
  const badge = article.querySelector(".tt-post-rate");
  badge.textContent = "left for the new copy";
  delete env.runtime.id;
  env.refresh();
  assert.equal(badge.textContent, "left for the new copy");
  assert.deepEqual(env.stopped, { mutations: true, interval: true, visibility: true });
  assert.equal(env.observed.size, 0);
  assert.equal(env.api.ttRateVisible.size, 0);
  env.mutate();
  assert.equal(env.api.ttRateArticles.size, 0);
});
