const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");
const { ttWalk } = load("src/x-api.js", ["ttWalk"]);

// Small DOM double for the migration dialog; API calls below never leave this process.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.selectedIndex = 0; }
  append(...nodes) {
    for (const node of nodes) {
      this.children.push(node);
      if (typeof node === "object") node.parentElement = this;
    }
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this);
    this.parentElement = null;
  }
  addEventListener() {}
  get isConnected() { return Boolean(this.parentElement); }
  get firstChild() { return this.children[0]; }
  get options() { return this.children.filter(node => node.tagName === "option"); }
  get value() { return this.tagName === "select" ? this.options[this.selectedIndex]?.value || "" : this._value; }
  set value(value) {
    if (this.tagName === "select") this.selectedIndex = this.options.findIndex(node => node.value === value);
    else this._value = value;
  }
  querySelectorAll(tag) {
    return this.children.filter(node => typeof node === "object")
      .flatMap(node => [...(node.tagName === tag ? [node] : []), ...node.querySelectorAll(tag)]);
  }
}

async function setup(mutate = async () => ({ data: {} }), options = {}) {
  const body = new Element("body");
  const calls = [];
  const user = id => ({ __typename: "User", rest_id: id, core: { name: "User", screen_name: "testuser" + id } });
  const state = new Map([
    ["source", (options.source || ["123"]).map(user)],
    ["target", (options.target || []).map(user)],
  ]);
  const api = load("src/lists.js", ["ttOpenListsTool"], {
    document: { body, createElement: tag => new Element(tag) },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    AbortController, confirm: () => true, ttSleep: async () => {}, ttWalk,
    ttFetchLists: async () => ({ lists: [
      { id: "source", name: "Source", count: 1, mine: true },
      { id: "target", name: "Target", count: 0, mine: true },
    ], partial: false }),
    ttGql: async (name, vars, mutation, opts) => {
      opts?.signal?.throwIfAborted();
      if (!mutation) {
        await options.read?.(vars.listId, calls);
        return { data: { list: { members_timeline: { timeline: { instructions: [{ users: [...state.get(vars.listId)] }] } } } } };
      }
      calls.push({ name, vars: { ...vars } });
      const result = await mutate(name, vars, opts, state);
      if (options.apply !== false) {
        const users = state.get(vars.listId);
        if (name === "ListAddMember") users.push(user(vars.userId));
        else state.set(vars.listId, users.filter(u => u.rest_id !== vars.userId));
      }
      return result;
    },
  });
  await api.ttOpenListsTool();
  const button = text => body.querySelectorAll("button").find(node => node.textContent.startsWith(text));
  const selects = body.querySelectorAll("select");
  const move = body.querySelectorAll("input")[0];
  await button("加载成员").onclick();
  const status = () => body.querySelectorAll("div").find(node => node.className === "tt-status").textContent;
  return { body, button, selects, move, calls, state, status };
}

test("changing destination to source after loading cannot start a destructive move", async () => {
  const env = await setup();
  env.selects[1].value = "source";
  env.move.checked = true;
  await env.button("开始迁移").onclick();
  assert.deepEqual(env.calls, []);
});

test("failed destination insertion never removes the source member", async () => {
  const env = await setup(async () => { throw new Error("add failed"); });
  env.move.checked = true;
  await env.button("开始迁移").onclick();
  assert.deepEqual(env.calls.map(call => call.name), ["ListAddMember"]);
});

test("successful move adds to the destination before removing from the source", async () => {
  const env = await setup();
  env.move.checked = true;
  await env.button("开始迁移").onclick();
  assert.deepEqual(env.calls, [
    { name: "ListAddMember", vars: { listId: "target", userId: "123" } },
    { name: "ListRemoveMember", vars: { listId: "source", userId: "123" } },
  ]);
  await env.button("开始迁移").onclick();
  assert.equal(env.calls.length, 2, "another move requires reloading current source membership");
});

test("closing a running migration cancels the pending request and prevents source removal", async () => {
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  const env = await setup((_, __, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
    started();
  }));
  env.move.checked = true;
  const migrating = env.button("开始迁移").onclick();
  await pending;
  env.button("关闭").onclick();
  await migrating;
  assert.deepEqual(env.calls.map(call => call.name), ["ListAddMember"]);
  assert.equal(env.body.children.length, 0);
});

test("a systemic decoding failure stops after one member and keeps all 16 source members", async () => {
  const source = Array.from({ length: 16 }, (_, i) => String(i + 1));
  const env = await setup(async () => { throw new Error("BadRequest: com.twitter.strato.serialization.DecodeException"); }, { source });
  env.move.checked = true;
  await env.button("开始迁移").onclick();
  assert.deepEqual(env.calls.map(c => c.name), ["ListAddMember"]);
  assert.equal(env.state.get("source").length, 16);
  assert.match(env.status(), /已停止。处理 1\/16，成功 0，失败 1/);
  assert.match(env.status(), /请重新加载成员核对/);
});

test("decoding after an applied insertion is confirmed by a fresh read before source removal", async () => {
  const env = await setup(async (name, vars, opts, state) => {
    if (name === "ListAddMember") {
      state.get(vars.listId).push(state.get("source")[0]);
      throw new Error("DecodeException");
    }
    return { data: {} };
  });
  env.move.checked = true;
  await env.button("开始迁移").onclick();
  assert.deepEqual(env.calls.map(c => c.name), ["ListAddMember", "ListRemoveMember"]);
  assert.equal(env.state.get("source").length, 0);
  assert.equal(env.state.get("target").length, 1);
  assert.match(env.status(), /成功 1，失败 0/);
  assert.match(env.status(), /1 次接口解码报错已通过成员复核确认成功/);
});

test("decoding after an applied removal is reconciled without repeating any write", async () => {
  const env = await setup(async (name, vars, opts, state) => {
    if (name === "ListRemoveMember") {
      state.set(vars.listId, []);
      throw new Error("DecodeException");
    }
    return { data: {} };
  });
  env.move.checked = true;
  await env.button("开始迁移").onclick();
  assert.equal(env.calls.length, 2);
  assert.equal(env.state.get("source").length, 0);
  assert.match(env.status(), /成功 1，失败 0/);
});

test("an error-free mutation response without destination membership cannot remove the source", async () => {
  const env = await setup(undefined, { apply: false });
  env.move.checked = true;
  await env.button("开始迁移").onclick();
  assert.deepEqual(env.calls.map(c => c.name), ["ListAddMember"]);
  assert.equal(env.state.get("source").length, 1);
  assert.match(env.status(), /已停止/);
});

test("destination read errors prevent writes, and verification read errors prevent removal", async () => {
  for (const afterWrite of [false, true]) {
    const env = await setup(undefined, { read: (listId, calls) => {
      if (listId === "target" && (!afterWrite || calls.length)) throw new Error("read failed");
    } });
    env.move.checked = true;
    await env.button("开始迁移").onclick();
    assert.deepEqual(env.calls.map(c => c.name), afterWrite ? ["ListAddMember"] : []);
    assert.equal(env.state.get("source").length, 1);
    assert.match(env.status(), /已停止/);
    assert.doesNotMatch(env.status(), /成功 -/);
  }
});

test("retry skips users already in the destination, including a move after partial success", async () => {
  const env = await setup(undefined, { target: ["123"] });
  env.move.checked = true;
  await env.button("开始迁移").onclick();
  assert.deepEqual(env.calls.map(c => c.name), ["ListRemoveMember"]);
  assert.equal(env.state.get("source").length, 0);
});

test("failed source removal reports the member retained in the destination", async () => {
  const env = await setup(async name => {
    if (name === "ListRemoveMember") throw new Error("DecodeException");
    return { data: {} };
  });
  env.move.checked = true;
  await env.button("开始迁移").onclick();
  assert.equal(env.state.get("source").length, 1);
  assert.equal(env.state.get("target").length, 1);
  assert.match(env.status(), /已在目标列表，源列表移除未完成/);
});

test("member verification rejects an absent timeline instead of treating malformed data as empty", async () => {
  let writes = 0;
  const { ttVerifiedListMutation } = load("src/lists.js", ["ttVerifiedListMutation"], {
    chrome: { runtime: { onMessage: { addListener() {} } } }, ttWalk,
    ttGql: async (name, vars, mutation) => {
      if (mutation) { writes++; throw new Error("DecodeException"); }
      return { data: { list: {} } };
    },
  });
  await assert.rejects(ttVerifiedListMutation("ListRemoveMember", "source", "123"), err => err.stopMigration === true);
  assert.equal(writes, 1);
});

test("member reads continue through duplicate-only pages with a new cursor", async () => {
  const calls = [];
  const { ttFetchMembers } = load("src/lists.js", ["ttFetchMembers"], {
    chrome: { runtime: { onMessage: { addListener() {} } } }, ttWalk,
    ttGql: async (name, vars) => {
      calls.push(vars.cursor);
      const i = calls.length;
      return { data: { list: { members_timeline: { timeline: { instructions: [{
        user: { __typename: "User", rest_id: i < 3 ? "1" : "2" },
        ...(i < 3 ? { cursor: { cursorType: "Bottom", value: String(i) } } : {}),
      }] } } } } };
    },
  });
  const users = await ttFetchMembers("source");
  assert.deepEqual(calls, [undefined, "1", "2"]);
  assert.equal(JSON.stringify(users.map(user => user.id)), JSON.stringify(["1", "2"]));
});
