import type { TuiChat } from "./chat.ts";
import type { ManagerMode } from "./completion.ts";

export const TUI_HELP = `Chat: mention @files or @folders anywhere; quote paths with spaces.
Each submission makes one request. No model tools or automatic follow-up requests.
/review  show pending diffs    /apply  approve writes    /reject  discard proposals
/context  manage context    /detach [path]  remove a reference or file
/attach [term]  toggle attached files/folders locally
/skill [term] or /skills [term]  open the same searchable skill-selection popup
/unskill [name]  choose/remove an active skill (instructions only; no scripts)
/copy  copy the last answer (Markdown) to your terminal clipboard
/theme [name]  choose a bundled termcn theme for this TUI run
/new  clear this in-memory conversation and transcript    /help    /quit
Enter selects an open mention, otherwise sends · Shift+Enter inserts a newline
Type / for searchable commands · /context, /detach and /unskill open management popups
Ctrl+C copies highlighted text (OSC52); without a selection it exits
Ctrl+D always exits · /copy copies the last answer as Markdown
Ctrl+V pastes local clipboard text · Command/Super+C copies · Command/Super+V pastes
Tab also selects a mention · Esc closes picker · Shift+drag uses native terminal selection
PageUp/PageDown scroll the conversation. Chat history is not saved after exit.
Updates only: use the existing ask /create command for new files.`;

/** Local command dispatch never initiates a model request. */
export async function dispatchCommand(text: string, chat: TuiChat, actions: {
  quit(): void; clear(): void; review(): void; copy(text: string | null): void;
  addText(text: string, color?: string): void; openManager(mode: ManagerMode, query?: string): void;
}): Promise<"handled" | "return" | "prompt"> {
  if (text === "/quit" || text === "/exit") { actions.quit(); return "return"; }
  if (text === "/help") actions.addText(TUI_HELP);
  else if (text === "/new") {
    chat.reset(); actions.clear();
    actions.addText("Started a new conversation; history, transcript, attachments, skills and pending edits cleared.");
  } else if (/^\/skills?(?:\s|$)/.test(text)) actions.openManager("skills", text.replace(/^\/skills?\s*/, ""));
  else if (text === "/unskill") actions.openManager("unskill");
  else if (text.startsWith("/unskill ")) {
    chat.removeSkill(text.slice(9).trim().replace(/^(["'])(.*)\1$/, "$2"));
    actions.addText("Skill removed from future requests. Earlier answers remain in chat history.");
  } else if (text === "/context") actions.openManager("context");
  else if (/^\/theme(?:\s|$)/.test(text)) actions.openManager("theme", text.replace(/^\/theme\s*/, ""));
  else if (/^\/attach(?:\s|$)/.test(text)) actions.openManager("attach", text.replace(/^\/attach\s*/, ""));
  else if (text === "/copy") { actions.copy(chat.lastAnswer); return "return"; }
  else if (text === "/detach") actions.openManager("detach");
  else if (text.startsWith("/detach ")) {
    chat.detach(text.slice(8).replace(/^(["'])(.*)\1$/, "$2")); actions.addText("Reference/file removed from future file context.");
  } else if (text === "/review") actions.review();
  else if (text === "/reject") { chat.reject(); actions.addText("Proposals rejected; nothing written."); }
  else if (text === "/apply") actions.addText(`Applied updates to ${JSON.stringify(await chat.apply())}. Review with git diff.`, "#a7f3d0");
  else if (text.startsWith("/")) throw new Error("Unknown command. Use /help.");
  else return "prompt";
  return "handled";
}
