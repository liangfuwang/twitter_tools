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
  const api = load("src/x-api.js", ["ttGetOps", "ttGql", "ttRestPost", "ttSleep", "ttWalk", "ttFetchLists"], {
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

test("partial tolerance is limited to list overview decoding errors, never other queries or mutations", async () => {
  const partial = { data: { ok: true }, errors: [{ message: "DecodeException" }] };
  const { api } = setup({ fetch: async () => response(partial), reply: () => ({ bearer: "test-only", ops: {
    Test: { id: "test-query", features: [], toggles: [] },
    ListsManagementPageTimeline: { id: "lists-query", features: [], toggles: [] },
  } }) });
  assert.equal((await api.ttGql("ListsManagementPageTimeline", {}, false, { allowPartial: true })).data.ok, true);
  await assert.rejects(api.ttGql("Test", {}, false, { allowPartial: true }), /DecodeException/);
  await assert.rejects(api.ttGql("Test", {}, false), /DecodeException/);
  await assert.rejects(api.ttGql("ListsManagementPageTimeline", {}, true, { allowPartial: true }), /DecodeException/);
  const empty = setup({ fetch: async () => response({ errors: [{ message: "no data" }] }) });
  await assert.rejects(empty.api.ttGql("Test", {}, false, { allowPartial: true }), /no data/);
});

test("list overview rejects authentication errors and decoding errors without valid lists", async () => {
  const list = { __typename: "TimelineTwitterList", list: { id_str: "1", name: "Example" } };
  for (const json of [
    { data: { list }, errors: [{ message: "Unauthorized" }] },
    { data: { list }, errors: [{ message: "DecodeException" }, { message: "Unauthorized" }] },
    { data: {}, errors: [{ message: "DecodeException" }] },
    { data: { malformed: { __typename: "TimelineTwitterList", list: { id_str: "1" } } }, errors: [{ message: "DecodeException" }] },
  ]) {
    const { api } = setup({
      reply: () => ({ bearer: "test-only", ops: { ListsManagementPageTimeline: { id: "lists-query", features: [], toggles: [] } } }),
      fetch: async () => response(json),
    });
    await assert.rejects(api.ttFetchLists());
  }
});

test("list overview keeps partial data and reports it", async () => {
  const list = (id, owner) => ({ __typename: "TimelineTwitterList", list: { id_str: id, name: id, member_count: 1, user_results: { result: { rest_id: owner } } } });
  const { api } = setup({
    reply: () => ({ bearer: "test-only", ops: { ListsManagementPageTimeline: { id: "lists-query", features: [], toggles: [] } } }),
    fetch: async () => response({ data: { a: list("mine", "123"), b: list("other", "999") }, errors: [{ message: "DecodeException" }] }),
  });
  const { lists, partial } = await api.ttFetchLists();
  assert.equal(partial, true);
  assert.equal(JSON.stringify(lists.map((l) => [l.id, l.mine])), JSON.stringify([["mine", true], ["other", false]]));
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

test("REST rejections preserve HTTP status and X error code for follow diagnostics", async () => {
  const { api } = setup({ fetch: async () => response({ errors: [{ code: 226, message: "Request refused" }] }, 403) });
  await assert.rejects(api.ttRestPost("friendships/create.json", { user_id: "123" }),
    error => error.status === 403 && error.apiCode === 226 && error.message === "Request refused");
});

test("GraphQL pre-follow errors preserve HTTP status and X error code", async () => {
  const { api } = setup({ fetch: async () => response({ errors: [{ code: 89, message: "Invalid session" }] }, 401) });
  await assert.rejects(api.ttGql("Test", {}, false), error => error.status === 401 && error.apiCode === 89);
});

test("GraphQL uses actual true/false feature values and keeps unknown experiments off for reads and writes", async () => {
  const calls = [];
  const { api } = setup({
    reply: () => ({ bearer: "test-only", ops: { Test: {
      id: "test-query", features: ["enabled", "disabled", "unknown", "nonBoolean"], toggles: ["extra"],
      featureValues: { enabled: true, disabled: false, nonBoolean: "true" },
    } } }),
    fetch: async (url, options) => { calls.push({ url, options }); return response({ data: {} }); },
  });
  await api.ttGql("Test", { listId: "1", userId: "2" }, false);
  await api.ttGql("Test", { listId: "1", userId: "2" }, true);
  const query = new URL(calls[0].url, "https://x.com").searchParams;
  const post = JSON.parse(calls[1].options.body);
  const expected = { enabled: true, disabled: false, unknown: false, nonBoolean: false };
  assert.deepEqual(JSON.parse(query.get("features")), expected);
  assert.deepEqual(post.features, expected);
  assert.deepEqual(post.variables, { listId: "1", userId: "2" });
  assert.deepEqual(post.fieldToggles, { extra: false });
});

test("list writes refresh page feature values rather than reusing cached account flags", async () => {
  const values = [];
  const { api, requests } = setup({
    reply: n => ({ bearer: "test-only", ops: { ListAddMember: {
      id: "test-query", features: ["experiment"], toggles: [], featureValues: { experiment: n === 1 },
    } } }),
    fetch: async (url, options) => { values.push(JSON.parse(options.body).features.experiment); return response({ data: {} }); },
  });
  await api.ttGql("ListAddMember", {}, true);
  await api.ttGql("ListAddMember", {}, true);
  assert.deepEqual(values, [true, false]);
  assert.equal(requests(), 2);
});
