const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const api = load("src/settings.js", [
  "TT_SECTIONS",
  "TT_DEFAULTS",
  "ttNoteHandleFromHref",
  "ttNoteMentionText",
  "ttNormalizeNotes",
  "ttParseUser",
]);

test("option keys are unique", () => {
  const keys = api.TT_SECTIONS.flatMap((s) => s.options.map((o) => o.key));
  assert.equal(new Set(keys).size, keys.length);
});

test("defaults: inject/hidden/on options are true, others false", () => {
  assert.equal(api.TT_DEFAULTS.navBookmarks, true);
  assert.equal(api.TT_DEFAULTS.navHistory, true);
  assert.equal(api.TT_DEFAULTS.userNotes, true);
  assert.equal(api.TT_DEFAULTS.noteReplaceAt, true);
  assert.equal(api.TT_DEFAULTS.noteToolbarBtn, undefined);
  assert.equal(api.TT_DEFAULTS.navHome, false);
});

test("ttNoteHandleFromHref accepts profile paths only", () => {
  assert.equal(api.ttNoteHandleFromHref("/jack"), "jack");
  assert.equal(api.ttNoteHandleFromHref("/a_b9"), "a_b9");
  assert.equal(api.ttNoteHandleFromHref("/jack/status/123"), null);
  assert.equal(api.ttNoteHandleFromHref("/"), null);
  assert.equal(api.ttNoteHandleFromHref(""), null);
  assert.equal(api.ttNoteHandleFromHref(null), null);
  assert.equal(api.ttNoteHandleFromHref("/this_name_is_too_long"), null);
  assert.equal(api.ttNoteHandleFromHref("/bad-name"), null);
  assert.equal(api.ttNoteHandleFromHref("https://x.com/jack"), null);
});

test("ttNoteMentionText replaces known mentions case-insensitively", () => {
  const notes = { jack: "老杰" };
  assert.equal(api.ttNoteMentionText("@Jack", notes, true), "@老杰");
  assert.equal(api.ttNoteMentionText("@jack", notes, false), "@jack");
  assert.equal(api.ttNoteMentionText("@other", notes, true), "@other");
  assert.equal(api.ttNoteMentionText("not a mention", notes, true), "not a mention");
});

test("ttNormalizeNotes cleans imported data", () => {
  const out = api.ttNormalizeNotes({ "@Jack": " 老杰 ", bob: "", eve: 5, "bad name": "x", ok_1: "y" });
  assert.deepEqual({ ...out }, { jack: "老杰", ok_1: "y" });
});

test("ttNormalizeNotes rejects non-objects", () => {
  for (const bad of [null, undefined, "str", 3, [], [1]]) assert.equal(api.ttNormalizeNotes(bad), null);
});

test("handles matching object property names do not inherit or lose notes", () => {
  assert.equal(api.ttNoteMentionText("@constructor", {}, true), "@constructor");
  const notes = api.ttNormalizeNotes(JSON.parse('{"__proto__":"备注","constructor":"作者"}'));
  assert.equal(Object.hasOwn(notes, "__proto__"), true);
  assert.equal(api.ttNoteMentionText("@__proto__", notes, true), "@备注");
  assert.equal(api.ttNoteMentionText("@constructor", notes, true), "@作者");
});

test("new options default on (hideBadges hidden, author info enabled)", () => {
  for (const k of ["hideBadges", "quickFollow"]) assert.equal(api.TT_DEFAULTS[k], true, k);
  assert.equal(api.TT_DEFAULTS.userInfoBio, false);
});

test("ttParseUser reads the current schema and expands bio links", () => {
  const u = api.ttParseUser({
    __typename: "User",
    rest_id: "12",
    relationship_counts: { followers: 100, following: 3 },
    relationship_perspectives: { following: true, followed_by: true, blocking: false },
    follow_request_sent: false,
    privacy: { protected: false },
    profile_bio: {
      description: " hi https://t.co/abc ",
      entities: { description: { urls: [{ url: "https://t.co/abc", display_url: "primal.net/jack" }] } },
    },
  });
  assert.deepEqual({ ...u }, {
    id: "12", bio: "hi primal.net/jack",
    followed: true, followedBy: true, requested: false, blocking: false, protected: false,
  });
});

test("ttParseUser falls back to legacy fields and rejects non-users", () => {
  const u = api.ttParseUser({ __typename: "User", rest_id: "1", legacy: { followers_count: 5, friends_count: 2, description: "x", following: false, followed_by: true, protected: true } });
  assert.equal(u.bio, "x");
  assert.equal(u.protected, true);
  assert.equal(u.followedBy, true);
  assert.equal(api.TT_DEFAULTS.followBack, true);
  assert.equal(api.ttParseUser({ __typename: "UserUnavailable" }), null);
  assert.equal(api.ttParseUser(undefined), null);
});
