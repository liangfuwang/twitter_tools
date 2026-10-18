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
  document.addEventListener("tt-ops-request", () => {
    let result = cache;
    if (!result) {
      result = scan();
      if (result.bearer && OPS.every((o) => result.ops[o])) cache = result;
    }
    document.dispatchEvent(new CustomEvent("tt-ops-response", { detail: JSON.stringify(result) }));
  });
})();
