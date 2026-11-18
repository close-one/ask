import { BoxRenderable, TextRenderable, StyledText, fg, type CliRenderer } from "@opentui/core";
import { terminalField } from "@codehaus-au/ask/internal/terminal";
import type { UpdateView } from "@codehaus-au/ask/internal/config";
import { updateDiff, type UpdateBlock } from "./updates.ts";

/** A response snippet, not the full-file review that authorizes /apply. */
export function createUpdatePanel(renderer: CliRenderer, id: string, block: UpdateBlock, raw: string, initialView: UpdateView) {
  let view = initialView;
  const panel = new BoxRenderable(renderer, {
    id, width: "100%", flexDirection: "column", flexShrink: 0, paddingLeft: 2,
  });
  const code = new BoxRenderable(renderer, {
    id: `${id}-block`, width: "100%", flexDirection: "column", flexShrink: 0,
    backgroundColor: "#1b2533", border: true, borderColor: "#344256", paddingX: 1,
  });
  const header = new BoxRenderable(renderer, {
    id: `${id}-toggle`, width: "100%", flexShrink: 0,
    flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between",
  });
  const filename = new TextRenderable(renderer, {
    content: terminalField(block.path), fg: "#82cfff", maxWidth: "100%",
    paddingRight: 1, flexShrink: 0, selectable: false,
  });
  const hint = new TextRenderable(renderer, {
    id: `${id}-hint`, fg: "#82cfff", maxWidth: "100%", flexShrink: 0, selectable: false,
  });
  const body = new TextRenderable(renderer, {
    id: `${id}-code`, fg: "#a7f3d0", width: "100%", flexShrink: 0, selectable: true,
  });
  // Derive the snippet diff from the exact SEARCH and REPLACE text, without
  // reading disk or touching controller review/approval state.
  const diff = updateDiff({ path: block.path, original: block.search, proposed: block.replacement })
    .replace(/^\\ No newline at end of file$/gm, "\\ No newline at end of snippet");
  function paint() {
    const next = view === "diff" ? "SEARCH / REPLACE" : "diff";
    hint.content = `click for ${next}`;
    const lines = (view === "diff" ? diff : raw).split("\n");
    let search = false;
    body.content = new StyledText(lines.map((line, index) => {
      if (line === "<<<<<<< SEARCH") search = true;
      else if (line === "=======") search = false;
      const color = view === "diff"
        ? line.startsWith("+") ? "#a7f3d0" : line.startsWith("-") ? "#fda4af" : "#cbd5e1"
        : /^(?:<<<<<<< SEARCH|=======|>>>>>>> REPLACE|<\/?update\b)/.test(line) ? "#82cfff"
        : search ? "#fda4af" : "#a7f3d0";
      // Never strip terminal-control payloads from either representation.
      return fg(color)(terminalField(line) + (index < lines.length - 1 ? "\n" : ""));
    }));
  }
  header.onMouseDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    view = view === "diff" ? "search-replace" : "diff";
    paint();
  };
  header.add(filename);
  header.add(hint);
  panel.add(header);
  code.add(body);
  panel.add(code);
  paint();
  return panel;
}
