import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const configFlags = [`--config=${fileURLToPath(new URL("../../src/tui/bunfig.toml", import.meta.url))}`];
const run = promisify(execFile);

test("Node launcher ignores repository and global Bun preload hooks, even for help", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-preload-"));
  try {
    const marker = path.join(cwd, "executed");
    const hook = path.join(cwd, "hook.ts");
    await writeFile(hook, `await Bun.write(${JSON.stringify(marker)}, "preload executed");`);
    const config = `preload = [${JSON.stringify(hook)}]\n`;
    const home = path.join(cwd, "home");
    await mkdir(home);
    await writeFile(path.join(home, ".bunfig.toml"), config);
    await writeFile(path.join(home, "bunfig.toml"), config);
    await writeFile(path.join(cwd, "bunfig.toml"), config);
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env["PATH"] ?? ""}` };
    // Positive control: the fixture really would execute without launcher isolation.
    await run(process.execPath, ["--no-env-file", "-e", "0"], { cwd, env });
    await access(marker);
    await rm(marker);
    const launcher = fileURLToPath(new URL("../../dist/src/tui/launcher.js", import.meta.url));
    for (const args of [["--help"], ["--list-skills"]]) {
      const result = await run("node", [launcher, ...args], { cwd, env, timeout: 10_000 });
      assert.match(result.stdout, args[0] === "--help" ? /ask-tui/ : /Search paths:/);
      await assert.rejects(access(marker), { code: "ENOENT" });
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("startup theme uses flag over exported default and ignores automatic .env theme settings", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-startup-theme-"));
  try {
    await writeFile(path.join(cwd, ".env"), "ASK_THEME=repository-selected-invalid-theme\n");
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(ASK_|OPENAI_|BUN_)/.test(key)) delete env[key];
    }
    const entry = new URL("../../src/tui/index.ts", import.meta.url).href;
    const cases = [
      { value: undefined, args: [], expected: /no API key/ },
      { value: "dracula", args: [], expected: /no API key/ },
      { value: "high-contrast-light", args: [], expected: /no API key/ },
      { value: "invalid-env-theme", args: ["--theme", "tokyo-night"], expected: /no API key/ },
      { value: "dracula", args: ["--theme", "invalid-flag-theme"], expected: /Unknown theme: invalid-flag-theme/ },
      { value: "invalid-env-theme", args: [], expected: /Unknown theme: invalid-env-theme/ },
      { value: "", args: [], expected: /Unknown theme:/ },
      { value: "dracula", args: ["--theme", ""], expected: /Unknown theme:/ },
    ];
    for (const { value, args, expected } of cases) {
      const bootstrap = `
        process.argv = [process.execPath, "index.ts", ...${JSON.stringify(args)}];
        Object.defineProperty(process.stdin, "isTTY", { value: true });
        Object.defineProperty(process.stdout, "isTTY", { value: true });
        await import(${JSON.stringify(entry)});
      `;
      const stderr = await new Promise<string>((resolve, reject) => {
        execFile(process.execPath, ["--no-env-file", ...configFlags, "-e", bootstrap], {
          cwd, env: { ...env, ...(value === undefined ? {} : { ASK_THEME: value }) }, timeout: 10_000,
        }, (error, _stdout, stderr) => {
          if (!error || error.code !== 1) { reject(error ?? new Error("expected startup to stop before UI")); return; }
          resolve(stderr);
        });
      });
      assert.match(stderr, expected);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("context capacity accepts an exported default, validates it and prefers the flag", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-context-window-"));
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(ASK_|OPENAI_|BUN_)/.test(key)) delete env[key];
    }
    const entry = new URL("../../src/tui/index.ts", import.meta.url).href;
    const cases = [
      { value: "32768", args: [], expected: /no API key/ },
      { value: "invalid", args: ["--context-window", "65536"], expected: /no API key/ },
      { value: "32768", args: ["--context-window", "0"], expected: /Invalid --context-window/ },
      ...["", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"].map((value) => ({
        value, args: [], expected: /Invalid ASK_CONTEXT_WINDOW/,
      })),
    ];
    for (const { value, args, expected } of cases) {
      const bootstrap = `
        process.argv = [process.execPath, "tui.ts", ...${JSON.stringify(args)}];
        Object.defineProperty(process.stdin, "isTTY", { value: true });
        Object.defineProperty(process.stdout, "isTTY", { value: true });
        await import(${JSON.stringify(entry)});
      `;
      const stderr = await new Promise<string>((resolve, reject) => {
        execFile(process.execPath, ["--no-env-file", ...configFlags, "-e", bootstrap], {
          cwd, env: { ...env, ASK_CONTEXT_WINDOW: value }, timeout: 10_000,
        }, (error, _stdout, stderr) => {
          if (!error || error.code !== 1) { reject(error ?? new Error("expected startup to stop before UI")); return; }
          resolve(stderr);
        });
      });
      assert.match(stderr, expected);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("TUI can list skills offline without an API key or terminal", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-list-skills-"));
  try {
    await writeFile(path.join(cwd, "review.md"), "---\nname: offline-review\ndescription: Check offline\n---\nReview.");
    const env: NodeJS.ProcessEnv = { ...process.env, ASK_SKILLS_DIR: cwd };
    delete env["OPENAI_API_KEY"];
    const entry = new URL("../../src/tui/index.ts", import.meta.url);
    const result = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ["--no-env-file", ...configFlags, fileURLToPath(entry), "--list-skills"], { cwd, env, timeout: 10_000 }, (error, stdout) => {
        if (error) reject(error); else resolve(stdout);
      });
    });
    assert.match(result, /offline-review — Check offline/);
    assert.match(result, /Search paths:/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("real Bun entry refuses autoload and repository-selected endpoints before a request", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-startup-"));
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end("unexpected"); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await writeFile(path.join(cwd, ".env"), `OPENAI_BASE_URL=http://127.0.0.1:${address.port}/v1\nOPENAI_API_KEY=repository-key\n`);
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(ASK_|OPENAI_|BUN_)/.test(key)) delete env[key];
    }
    const entry = new URL("../../src/tui/index.ts", import.meta.url).href;
    const bootstrap = `
      process.argv = [process.execPath, "tui.ts"];
      Object.defineProperty(process.stdin, "isTTY", { value: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true });
      await import(${JSON.stringify(entry)});
    `;
    for (const flags of [["--no-env-file"], []]) {
      const result = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
        execFile(process.execPath, [...flags, ...configFlags, "-e", bootstrap], { cwd, env, timeout: 10_000 }, (error, _stdout, stderr) => {
          if (error && typeof error.code !== "number") { reject(error); return; }
          resolve({ code: error ? Number(error.code) : 0, stderr });
        });
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, flags.length ? /automatic \.env file/ : /autoload must be disabled/);
    }
    assert.equal(requests, 0);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(cwd, { recursive: true, force: true });
  }
});
