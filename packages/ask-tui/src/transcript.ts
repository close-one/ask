import {
  BoxRenderable, MarkdownRenderable, SyntaxStyle, TextRenderable, StyledText,
  bold, fg, italic, strikethrough, type CliRenderer, type ScrollBoxRenderable, type TextChunk,
} from "@opentui/core";
import type { Token } from "marked";
import { sanitizeForTerminal, terminalField } from "@codehaus-au/ask/internal/terminal";
import type { TuiTheme } from "./theme.ts";
import { COMPOSER_PADDING } from "./layout.ts";

/** Native inline markup, without a Tree-sitter worker/download. */
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

export function createTranscript(renderer: CliRenderer, transcript: ScrollBoxRenderable, theme: TuiTheme) {
  let serial = 0;
  const markdownText = new Set<TextRenderable>();
  const caps: { text: TextRenderable; glyph: string }[] = [];
  const style = SyntaxStyle.fromStyles({
    default: { fg: theme.palette.text },
    "markup.heading": { fg: theme.palette.accent, bold: true },
    "markup.strong": { bold: true },
    "markup.raw": { fg: theme.palette.code },
  }, renderer.nativeScene);

  function addText(content: string, color = "#9baac1") {
    transcript.add(new TextRenderable(renderer, {
      id: `message-${serial++}`, content: sanitizeForTerminal(content), fg: color, width: "100%", flexShrink: 0, selectable: true,
    }));
  }

  function cap(id: string, glyph: string) {
    const text = new TextRenderable(renderer, {
      id, content: glyph.repeat(renderer.width), width: "100%", height: 1, flexShrink: 0,
      fg: "#1b2533", bg: "#10151d", wrapMode: "none", overflow: "hidden", selectable: false,
    });
    caps.push({ text, glyph });
    return text;
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
    message.add(cap(`${id}-top-cap`, "▄"));
    message.add(panel);
    message.add(cap(`${id}-bottom-cap`, "▀"));
    transcript.add(message);
  }

  function addAnswer(content: string) {
    transcript.add(new MarkdownRenderable(renderer, {
      id: `answer-${serial++}`, content: sanitizeForTerminal(content), syntaxStyle: style,
      width: "100%", flexShrink: 0, conceal: true, internalBlockMode: "top-level",
      // Override every block: even default paragraphs can load Tree-sitter.
      renderNode: (token) => {
        const chunks = token.type === "paragraph" || token.type === "heading" ? inlineChunks(token.tokens ?? []) : null;
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

  function review(diffs: readonly string[]) {
    for (const diff of diffs) {
      const panel = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", flexShrink: 0 });
      for (const line of diff.split("\n")) {
        panel.add(new TextRenderable(renderer, {
          // Approval must expose every byte, not remove escape-string payloads.
          content: terminalField(line), flexShrink: 0, selectable: true,
          fg: line.startsWith("+") ? "#a7f3d0" : line.startsWith("-") ? "#fda4af" : "#cbd5e1",
        }));
      }
      transcript.add(panel);
    }
    addText("Review the proposed diffs above. Control characters are shown as escapes. /apply approves all pending files; /reject discards them.\nMultiple files are written individually, not as an all-or-nothing transaction.", "#fcd34d");
  }

  function clear() {
    renderer.clearSelection();
    for (const child of [...transcript.getChildren()]) {
      transcript.remove(child);
      child.destroyRecursively();
    }
    // Markdown owns native blocks that getChildren() does not expose.
    for (const text of markdownText) if (!text.isDestroyed) text.destroyRecursively();
    markdownText.clear();
    caps.length = 0;
    transcript.scrollTo(0);
  }

  return {
    addText, addUserMessage, addAnswer, review, clear,
    paintTheme() {
      for (const text of markdownText) {
        if (text.isDestroyed) markdownText.delete(text); else theme.paint(text);
      }
    },
    updateStyle() {
      style.registerStyle("default", { fg: theme.palette.text });
      style.registerStyle("markup.heading", { fg: theme.palette.accent, bold: true });
      style.registerStyle("markup.raw", { fg: theme.palette.code });
    },
    resize() { for (const { text, glyph } of caps) text.content = glyph.repeat(renderer.width); },
    dispose() { markdownText.clear(); caps.length = 0; style.destroy(); },
  };
}
