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
