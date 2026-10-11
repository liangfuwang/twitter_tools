const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const api = load("src/settings.js", [
  "TT_SECTIONS",
  "TT_DEFAULTS",
  "ttNoteHandleFromHref",
  "ttNoteMentionText",
  "ttNormalizeNotes",
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
  assert.equal(api.TT_DEFAULTS.noteToolbarBtn, false);
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
