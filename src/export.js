// Adds "export as image" / "export as Markdown" items to the share menu of a post.
// Runs after content.js (shares its ttSettings global) and html-to-image (lib/html-to-image.js).

const TT_EXPORT_ITEMS = [
  {
    key: "exportImage",
    label: "导出为图片",
    icon: "M5.5 3h13C19.88 3 21 4.12 21 5.5v13c0 1.38-1.12 2.5-2.5 2.5h-13C4.12 21 3 19.88 3 18.5v-13C3 4.12 4.12 3 5.5 3zm0 2c-.28 0-.5.22-.5.5v13c0 .28.22.5.5.5h13c.28 0 .5-.22.5-.5v-13c0-.28-.22-.5-.5-.5h-13zM9.5 7.5a1.75 1.75 0 110 3.5 1.75 1.75 0 010-3.5zM6 17l3.5-4.5 2.5 3 2-2.5L18 17H6z",
    run: ttExportImage,
  },
  {
    key: "exportMd",
    label: "导出为 Markdown",
    icon: "M6.5 2h8L20 7.5v13c0 .83-.67 1.5-1.5 1.5h-12C5.67 22 5 21.33 5 20.5v-17C5 2.67 5.67 2 6.5 2zm0 2c-.28 0-.5.22-.5.5v16c0 .28.22.5.5.5h12c.28 0 .5-.22.5-.5V8h-4.5V4h-8zM8 12h8v2H8v-2zm0 4h8v2H8v-2z",
    run: ttExportMarkdown,
  },
];

let ttShareButton = null;

// The share button is the only menu button in the action bar that is not the "..." caret.
document.addEventListener(
  "click",
  (e) => {
    const btn = e.target.closest?.('article button[aria-haspopup="menu"]');
    if (btn) ttShareButton = btn.matches('[data-testid="caret"]') ? null : btn;
  },
  true
);

function ttToast(text) {
  const el = document.createElement("div");
  el.textContent = text;
  el.style.cssText =
    "position:fixed;left:50%;bottom:48px;transform:translateX(-50%);z-index:99999;padding:10px 16px;border-radius:8px;background:#1d9bf0;color:#fff;font:15px sans-serif;";
  document.body.append(el);
  setTimeout(() => el.remove(), 2500);
}

function ttDownload(href, filename) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
}

function ttStatusInfo(article) {
  const href = article.querySelector("time")?.closest("a")?.getAttribute("href") || "";
  const [, handle, id] = href.match(/^\/([^/]+)\/status\/(\d+)/) || [];
  return { handle: handle || "tweet", id: id || String(Date.now()), url: href ? "https://x.com" + href : location.href };
}

// X renders some parts in ways that do not survive html-to-image (rolling view-count digits, header buttons), so the
// image is taken from an off-screen copy of the post with those parts removed or flattened.
function ttCleanCopy(article) {
  const copy = article.cloneNode(true);
  const bar = copy.querySelector('[data-testid="reply"]')?.closest('[role="group"]');
  let parent = bar?.parentElement;
  bar?.remove();
  while (parent && parent !== copy && !parent.firstElementChild) {
    const next = parent.parentElement;
    parent.remove();
    parent = next;
  }
  // The timestamp row (time · views) is shrink-wrapped to widths measured with X's own font and its view-count
  // digits roll in separate clipped boxes, so flatten it into plain text that cannot wrap.
  const views = copy.querySelector('a[href$="/analytics"]');
  const source = article.querySelector('a[href$="/analytics"]');
  const row = views?.parentElement;
  if (row && source) {
    const style = getComputedStyle(source.parentElement.firstElementChild);
    const part = (text, bold) => {
      const span = document.createElement("span");
      span.textContent = text;
      span.style.cssText = "white-space:nowrap;font-weight:" + (bold ? 700 : 400);
      return span;
    };
    const line = document.createElement("div");
    line.style.cssText = "white-space:nowrap;width:max-content;font-size:" + style.fontSize + ";line-height:" + style.lineHeight + ";color:" + style.color;
    line.append(part(row.firstElementChild.textContent + " · "), part(source.textContent, true));
    row.replaceChildren(line);
  }
  // "相关 / 查看引用" row under the timestamp (detail page only): not part of the post.
  const quotes = copy.querySelector('a[href$="/quotes"]');
  const related = quotes && Array.from(copy.querySelectorAll("button")).findLast((b) => b.compareDocumentPosition(quotes) & Node.DOCUMENT_POSITION_FOLLOWING);
  if (quotes && related) {
    let row = quotes;
    while (row.parentElement && !row.contains(related)) row = row.parentElement;
    if (!row.querySelector('[data-testid="tweetText"]') && row !== copy) row.remove();
  }
  // Names and handles are ellipsised to widths measured with X's own font; let them run to full length.
  for (const el of copy.querySelectorAll('[data-testid="User-Name"], [data-testid="User-Name"] *')) {
    el.style.overflow = "visible";
    el.style.textOverflow = "clip";
    el.style.maxWidth = "none";
    el.style.flexShrink = "0";
    el.style.whiteSpace = "nowrap";
  }
  copy.style.borderBottom = "none";
  return copy;
}

async function ttExportImage(article) {
  const info = ttStatusInfo(article);
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;top:0;left:-100000px;width:" + article.getBoundingClientRect().width + "px;";
  const copy = ttCleanCopy(article);
  holder.append(copy);
  document.body.append(holder);
  try {
    ttToast("正在生成图片…");
    const dataUrl = await htmlToImage.toPng(copy, {
      pixelRatio: 2,
      skipFonts: true,
      backgroundColor: getComputedStyle(document.body).backgroundColor,
    });
    ttDownload(dataUrl, info.handle + "-" + info.id + ".png");
  } catch (err) {
    console.error("[Twitter Tools] image export failed", err);
    ttToast("导出图片失败");
  } finally {
    holder.remove();
  }
}

// Post text to Markdown: links keep their href, emoji images become their alt text.
function ttTextToMd(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  if (node.tagName === "IMG") return node.alt || "";
  if (node.tagName === "BR") return "\n";
  const inner = Array.from(node.childNodes, ttTextToMd).join("");
  if (node.tagName === "A") {
    const href = node.getAttribute("href") || "";
    return "[" + inner + "](" + (href.startsWith("/") ? "https://x.com" + href : href) + ")";
  }
  return inner;
}

const ttBigImage = (src) => src.replace(/([?&])name=\w+/, "$1name=large");

// Collects text and media for the post itself (root = article, quote = null) or its quoted post.
function ttPartToMd(root, inQuote) {
  const belongs = (el) => (el.closest('div[role="link"]') !== null) === inQuote;
  const parts = [];
  const text = Array.from(root.querySelectorAll('[data-testid="tweetText"]')).find(belongs);
  if (text) parts.push(ttTextToMd(text).trim());
  const images = Array.from(root.querySelectorAll('img[src*="pbs.twimg.com/media/"]'))
    .filter(belongs)
    .map((img) => "![图片](" + ttBigImage(img.src) + ")");
  if (images.length) parts.push(images.join("\n\n"));
  return parts;
}

function ttExportMarkdown(article) {
  const info = ttStatusInfo(article);
  const name = article.querySelector('[data-testid="User-Name"]')?.innerText.split("\n")[0] || info.handle;
  const time = article.querySelector("time")?.getAttribute("datetime");
  const when = time ? new Date(time).toLocaleString("sv-SE").slice(0, 16) : "";
  const blocks = ["**" + name + "** ([@" + info.handle + "](https://x.com/" + info.handle + "))" + (when ? " · " + when : "")];
  blocks.push(...ttPartToMd(article, false));
  if (article.querySelector('[data-testid="videoPlayer"]')) blocks.push("[视频](" + info.url + ")");

  const quote = article.querySelector('div[role="link"]:has([data-testid="tweetText"])');
  if (quote) {
    const qName = quote.querySelector('[data-testid="User-Name"]')?.innerText.replace(/\n+/g, " ").trim();
    const qParts = [qName && "**" + qName + "**", ...ttPartToMd(article, true)].filter(Boolean);
    blocks.push(qParts.join("\n\n").replace(/^(.*)$/gm, (line) => (line ? "> " + line : ">")));
  }
  blocks.push("原帖：" + info.url);

  const blob = new Blob([blocks.join("\n\n") + "\n"], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  ttDownload(url, info.handle + "-" + info.id + ".md");
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Clicking the share button again toggles its menu closed.
function ttCloseMenu() {
  ttShareButton?.click();
}

function ttInjectExport() {
  if (!ttShareButton?.isConnected || ttShareButton.getAttribute("aria-expanded") !== "true") return;
  const dropdown = document.querySelector('[role="menu"] [data-testid="Dropdown"]');
  const template = dropdown?.querySelector('[role="menuitem"]:not([data-tt-export])');
  const article = ttShareButton.closest("article");
  if (!template || !article) return;
  for (const { key, label, icon, run } of TT_EXPORT_ITEMS) {
    const existing = dropdown.querySelector('[data-tt-export="' + key + '"]');
    if (!ttSettings[key]) {
      existing?.remove();
      continue;
    }
    if (existing) continue;
    const item = template.cloneNode(true);
    item.setAttribute("data-tt-export", key);
    item.querySelector("svg path").setAttribute("d", icon);
    item.querySelector("span").textContent = label;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      ttCloseMenu();
      setTimeout(() => run(article), 100);
    });
    dropdown.append(item);
  }
}

let ttExportQueued = false;
new MutationObserver(() => {
  if (ttExportQueued || !ttShareButton) return;
  ttExportQueued = true;
  requestAnimationFrame(() => {
    ttExportQueued = false;
    ttInjectExport();
  });
}).observe(document.documentElement, { childList: true, subtree: true });
