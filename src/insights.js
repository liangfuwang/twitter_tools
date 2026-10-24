// Average post views per hour, read only from the existing DOM: no additional API calls.
// Uses the same author-header selectors as userinfo.js and pure helpers from settings.js.
const ttRateArticles = new Set();
const ttRateVisible = new Set();
const ttRateEnabled = () => document.documentElement.classList.contains("tt-postViewRate");

function ttRateMetrics(article) {
  // Ignore quoted/nested posts. The timestamp and analytics link must refer to the same post ID.
  const time = Array.from(article.querySelectorAll("time")).find(el =>
    el.closest("article") === article && !el.closest('div[role="link"]'));
  const href = time?.closest("a")?.getAttribute("href") || "";
  const id = href.match(/\/status\/(\d+)(?:[/?#]|$)/)?.[1];
  if (!id) return null;
  const analytics = Array.from(article.querySelectorAll('a[href*="/analytics"]')).find(el =>
    el.closest("article") === article &&
    el.getAttribute("href")?.match(/\/status\/(\d+)\/analytics(?:[?#]|$)/)?.[1] === id);
  if (!analytics) return null;
  const count = ttParseViewCount(analytics.getAttribute("aria-label")) ?? ttParseViewCount(analytics.textContent);
  const rate = ttAverageViewsPerHour(count, time.getAttribute("datetime"));
  return rate === null ? null : { rate, count };
}

function ttRateRender(article) {
  const existing = article.querySelector(".tt-post-rate");
  const metrics = ttRateEnabled() ? ttRateMetrics(article) : null;
  const name = article.querySelector('[data-testid="User-Name"]');
  const caret = article.querySelector('[data-testid="caret"]');
  // The smallest common header row lets the pill flow beside X's controls, without an overlay.
  let header = name;
  while (header && !header.contains(caret)) header = header.parentElement;
  if (!metrics || !header || header === article || !article.contains(header)) {
    existing?.remove();
    return;
  }
  let controls = caret;
  while (controls.parentElement !== header) controls = controls.parentElement;
  const badge = existing || document.createElement("span");
  if (badge.className !== "tt-post-rate") badge.className = "tt-post-rate";
  const text = "🔥 " + ttFormatViewRate(metrics.rate);
  const title = "发布以来平均浏览量，非实时增速；按页面浏览量 ÷ 发布时长估算。页面浏览量：" + metrics.count.toLocaleString("zh-CN");
  if (badge.textContent !== text) badge.textContent = text;
  if (badge.title !== title) badge.title = title;
  if (badge.parentElement !== header || badge.nextElementSibling !== controls) header.insertBefore(badge, controls);
}

const ttRateObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!ttRateArticles.has(entry.target)) continue;
    if (entry.isIntersecting) {
      ttRateVisible.add(entry.target);
      ttRateRender(entry.target);
    } else ttRateVisible.delete(entry.target);
  }
}, { rootMargin: "400px 0px" });

function ttRateScan() {
  const enabled = ttRateEnabled();
  const articles = enabled ? new Set(document.querySelectorAll('article[data-testid="tweet"]')) : new Set();
  for (const article of ttRateArticles) {
    if (!articles.has(article)) {
      ttRateObserver.unobserve(article);
      ttRateArticles.delete(article);
      ttRateVisible.delete(article);
      article.querySelector(".tt-post-rate")?.remove();
    }
  }
  for (const article of articles) {
    if (!ttRateArticles.has(article)) {
      ttRateArticles.add(article);
      ttRateObserver.observe(article);
    }
  }
  for (const article of ttRateVisible) ttRateRender(article);
}

let ttRateQueued = false;
function ttRateQueueScan() {
  if (ttRateQueued) return;
  ttRateQueued = true;
  requestAnimationFrame(() => {
    ttRateQueued = false;
    ttRateScan();
  });
}
new MutationObserver(ttRateQueueScan).observe(document.documentElement, {
  childList: true, subtree: true, characterData: true,
  attributes: true, attributeFilter: ["class", "aria-label", "href", "datetime"],
});
document.addEventListener("visibilitychange", ttRateQueueScan);
setInterval(() => {
  if (!document.hidden) for (const article of ttRateVisible) ttRateRender(article);
}, 60000);
ttRateQueueScan();
