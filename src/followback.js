// Follow-back writes only run after a user clicks the button. Re-read the relationship instead of trusting
// the author cache; a handle can change owners and the follow/create response can contain old follow state.
async function ttFollowBackUser(handle, expectedID) {
  const viewer = ttOwnId();
  function sameViewer() {
    if (!viewer || ttOwnId() !== viewer) {
      const error = new Error("登录账号已变化，请刷新页面后重试");
      error.code = "VIEWER_CHANGED";
      throw error;
    }
  }
  async function readUser() {
    sameViewer();
    const json = await ttGql("UserByScreenName", { screen_name: handle }, false, { retry: false });
    sameViewer();
    const user = ttParseUser(json.data?.user?.result);
    if (!user || user.id !== expectedID) throw new Error("账号信息已变化，请刷新页面后重试");
    return user;
  }

  let user = await readUser();
  if (user.blocking || (!user.followedBy && !user.followed)) return { user, status: "unavailable" };
  if (!user.followed && user.requested) return { user, status: "requested" };
  if (!user.followed) {
    const result = await ttRestPost("friendships/create.json", { user_id: user.id });
    sameViewer();
    if (result.follow_request_sent) return { user: { ...user, requested: true }, status: "requested" };
    try {
      user = await readUser();
    } catch (error) {
      if (error.code === "VIEWER_CHANGED") throw error;
      return { user, status: "unconfirmed" };
    }
    if (!user.followed) return { user, status: user.requested ? "requested" : "unconfirmed" };
  }

  try {
    const result = await ttRestPost("friendships/update.json", { user_id: user.id, device: "true" });
    sameViewer();
    const relation = result.relationship;
    const targetID = relation?.target?.id_str;
    if (relation?.source?.notifications_enabled !== true || (targetID && targetID !== user.id)) {
      return { user, status: "notifyFailed" };
    }
    return { user, status: "done" };
  } catch (error) {
    if (error.code === "VIEWER_CHANGED") throw error;
    // The follow already succeeded. A retry must enable notifications without following again.
    return { user, status: "notifyFailed" };
  }
}
