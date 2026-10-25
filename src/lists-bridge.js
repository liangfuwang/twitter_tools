// Runs in the page's own JS world (manifest "world": "MAIN") because X's GraphQL query ids and feature flags only
// exist in its webpack modules. Answers requests from lists.js with a JSON string (CustomEvent details do not
// reliably carry objects across worlds).
(() => {
  const OPS = ["ListMembers", "ListAddMember", "ListRemoveMember", "ListsManagementPageTimeline", "UserByScreenName"];
  const OP_RE = /queryId:"([^"]+)",operationName:"(\w+)",operationType:"\w+",metadata:\{featureSwitches:\[([^\]]*)\](?:,fieldToggles:\[([^\]]*)\])?/;
  const names = (s) => (s || "").split(",").map((x) => x.replace(/"/g, "").trim()).filter(Boolean);

  function scan() {
    const ops = {};
    let bearer;
    for (const chunk of window.webpackChunk_twitter_responsive_web || []) {
      for (const id in chunk[1]) {
        const src = chunk[1][id].toString();
        bearer ||= src.match(/AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]+/)?.[0];
        if (!src.includes("operationName:")) continue;
        const m = src.match(OP_RE);
        if (m && OPS.includes(m[2])) ops[m[2]] = { id: m[1], features: names(m[3]), toggles: names(m[4]) };
      }
    }
    return { ops, bearer };
  }

  let cache;
  function featureValues(ops) {
    // Copy only declared boolean flags, never the surrounding account/session state.
    const fs = window.__INITIAL_STATE__?.featureSwitch;
    const configs = [fs?.defaultConfig, fs?.config, fs?.user?.config, fs?.customOverrides];
    return Object.fromEntries(Object.entries(ops).map(([name, op]) => {
      const values = {};
      for (const key of op.features) {
        for (const config of configs) {
          const entry = config?.[key];
          const value = typeof entry === "boolean" ? entry : entry?.value;
          if (typeof value === "boolean") values[key] = value;
        }
      }
      return [name, { ...op, featureValues: values }];
    }));
  }

  document.addEventListener("tt-ops-request", () => {
    let result = cache;
    if (!result) {
      result = scan();
      if (result.bearer && OPS.every((o) => result.ops[o])) cache = result;
    }
    // Query metadata can be cached; feature values may change with the active account.
    document.dispatchEvent(new CustomEvent("tt-ops-response", {
      detail: JSON.stringify({ ...result, ops: featureValues(result.ops) }),
    }));
  });
})();
