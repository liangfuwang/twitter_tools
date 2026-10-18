const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");
const { ttParseUser } = load("src/settings.js", ["ttParseUser"]);

function setup({ followed = false, followedBy = true, requested = false, blocked = false,
  create, notify, read, viewer = () => "viewer" } = {}) {
  const calls = [];
  let reads = 0;
  const user = () => ({ __typename: "User", rest_id: "123", relationship_perspectives: {
    following: followed, followed_by: followedBy, blocking: blocked,
  }, follow_request_sent: requested });
  const api = load("src/followback.js", ["ttFollowBackUser", "ttFollowAndNotifyUser"], {
    ttParseUser,
    ttOwnId: viewer,
    ttGql: async (name, params) => {
      calls.push({ name, params: { ...params } });
      reads++;
      return { data: { user: { result: read ? read(reads, user()) : user() } } };
    },
    ttRestPost: async (name, params) => {
      calls.push({ name, params: { ...params } });
      if (name === "friendships/create.json") {
        if (create) return create();
        followed = true;
        // X can return the previous following state here; the post-write read is authoritative.
        return { following: false };
      }
      if (notify) return notify();
      return { relationship: { source: { notifications_enabled: true }, target: { id_str: "123" } } };
    },
  });
  return { ...api, calls };
}

test("follow-back rechecks relationship, follows first, then enables post notifications", async () => {
  const env = setup();
  const result = await env.ttFollowBackUser("testuser", "123");
  assert.equal(result.status, "done");
  assert.equal(result.user.followed, true);
  assert.deepEqual(env.calls.map(c => c.name), ["UserByScreenName", "friendships/create.json", "UserByScreenName", "friendships/update.json"]);
  assert.deepEqual(env.calls.at(-1).params, { user_id: "123", device: "true" });
});

test("a non-follower never triggers a follow or notification write", async () => {
  const env = setup({ followedBy: false });
  assert.equal((await env.ttFollowBackUser("testuser", "123")).status, "unavailable");
  assert.equal(env.calls.length, 1);
});

test("ordinary follow enables notifications even when the target does not follow the viewer", async () => {
  const env = setup({ followedBy: false });
  const result = await env.ttFollowAndNotifyUser("testuser", "123");
  assert.equal(result.status, "done");
  assert.equal(result.user.followed, true);
  assert.deepEqual(env.calls.map(c => c.name), ["UserByScreenName", "friendships/create.json", "UserByScreenName", "friendships/update.json"]);
  assert.deepEqual(env.calls.at(-1).params, { user_id: "123", device: "true" });
});

test("ordinary follow retries only notifications after partial success", async () => {
  let attempts = 0;
  const env = setup({ followedBy: false, notify: () => {
    if (++attempts === 1) throw new Error("temporarily unavailable");
    return { relationship: { source: { notifications_enabled: true } } };
  } });
  assert.equal((await env.ttFollowAndNotifyUser("testuser", "123")).status, "notifyFailed");
  assert.equal((await env.ttFollowAndNotifyUser("testuser", "123")).status, "done");
  assert.equal(env.calls.filter(c => c.name === "friendships/create.json").length, 1);
  assert.equal(env.calls.filter(c => c.name === "friendships/update.json").length, 2);
});

test("ordinary private follow waits for approval and checks it on the next click", async () => {
  let approved = false;
  const env = setup({ followedBy: false, create: () => ({ follow_request_sent: true }),
    read: (_, user) => ({ ...user, relationship_perspectives: { ...user.relationship_perspectives, following: approved } }) });
  assert.equal((await env.ttFollowAndNotifyUser("testuser", "123")).status, "requested");
  assert.equal(env.calls.some(c => c.name === "friendships/update.json"), false);
  approved = true;
  assert.equal((await env.ttFollowAndNotifyUser("testuser", "123")).status, "done");
  assert.equal(env.calls.filter(c => c.name === "friendships/create.json").length, 1);
});

test("ordinary follow still rejects blocked or reassigned targets before writes", async () => {
  const blocked = setup({ followedBy: false, blocked: true });
  assert.equal((await blocked.ttFollowAndNotifyUser("testuser", "123")).status, "unavailable");
  assert.equal(blocked.calls.length, 1);
  const reassigned = setup({ followedBy: false, read: (_, user) => ({ ...user, rest_id: "456" }) });
  await assert.rejects(reassigned.ttFollowAndNotifyUser("testuser", "123"), /账号信息已变化/);
  assert.equal(reassigned.calls.length, 1);
});

test("blocked accounts never trigger writes", async () => {
  const env = setup({ blocked: true });
  assert.equal((await env.ttFollowBackUser("testuser", "123")).status, "unavailable");
  assert.equal(env.calls.length, 1);
});

test("a reassigned handle is rejected before mutating the wrong account", async () => {
  const env = setup({ read: (_, user) => ({ ...user, rest_id: "456" }) });
  await assert.rejects(env.ttFollowBackUser("testuser", "123"), /账号信息已变化/);
  assert.equal(env.calls.length, 1);
});

test("failed follow does not enable notifications", async () => {
  const env = setup({ create: () => { throw new Error("denied"); } });
  await assert.rejects(env.ttFollowBackUser("testuser", "123"), /denied/);
  assert.deepEqual(env.calls.map(c => c.name), ["UserByScreenName", "friendships/create.json"]);
});

test("a protected follow request stays pending and does not enable notifications", async () => {
  const env = setup({ create: () => ({ follow_request_sent: true }) });
  const result = await env.ttFollowBackUser("testuser", "123");
  assert.equal(result.status, "requested");
  assert.equal(result.user.requested, true);
  assert.equal(env.calls.length, 2);
});

test("an existing pending request is not submitted again", async () => {
  const env = setup({ requested: true });
  assert.equal((await env.ttFollowBackUser("testuser", "123")).status, "requested");
  assert.equal(env.calls.length, 1);
});

test("notification retries never submit another follow", async () => {
  let attempts = 0;
  const env = setup({ notify: () => {
    if (++attempts === 1) throw new Error("temporarily unavailable");
    return { relationship: { source: { notifications_enabled: true } } };
  } });
  assert.equal((await env.ttFollowBackUser("testuser", "123")).status, "notifyFailed");
  assert.equal((await env.ttFollowBackUser("testuser", "123")).status, "done");
  assert.equal(env.calls.filter(c => c.name === "friendships/create.json").length, 1);
  assert.equal(env.calls.filter(c => c.name === "friendships/update.json").length, 2);
});

test("a missing or disabled notification confirmation is not reported as success", async () => {
  for (const response of [{}, { relationship: { source: { notifications_enabled: false } } },
    { relationship: { source: { notifications_enabled: true }, target: { id_str: "456" } } }]) {
    const env = setup({ followed: true, notify: () => response });
    assert.equal((await env.ttFollowBackUser("testuser", "123")).status, "notifyFailed");
    assert.equal(env.calls.some(c => c.name === "friendships/create.json"), false);
  }
});

test("unconfirmed follow state never enables notifications", async () => {
  const env = setup({ create: () => ({ following: false }) });
  assert.equal((await env.ttFollowBackUser("testuser", "123")).status, "unconfirmed");
  assert.equal(env.calls.some(c => c.name === "friendships/update.json"), false);
});

test("failure to read the post-follow state never enables notifications", async () => {
  const env = setup({ read: (n, user) => { if (n > 1) throw new Error("limited"); return user; } });
  assert.equal((await env.ttFollowBackUser("testuser", "123")).status, "unconfirmed");
  assert.equal(env.calls.some(c => c.name === "friendships/update.json"), false);
});

test("switching login during the operation prevents subsequent writes", async () => {
  let viewer = "first";
  const env = setup({ viewer: () => viewer, create: () => { viewer = "second"; return {}; } });
  await assert.rejects(env.ttFollowBackUser("testuser", "123"), error => error.code === "VIEWER_CHANGED");
  assert.equal(env.calls.some(c => c.name === "friendships/update.json"), false);
});
