const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

function setup({ reply, fetch = async () => response({ data: {} }), ...extra } = {}) {
  const listeners = new Set();
  let requests = 0;
  const document = {
    cookie: "ct0=test; twid=u%3D123",
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
    dispatchEvent() {
      requests++;
      const data = reply ? reply(requests) : {
        bearer: "test-only",
        ops: { Test: { id: "test-query", features: [], toggles: [] } },
      };
      if (data !== undefined) for (const fn of [...listeners]) fn({ detail: typeof data === "string" ? data : JSON.stringify(data) });
    },
  };
  const api = load("src/x-api.js", ["ttGetOps", "ttGql", "ttRestPost", "ttSleep", "ttWalk"], {
    document, CustomEvent: class {}, setTimeout, clearTimeout, URLSearchParams, fetch, ...extra,
  });
  return { api, listeners, requests: () => requests };
}

function response(json, status = 200) {
  return { ok: status < 400, status, headers: { get: () => "12345" }, json: async () => json };
}

test("bridge refreshes synchronously returned metadata when a new operation appears", async () => {
  const { api, requests } = setup({ reply: n => ({
    bearer: "test-only",
    ops: n === 1 ? { First: {} } : { Second: {} },
  }) });
  await api.ttGetOps(["First"]);
  const data = await api.ttGetOps(["Second"]);
  assert.ok(data.ops.First);
  assert.ok(data.ops.Second);
  assert.equal(requests(), 2);
});

test("malformed bridge JSON rejects and allows a clean retry", async () => {
  const { api, listeners } = setup({ reply: n => n === 1 ? "{" : { bearer: "test-only", ops: {} } });
  await assert.rejects(api.ttGetOps());
  assert.equal(listeners.size, 0);
  await api.ttGetOps();
});

test("bridge timeout removes its response listener", async () => {
  let timeout;
  const { api, listeners } = setup({ reply: () => undefined, setTimeout: fn => { timeout = fn; }, clearTimeout() {} });
  const pending = api.ttGetOps();
  assert.equal(listeners.size, 1);
  timeout();
  await assert.rejects(pending, /无法读取/);
  assert.equal(listeners.size, 0);
});

test("GraphQL partial mutation errors are failures even with data present", async () => {
  const { api } = setup({ fetch: async () => response({ data: { result: null }, errors: [{ message: "add failed" }] }) });
  await assert.rejects(api.ttGql("Test", {}, true), /add failed/);
});

test("REST errors in a successful HTTP response are failures", async () => {
  const { api } = setup({ fetch: async () => response({ errors: [{ message: "follow denied" }] }) });
  await assert.rejects(api.ttRestPost("friendships/create.json", {}), /follow denied/);
});

test("background requests expose rate limits without retrying", async () => {
  let calls = 0;
  const { api } = setup({ fetch: async () => { calls++; return response(null, 429); } });
  await assert.rejects(api.ttGql("Test", {}, false, { retry: false }), e => e.status === 429 && e.resetAt === 12345);
  assert.equal(calls, 1);
});

test("cancel interrupts rate-limit backoff and prevents another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  let waiting;
  const paused = new Promise(resolve => { waiting = resolve; });
  const { api } = setup({
    fetch: async () => { calls++; return response(null, 429); },
    setTimeout(fn, ms) { if (ms === 30000) waiting(); return setTimeout(fn, ms); },
  });
  const pending = api.ttGql("Test", {}, true, { signal: controller.signal });
  await paused;
  controller.abort();
  await assert.rejects(pending, e => e.name === "AbortError");
  assert.equal(calls, 1);
});

test("an already cancelled migration sends no API request", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const { api } = setup({ fetch: async () => { calls++; return response({}); } });
  await assert.rejects(api.ttGql("Test", {}, true, { signal: controller.signal }), e => e.name === "AbortError");
  assert.equal(calls, 0);
});
