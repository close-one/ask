import {
  BoxRenderable, MarkdownRenderable, ScrollBoxRenderable, SyntaxStyle,
  TextareaRenderable, TextRenderable, StyledText, bold, fg, italic, strikethrough,
  createHostClipboard, PasteEvent,
  type CliRenderer, type TextChunk, type HostClipboardService, type MouseEvent,
} from "@opentui/core";
import type { Token } from "marked";
import { rankMatch } from "../refs.ts";
import { sanitizeForTerminal, terminalField } from "../terminal.ts";
import { TuiChat } from "./chat.ts";
import { SkillResolutionError, type SkillSummary } from "../skills.ts";
import { filterPopupItems, isFileCandidateVisible, SLASH_COMMANDS, type PopupItem } from "./picker.ts";
import { THEME_NAMES, themeModes, type ThemeMode } from "./themes.ts";
import { TuiTheme } from "./theme.ts";

export const TUI_HELP = `Chat: mention @files or @folders anywhere; quote paths with spaces.
Each submission makes one request. No model tools or automatic follow-up requests.
/review  show pending diffs    /apply  approve writes    /reject  discard proposals
/context  manage context    /detach [path]  remove a reference or file
/attach [term]  toggle attached files/folders locally
/skill [term] or /skills [term]  open the same searchable skill-selection popup
/unskill [name]  choose/remove an active skill (instructions only; no scripts)
/copy  copy the last answer (Markdown) to your terminal clipboard
/theme [name]  choose a bundled termcn theme for this TUI run
/new  clear this in-memory conversation    /help    /quit
Enter selects an open mention, otherwise sends · Shift+Enter inserts a newline
Type / for searchable commands · /context, /detach and /unskill open management popups
Ctrl+C copies highlighted text (OSC52); without a selection it exits
Ctrl+D always exits · /copy copies the last answer as Markdown
Ctrl+V pastes local clipboard text · Command/Super+C copies · Command/Super+V pastes
Tab also selects a mention · Esc closes picker · Shift+drag uses native terminal selection
PageUp/PageDown scroll the conversation. Chat history is not saved after exit.
Updates only: use the existing ask /create command for new files.`;

export const SIDEBAR_MIN_WIDTH = 120;
const SIDEBAR_DEFAULT_COLUMNS = 32;
export const SIDEBAR_MIN_COLUMNS = 24;
export const CHAT_MIN_COLUMNS = 60;
const COMPOSER_PADDING = 2;
const COMPOSER_BORDER_COLUMNS = 1;
const COMPOSER_INPUT_ROWS = 4;
const COMPOSER_ROWS = COMPOSER_INPUT_ROWS + 2;

const sidebarHeading = (text: string) => fg("#f8fafc")(bold(text));
const MAX_PASTE_BYTES = 1024 * 1024;

export interface TuiUIOptions {
  readonly theme?: string;
  readonly createClipboard?: () => Pick<HostClipboardService, "read" | "dispose">;
}

/** Render inline markup with native text, without a Tree-sitter worker/download. */
function inlineChunks(tokens: readonly Token[]): TextChunk[] {
  return tokens.flatMap((token): TextChunk[] => {
    switch (token.type) {
      case "strong": return inlineChunks(token.tokens ?? []).map(bold);
      case "em": return inlineChunks(token.tokens ?? []).map(italic);
      case "del": return inlineChunks(token.tokens ?? []).map(strikethrough);
      case "codespan": return [fg("#a7f3d0")(String(token.text))];
      case "link": return [...inlineChunks(token.tokens ?? []), fg("#9baac1")(` (${String(token.href)})`)];
      case "image": return [fg("#9baac1")(`${String(token.text)} (${String(token.href)})`)];
      case "br": return [fg("#e2e8f0")("\n")];
      case "text": return token.tokens ? inlineChunks(token.tokens) : [fg("#e2e8f0")(String(token.text))];
      default: return [fg("#e2e8f0")(token.raw)];
    }
  });
}

export function mountChatUI(renderer: CliRenderer, chat: TuiChat, model: string, options: TuiUIOptions = {}) {
  const theme = new TuiTheme();
  if (options.theme !== undefined) theme.select(options.theme, themeModes(options.theme)[0]!);
  // Markdown's native internal blocks are not exposed through getChildren().
  const markdownText = new Set<TextRenderable>();
  const caps: { text: TextRenderable; glyph: string }[] = [];
  function messageCap(id: string, glyph: string) {
    const text = new TextRenderable(renderer, {
      id, content: glyph.repeat(renderer.width), width: "100%", height: 1, flexShrink: 0,
      fg: "#1b2533", bg: "#10151d", wrapMode: "none", overflow: "hidden", selectable: false,
    });
    caps.push({ text, glyph });
    return text;
  }
  const root = new BoxRenderable(renderer, {
    width: "100%", height: "100%", flexDirection: "column", padding: 1,
    backgroundColor: "#10151d", gap: 0,
  });
  renderer.root.add(root);
  function paintTheme() {
    theme.paint(root);
    for (const text of markdownText) {
      if (text.isDestroyed) markdownText.delete(text); else theme.paint(text);
    }
  }
  root.renderBefore = paintTheme;
  const body = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, minHeight: 0, gap: 2 });
  root.add(body);
  const main = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, gap: 1 });
  body.add(main);
  main.add(new TextRenderable(renderer, {
    content: `ask  /  ${terminalField(model)}  ·  chat, not an agent`, fg: "#82cfff", flexShrink: 0,
  }));
  const transcript = new ScrollBoxRenderable(renderer, {
    flexGrow: 1, minHeight: 1, scrollY: true, scrollX: false,
    stickyScroll: true, stickyStart: "bottom", contentOptions: { flexDirection: "column", gap: 1 },
  });
  main.add(transcript);
  const status = new TextRenderable(renderer, { content: "Ready · /help for commands", fg: "#9baac1", height: 1, flexShrink: 0, wrapMode: "none" });
  main.add(status);
  const composer = new BoxRenderable(renderer, { height: COMPOSER_ROWS, flexDirection: "column", flexShrink: 0, overflow: "visible" });
  const composerFooter = new BoxRenderable(renderer, { flexDirection: "column", flexShrink: 0, gap: 0, overflow: "visible" });
  main.add(composerFooter);
  composerFooter.add(composer);
  const topCap = messageCap("composer-top-cap", "▄");
  const inputArea = new BoxRenderable(renderer, {
    id: "composer-input-area", width: "100%", height: COMPOSER_INPUT_ROWS,
    flexShrink: 0, paddingX: COMPOSER_PADDING, backgroundColor: "#1b2533",
    border: ["left"], borderColor: "#82cfff",
  });
  const bottomCap = messageCap("composer-bottom-cap", "▀");
  composer.add(topCap); composer.add(inputArea); composer.add(bottomCap);
  // Absolute positioning overlays the transcript instead of reflowing it as
  // candidates change. The popup is anchored immediately above the composer.
  const picker = new BoxRenderable(renderer, {
    id: "composer-popup", position: "absolute", bottom: COMPOSER_ROWS, left: 0, width: "100%",
    zIndex: 100, visible: false, border: true, borderColor: "#82cfff",
    backgroundColor: "#1b2533", flexDirection: "column", title: "Files / folders",
  });
  const pickerMetadata = new TextRenderable(renderer, { content: "", fg: "#9baac1", height: 2, wrapMode: "none", selectable: false, visible: false });
  picker.add(pickerMetadata);
  const pickerRows = new TextRenderable(renderer, { id: "popup-options", content: "", fg: "#82cfff", wrapMode: "none" });
  picker.add(pickerRows);
  const pickerHint = new TextRenderable(renderer, { content: "↑↓ move · Enter/Tab select · Esc close", fg: "#9baac1", height: 1, wrapMode: "none" });
  picker.add(pickerHint);
  const sidebar = new BoxRenderable(renderer, {
    id: "session-sidebar", width: SIDEBAR_DEFAULT_COLUMNS, flexShrink: 0, flexDirection: "column", gap: 1,
    border: ["left"], borderColor: "#344256", paddingLeft: 2,
    visible: renderer.width >= SIDEBAR_MIN_WIDTH,
  });
  body.add(sidebar);
  const sidebarDivider = new BoxRenderable(renderer, {
    id: "sidebar-divider", position: "absolute", left: -1, top: 0, width: 2, height: "100%",
    zIndex: 20, border: ["left"], borderColor: "#344256",
  });
  sidebar.add(sidebarDivider);
  const summaryScroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1, minHeight: 1, scrollY: true, scrollX: false,
  });
  sidebar.add(summaryScroll);
  const summary = new TextRenderable(renderer, { id: "session-summary", content: "", fg: "#cbd5e1", width: "100%", flexShrink: 0 });
  summaryScroll.add(summary);
  const sidebarCwd = new TextRenderable(renderer, {
    id: "sidebar-cwd", content: terminalField(chat.sessionStats.cwd),
    fg: "#9baac1", flexShrink: 0, width: "100%", height: 1,
    wrapMode: "none", overflow: "hidden", textAlign: "right",
  });
  sidebar.add(sidebarCwd);
  const footer = new BoxRenderable(renderer, { id: "session-footer", flexDirection: "row", height: 1, flexShrink: 0, gap: 1 });
  const footerLeft = new TextRenderable(renderer, {
    content: terminalField(chat.sessionStats.cwd), fg: "#9baac1", flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0,
    height: 1, wrapMode: "none", overflow: "hidden",
  });
  const footerRight = new TextRenderable(renderer, { content: "Tokens: —", fg: "#82cfff", height: 1, flexShrink: 0, wrapMode: "none" });
  footer.add(footerLeft); footer.add(footerRight); composerFooter.add(footer);
  const style = SyntaxStyle.fromStyles({
    default: { fg: theme.palette.text },
    "markup.heading": { fg: theme.palette.accent, bold: true },
    "markup.strong": { bold: true },
    "markup.raw": { fg: theme.palette.code },
  }, renderer.nativeScene);
  let working = false;
  let alive = true;
  let preferredSidebarWidth = SIDEBAR_DEFAULT_COLUMNS;
  let sidebarDrag: { x: number; width: number } | null = null;
  let dividerHovered = false;
  let candidates: readonly string[] = [];
  let matches: PopupItem[] = [];
  let pickerMode: "mention" | "commands" | "detach" | "unskill" | "context" | "skills" | "files" | "themes" = "mention";
  let pickerPrefix = "";
  let skillCatalog: readonly SkillSummary[] = [];
  let skillsReady = false;
  let loadingSkills = false;
  let skillLoadId = 0;
  let skillLoadError = "";
  let selected = 0;
  let dismissedAt = "";
  let themeBeforePreview: { name: string; mode: ThemeMode } | null = null;
  let pickerError = "";
  let serial = 0;
  let draftEpoch = 0;
  let pasting = false;
  let clipboard: Pick<HostClipboardService, "read" | "dispose"> | undefined;
  const pasteLifetime = new AbortController();
  const input = new TextareaRenderable(renderer, {
    id: "composer", height: COMPOSER_INPUT_ROWS, flexShrink: 0, width: "100%",
    backgroundColor: "#1b2533", focusedBackgroundColor: "#1b2533",
    textColor: "#e2e8f0", cursorColor: "#82cfff",
    placeholder: "Ask a question… @ to attach context",
    keyBindings: [
      { name: "return", action: "submit" },
      { name: "return", shift: true, action: "newline" },
    ],
    onSubmit: () => { void submit(); },
    onContentChange: () => { dismissedAt = ""; refreshPicker(); },
    onCursorChange: () => refreshPicker(),
  });
  inputArea.add(input);
  const cwdPath = terminalField(chat.sessionStats.cwd);
  const cwdSegments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(cwdPath)].map((part) => part.segment);
  function updateSidebarCwd(width: number) {
    if (input.editBuffer.measureText(cwdPath) <= width) {
      sidebarCwd.content = cwdPath;
      return;
    }
    let suffix = "";
    for (let index = cwdSegments.length - 1; index >= 0; index--) {
      const next = cwdSegments[index]! + suffix;
      if (input.editBuffer.measureText("…" + next) > width) break;
      suffix = next;
    }
    sidebarCwd.content = width > 0 ? "…" + suffix : "";
  }
  sidebarCwd.onSizeChange = () => updateSidebarCwd(sidebarCwd.width);
  composer.add(picker);
  composer.onMouseDown = (event) => {
    if (event.target === topCap || event.target === bottomCap || event.target === inputArea) {
      event.preventDefault(); input.focus();
    }
  };
  root.onMouseDown = (event) => {
    if (event.button !== 0 || event.defaultPrevented) return;
    for (let target = event.target; target; target = target.parent) {
      if (target === input || target === picker || target === sidebarDivider) return;
    }
    // Stop OpenTUI's subsequent autofocus from moving focus to a ScrollBox.
    // Text selection starts before this event, so preserve an active selection
    // drag while returning keyboard focus to the composer.
    event.preventDefault();
    if (!renderer.getSelection()?.isDragging) renderer.clearSelection();
    input.focus();
  };
  input.focus();

  function clampSidebarWidth(width: number): number {
    // Two outer padding columns and two columns between the panes.
    const available = renderer.width - 4;
    const max = Math.max(SIDEBAR_MIN_COLUMNS, Math.min(Math.floor(available / 2), available - CHAT_MIN_COLUMNS - COMPOSER_PADDING * 2 - COMPOSER_BORDER_COLUMNS));
    return Math.max(SIDEBAR_MIN_COLUMNS, Math.min(max, Math.round(width)));
  }

  function layoutSidebar() {
    sidebar.visible = renderer.width >= SIDEBAR_MIN_WIDTH;
    sidebar.width = clampSidebarWidth(preferredSidebarWidth);
    updateSidebarCwd(Math.max(0, sidebar.width - 3)); // left border and padding
  }

  function updateDividerAppearance() {
    sidebarDivider.borderColor = sidebarDrag || dividerHovered ? "#82cfff" : "#344256";
    renderer.setMousePointer(sidebarDrag || dividerHovered ? "col-resize" : "auto");
  }

  function dragSidebar(event: MouseEvent) {
    if (!alive || !sidebarDrag || !sidebar.visible) return;
    event.preventDefault(); event.stopPropagation();
    preferredSidebarWidth = clampSidebarWidth(sidebarDrag.width + sidebarDrag.x - event.x);
    layoutSidebar();
    updateDividerAppearance();
  }

  function finishSidebarDrag(event: MouseEvent) {
    if (!sidebarDrag) return;
    dragSidebar(event);
    sidebarDrag = null;
    dividerHovered = false;
    updateDividerAppearance();
    input.focus();
  }

  sidebarDivider.onMouseOver = () => { dividerHovered = true; updateDividerAppearance(); };
  sidebarDivider.onMouseOut = () => { dividerHovered = false; updateDividerAppearance(); };
  sidebarDivider.onMouseDown = (event) => {
    if (event.button !== 0 || !sidebar.visible) return;
    event.preventDefault(); event.stopPropagation();
    sidebarDrag = { x: event.x, width: sidebar.width };
    updateDividerAppearance();
  };
  sidebarDivider.onMouseDrag = dragSidebar;
  sidebarDivider.onMouseDragEnd = finishSidebarDrag;
  sidebarDivider.onMouseUp = finishSidebarDrag;

  function addText(content: string, color = "#9baac1") {
    if (!alive) return;
    transcript.add(new TextRenderable(renderer, {
      id: `message-${serial++}`, content: sanitizeForTerminal(content), fg: color, width: "100%", flexShrink: 0, selectable: true,
    }));
  }

  function addUserMessage(content: string) {
    const id = `user-${serial++}`;
    const message = new BoxRenderable(renderer, { id, width: "100%", flexDirection: "column", flexShrink: 0 });
    const panel = new BoxRenderable(renderer, {
      id: `${id}-body`, width: "100%", flexShrink: 0,
      backgroundColor: "#1b2533", border: ["left"], borderColor: "#82cfff", paddingX: COMPOSER_PADDING,
    });
    panel.add(new TextRenderable(renderer, {
      content: sanitizeForTerminal(content), fg: "#e2e8f0", width: "100%", flexShrink: 0, selectable: true,
    }));
    message.add(messageCap(`${id}-top-cap`, "▄"));
    message.add(panel);
    message.add(messageCap(`${id}-bottom-cap`, "▀"));
    transcript.add(message);
  }

  function addAnswer(content: string) {
    transcript.add(new MarkdownRenderable(renderer, {
      id: `answer-${serial++}`, content: sanitizeForTerminal(content), syntaxStyle: style,
      width: "100%", flexShrink: 0, conceal: true, internalBlockMode: "top-level",
      // Override EVERY block, not just fenced code. OpenTUI's default paragraph
      // renderer also uses Tree-sitter and can be blank while its parser loads.
      renderNode: (token) => {
        const chunks = token.type === "paragraph" || token.type === "heading"
          ? inlineChunks(token.tokens ?? []) : null;
        const text = new TextRenderable(renderer, {
          content: chunks ? new StyledText(token.type === "heading" ? chunks.map((chunk) => fg("#82cfff")(bold(chunk))) : chunks)
            : sanitizeForTerminal(token.type === "code" ? String(token.text) : token.raw.replace(/\n+$/, "")),
          fg: token.type === "code" ? "#a7f3d0" : "#e2e8f0", width: "100%", flexShrink: 0, selectable: true,
        });
        markdownText.add(text);
        theme.paint(text);
        return text;
      },
    }));
  }

  function refreshSummary() {
    if (!alive) return;
    layoutSidebar();
    const stats = chat.sessionStats;
    const number = (value: number | null) => value === null ? "unknown" : value.toLocaleString("en-US");
    const used = stats.lastInput !== null && stats.lastOutput !== null ? stats.lastInput + stats.lastOutput : null;
    const percentage = used !== null && stats.contextWindow !== null
      ? ` (${(used / stats.contextWindow * 100).toFixed(1)}%)` : "";
    footerRight.content = !stats.turns ? "Tokens: —" : used === null ? "Tokens: unknown" : `${(used / 1000).toFixed(1)}K tokens${percentage}`;
    const capacity = stats.contextWindow === null ? "Window limit: unknown" : `${number(stats.contextWindow)} token capacity`;
    const context = used === null ? "Usage not reported" : stats.contextWindow === null
      ? `${number(used)} tokens (last response)`
      : `${number(used)} / ${number(stats.contextWindow)} (${(used / stats.contextWindow * 100).toFixed(1)}%)`;
    const total = (value: number, reported: number) => reported ? `${number(value)}${reported < stats.turns ? " (partial)" : ""}` : "unknown";
    const lines = [
      sidebarHeading("Session"), terminalField(model), `${stats.turns} response(s) · ${chat.pendingCount} pending file(s)`, "",
      sidebarHeading("Context window"), ...(!stats.turns ? ["No responses yet"] : [context]), capacity,
      sidebarHeading("Last response (input + output)"), `${number(stats.lastInput)} in / ${number(stats.lastOutput)} out`, "",
      sidebarHeading("Session totals"), `${total(stats.totalInput, stats.inputTurns)} input`, `${total(stats.totalOutput, stats.outputTurns)} output`,
      `Usage reported: ${stats.inputTurns} in / ${stats.outputTurns} out of ${stats.turns} turns`, "",
      sidebarHeading(`Skills (${chat.activeSkillNames.length})`), ...(chat.activeSkillNames.length ? chat.activeSkillNames.map((name) => `• ${terminalField(name)}`) : ["None"]), "",
      sidebarHeading(`Files referenced (${stats.files.length})`), ...(stats.files.length ? stats.files.map((file) => `• ${terminalField(file)}`) : ["None"]),
    ];
    summary.content = new StyledText(lines.map((line, index) => {
      const suffix = index < lines.length - 1 ? "\n" : "";
      return typeof line === "string" ? fg("#cbd5e1")(line + suffix) : { ...line, text: line.text + suffix };
    }));
  }

  function selectedText(): string {
    const draftSelection = input.getSelectedText();
    return (input.focused && draftSelection) || renderer.getSelection()?.getSelectedText() || draftSelection;
  }

  function copyText(text: string | null) {
    if (!text) { status.content = "Nothing to copy. Select text or receive an answer first."; input.focus(); return; }
    const sent = renderer.copyToClipboardOSC52(sanitizeForTerminal(text));
    status.content = sent ? "Copy sent to terminal clipboard (OSC52)" : "Clipboard unavailable. Use Shift+drag or restart with --no-mouse for terminal selection.";
    input.focus();
  }

  function insertPaste(event: PasteEvent) {
    if (!alive) return;
    if (event.metadata?.kind === "binary" || event.bytes.byteLength > MAX_PASTE_BYTES) {
      status.content = "Paste refused: only text up to 1 MiB is supported."; return;
    }
    if (!event.bytes.byteLength) { status.content = "Clipboard is empty."; return; }
    input.focus();
    // Use the same ANSI stripping and text insertion as native bracketed paste.
    // Newlines are buffer content, never Enter key events or a submission.
    input.handlePaste(event);
    status.content = "Pasted clipboard text.";
  }

  async function pasteText() {
    if (!alive || pasting) return;
    if (renderer.capabilities?.remote || process.env["SSH_CONNECTION"] || process.env["SSH_TTY"]) {
      status.content = "Remote session: use your terminal's native paste (Command+V or Ctrl+Shift+V).";
      input.focus(); return;
    }
    input.focus();
    const epoch = draftEpoch;
    const draft = input.plainText;
    const cursor = input.cursorOffset;
    const selection = JSON.stringify(input.getSelection());
    pasting = true;
    try {
      clipboard ??= options.createClipboard?.() ?? createHostClipboard({ maxReadBytes: MAX_PASTE_BYTES, timeoutMs: 2000 });
      const result = await clipboard.read({ preferredTypes: ["text/plain;charset=utf-8", "text/plain"], signal: pasteLifetime.signal });
      if (!alive) return;
      if (result.status !== "read") {
        status.content = result.status === "empty" ? "Clipboard is empty." : `Paste unavailable (${result.status}); use your terminal's native paste.`;
        return;
      }
      if (draftEpoch !== epoch || input.plainText !== draft || input.cursorOffset !== cursor || JSON.stringify(input.getSelection()) !== selection) {
        status.content = "Draft changed while reading clipboard; press paste again."; return;
      }
      if (!/^text\/plain(?:;|$)/i.test(result.representation.mimeType)) {
        status.content = "Paste refused: clipboard does not contain plain text."; return;
      }
      insertPaste(new PasteEvent(result.representation.bytes, { kind: "text", mimeType: result.representation.mimeType }));
    } catch {
      if (alive) status.content = "Clipboard read failed; use your terminal's native paste.";
    } finally { pasting = false; }
  }

  // Native offsets are terminal-cell offsets, NOT JS string indexes. Read the
  // prefix through the buffer API so Unicode/emoji before @ cannot corrupt text.
  function mention() {
    const prefix = input.editBuffer.getTextRange(0, input.cursorOffset);
    const match = /(?:^|[\s(])(@(?:"[^"\n]*|'[^'\n]*|[^\s)]*))$/.exec(prefix);
    if (!match) return null;
    const token = match[1]!;
    return {
      prefix, start: prefix.length - token.length,
      query: token.slice(1).replace(/^["']/, "").replace(/["']$/, ""),
    };
  }

  function contextItems(mode: "context" | "detach" | "unskill"): PopupItem[] {
    const items: PopupItem[] = [];
    if (mode !== "unskill") {
      const references = new Set(chat.attachmentPaths);
      for (const value of references) items.push({ kind: "detach", value, label: `@${value}`, description: "Remove reference" });
      for (const value of chat.sessionStats.files) {
        if (!references.has(value)) items.push({ kind: "detach", value, label: value, description: "Exclude file from folder context" });
      }
    }
    if (mode !== "detach") {
      for (const value of chat.activeSkillNames) items.push({ kind: "unskill", value, label: value, description: "Remove skill" });
    }
    if (mode === "context") {
      for (const value of chat.excludedFilePaths) items.push({ kind: "restore", value, label: value, description: "Restore excluded file" });
      items.push({ kind: "open-skills", value: "add-skills", label: "Add skills…", description: "Open skill selector" });
      items.push({ kind: "open-files", value: "add-files", label: "Add files…", description: "Open file/folder selector" });
    }
    return items;
  }

  function fileIsAttached(value: string): boolean {
    const name = value.replace(/\/$/, "");
    return chat.attachmentPaths.includes(name) || chat.sessionStats.files.includes(name);
  }

  function invalidateSkills() {
    skillLoadId++; skillsReady = false; loadingSkills = false; skillLoadError = "";
  }

  async function loadSkillCatalog() {
    if (loadingSkills || skillsReady) return;
    loadingSkills = true;
    const id = ++skillLoadId;
    try {
      const catalog = await chat.availableSkills();
      if (!alive || id !== skillLoadId) return;
      skillCatalog = catalog;
    } catch (error) {
      if (!alive || id !== skillLoadId) return;
      skillCatalog = [];
      skillLoadError = terminalField(error instanceof Error ? error.message : String(error));
    } finally {
      if (alive && id === skillLoadId) { loadingSkills = false; skillsReady = true; refreshPicker(); }
    }
  }

  function refreshPicker() {
    if (!alive) return;
    const prefix = input.editBuffer.getTextRange(0, input.cursorOffset);
    if (working || prefix === dismissedAt) { cancelThemePreview(); matches = []; picker.visible = false; return; }
    const previous = matches[selected];
    const oldMode = pickerMode;
    const command = prefix === input.plainText ? /^\/(attach|detach|unskill|context|skills?|theme)\s+([^\n]*)$/.exec(prefix) : null;
    if (command?.[1] !== "theme") cancelThemePreview();
    let startingThemePicker = false;
    if (command) {
      const query = command[2]!.trim().replace(/^@/, "").replace(/^["']/, "").replace(/["']$/, "");
      if (command[1] === "theme") {
        pickerMode = "themes";
        startingThemePicker = themeBeforePreview === null;
        themeBeforePreview ??= { name: theme.name, mode: theme.mode };
        matches = filterPopupItems(THEME_NAMES.flatMap((name): PopupItem[] =>
          themeModes(name).map((mode) => ({
            kind: "theme", value: `${name} ${mode}`, label: `${themeBeforePreview!.name === name && themeBeforePreview!.mode === mode ? "✓ " : "  "}${name} · ${mode}`,
            description: name === "ask" ? "Original ask colors" : "",
          }))), query);
      } else if (command[1] === "skill" || command[1] === "skills") {
        pickerMode = "skills";
        void loadSkillCatalog();
        matches = filterPopupItems((skillsReady ? skillCatalog : []).map((skill) => {
          const active = chat.activeSkillNames.includes(skill.name);
          return { kind: "skill", value: skill.name, label: `${active ? "✓ " : "  "}${skill.name}`, description: `${active ? "Active · " : ""}${skill.description}` };
        }), query);
      } else if (command[1] === "attach") {
        pickerMode = "files";
        matches = filterPopupItems(candidates.filter((value) => isFileCandidateVisible(value, query)).map((value) => {
          const attached = fileIsAttached(value);
          return { kind: "attach", value, label: `${attached ? "✓ " : "  "}${value}`, description: attached ? "Attached · select to detach" : value.endsWith("/") ? "Attach folder" : "Attach file" };
        }), query);
      } else {
        pickerMode = command[1] as "detach" | "unskill" | "context";
        matches = filterPopupItems(contextItems(pickerMode), query);
        if (pickerMode === "context") {
          const order = (item: PopupItem) => item.kind === "unskill" ? 0 : item.kind === "open-skills" ? 1 : item.kind === "open-files" ? 3 : 2;
          matches.sort((a, b) => order(a) - order(b));
        }
      }
    } else if (prefix === input.plainText && /^\/[^\n]*$/.test(prefix) &&
      (!prefix.includes(" ") || !SLASH_COMMANDS.some((entry) => prefix.startsWith(entry.value + " ")))) {
      pickerMode = "commands";
      matches = filterPopupItems(SLASH_COMMANDS.map((entry) => ({ kind: "command", value: entry.value, label: entry.value, description: entry.description })), prefix.slice(1));
    } else {
      const current = mention();
      if (!current) { matches = []; picker.visible = false; return; }
      pickerMode = "mention";
      matches = candidates.filter((candidate) => isFileCandidateVisible(candidate, current.query))
        .map((candidate) => ({ candidate, rank: current.query ? rankMatch(candidate.replace(/\/$/, ""), current.query) : 0 }))
        .filter((item) => item.rank !== null)
        .sort((a, b) => a.rank! - b.rank! || a.candidate.length - b.candidate.length || a.candidate.localeCompare(b.candidate))
        .map(({ candidate }) => ({ kind: "mention", value: candidate, label: candidate, description: "" }));
    }
    const sameQuery = oldMode === pickerMode && pickerPrefix === prefix;
    pickerPrefix = prefix;
    const kept = sameQuery && previous ? matches.findIndex((item) => item.kind === previous.kind && item.value === previous.value) : -1;
    // Only retain keyboard selection for unchanged input (e.g. an item was
    // removed). Typing a new query must highlight the best-ranked result.
    selected = kept >= 0 ? kept : sameQuery ? Math.max(0, Math.min(selected, matches.length - 1)) : 0;
    if (startingThemePicker && command?.[2]?.trim() === "") {
      const current = matches.findIndex((item) => item.value === `${themeBeforePreview!.name} ${themeBeforePreview!.mode}`);
      if (current >= 0) selected = current;
    }
    paintPicker();
    picker.visible = true;
  }

  function paintPicker() {
    if (pickerMode === "themes" && themeBeforePreview) {
      const choice = matches[selected];
      if (choice) {
        const [name, mode] = choice.value.split(" ");
        applyTheme(name!, mode as ThemeMode);
      } else applyTheme(themeBeforePreview.name, themeBeforePreview.mode);
    }
    const metadataRows = pickerMode === "context" ? 2 : 0;
    pickerMetadata.visible = metadataRows > 0;
    if (metadataRows) pickerMetadata.content = `Working directory: ${terminalField(chat.sessionStats.cwd)}\nSession: ${chat.sessionStats.turns} response(s) · ${chat.pendingCount} pending file(s)`;
    const sectionRows = pickerMode === "context" ? 4 : 0;
    const count = Math.max(1, Math.min(7, renderer.height - 14 - metadataRows - sectionRows));
    const start = Math.max(0, selected - count + 1);
    const visible = matches.slice(start, start + count);
    const renderItem = (item: PopupItem) => `${item === matches[selected] ? "›" : " "} ${terminalField(item.label)}${item.description ? `  ${terminalField(item.description)}` : ""}`;
    const hasFiles = chat.attachmentPaths.length > 0 || chat.sessionStats.files.length > 0;
    let rows: string[];
    if (pickerMode === "context") {
      const skillRow = (item: PopupItem) => item.kind === "unskill" || item.kind === "open-skills";
      const skills = visible.filter(skillRow);
      const files = visible.filter((item) => !skillRow(item));
      rows = [
        "Skills",
        ...(!chat.activeSkillNames.length ? ["  No skills attached."] : []),
        ...skills.map(renderItem),
        ...(chat.activeSkillNames.length && !skills.some((item) => item.kind === "unskill")
          ? [matches.some((item) => item.kind === "unskill") ? "  … more skills (↑/↓)" : "  No matching skills."] : []),
        "Files",
        ...(!hasFiles ? ["  No files attached."] : []),
        ...files.map(renderItem),
        ...(hasFiles && !files.some((item) => item.kind === "detach")
          ? [matches.some((item) => item.kind === "detach") ? "  … more files (↑/↓)" : "  No matching files."] : []),
      ];
    } else rows = [matches.length
      ? visible.map(renderItem).join("\n")
      : pickerMode === "mention" ? pickerError || "No indexed matches; you can still type an exact @path."
        : pickerMode === "skills" ? loadingSkills ? "Loading skills…" : skillLoadError || "No matching skills."
          : pickerMode === "unskill" ? chat.activeSkillNames.length ? "No matching skills." : "No skills attached."
            : pickerMode === "detach" ? hasFiles ? "No matching files." : "No files attached."
              : pickerMode === "files" ? pickerError || "No matching files/folders."
                : pickerMode === "themes" ? "No matching themes." : "No matching commands."];
    if (pickerMode === "context") {
      const actionRows = new Set(visible.map(renderItem));
      pickerRows.content = new StyledText(rows.map((row, index) =>
        fg(actionRows.has(row) ? "#82cfff" : "#e2e8f0")(row + (index < rows.length - 1 ? "\n" : ""))));
    } else pickerRows.content = matches.length ? rows.join("\n") : new StyledText([fg("#e2e8f0")(rows.join("\n"))]);
    picker.title = { mention: "Files / folders", commands: "Commands", detach: "Detach files / folders", unskill: "Remove skills", context: "Manage context", skills: "Select skills", files: "Select files / folders", themes: "Select theme" }[pickerMode];
    pickerHint.content = pickerMode === "mention" ? "↑↓ move · Enter/Tab select · Esc close"
      : pickerMode === "commands" ? "↑↓ move · Enter run · Tab complete · Esc close"
        : pickerMode === "themes" ? "↑↓ preview · Enter/Tab keep · ✓ current · Esc cancel"
        : pickerMode === "skills" ? "↑↓ move · Enter toggle · ✓ active · type to filter · Esc close"
          : pickerMode === "files" ? "↑↓ move · Enter/Tab toggle · ✓ attached · type to filter · Esc close" : "↑↓ move · Enter action · type to filter · Esc close";
    picker.height = pickerMode === "context" ? rows.length + 3 + metadataRows : (visible.length || 1) + 3;
  }

  function completeMention() {
    const current = mention();
    const candidate = matches[selected];
    if (!current || !candidate) return;
    const target = candidate.value.replace(/\/$/, "");
    // Quoted mentions support spaces and quotes without shell evaluation.
    const quoted = /[\s"']/.test(target)
      ? !target.includes('"') ? `@"${target}"` : !target.includes("'") ? `@'${target}'` : null
      : `@${target}`;
    if (quoted === null) { status.content = "This filename contains both quote styles; use an exact directory reference."; return; }
    const start = input.editBuffer.measureText(current.prefix.slice(0, current.start));
    input.setSelection(start, input.cursorOffset);
    input.insertText(`${quoted} `);
    dismissedAt = "";
    refreshPicker();
  }

  picker.onMouseScroll = (event) => {
    if (working || !picker.visible || pickerMode !== "themes" || !matches.length) return;
    const direction = event.scroll?.direction;
    if (direction !== "up" && direction !== "down") return;
    event.preventDefault(); event.stopPropagation();
    selected = Math.max(0, Math.min(matches.length - 1, selected + (direction === "up" ? -1 : 1)));
    paintPicker();
  };

  function openManager(mode: "context" | "attach" | "detach" | "unskill" | "skill" | "skills" | "theme", query = "") {
    if (mode === "skill" || mode === "skills") invalidateSkills();
    input.setText(`/${mode} ${query}`); input.gotoBufferEnd(); dismissedAt = ""; refreshPicker();
  }

  async function togglePopupFile(name: string) {
    if (working) return;
    working = true;
    try {
      const target = name.replace(/\/$/, "");
      if (fileIsAttached(name)) {
        chat.detach(target);
        if (alive) status.content = `Detached ${terminalField(name)} from future file context.`;
      } else {
        const context = await chat.attach(target);
        if (alive) status.content = `Attached ${terminalField(name)} · ${context.blocks.length} file(s) · ${context.skipped.length} skipped${context.truncated ? " · context truncated" : ""}`;
      }
    } catch (error) {
      if (alive) status.content = terminalField(error instanceof Error ? error.message : String(error));
    } finally {
      working = false;
      if (alive) { refreshSummary(); refreshPicker(); }
    }
  }

  async function togglePopupSkill(name: string) {
    if (working) return;
    working = true;
    try {
      const active = chat.activeSkillNames.includes(name);
      if (active) chat.removeSkill(name); else await chat.selectSkills([name]);
      if (alive) status.content = `${active ? "Disabled" : "Enabled"} skill ${terminalField(name)}. Instructions only; no scripts are executed.`;
    } catch (error) {
      if (alive) status.content = terminalField(error instanceof Error ? error.message : String(error));
    } finally {
      working = false;
      if (alive) { refreshSummary(); refreshPicker(); }
    }
  }

  function acceptPopup(run: boolean) {
    if (working) return;
    const item = matches[selected];
    if (!item) return;
    if (item.kind === "mention") { completeMention(); return; }
    if (item.kind === "command") {
      if (item.value === "/context" || item.value === "/attach" || item.value === "/detach" || item.value === "/unskill" || item.value === "/skill" || item.value === "/skills" || item.value === "/theme") {
        openManager(item.value.slice(1) as "context" | "attach" | "detach" | "unskill" | "skill" | "skills" | "theme"); return;
      }
      input.setText(item.value + (run ? "" : " ")); input.gotoBufferEnd();
      if (run) void submit(); else { dismissedAt = input.plainText; picker.visible = false; }
      return;
    }
    if (item.kind === "attach") { void togglePopupFile(item.value); return; }
    if (item.kind === "theme") {
      const [name, mode] = item.value.split(" ");
      changeTheme(name!, mode as ThemeMode);
      return;
    }
    if (!run) return;
    if (item.kind === "open-skills") { openManager("skills"); return; }
    if (item.kind === "open-files") { openManager("attach"); return; }
    if (item.kind === "skill") { void togglePopupSkill(item.value); return; }
    try {
      if (item.kind === "detach") { chat.detach(item.value); status.content = `Removed ${terminalField(item.value)} from future file context.`; }
      else if (item.kind === "unskill") { chat.removeSkill(item.value); status.content = `Removed skill ${terminalField(item.value)}.`; }
      else if (item.kind === "restore") { chat.restoreFile(item.value); status.content = `Restored ${terminalField(item.value)} for the next request.`; }
      refreshSummary(); refreshPicker();
    } catch (error) { status.content = terminalField(error instanceof Error ? error.message : String(error)); }
  }

  function applyTheme(name: string, mode: ThemeMode) {
    if (theme.name === name && theme.mode === mode) return;
    theme.select(name, mode);
    style.registerStyle("default", { fg: theme.palette.text });
    style.registerStyle("markup.heading", { fg: theme.palette.accent, bold: true });
    style.registerStyle("markup.raw", { fg: theme.palette.code });
    paintTheme();
  }

  function cancelThemePreview() {
    if (!themeBeforePreview) return;
    const previous = themeBeforePreview;
    themeBeforePreview = null;
    applyTheme(previous.name, previous.mode);
  }

  function changeTheme(name: string, mode: ThemeMode) {
    // Clear the snapshot before changing the draft, whose change handler can
    // close the picker. A confirmed preview must not be rolled back then.
    themeBeforePreview = null;
    applyTheme(name, mode);
    input.setText(""); dismissedAt = ""; picker.visible = false; matches = [];
    status.content = `Theme: ${name} · ${mode} (current TUI run)`;
    paintTheme();
    input.focus();
  }

  function review() {
    for (const diff of chat.review()) {
      const panel = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", flexShrink: 0 });
      for (const line of diff.split("\n")) {
        panel.add(new TextRenderable(renderer, {
          content: sanitizeForTerminal(line), flexShrink: 0, selectable: true,
          fg: line.startsWith("+") ? "#a7f3d0" : line.startsWith("-") ? "#fda4af" : "#cbd5e1",
        }));
      }
      transcript.add(panel);
    }
    addText("Review the proposed diffs above. /apply approves all pending files; /reject discards them.\nMultiple files are written individually, not as an all-or-nothing transaction.", "#fcd34d");
  }

  async function submit() {
    if (working || !alive) return;
    const text = input.plainText.trim();
    if (!text) return;
    draftEpoch++;
    working = true;
    picker.visible = false;
    input.setText("");
    const started = Date.now();
    const timer = setInterval(() => {
      if (alive) status.content = `Waiting for ${terminalField(model)}… ${((Date.now() - started) / 1000).toFixed(1)}s · no automatic follow-up`;
    }, 250);
    try {
      if (text === "/quit" || text === "/exit") { renderer.destroy(); return; }
      if (text === "/help") addText(TUI_HELP);
      else if (text === "/new") { chat.reset(); addText("Started a new conversation; history, attachments, skills and pending edits cleared."); }
      else if (/^\/skills?(?:\s|$)/.test(text)) openManager("skills", text.replace(/^\/skills?\s*/, ""));
      else if (text === "/unskill") openManager("unskill");
      else if (text.startsWith("/unskill ")) {
        chat.removeSkill(text.slice(9).trim().replace(/^(["'])(.*)\1$/, "$2")); addText("Skill removed from future requests. Earlier answers remain in chat history.");
      }
      else if (text === "/context") openManager("context");
      else if (/^\/theme(?:\s|$)/.test(text)) openManager("theme", text.replace(/^\/theme\s*/, ""));
      else if (/^\/attach(?:\s|$)/.test(text)) openManager("attach", text.replace(/^\/attach\s*/, ""));
      else if (text === "/copy") { copyText(chat.lastAnswer); return; }
      else if (text === "/detach") openManager("detach");
      else if (text.startsWith("/detach ")) {
        chat.detach(text.slice(8).replace(/^(["'])(.*)\1$/, "$2")); addText("Reference/file removed from future file context.");
      }
      else if (text === "/review") review();
      else if (text === "/reject") { chat.reject(); addText("Proposals rejected; nothing written."); }
      else if (text === "/apply") {
        addText(`Applied updates to ${JSON.stringify(await chat.apply())}. Review with git diff.`, "#a7f3d0");
      }
      else if (text.startsWith("/")) throw new Error("Unknown command. Use /help.");
      else {
        addUserMessage(text);
        status.content = `Waiting for ${terminalField(model)}…`;
        const reply = await chat.submit(text, () => { if (alive) refreshSummary(); });
        if (!alive) return;
        addAnswer(reply.text);
        if (reply.context.skipped.length) addText(`Skipped context: ${reply.context.skipped.map((item) => `${terminalField(item.path)} (${item.reason})`).join(", ")}`, "#fcd34d");
        if (reply.context.truncated) addText("Context was truncated; truncated files cannot be updated.", "#fcd34d");
        if (reply.proposalError) addText(`Edits unavailable: ${reply.proposalError}`, "#fcd34d");
        if (chat.pendingCount) review();
      }
      if (alive) status.content = chat.pendingCount ? `${chat.pendingCount} pending file(s) · /apply to approve · /reject to discard` : "Ready · /help for commands";
    } catch (error) {
      if (alive) {
        addText(error instanceof Error ? error.message : String(error), "#fda4af");
        if (error instanceof SkillResolutionError && error.candidates.length) addText(error.candidates.map(terminalField).join("\n"), "#fcd34d");
        status.content = "Failed · no automatic retry · your draft has been restored";
        if (!input.plainText) { input.setText(text); input.gotoBufferEnd(); }
      }
    } finally {
      clearInterval(timer);
      working = false;
      if (alive) { input.focus(); refreshPicker(); refreshSummary(); }
    }
  }

  renderer.keyInput.on("keypress", (key) => {
    // Command is the Super modifier in enhanced terminal keyboard protocols.
    // Meta is usually Alt/Option, so deliberately do not bind Meta+C/V.
    if (key.super && key.name === "c") {
      key.preventDefault(); copyText(selectedText() || null); return;
    }
    if ((key.ctrl || key.super) && key.name === "v") {
      key.preventDefault(); void pasteText(); return;
    }
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      const selection = selectedText();
      if (selection) copyText(selection); else renderer.destroy();
      return;
    }
    if (key.ctrl && key.name === "d") {
      key.preventDefault(); renderer.destroy(); return;
    }
    if (!working && key.sequence === "@" && dismissedAt && mention()?.prefix === dismissedAt) {
      // The original sigil remains after Escape. Treat another @ as an explicit
      // reopen, not a second sigil that would filter the list to a literal @.
      key.preventDefault(); dismissedAt = ""; refreshPicker(); return;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault(); transcript.scrollBy(key.name === "pageup" ? -10 : 10); return;
    }
    // Native editor change notifications can arrive on the next frame. Always
    // resolve selection keys against the latest buffer, not a stale menu.
    if (["return", "tab", "up", "down", "escape"].includes(key.name)) refreshPicker();
    if (!picker.visible) return;
    if (!matches.length && key.name === "return" && !key.shift &&
      (pickerMode === "context" || pickerMode === "detach" || pickerMode === "unskill" || pickerMode === "skills" || pickerMode === "files" || pickerMode === "themes")) {
      key.preventDefault(); return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      if (pickerMode === "skills") invalidateSkills();
      if (pickerMode === "themes") cancelThemePreview();
      if (pickerMode === "context" || pickerMode === "detach" || pickerMode === "unskill" || pickerMode === "skills" || pickerMode === "files" || pickerMode === "themes") input.setText("");
      dismissedAt = input.editBuffer.getTextRange(0, input.cursorOffset); picker.visible = false; matches = [];
    } else if (matches.length && (key.name === "up" || key.name === "down")) {
      key.preventDefault();
      selected = (selected + (key.name === "up" ? -1 : 1) + matches.length) % matches.length;
      paintPicker();
    } else if (matches.length && (key.name === "tab" || (key.name === "return" && !key.shift && !key.ctrl && !key.meta))) {
      key.preventDefault(); acceptPopup(key.name === "return");
    }
  });
  const nativePaste = (event: PasteEvent) => { event.preventDefault(); insertPaste(event); };
  renderer.keyInput.on("paste", nativePaste);
  const resize = () => {
    sidebarDrag = null;
    dividerHovered = false;
    updateDividerAppearance();
    for (const { text, glyph } of caps) text.content = glyph.repeat(renderer.width);
    refreshSummary(); refreshPicker();
  };
  renderer.on("resize", resize);
  renderer.once("destroy", () => {
    alive = false;
    sidebarDrag = null;
    invalidateSkills();
    pasteLifetime.abort();
    renderer.removeListener("resize", resize);
    renderer.keyInput.removeListener("paste", nativePaste);
    if (clipboard) void clipboard.dispose().catch(() => {});
    style.destroy();
  });
  addText("Ask a question or discuss a function. Attach @files or @folders anywhere.\nSuggested <update> blocks become reviewable diffs, never automatic writes. /help for commands.");
  if (chat.activeSkillNames.length) addText(`Active skills: ${chat.activeSkillNames.map(terminalField).join(", ")}`);
  refreshSummary();
  return {
    input, composer, sidebar, sidebarDivider, picker, footerLeft, footerRight, transcript,
    setCandidates(paths: readonly string[], truncated = false) {
      if (!alive) return;
      candidates = paths;
      pickerError = truncated ? "Index capped; type an exact path for missing files." : "";
      if (truncated) addText("Mention index reached its cap; exact @paths still work.", "#fcd34d");
      refreshPicker();
    },
    setIndexError(message: string) { pickerError = terminalField(message); refreshPicker(); },
    get working() { return working; },
    get pasting() { return pasting; },
    get loadingSkills() { return loadingSkills; },
    get theme() { return { name: theme.name, mode: theme.mode }; },
  };
}
