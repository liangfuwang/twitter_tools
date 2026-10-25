const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

function setup(state) {
  let listener, result;
  const ops = ["ListMembers", "ListAddMember", "ListRemoveMember", "ListsManagementPageTimeline", "UserByScreenName"];
  const modules = Object.fromEntries(ops.map((op, i) => [i, {
    toString: () => 'queryId:"test-id",operationName:"' + op + '",operationType:"query",metadata:{featureSwitches:["enabled","disabled","unknown","overridden","invalid"],fieldToggles:[]}' +
      ' AAAAAAAAAAAAAAAAAAAAAtestonly',
  }]));
  const window = { __INITIAL_STATE__: state, webpackChunk_twitter_responsive_web: [[[], modules]] };
  load("src/lists-bridge.js", [], {
    window, CustomEvent: class { constructor(type, props) { Object.assign(this, props); } },
    document: {
      addEventListener: (_, fn) => { listener = fn; },
      dispatchEvent: event => { result = JSON.parse(event.detail); },
    },
  });
  return { request() { listener(); return result; }, window };
}

test("bridge returns only declared boolean flags with user/override precedence, without account state", () => {
  const env = setup({ featureSwitch: {
    defaultConfig: { enabled: { value: true }, disabled: { value: false }, overridden: { value: true } },
    config: { enabled: { value: false } },
    user: { config: { enabled: { value: true }, overridden: { value: true }, invalid: { value: "false" } } },
    customOverrides: { overridden: false },
  }, session: { privateValue: "never-copy-this" } });
  const result = env.request();
  assert.deepEqual(result.ops.ListAddMember.featureValues, { enabled: true, disabled: false, overridden: false });
  assert.equal(JSON.stringify(result).includes("never-copy-this"), false);
  env.window.__INITIAL_STATE__.featureSwitch.user.config.enabled.value = false;
  assert.equal(env.request().ops.ListAddMember.featureValues.enabled, false, "cached IDs do not cache feature values");
});

test("bridge tolerates missing initial feature state without inventing enabled values", () => {
  const env = setup(undefined);
  assert.deepEqual(env.request().ops.ListMembers.featureValues, {});
});
