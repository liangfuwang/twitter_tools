const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

function setup(withText) {
  const links = new Map();
  class Link {
    constructor() {
      this.attrs = { "data-testid": "AppTabBar_Explore_Link", "aria-current": "page" };
      this.firstElementChild = { style: {} };
      this.text = withText ? { textContent: "探索" } : null;
      this.path = { setAttribute: (key, value) => { this.icon = value; } };
      this.events = {};
    }
    cloneNode() { return new Link(); }
    querySelector(selector) { return selector === "svg path" ? this.path : this.text; }
    setAttribute(key, value) { this.attrs[key] = value; }
    removeAttribute(key) { delete this.attrs[key]; }
    addEventListener(key, value) { this.events[key] = value; }
    remove() { links.delete(this.attrs["data-tt-inject"]); }
  }
  const template = new Link();
  const nav = { querySelector(selector) {
    if (selector.includes("Explore_Link")) return template;
    if (selector.includes("More_Menu")) return { before: link => links.set(link.attrs["data-tt-inject"], link) };
    if (selector.includes("Profile_Link")) return { getAttribute: () => "/viewer" };
    return links.get(/data-tt-inject="([^"]+)"/.exec(selector)?.[1]) || null;
  } };
  const defaults = { navLists: true, hideBadges: false };
  const { ttApply, ttInject } = load("src/content.js", ["ttApply", "ttInject"], {
    TT_DEFAULTS: defaults,
    TT_SECTIONS: [{ options: [{ key: "navLists", label: "列表", inject: "{user}/lists" }] }],
    ttLoadSettings: () => new Promise(() => {}),
    document: { documentElement: { classList: { toggle() {} } }, querySelector: () => nav },
    chrome: { storage: { onChanged: { addListener() {} } } },
    MutationObserver: class { observe() {} },
    getComputedStyle: el => { assert.ok(el); return { color: "rgb(15, 20, 25)" }; },
  });
  return { links, show: () => ttApply({ ...defaults, navLists: false }), hide: () => ttApply(defaults), inject: ttInject };
}

for (const withText of [false, true]) {
  test(`list shortcut supports ${withText ? "labelled" : "icon-only"} native navigation`, () => {
    const env = setup(withText);
    env.show();
    const link = env.links.get("navLists");
    assert.ok(link);
    assert.equal(link.attrs.href, "/viewer/lists");
    assert.equal(link.attrs["aria-label"], "列表");
    assert.equal(link.attrs["data-testid"], undefined);
    assert.equal(link.attrs["aria-current"], undefined);
    if (withText) assert.equal(link.text.textContent, "列表");
    assert.doesNotThrow(() => link.events.mouseenter());
    assert.match(link.firstElementChild.style.backgroundColor, /10%/);
    env.inject();
    assert.equal(env.links.size, 1);
    env.links.clear(); // X replaces the navigation tree.
    env.inject();
    assert.equal(env.links.size, 1);
    env.hide();
    assert.equal(env.links.size, 0);
  });
}
