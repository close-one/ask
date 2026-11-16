#!/usr/bin/env node
// A fixed runtime launch, not a model tool. Bun must not preload repository .env
// files before the application's restricted/provenance-aware loader sees them.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { terminalField } from "../terminal.ts";

const child = spawn("bun", ["--no-env-file", fileURLToPath(new URL("./index.js", import.meta.url)), ...process.argv.slice(2)], {
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
