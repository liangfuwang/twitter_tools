const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

test("an orphaned copy after an extension reload stops rewriting pills and opening the editor", () => {
  const runtime = { id: "test" };
  const observers = [];
  let click, created = 0, scans = 0;
  load("src/notes.js", [], {
    document: {
      documentElement: { classList: { contains: () => true } },
      addEventListener: (type, fn) => { if (type === "click") click = fn; },
      querySelectorAll: () => { scans++; return []; },
      querySelector: () => null,
      createElement: () => { created++; return {}; },
    },
    chrome: { runtime, storage: { local: { get: () => new Promise(() => {}) }, onChanged: { addListener() {} } } },
    ...load("src/settings.js", ["ttAlive", "TT_NOTES_KEY"], { chrome: { runtime } }),
    requestAnimationFrame: fn => fn(),
    MutationObserver: class {
      constructor(fn) { this.fire = fn; this.disconnected = false; observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
  });
  observers[1].fire();
  assert.ok(scans > 0);
  delete runtime.id;
  const before = scans;
  observers[1].fire();
  assert.equal(scans, before);
  assert.deepEqual(observers.map(o => o.disconnected), [true, true]);
  let prevented = false;
  click({ target: { closest: () => ({ dataset: { ttHandle: "jack" } }) }, preventDefault: () => { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, false);
  assert.equal(created, 0);
});
