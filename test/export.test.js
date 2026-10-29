const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

for (const kind of ["share", "retweet", "unretweet", "grok", "caret"]) {
  test(`export items are considered only for the share action: ${kind}`, () => {
    let click;
    let menuLookups = 0;
    const api = load("src/export.js", ["ttInjectExport"], {
      document: {
        documentElement: {},
        addEventListener: (_, fn) => { click = fn; },
        querySelector: () => { menuLookups++; return null; },
      },
      MutationObserver: class { observe() {} },
    });
    const button = {
      isConnected: true,
      getAttribute: () => "true",
      matches: selector => kind === "caret" && selector.includes("caret"),
      closest: selector => {
        if (selector === '[role="group"]') return ["share", "retweet", "unretweet"].includes(kind) ? {} : null;
        if (selector.startsWith("[data-testid=")) return kind !== "share" && selector.includes(`"${kind}"`) ? {} : null;
        return {};
      },
    };
    click({ target: { closest: () => button } });
    api.ttInjectExport();
    assert.equal(menuLookups, kind === "share" ? 1 : 0);
  });
}

function mediaHarness() {
  const make = (tagName, attributes = {}) => ({
    tagName,
    attributes,
    children: [],
    style: {},
    append(child) { this.children.push(child); },
    getAttribute(name) { return this.attributes[name] || null; },
    querySelector(selector) { return selector === "video" ? this.children.find(child => child.tagName === "VIDEO") || null : null; },
    replaceWith(replacement) { this.replacement = replacement; },
  });
  const api = load("src/export.js", ["ttStaticMedia"], {
    document: { documentElement: {}, addEventListener() {}, createElement: tag => make(tag.toUpperCase()) },
    MutationObserver: class { observe() {} },
  });
  return { make, ...api };
}

test("video frames are replaced by a poster and original-post link, including nested players", () => {
  const { make, ttStaticMedia } = mediaHarness();
  const video = make("VIDEO", { poster: "https://pbs.twimg.com/cover.jpg" });
  Object.defineProperty(video, "currentSrc", { get() { throw new Error("must not read video frames"); } });
  const player = make("DIV");
  player.append(video);
  const copy = {
    querySelectorAll: () => [player, video],
    contains: node => node === player || !player.replacement,
  };
  ttStaticMedia(copy, "https://x.com/example/status/123");
  assert.equal(video.replacement, undefined, "removed player's descendants must be skipped");
  assert.equal(player.replacement.children[0].tagName, "IMG");
  assert.equal(player.replacement.children[0].src, "https://pbs.twimg.com/cover.jpg");
  assert.equal(player.replacement.children[1].href, "https://x.com/example/status/123");
  assert.match(player.replacement.children[1].textContent, /视频/);
});

for (const kind of ["VIDEO", "CANVAS", "IFRAME"]) {
  test(`${kind} without a safe cover exports an explicit placeholder without reading pixels`, () => {
    const { make, ttStaticMedia } = mediaHarness();
    const media = make(kind, { poster: "blob:cross-origin-resource" });
    const copy = { querySelectorAll: () => [media], contains: () => true };
    ttStaticMedia(copy, "https://x.com/example/status/123");
    assert.equal(media.replacement.children.length, 1);
    assert.equal(media.replacement.children[0].tagName, "A");
    assert.match(media.replacement.children[0].textContent, /请查看原帖/);
  });
}

test("an orphaned copy after an extension reload stops adding menu items", () => {
  let click, fire, disconnected = false, menuLookups = 0;
  const runtime = { id: "test" };
  load("src/export.js", [], {
    document: {
      documentElement: {},
      addEventListener: (_, fn) => { click = fn; },
      querySelector: () => { menuLookups++; return null; },
    },
    ttAlive: load("src/settings.js", ["ttAlive"], { chrome: { runtime } }).ttAlive,
    requestAnimationFrame: fn => fn(),
    MutationObserver: class { constructor(fn) { fire = fn; } observe() {} disconnect() { disconnected = true; } },
  });
  const share = { isConnected: true, getAttribute: () => "true", closest: s => s.startsWith("[data-testid=") ? null : {} };
  click({ target: { closest: () => share } });
  fire();
  assert.equal(menuLookups, 1);
  delete runtime.id;
  fire();
  assert.equal(disconnected, true);
  assert.equal(menuLookups, 1);
});
