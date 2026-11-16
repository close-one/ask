import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const launcher = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../src/launcher.ts" : "../src/launcher.js", import.meta.url));

test("TUI launcher disables Bun env autoload and forwards literal arguments without a shell", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-launcher-"));
  try {
    const bun = path.join(cwd, "bun");
    await writeFile(bun, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`);
    await chmod(bun, 0o755);
    const args = ["--model", "value with spaces; $(touch should-not-exist)"];
    const result = await run(process.execPath, [launcher, ...args], {
      cwd, env: { ...process.env, PATH: cwd },
    });
    assert.deepEqual(JSON.parse(result.stdout), [
      "--no-env-file", `--config=${fileURLToPath(new URL("../src/bunfig.toml", import.meta.url))}`,
      fileURLToPath(new URL("../src/index.js", import.meta.url)), ...args,
    ]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("missing Bun produces an actionable error without importing the native UI", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-launcher-"));
  try {
    await assert.rejects(run(process.execPath, [launcher, "--help"], {
      cwd, env: { ...process.env, PATH: cwd },
    }), (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, /Install Bun 1\.3\.14\+/);
      return true;
    });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
