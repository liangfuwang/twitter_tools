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

async function setup(mutate = async () => ({ data: {} })) {
  const body = new Element("body");
  const calls = [];
  const api = load("src/lists.js", ["ttOpenListsTool"], {
    document: { body, createElement: tag => new Element(tag) },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    AbortController, confirm: () => true, ttSleep: async () => {}, ttWalk,
    ttFetchLists: async () => [
      { id: "source", name: "Source", count: 1, mine: true },
      { id: "target", name: "Target", count: 0, mine: true },
    ],
    ttGql: async (name, vars, mutation, opts) => {
      opts?.signal?.throwIfAborted();
      if (!mutation) return { users: [{ __typename: "User", rest_id: "123", core: { name: "User", screen_name: "testuser" } }] };
      calls.push({ name, vars: { ...vars } });
      return mutate(name, vars, opts);
    },
  });
  await api.ttOpenListsTool();
  const button = text => body.querySelectorAll("button").find(node => node.textContent.startsWith(text));
  const selects = body.querySelectorAll("select");
  const move = body.querySelectorAll("input")[0];
  await button("加载成员").onclick();
  return { body, button, selects, move, calls };
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
