export type PageSession = {
  twitchUserId: string;
  csrf: string;
};

export type PageOptions = {
  session?: PageSession | null;
  mainClass?: string;
  bodyClass?: string;
};

const THEME_BOOTSTRAP = `(() => {
  const root = document.documentElement;
  let saved = null;
  try { saved = localStorage.getItem("orbsky-theme"); } catch {}
  const theme = saved === "light" || saved === "dark"
    ? saved
    : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
})();`;

const PAGE_SCRIPT = `(() => {
  const root = document.documentElement;
  root.classList.add("js-ready");

  const themeButton = document.querySelector("[data-theme-toggle]");
  const syncThemeButton = () => {
    if (!(themeButton instanceof HTMLButtonElement)) return;
    const isDark = root.dataset.theme === "dark";
    themeButton.textContent = isDark ? "ライト" : "ダーク";
    themeButton.setAttribute("aria-label", isDark ? "ライトモードに切り替える" : "ダークモードに切り替える");
    themeButton.setAttribute("aria-pressed", String(isDark));
  };
  syncThemeButton();
  themeButton?.addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    root.style.colorScheme = next;
    try { localStorage.setItem("orbsky-theme", next); } catch {}
    syncThemeButton();
  });

  const tabs = Array.from(document.querySelectorAll("[data-channel-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-channel-panel]"));
  const previewText = document.querySelector("[data-preview-text]");
  const previewChannel = document.querySelector("[data-preview-channel]");
  const previewState = document.querySelector("[data-preview-state]");

  const replaceAll = (value, token, replacement) => value.split(token).join(replacement);
  const updatePreview = (panel) => {
    if (!(panel instanceof HTMLElement)) return;
    const form = panel.querySelector("[data-posting-form]");
    if (!(form instanceof HTMLFormElement)) return;
    const textarea = form.querySelector("[data-post-template]");
    const includeTitle = form.querySelector("[data-include-title]");
    const includeCategory = form.querySelector("[data-include-category]");
    const postOnStart = form.querySelector("[data-post-on-start]");
    if (!(textarea instanceof HTMLTextAreaElement)) return;

    let rendered = textarea.value;
    rendered = replaceAll(rendered, "{title}", includeTitle instanceof HTMLInputElement && includeTitle.checked ? "週末の雑談配信" : "");
    rendered = replaceAll(rendered, "{category}", includeCategory instanceof HTMLInputElement && includeCategory.checked ? "Just Chatting" : "");
    rendered = replaceAll(rendered, "{channel}", panel.dataset.channelDisplay || panel.dataset.channelLogin || "Twitchチャンネル");
    rendered = replaceAll(rendered, "{url}", "https://twitch.tv/" + (panel.dataset.channelLogin || "channel"));
    rendered = rendered.replace(/\\n{3,}/g, "\\n\\n").trim();

    if (previewText) previewText.textContent = rendered || "配信開始しました";
    if (previewChannel) previewChannel.textContent = "@" + (panel.dataset.channelLogin || "channel");
    if (previewState) {
      const enabled = postOnStart instanceof HTMLInputElement && postOnStart.checked;
      previewState.textContent = enabled ? "配信開始時に投稿されます" : "自動ポストはオフです";
      previewState.classList.toggle("is-off", !enabled);
    }
  };

  const activatePanel = (panelId) => {
    let activePanel = null;
    for (const panel of panels) {
      const active = panel instanceof HTMLElement && panel.id === panelId;
      if (panel instanceof HTMLElement) panel.hidden = !active;
      if (active) activePanel = panel;
    }
    for (const tab of tabs) {
      if (!(tab instanceof HTMLElement)) continue;
      const active = tab.dataset.channelTarget === panelId;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    if (activePanel) updatePreview(activePanel);
  };

  if (tabs.length && panels.length) {
    const hashId = location.hash.startsWith("#channel-") ? location.hash.slice(1) : "";
    const initial = panels.some((panel) => panel instanceof HTMLElement && panel.id === hashId)
      ? hashId
      : (tabs[0] instanceof HTMLElement ? tabs[0].dataset.channelTarget : "");
    if (initial) activatePanel(initial);
    for (const tab of tabs) {
      tab.addEventListener("click", () => {
        if (!(tab instanceof HTMLElement) || !tab.dataset.channelTarget) return;
        activatePanel(tab.dataset.channelTarget);
        history.replaceState(null, "", "#" + tab.dataset.channelTarget);
      });
      tab.addEventListener("keydown", (event) => {
        if (!(event instanceof KeyboardEvent)) return;
        const current = tabs.indexOf(tab);
        let next = current;
        if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
        else if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabs.length - 1;
        else return;
        event.preventDefault();
        const nextTab = tabs[next];
        if (!(nextTab instanceof HTMLElement) || !nextTab.dataset.channelTarget) return;
        nextTab.focus();
        activatePanel(nextTab.dataset.channelTarget);
        history.replaceState(null, "", "#" + nextTab.dataset.channelTarget);
      });
    }
  }

  for (const form of document.querySelectorAll("[data-posting-form]")) {
    form.addEventListener("input", () => {
      const panel = form.closest("[data-channel-panel]");
      if (panel instanceof HTMLElement && !panel.hidden) updatePreview(panel);
    });
  }

  for (const button of document.querySelectorAll("[data-insert-token]")) {
    button.addEventListener("click", () => {
      if (!(button instanceof HTMLButtonElement)) return;
      const form = button.closest("[data-posting-form]");
      const textarea = form?.querySelector("[data-post-template]");
      if (!(textarea instanceof HTMLTextAreaElement)) return;
      const token = button.dataset.insertToken || "";
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.setRangeText(token, start, end, "end");
      textarea.focus();
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
})();`;

const STYLES = `
:root {
  color-scheme: light;
  --bg: #f8fafc;
  --surface: #ffffff;
  --surface-soft: #f5f7fb;
  --surface-warm: #fcfaf6;
  --surface-accent: #f5f0ff;
  --text: #171a2b;
  --text-strong: #0f1424;
  --muted: #667085;
  --muted-strong: #475467;
  --border: #dfe4ec;
  --border-strong: #c9d1de;
  --primary: #7137d6;
  --primary-hover: #5f2bbd;
  --primary-soft: #efe7ff;
  --sky: #1677e8;
  --sky-soft: #eaf4ff;
  --success: #168a55;
  --success-soft: #e7f8ef;
  --danger: #c83e52;
  --danger-soft: #fff0f2;
  --focus: #2589ff;
  --shadow: 0 18px 50px rgba(30, 41, 59, 0.08);
  --header-bg: rgba(255, 255, 255, 0.92);
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #071426;
  --surface: #0c1b2f;
  --surface-soft: #10223a;
  --surface-warm: #17202b;
  --surface-accent: #1b1634;
  --text: #edf2fb;
  --text-strong: #ffffff;
  --muted: #aab5c7;
  --muted-strong: #c4ccda;
  --border: #2a3b54;
  --border-strong: #40516a;
  --primary: #9b5de5;
  --primary-hover: #b47af0;
  --primary-soft: #2a1c4b;
  --sky: #55a7ff;
  --sky-soft: #102d4d;
  --success: #45cc83;
  --success-soft: #0d3526;
  --danger: #ff7d8f;
  --danger-soft: #3a1720;
  --focus: #6bb5ff;
  --shadow: 0 24px 70px rgba(0, 0, 0, 0.28);
  --header-bg: rgba(7, 20, 38, 0.92);
}

* { box-sizing: border-box; }

html {
  min-width: 320px;
  background: var(--bg);
  scroll-behavior: smooth;
}

body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic UI", "Yu Gothic", Meiryo, sans-serif;
  font-size: 16px;
  line-height: 1.7;
  text-rendering: optimizeLegibility;
}

a {
  color: var(--sky);
  text-underline-offset: 0.18em;
}

a:hover { color: var(--primary); }

button, input, textarea { font: inherit; }

button, .button {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  border: 1px solid transparent;
  border-radius: 10px;
  background: var(--primary);
  color: #fff;
  padding: 0.65rem 1.15rem;
  font-weight: 700;
  line-height: 1.2;
  text-decoration: none;
  cursor: pointer;
  transition: background 160ms ease, border-color 160ms ease, color 160ms ease, transform 160ms ease;
}

button:hover, .button:hover {
  background: var(--primary-hover);
  color: #fff;
}

button:active, .button:active { transform: translateY(1px); }

button:focus-visible, .button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--focus) 35%, transparent);
  outline-offset: 2px;
}

.button-secondary {
  border-color: var(--border-strong);
  background: var(--surface);
  color: var(--text);
}

.button-secondary:hover {
  border-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary);
}

.button-danger {
  border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
  background: transparent;
  color: var(--danger);
}

.button-danger:hover { background: var(--danger-soft); color: var(--danger); }

.text-button {
  min-height: auto;
  border: 0;
  background: transparent;
  color: var(--primary);
  padding: 0.5rem 0;
}

.text-button:hover { background: transparent; color: var(--primary-hover); }

input[type="text"], textarea {
  width: 100%;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--surface);
  color: var(--text);
  padding: 0.75rem 0.9rem;
}

textarea {
  min-height: 108px;
  resize: vertical;
  line-height: 1.6;
}

input[type="checkbox"] { accent-color: var(--primary); }

label { color: var(--text-strong); font-weight: 650; }

small, .help-text { color: var(--muted); }

code, pre {
  border-radius: 7px;
  background: var(--surface-soft);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

code { padding: 0.1rem 0.35rem; }

pre {
  overflow-x: auto;
  border: 1px solid var(--border);
  padding: 1rem;
}

pre code { padding: 0; background: transparent; }

.site-header {
  position: sticky;
  z-index: 20;
  top: 0;
  border-bottom: 1px solid var(--border);
  background: var(--header-bg);
  backdrop-filter: blur(16px);
}

.header-inner {
  display: flex;
  width: min(100% - 40px, 1380px);
  min-height: 72px;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  margin: 0 auto;
}

.brand {
  color: var(--text-strong);
  font-size: clamp(1.45rem, 2vw, 1.85rem);
  font-weight: 850;
  letter-spacing: -0.045em;
  text-decoration: none;
}

.brand:hover { color: var(--primary); }

.header-nav {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.25rem;
}

.header-nav > a {
  border-radius: 8px;
  color: var(--muted-strong);
  padding: 0.5rem 0.7rem;
  font-size: 0.92rem;
  font-weight: 650;
  text-decoration: none;
}

.header-nav > a:hover { background: var(--surface-soft); color: var(--text); }

.theme-toggle {
  min-height: 38px;
  border-color: var(--border-strong);
  background: var(--surface);
  color: var(--text);
  padding: 0.45rem 0.75rem;
  font-size: 0.86rem;
}

.theme-toggle:hover { border-color: var(--primary); background: var(--primary-soft); color: var(--primary); }

.account-chip {
  border-left: 1px solid var(--border);
  color: var(--muted);
  margin-left: 0.35rem;
  padding-left: 0.9rem;
  font-size: 0.86rem;
  white-space: nowrap;
}

.page-shell {
  width: min(100% - 48px, 1380px);
  min-height: calc(100vh - 170px);
  margin: 0 auto;
  padding: 2.2rem 0 4rem;
}

.channels-page { padding-top: 1.5rem; }
.channels-page .page-heading { margin-bottom: 0.65rem; }
.channels-page .progress-strip { margin-bottom: 1.1rem; }

.site-footer {
  border-top: 1px solid var(--border);
  color: var(--muted);
}

.footer-inner {
  display: flex;
  width: min(100% - 48px, 1380px);
  min-height: 90px;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin: 0 auto;
  font-size: 0.88rem;
}

.footer-nav { display: flex; flex-wrap: wrap; gap: 1rem; }
.footer-nav a { color: var(--muted-strong); text-decoration: none; }
.footer-nav a:hover { color: var(--primary); }

.page-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 2rem;
  margin-bottom: 1rem;
}

.page-heading h1 {
  color: var(--text-strong);
  margin: 0;
  font-size: clamp(1.75rem, 2.4vw, 2.2rem);
  line-height: 1.25;
  letter-spacing: -0.035em;
}

.page-heading p { max-width: 680px; margin: 0.25rem 0 0; color: var(--muted-strong); }

.status-badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.65rem; }

.status-badge {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--muted-strong);
  padding: 0.42rem 0.75rem;
  font-size: 0.86rem;
  font-weight: 750;
  line-height: 1.2;
}

.status-badge.is-success { border-color: color-mix(in srgb, var(--success) 30%, var(--border)); background: var(--success-soft); color: var(--success); }
.status-badge.is-primary { border-color: color-mix(in srgb, var(--primary) 35%, var(--border)); background: var(--primary-soft); color: var(--primary); }

.progress-strip {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0;
  margin-bottom: 1.55rem;
}

.progress-step {
  position: relative;
  border-bottom: 2px solid var(--border);
  padding: 0.15rem 1rem 0.7rem 0;
}

.progress-step + .progress-step { padding-left: 1.4rem; }
.progress-step.is-complete { border-color: color-mix(in srgb, var(--sky) 55%, var(--border)); }
.progress-step.is-current { border-color: var(--primary); }
.progress-step strong { display: block; color: var(--text-strong); font-size: 0.95rem; }
.progress-step span { color: var(--muted); font-size: 0.82rem; }
.progress-step.is-current span { color: var(--primary); font-weight: 700; }

.section-label {
  display: block;
  color: var(--text-strong);
  margin-bottom: 0.55rem;
  font-size: 0.9rem;
  font-weight: 750;
}

.channel-tabs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  max-width: 760px;
  margin-bottom: 0.8rem;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--surface);
}

.channel-tab {
  min-height: 58px;
  border: 0;
  border-radius: 0;
  background: var(--surface);
  color: var(--text);
  padding: 0.65rem 1.1rem;
  text-align: left;
}

.channel-tab + .channel-tab { border-left: 1px solid var(--border); }
.channel-tab:hover { background: var(--surface-soft); color: var(--text); }
.channel-tab.is-active { background: var(--surface-accent); color: var(--primary); box-shadow: inset 0 0 0 1px var(--primary); }
.channel-tab strong, .channel-tab small { display: block; }
.channel-tab strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.channel-tab small { color: var(--muted); font-weight: 500; }

.empty-state {
  border: 1px dashed var(--border-strong);
  border-radius: 14px;
  background: var(--surface-soft);
  color: var(--muted-strong);
  padding: 2rem;
  text-align: center;
}

.channel-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(300px, 0.95fr);
  gap: 1.75rem;
  align-items: stretch;
}

.channel-panel {
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: var(--shadow);
  line-height: 1.5;
  padding: 1.15rem;
}

.channel-panel + .channel-panel { margin-top: 1rem; }
.js-ready .channel-panel[hidden] { display: none; }

.panel-title { margin: 0 0 0.35rem; color: var(--text-strong); font-size: 1.05rem; }

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 0.45rem;
  padding-bottom: 0.35rem;
}

.setting-copy strong { display: block; color: var(--text-strong); }
.setting-copy span { display: block; color: var(--muted); font-size: 0.82rem; line-height: 1.45; }

.switch-control input {
  appearance: none;
  position: relative;
  width: 50px;
  height: 28px;
  flex: 0 0 auto;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--surface-soft);
  cursor: pointer;
  transition: background 160ms ease, border-color 160ms ease;
}

.switch-control input::after {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 2px 6px rgba(15, 23, 42, 0.22);
  content: "";
  transition: transform 160ms ease;
}

.switch-control input:checked { border-color: var(--primary); background: var(--primary); }
.switch-control input:checked::after { transform: translateX(22px); }

.field { margin-bottom: 0.85rem; }
.field label { display: block; margin-bottom: 0.25rem; }
.field .help-text { display: block; margin-bottom: 0.25rem; font-size: 0.84rem; }
.field textarea { height: 88px; }

.variable-group { margin: 0.35rem 0 0.55rem; }
.variable-group .section-label { margin-bottom: 0; }
.variable-group .help-text { display: block; margin-bottom: 0.25rem; font-size: 0.82rem; line-height: 1.45; }
.variable-buttons { display: flex; flex-wrap: wrap; gap: 0.45rem; }

.variable-chip {
  min-height: 34px;
  border-color: color-mix(in srgb, var(--sky) 25%, var(--border));
  background: var(--sky-soft);
  color: var(--sky);
  padding: 0.35rem 0.65rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8rem;
}

.variable-chip:hover { border-color: var(--sky); background: var(--sky-soft); color: var(--sky); }

.setting-check {
  display: grid;
  grid-template-columns: 20px 1fr;
  gap: 0.55rem;
  align-items: start;
  margin: 0.35rem 0;
}

.setting-check input { width: 18px; height: 18px; margin: 0.3rem 0 0; }
.setting-check label { font-size: 0.92rem; }
.setting-check small { display: block; font-weight: 400; }

.action-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1.5rem;
  margin-top: 0.75rem;
}

.channels-page .channel-panel { padding: 0.9rem; }
.channels-page .setting-row { margin-bottom: 0.3rem; padding-bottom: 0.3rem; }
.channels-page .field { margin-bottom: 0.5rem; }
.channels-page .field textarea {
  height: 80px;
  min-height: 80px;
  padding: 0.55rem 0.75rem;
  line-height: 1.45;
}
.channels-page .variable-group { margin: 0.2rem 0 0.35rem; }
.channels-page .setting-check { margin: 0.15rem 0; line-height: 1.35; }
.channels-page .setting-check input { margin-top: 0.15rem; }
.channels-page .action-row { margin-top: 0.45rem; }
.channels-page .action-row button { min-height: 40px; padding: 0.5rem 1rem; }

.disconnect-form { margin: 0; }

.post-preview {
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface-warm);
  padding: 1.35rem;
}

.post-preview h2 { margin: 0; color: var(--text-strong); font-size: 1.05rem; }
.post-preview > p { margin: 0.25rem 0 1rem; color: var(--muted); font-size: 0.84rem; }

.preview-card {
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--surface);
  padding: 1.15rem;
}

.preview-author strong { display: block; color: var(--text-strong); }
.preview-author span { color: var(--muted); font-size: 0.82rem; }
.preview-text { min-height: 120px; margin: 1rem 0; color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; }
.preview-meta { border-top: 1px solid var(--border); color: var(--muted); padding-top: 0.75rem; font-size: 0.78rem; }
.preview-state { border: 1px solid color-mix(in srgb, var(--sky) 25%, var(--border)); border-radius: 9px; background: var(--sky-soft); color: var(--sky); margin-top: 1rem; padding: 0.65rem 0.8rem; font-size: 0.82rem; font-weight: 650; }
.preview-state.is-off { border-color: var(--border); background: var(--surface-soft); color: var(--muted); }

.notice {
  border: 1px solid color-mix(in srgb, var(--success) 30%, var(--border));
  border-radius: 10px;
  background: var(--success-soft);
  color: var(--success);
  margin-bottom: 1.25rem;
  padding: 0.75rem 0.9rem;
  font-weight: 700;
}

.content-section {
  border-top: 1px solid var(--border);
  margin-top: 2.5rem;
  padding-top: 2rem;
}

.content-section h2 { margin: 0 0 0.45rem; color: var(--text-strong); font-size: 1.3rem; }
.content-section > p { max-width: 780px; color: var(--muted-strong); }

.inline-form { display: flex; max-width: 680px; align-items: end; gap: 0.75rem; }
.inline-form .field { flex: 1; margin: 0; }

.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(300px, 0.75fr);
  min-height: 600px;
  align-items: center;
  gap: 4rem;
}

.hero-kicker { color: var(--primary); font-size: 0.85rem; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
.hero h1 { max-width: 760px; margin: 0.55rem 0 1rem; color: var(--text-strong); font-size: clamp(2.6rem, 6vw, 5.5rem); line-height: 1.05; letter-spacing: -0.06em; }
.hero-lead { max-width: 660px; color: var(--muted-strong); font-size: clamp(1rem, 1.6vw, 1.25rem); }
.hero-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1.75rem; }

.hero-summary {
  border: 1px solid var(--border);
  border-radius: 18px;
  background: var(--surface);
  box-shadow: var(--shadow);
  padding: 1.6rem;
}

.hero-summary h2 { margin: 0 0 1rem; color: var(--text-strong); font-size: 1.1rem; }
.hero-summary ol { display: grid; gap: 1rem; margin: 0; padding-left: 1.4rem; }
.hero-summary li { color: var(--muted-strong); padding-left: 0.25rem; }
.hero-summary li::marker { color: var(--primary); font-weight: 800; }

.dashboard h1 { margin: 0; color: var(--text-strong); font-size: clamp(2rem, 4vw, 3.2rem); letter-spacing: -0.045em; }
.dashboard > p { color: var(--muted-strong); }

.dashboard-actions {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
  margin: 2rem 0;
}

.dashboard-action {
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  color: var(--text);
  padding: 1.3rem;
  text-decoration: none;
}

.dashboard-action:hover { border-color: var(--primary); background: var(--surface-accent); color: var(--text); }
.dashboard-action strong { display: block; color: var(--text-strong); margin-bottom: 0.3rem; }
.dashboard-action span { color: var(--muted); font-size: 0.88rem; }

.content-page { max-width: 980px; }
.content-page.wide { max-width: 1180px; }
.back-link { display: inline-block; margin-bottom: 1rem; color: var(--muted-strong); text-decoration: none; }
.back-link:hover { color: var(--primary); }
.content-page h1 { margin: 0 0 0.5rem; color: var(--text-strong); font-size: clamp(2rem, 4vw, 3rem); line-height: 1.2; letter-spacing: -0.04em; }
.content-page > .lead { max-width: 780px; color: var(--muted-strong); font-size: 1.05rem; }
.content-page h2 { border-top: 1px solid var(--border); margin: 2.5rem 0 0.75rem; padding-top: 2rem; color: var(--text-strong); font-size: 1.35rem; }
.content-page h3 { color: var(--text-strong); font-size: 1.02rem; }
.content-page li { margin: 0.35rem 0; }

.content-card {
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: var(--shadow);
  margin-top: 1.25rem;
  padding: 1.35rem;
}

.content-card h2 { border: 0; margin-top: 0; padding-top: 0; }

.feature-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin: 1.5rem 0; }
.feature-item { border-top: 3px solid var(--primary); background: var(--surface); padding: 1.15rem 0.2rem 0; }
.feature-item strong { display: block; color: var(--text-strong); }
.feature-item span { color: var(--muted); font-size: 0.88rem; }

.step-list { counter-reset: steps; display: grid; gap: 1rem; list-style: none; padding: 0; }
.step-list > li { counter-increment: steps; position: relative; border-left: 2px solid var(--border); margin: 0; padding: 0 0 0.75rem 3rem; }
.step-list > li::before { position: absolute; left: -1rem; top: 0; display: grid; width: 2rem; height: 2rem; place-items: center; border-radius: 50%; background: var(--primary); color: white; content: counter(steps); font-size: 0.82rem; font-weight: 800; }
.step-list h3 { margin-top: 0; }

.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; }
table { width: 100%; border-collapse: collapse; background: var(--surface); }
th, td { border-bottom: 1px solid var(--border); padding: 0.8rem 0.9rem; text-align: left; vertical-align: top; }
th { background: var(--surface-soft); color: var(--text-strong); font-size: 0.84rem; }
tr:last-child td { border-bottom: 0; }

.support-layout, .settings-layout { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(300px, 0.85fr); gap: 1.25rem; align-items: start; }
.stack { display: grid; gap: 1.25rem; }
.plan-list { margin: 0; padding-left: 1.2rem; }
.plan-list li { margin: 0.5rem 0; }
.status-line { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid var(--border); padding: 0.8rem 0; }
.status-line:first-of-type { padding-top: 0; }
.status-line:last-of-type { border-bottom: 0; padding-bottom: 0; }

.forms-stack { display: grid; gap: 0.65rem; }
.forms-stack form { margin: 0; }

.logout-form { margin-top: 2rem; }

@media (max-width: 980px) {
  .header-inner, .page-shell, .footer-inner { width: min(100% - 32px, 1380px); }
  .header-nav > a.hide-tablet { display: none; }
  .page-heading { display: block; }
  .status-badges { justify-content: flex-start; margin-top: 1rem; }
  .channel-workspace, .support-layout, .settings-layout, .hero { grid-template-columns: 1fr; }
  .post-preview { min-height: 0; }
  .dashboard-actions, .feature-grid { grid-template-columns: 1fr; }
  .hero { min-height: auto; gap: 2rem; padding: 3rem 0; }
}

@media (max-width: 700px) {
  .header-inner { min-height: 64px; gap: 0.75rem; }
  .header-nav { gap: 0.1rem; }
  .header-nav > a { display: none; }
  .account-chip { display: none; }
  .page-shell { padding-top: 1.5rem; }
  .footer-inner { align-items: flex-start; flex-direction: column; justify-content: center; padding: 1rem 0; }
  .progress-strip { grid-template-columns: 1fr; }
  .progress-step, .progress-step + .progress-step { padding: 0.65rem 0; }
  .channel-tabs { grid-template-columns: 1fr; }
  .channel-tab + .channel-tab { border-top: 1px solid var(--border); border-left: 0; }
  .channel-panel, .post-preview, .content-card { padding: 1rem; }
  .setting-row, .inline-form { align-items: stretch; flex-direction: column; }
  .setting-row { display: flex; }
  .switch-control { align-self: flex-start; }
  .action-row { align-items: stretch; flex-direction: column; gap: 0.5rem; }
  .action-row > *, .action-row form, .action-row button { width: 100%; }
  .hero h1 { font-size: clamp(2.45rem, 14vw, 4rem); }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
}
`;

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function renderHtmlPage(
  title: string,
  body: string,
  options: PageOptions = {},
): string {
  const session = options.session ?? null;
  const mainClass = options.mainClass ? ` ${escapeAttribute(options.mainClass)}` : "";
  const bodyClass = options.bodyClass
    ? ` class="${escapeAttribute(options.bodyClass)}"`
    : "";
  const authenticatedNav = session
    ? `<a href="/channels">チャンネル</a>
       <a href="/settings">Bluesky設定</a>
       <a class="hide-tablet" href="/support">特典</a>`
    : "";
  const account = session
    ? `<span class="account-chip">ログイン中: ${escapeAttribute(session.twitchUserId)}</span>`
    : "";

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeAttribute(title)}</title>
  <script>${THEME_BOOTSTRAP}</script>
  <style>${STYLES}</style>
</head>
<body${bodyClass}>
  <header class="site-header">
    <div class="header-inner">
      <a class="brand" href="/" aria-label="orbsky トップ">orbsky</a>
      <nav class="header-nav" aria-label="メインナビゲーション">
        ${authenticatedNav}
        <a class="hide-tablet" href="/guide">使い方</a>
        <button class="theme-toggle" type="button" data-theme-toggle aria-label="表示テーマを切り替える">テーマ</button>
        ${account}
      </nav>
    </div>
  </header>
  <main class="page-shell${mainClass}">${body}</main>
  <footer class="site-footer">
    <div class="footer-inner">
      <span>orbsky — Twitchの配信をBlueskyへ</span>
      <nav class="footer-nav" aria-label="フッターナビゲーション">
        <a href="/">トップ</a>
        <a href="/guide">機能概要・使い方</a>
        <a href="/privacy">プライバシーポリシー</a>
      </nav>
    </div>
  </footer>
  <script>${PAGE_SCRIPT}</script>
</body>
</html>`;
}
