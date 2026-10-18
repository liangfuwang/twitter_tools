const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

test("manifest assets exist and classic scripts share a valid global scope", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(fs.existsSync(path.join(root, manifest.action.default_popup)));
  const worlds = new Map();
  for (const entry of manifest.content_scripts) {
    for (const file of [...(entry.js || []), ...(entry.css || [])]) assert.ok(fs.existsSync(path.join(root, file)), file);
    const world = entry.world || "ISOLATED";
    worlds.set(world, (worlds.get(world) || "") + entry.js.map(file => fs.readFileSync(path.join(root, file), "utf8")).join("\n") + "\n");
  }
  for (const source of worlds.values()) assert.doesNotThrow(() => new vm.Script(source));
  const popupPath = path.join(root, manifest.action.default_popup);
  const popup = fs.readFileSync(popupPath, "utf8");
  const popupScripts = [...popup.matchAll(/<script src="([^"]+)"/g)].map(match => path.resolve(path.dirname(popupPath), match[1]));
  assert.doesNotThrow(() => new vm.Script(popupScripts.map(file => fs.readFileSync(file, "utf8")).join("\n")));
});
