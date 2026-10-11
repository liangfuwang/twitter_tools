// Loads a classic (non-module) extension script into a fresh vm context and returns that context's globals.
// Top-level const/function declarations are copied onto the returned object via a trailing export list.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load(file, names, globals = {}) {
  const code = fs.readFileSync(path.join(__dirname, "..", file), "utf8") + "\n;({" + names.join(",") + "})";
  return vm.runInNewContext(code, { ...globals });
}

module.exports = { load };
