// Renders one checkbox per option, grouped by section, and saves on change.
const form = document.getElementById("options");

document.getElementById("open-lists").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "tt-open-lists" });
    window.close();
  } catch {
    const hint = document.getElementById("hint");
    hint.textContent = "请先切换到 x.com 页面（已打开的页面需刷新）。";
    hint.hidden = false;
  }
});

const hint = document.getElementById("hint");
function showHint(text, ok) {
  hint.textContent = text;
  hint.style.color = ok ? "#080" : "#c00";
  hint.hidden = false;
}

document.getElementById("export-notes").addEventListener("click", async () => {
  const notes = (await chrome.storage.local.get(TT_NOTES_KEY))[TT_NOTES_KEY] || {};
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(notes, null, 2)], { type: "application/json" }));
  a.download = "twitter-tools-notes.json";
  a.click();
  showHint("已导出 " + Object.keys(notes).length + " 条备注。", true);
});

const importFile = document.getElementById("import-file");
document.getElementById("import-notes").addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async () => {
  try {
    const data = JSON.parse(await importFile.files[0].text());
    const incoming = ttNormalizeNotes(data);
    if (!incoming) throw new Error();
    const old = (await chrome.storage.local.get(TT_NOTES_KEY))[TT_NOTES_KEY] || {};
    await chrome.storage.local.set({ [TT_NOTES_KEY]: { ...old, ...incoming } });
    showHint("已导入 " + Object.keys(incoming).length + " 条备注（同名覆盖）。", true);
  } catch {
    showHint("文件格式不对，需要 { \"用户名\": \"备注\" } 的 JSON。", false);
  }
  importFile.value = "";
});

ttLoadSettings().then((settings) => {
  for (const section of TT_SECTIONS) {
    const heading = document.createElement("h2");
    heading.textContent = section.title;
    form.append(heading);
    for (const { key, label } of section.options) {
      const row = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Boolean(settings[key]);
      input.addEventListener("change", () => chrome.storage.sync.set({ [key]: input.checked }));
      row.append(input, label);
      form.append(row);
    }
  }
});
