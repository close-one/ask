import type { CliRenderer, KeyEvent } from "@opentui/core";
import { terminalField } from "@codehaus-au/ask/internal/terminal";
import { SkillResolutionError } from "@codehaus-au/ask/internal/skills";
import { TuiChat } from "./chat.ts";
import { themeModes, type ThemeMode } from "./themes.ts";
import { TuiTheme } from "./theme.ts";
import { createChatLayout } from "./layout.ts";
import { createTranscript } from "./transcript.ts";
import { createClipboardController, type ClipboardFactory } from "./clipboard.ts";
import { createCompletion, type UIState } from "./completion.ts";
import { dispatchCommand } from "./commands.ts";

export { TUI_HELP } from "./commands.ts";
export { SIDEBAR_MIN_WIDTH, SIDEBAR_MIN_COLUMNS, CHAT_MIN_COLUMNS } from "./layout.ts";
export interface TuiUIOptions {
  readonly theme?: string;
  readonly createClipboard?: ClipboardFactory;
  /** Startup warnings, shown in the transcript rather than written over the UI. */
  readonly notices?: readonly string[];
}

/** Coordinates components and the single in-flight submission/write lifecycle. */
export function mountChatUI(renderer: CliRenderer, chat: TuiChat, model: string, options: TuiUIOptions = {}) {
  const theme = new TuiTheme();
  if (options.theme !== undefined) theme.select(options.theme, themeModes(options.theme)[0]!);
  const state: UIState = { working: false, alive: true };
  let completion: ReturnType<typeof createCompletion> | undefined;
  const layout = createChatLayout(renderer, model, chat.sessionStats.cwd, {
    onSubmit: () => { void submit(); },
    onContentChange: () => completion?.contentChanged(),
    onCursorChange: () => completion?.refresh(),
  });
  const { root, input, status, picker, transcript } = layout;
  const view = createTranscript(renderer, transcript, theme);
  const clipboard = createClipboardController(renderer, input, status, options.createClipboard);
  function paintTheme() { theme.paint(root); view.paintTheme(); }
  root.renderBefore = paintTheme;
  function applyTheme(name: string, mode: ThemeMode) {
    if (theme.name === name && theme.mode === mode) return;
    theme.select(name, mode); view.updateStyle(); paintTheme();
  }
  function refreshSummary() {
    if (state.alive) layout.refreshSummary(chat.sessionStats, chat.activeSkillNames, chat.pendingCount);
  }
  function addText(content: string, color?: string) { if (state.alive) view.addText(content, color); }
  completion = createCompletion(renderer, chat, layout, theme, state, { submit, refreshSummary, applyTheme, addText });
  const review = (paths: readonly string[]) => view.review(chat.reviewDetails(paths));

  async function submit() {
    if (state.working || !state.alive) return;
    const text = input.plainText.trim();
    if (!text) return;
    clipboard.submitted();
    state.working = true; picker.visible = false; input.setText("");
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const command = await dispatchCommand(text, chat, {
        quit: () => renderer.destroy(), clear: view.clear, review, copy: clipboard.copyText,
        addText, openManager: (mode, query) => completion!.openManager(mode, query),
      });
      if (command === "return" || !state.alive) return;
      if (command === "prompt") {
        view.addUserMessage(text); status.content = `Waiting for ${terminalField(model)}…`;
        // Only a model request shows the waiting timer; local commands do not.
        const started = Date.now();
        timer = setInterval(() => {
          if (state.alive) status.content = `Waiting for ${terminalField(model)}… ${((Date.now() - started) / 1000).toFixed(1)}s · no automatic follow-up`;
        }, 250);
        const reply = await chat.submit(text, refreshSummary);
        if (!state.alive) return;
        if (reply.missing.length) addText(`Removed attachments that no longer exist: ${reply.missing.map(terminalField).join(", ")}`, "#fcd34d");
        if (reply.historyDropped) {
          const limit = chat.sessionStats.contextWindow === null ? "the default history cap (set --context-window to use your model's limit)" : "the context window";
          addText(`Dropped the ${reply.historyDropped} oldest history message(s) to fit ${limit}. Attached files are still sent in full.`, "#fcd34d");
        }
        view.addAnswer(reply.text);
        if (reply.context.skipped.length) addText(`Skipped context: ${reply.context.skipped.map((item) => `${terminalField(item.path)} (${item.reason})`).join(", ")}`, "#fcd34d");
        if (reply.context.truncated) addText("Context was truncated; truncated files cannot be updated.", "#fcd34d");
        if (reply.proposalError) addText(`Edits unavailable: ${reply.proposalError}`, "#fcd34d");
        if (chat.pendingCount) view.proposals(chat.pendingSummary);
      }
      if (state.alive) status.content = chat.pendingCount ? `${chat.pendingCount} pending file(s) · /review to inspect · /apply to approve · /reject to discard` : "Ready · /help for commands";
    } catch (error) {
      if (state.alive) {
        addText(error instanceof Error ? error.message : String(error), "#fda4af");
        if (error instanceof SkillResolutionError && error.candidates.length) addText(error.candidates.map(terminalField).join("\n"), "#fcd34d");
        status.content = "Failed · no automatic retry · your draft has been restored";
        if (!input.plainText) { input.setText(text); input.gotoBufferEnd(); }
      }
    } finally {
      if (timer) clearInterval(timer);
      state.working = false;
      if (state.alive) { input.focus(); completion!.refresh(); refreshSummary(); }
    }
  }

  const keypress = (key: KeyEvent) => {
    // Super is Command; Meta is usually Alt/Option and is intentionally unbound.
    if (key.super && key.name === "c") { key.preventDefault(); clipboard.copyText(clipboard.selectedText() || null); return; }
    if ((key.ctrl || key.super) && key.name === "v") { key.preventDefault(); void clipboard.pasteText(); return; }
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      const selection = clipboard.selectedText();
      if (selection) clipboard.copyText(selection); else renderer.destroy();
      return;
    }
    if (key.ctrl && key.name === "d") { key.preventDefault(); renderer.destroy(); return; }
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault(); transcript.scrollBy(key.name === "pageup" ? -10 : 10); return;
    }
    completion!.handleKey(key);
  };
  renderer.keyInput.on("keypress", keypress);
  const resize = () => { layout.resize(); view.resize(); refreshSummary(); completion!.refresh(); };
  renderer.on("resize", resize);
  renderer.once("destroy", () => {
    state.alive = false;
    completion!.dispose(); clipboard.dispose();
    renderer.removeListener("resize", resize);
    renderer.keyInput.removeListener("keypress", keypress);
    view.dispose();
  });
  addText("Ask a question or discuss a function. Attach @files or @folders anywhere.\nSuggested <update> blocks become reviewable diffs, never automatic writes. /help for commands.");
  for (const notice of options.notices ?? []) addText(notice, "#fcd34d");
  if (chat.activeSkillNames.length) addText(`Active skills: ${chat.activeSkillNames.map(terminalField).join(", ")}`);
  refreshSummary();
  return {
    input, composer: layout.composer, sidebar: layout.sidebar, sidebarDivider: layout.sidebarDivider,
    picker, footerLeft: layout.footerLeft, footerRight: layout.footerRight, transcript,
    setCandidates: completion.setCandidates, setIndexError: completion.setIndexError,
    get working() { return state.working; },
    get pasting() { return clipboard.pasting; },
    get loadingSkills() { return completion!.loadingSkills; },
    get theme() { return { name: theme.name, mode: theme.mode }; },
  };
}
