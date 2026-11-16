#!/usr/bin/env node
// A fixed runtime launch, not a model tool. Neither repository runtime hooks nor
// automatic .env loading may run before the application's own checks.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { terminalField } from "@codehaus-au/ask/internal/terminal";

const child = spawn("bun", [
  "--no-env-file", `--config=${fileURLToPath(new URL("./bunfig.toml", import.meta.url))}`,
  fileURLToPath(new URL("./index.js", import.meta.url)), ...process.argv.slice(2),
], {
  stdio: "inherit",
  shell: false,
});
const term = () => { child.kill("SIGTERM"); };
const hup = () => { child.kill("SIGHUP"); };
process.on("SIGTERM", term);
process.on("SIGHUP", hup);
function cleanup() {
  process.removeListener("SIGTERM", term);
  process.removeListener("SIGHUP", hup);
}
child.once("error", (error) => {
  cleanup();
  process.stderr.write(`ask-tui: could not start Bun. Install Bun 1.3.14+ and put it on PATH. ${terminalField(error.message)}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  cleanup();
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
});
