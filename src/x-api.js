// Shared access to X's own web API from the content script (isolated world), using the logged-in session.
// Query ids, feature flags and the bearer token come from lists-bridge.js, which runs in the page's main world.

const ttSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const finish = () => {
    signal?.removeEventListener("abort", abort);
    resolve();
  };
  const timer = setTimeout(finish, ms);
  const abort = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    reject(signal.reason);
  };
  signal?.addEventListener("abort", abort, { once: true });
});

let ttOpsCache = null; // { bearer, ops } merged over every bridge response
let ttOpsPending = null;

function ttFetchOps() {
  if (ttOpsPending) return ttOpsPending;
  const request = new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      document.removeEventListener("tt-ops-response", onResponse);
    };
    const onResponse = (e) => {
      cleanup();
      try {
        const data = JSON.parse(e.detail);
        if (!data || typeof data.bearer !== "string" || !data.ops || typeof data.ops !== "object") {
          throw new Error("X 的接口信息格式无效，请刷新页面后重试");
        }
        resolve(data);
      } catch (err) {
        reject(err);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("无法读取 X 的接口信息，请刷新页面后重试"));
    }, 5000);
    document.addEventListener("tt-ops-response", onResponse);
    document.dispatchEvent(new CustomEvent("tt-ops-request"));
  });
  const pending = request.finally(() => {
    if (ttOpsPending === pending) ttOpsPending = null;
  });
  ttOpsPending = pending;
  return pending;
}

// Resolves with { bearer, ops } once every operation in `needed` is known.
async function ttGetOps(needed = []) {
  if (!ttOpsCache || !needed.every((n) => ttOpsCache.ops[n])) {
    const data = await ttFetchOps();
    if (data.bearer) ttOpsCache = { bearer: data.bearer, ops: { ...ttOpsCache?.ops, ...data.ops } };
  }
  const missing = needed.filter((n) => !ttOpsCache?.ops[n]);
  if (!ttOpsCache || missing.length) throw new Error("没有找到接口 " + missing.join("、") + "，请刷新页面后重试");
  return ttOpsCache;
}

function ttHeaders(bearer) {
  return {
    authorization: "Bearer " + bearer,
    "x-csrf-token": document.cookie.match(/ct0=([^;]+)/)?.[1] || "",
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-active-user": "yes",
  };
}

// Error carrying the HTTP status and, for 429, when the rate limit resets (epoch seconds).
function ttHttpError(res) {
  const err = new Error("HTTP " + res.status);
  err.status = res.status;
  err.resetAt = Number(res.headers.get("x-rate-limit-reset")) || 0;
  return err;
}

// opts.retry = false: throw on 429 instead of waiting and retrying (for background fetches).
// opts.allowPartial = true: only the list overview's known DecodeException can retain query data.
// Members and all mutations remain strict; ttFetchLists must still verify usable list records.
async function ttGql(name, variables, mutation, opts = {}) {
  const { ops, bearer } = await ttGetOps([name]);
  const op = ops[name];
  const features = Object.fromEntries(op.features.map((f) => [f, true]));

  const headers = ttHeaders(bearer);
  for (let attempt = 0; ; attempt++) {
    opts.signal?.throwIfAborted();
    let res;
    if (mutation) {
      res = await fetch("/i/api/graphql/" + op.id + "/" + name, {
        method: "POST",
        credentials: "include",
        signal: opts.signal,
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ variables, features, queryId: op.id }),
      });
    } else {
      const params = new URLSearchParams({
        variables: JSON.stringify(variables),
        features: JSON.stringify(features),
        fieldToggles: JSON.stringify(Object.fromEntries(op.toggles.map((f) => [f, false]))),
      });
      res = await fetch("/i/api/graphql/" + op.id + "/" + name + "?" + params, { credentials: "include", headers, signal: opts.signal });
    }
    if (res.status === 429) {
      if (opts.retry === false || attempt >= 5) throw ttHttpError(res);
      await ttSleep(30000, opts.signal);
      continue;
    }
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) throw ttHttpError(res);
    // Even a partial GraphQL response can mean a mutation failed. Never remove a source-list member after it.
    const partialLists = opts.allowPartial && !mutation && name === "ListsManagementPageTimeline" && json.data &&
      json.errors?.every(error => /\bDecodeException\b/.test(error.message || ""));
    if (json.errors?.length && !partialLists) throw new Error(json.errors[0].message || "接口错误");
    return json;
  }
}

// POST to a v1.1 REST endpoint (e.g. "friendships/create.json") with a form body; resolves with the parsed JSON.
async function ttRestPost(path, form) {
  const { bearer } = await ttGetOps();
  const res = await fetch("/i/api/1.1/" + path, {
    method: "POST",
    credentials: "include",
    headers: { ...ttHeaders(bearer), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) throw ttHttpError(res);
  if (json.errors?.length) throw new Error(json.errors[0].message || "接口错误");
  return json;
}

function ttOwnId() {
  return decodeURIComponent(document.cookie.match(/twid=([^;]+)/)?.[1] || "").replace(/^u=/, "");
}

function ttWalk(node, visit) {
  if (node && typeof node === "object") {
    visit(node);
    for (const k in node) ttWalk(node[k], visit);
  }
}

// Resolves with { lists, partial }. X can return list records plus an unrelated strato DecodeException.
// Keep validated records and report the partial result. Errors without usable lists still fail.
async function ttFetchLists() {
  const json = await ttGql("ListsManagementPageTimeline", { count: 100 }, false, { allowPartial: true });
  const me = ttOwnId();
  const seen = new Map();
  ttWalk(json, (o) => {
    if (o.__typename === "TimelineTwitterList" && typeof o.list?.id_str === "string" && o.list.id_str && typeof o.list.name === "string") {
      const l = o.list;
      seen.set(l.id_str, {
        id: l.id_str,
        name: l.name,
        count: l.member_count,
        mine: l.user_results?.result?.rest_id === me,
      });
    }
  });
  if (json.errors?.length && !seen.size) throw new Error(json.errors[0].message || "无法读取列表");
  return { lists: [...seen.values()], partial: !!json.errors?.length };
}
