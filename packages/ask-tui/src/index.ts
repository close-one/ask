// Use the Node launcher so repository Bun hooks cannot execute before this entry.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClient, DEFAULT_MODEL, isInsecureHttpEndpoint } from "@codehaus-au/ask/internal/chat";
import { applyEnvFiles, endpointFromEnvFile, PROJECT_ENV_KEYS } from "@codehaus-au/ask/internal/env";
import { mentionCandidates } from "@codehaus-au/ask/internal/refs";
import { terminalField } from "@codehaus-au/ask/internal/terminal";
import { responseTimeoutMs } from "@codehaus-au/ask/internal/timeout";
import { TuiChat } from "./chat.ts";
import { discoverSkills, skillSearchPaths, SkillResolutionError } from "@codehaus-au/ask/internal/skills";
import { themeModes } from "./themes.ts";

const HELP = `ask-tui — user-driven OpenTUI chat (Bun 1.3.14+)
Usage: ask-tui [--model <id>] [--base-url <url>] [--api-key <key>]
               [--system <text>] [--max-tokens <n>] [--temperature <n>]
               [--allow-insecure-http] [--skill <name>]... [--list-skills]
               [--context-window <tokens>] [--timeout <seconds>] [--theme <name>] [--no-mouse]
Uses OPENAI_API_KEY, OPENAI_BASE_URL, ASK_MODEL and ASK_SYSTEM like ask.
ASK_CONTEXT_WINDOW supplies the model's context capacity in tokens.
One request per submission; no model tools, automatic retries or agent loop.
Mention @files or @folders anywhere. Suggested updates require review and /apply.
History is in memory for this TUI only. Ctrl+C copies a selection, otherwise exits.
Ctrl+D always exits. /help lists commands.
--skill selects instructions for this chat; repeat to compose skills.
--list-skills lists discovered skills offline; no key or terminal required.
--context-window overrides ASK_CONTEXT_WINDOW (positive integer tokens).
Capacity and percent used are display-only; no model lookup or server changes.
--timeout overrides ASK_TIMEOUT; default 120 seconds per request, no retries.
--theme overrides ASK_THEME; default ask. Use /theme to preview and change themes.
--no-mouse leaves mouse selection to your terminal; /copy uses OSC52.
`;

async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    model: { type: "string", short: "m" }, "base-url": { type: "string" },
    "api-key": { type: "string" }, system: { type: "string", short: "s" },
    "max-tokens": { type: "string" }, temperature: { type: "string" },
    "allow-insecure-http": { type: "boolean" }, help: { type: "boolean", short: "h" },
    skill: { type: "string", multiple: true }, "list-skills": { type: "boolean" },
    "context-window": { type: "string" }, "no-mouse": { type: "boolean" },
    timeout: { type: "string" }, theme: { type: "string" },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  if (!("Bun" in globalThis)) throw new Error("ask-tui requires Bun 1.3.14+; the existing ask CLI still runs on Node.");
  if (!process.execArgv.includes("--no-env-file") || process.execArgv.some((arg) => /^--env-file(?:=|$)/.test(arg))) {
    throw new Error("Bun's .env autoload must be disabled. Use ask-tui or pnpm tui; do not pass --env-file.");
  }
  const config = fileURLToPath(new URL("./bunfig.toml", import.meta.url));
  if (!process.execArgv.includes(`--config=${config}`)) {
    throw new Error("Use ask-tui or pnpm tui to launch with Ask's trusted Bun configuration.");
  }
  const cwd = process.cwd();
  if (values["list-skills"]) {
    const roots = skillSearchPaths(cwd);
    const available = await discoverSkills(roots);
    process.stdout.write([
      ...available.map((skill) => `${terminalField(skill.name)} — ${terminalField(skill.description)}`),
      ...(available.length ? [] : ["No skills found."]),
      "Search paths:", ...roots.map((root) => `  ${terminalField(root)}`), "",
    ].join("\n"));
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("ask-tui requires an interactive terminal. Use ask for pipes and scripts.");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const reports = await applyEnvFiles([
    path.join(cwd, ".env"), path.resolve(here, "..", "..", ".env"), path.resolve(here, "..", ".env"),
  ].map((file) => ({ file, allow: PROJECT_ENV_KEYS })));
  if (!values["base-url"] && endpointFromEnvFile(reports)) {
    throw new Error("Refusing an endpoint selected by an automatic .env file. Export OPENAI_BASE_URL or pass --base-url explicitly.");
  }
  const baseURL = values["base-url"] ?? process.env["OPENAI_BASE_URL"];
  if (isInsecureHttpEndpoint(baseURL) && !values["allow-insecure-http"]) {
    throw new Error("Refusing unencrypted remote HTTP; use HTTPS or explicitly pass --allow-insecure-http.");
  }
  function numeric(name: "max-tokens" | "temperature" | "context-window") {
    const raw = values[name] ?? (name === "context-window" ? process.env["ASK_CONTEXT_WINDOW"] : undefined);
    if (raw === undefined) return undefined;
    const number = Number(raw);
    if (!raw.trim() || !Number.isFinite(number) ||
      (name !== "temperature" ? !Number.isSafeInteger(number) || number <= 0 : number < 0 || number > 2)) {
      const source = name === "context-window" && values[name] === undefined ? "ASK_CONTEXT_WINDOW" : `--${name}`;
      throw new Error(`Invalid ${source}.`);
    }
    return number;
  }
  const model = values.model ?? process.env["ASK_MODEL"] ?? DEFAULT_MODEL;
  const contextWindow = numeric("context-window");
  const timeoutMs = responseTimeoutMs(values.timeout);
  const theme = values.theme ?? process.env["ASK_THEME"] ?? "ask";
  themeModes(theme); // Validate before creating a client or loading the native UI.
  const lifetime = new AbortController();
  const chat = new TuiChat(createClient({
    apiKey: values["api-key"] ?? process.env["OPENAI_API_KEY"], baseURL, timeoutMs, maxRetries: 0, signal: lifetime.signal,
  }), {
    cwd, model, baseURL, system: values.system ?? process.env["ASK_SYSTEM"] ?? "",
    maxTokens: numeric("max-tokens"), temperature: numeric("temperature"),
    contextWindow,
  });
  await chat.selectSkills(values.skill ?? []);
  // Never load the native UI from the existing Node entry point or offline help.
  const [{ createCliRenderer }, { mountChatUI }] = await Promise.all([
    import("@opentui/core"), import("./ui.ts"),
  ]);
  // The UI decides whether Ctrl+C copies a selection or exits.
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: !values["no-mouse"] });
  renderer.once("destroy", () => lifetime.abort());
  const stop = () => renderer.destroy();
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
  try {
    const ui = mountChatUI(renderer, chat, model, { theme });
    for (const report of reports) {
      if (report.ignored?.length) process.stderr.write(`Ignored .env keys: ${report.ignored.map(terminalField).join(", ")}\n`);
    }
    void mentionCandidates(cwd).then(
      (index) => ui.setCandidates(index.paths, index.truncated),
      (error: unknown) => ui.setIndexError(`Mention index unavailable: ${String(error)}`),
    );
    await renderer.closed;
  } finally {
    lifetime.abort();
    renderer.destroy();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGHUP", stop);
  }
}

main().catch((error: unknown) => {
  const candidates = error instanceof SkillResolutionError ? error.candidates.map((name) => `\n  ${terminalField(name)}`).join("") : "";
  process.stderr.write(`ask-tui: ${terminalField(error instanceof Error ? error.message : String(error))}${candidates}\n`);
  process.exitCode = 1;
});
