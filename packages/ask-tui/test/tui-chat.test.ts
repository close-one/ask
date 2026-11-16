import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChatCompletion } from "openai/resources/chat/completions";
import type { ChatClient, OneShotRequest } from "@codehaus-au/ask/internal/chat";
import { chatRefs, TuiChat } from "../src/chat.ts";
import { mentionCandidates } from "@codehaus-au/ask/internal/refs";
import { MAX_SKILL_BYTES, SkillResolutionError } from "@codehaus-au/ask/internal/skills";
import { collectContext } from "@codehaus-au/ask/internal/context";

function block(target: string, search: string, replacement: string) {
  return `<update path=${JSON.stringify(target)}>\n<<<<<<< SEARCH\n${search}\n=======\n${replacement}\n>>>>>>> REPLACE\n</update>`;
}

function clientWith(answers: { text: string; reason?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }[]) {
  const requests: OneShotRequest[] = [];
  const client: ChatClient = { chat: { completions: { async create(request) {
    requests.push(request);
    const answer = answers.shift();
    if (!answer) throw new Error("Unexpected request");
    return { id: "test", object: "chat.completion", created: 0, model: "test-model",
      ...(answer.usage ? { usage: answer.usage } : {}),
      choices: [{ index: 0, finish_reason: answer.reason ?? "stop", logprobs: null,
        message: { role: "assistant", content: answer.text, refusal: null } }],
    } as ChatCompletion;
  } } } };
  return { client, requests };
}

test("submission publishes validated attachment context before requesting a completion", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-context-ready-"));
  try {
    await writeFile(path.join(cwd, "a.ts"), "source");
    const { client, requests } = clientWith([{ text: "Answer" }]);
    const chat = new TuiChat(client, { cwd });
    let notifications = 0;
    await chat.submit("Explain @a.ts", () => {
      notifications++;
      assert.equal(requests.length, 0);
      assert.deepEqual(chat.attachmentPaths, ["a.ts"]);
      assert.deepEqual(chat.sessionStats.files, ["a.ts"]);
      assert.equal(chat.sessionStats.turns, 0);
    });
    assert.equal(notifications, 1);
    assert.equal(chat.sessionStats.turns, 1);
    await assert.rejects(chat.submit("Explain @missing-file.ts", () => { notifications++; }));
    assert.equal(notifications, 1, "invalid context must not publish a new attachment selection");
    assert.deepEqual(chat.attachmentPaths, ["a.ts"]);
    assert.equal(requests.length, 1);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("session stats track provider usage honestly, files, and reset without model lookups", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-stats-"));
  try {
    await writeFile(path.join(cwd, "a.ts"), "source");
    const { client, requests } = clientWith([
      { text: "First answer.", usage: { prompt_tokens: 100, completion_tokens: 25 } },
      { text: "No usage reported." },
      { text: "Partial usage.", usage: { prompt_tokens: 50 } },
    ]);
    const chat = new TuiChat(client, { cwd, contextWindow: 1000 });
    assert.equal(chat.sessionStats.turns, 0);
    assert.equal(chat.sessionStats.lastInput, null);
    await chat.submit("Explain @a.ts");
    assert.equal(chat.lastAnswer, "First answer.");
    assert.deepEqual({ ...chat.sessionStats }, {
      cwd, turns: 1, contextWindow: 1000, lastInput: 100, lastOutput: 25,
      totalInput: 100, totalOutput: 25, inputTurns: 1, outputTurns: 1, files: ["a.ts"],
    });
    await chat.submit("Again");
    assert.equal(chat.sessionStats.lastInput, null);
    assert.equal(chat.sessionStats.lastOutput, null);
    await chat.submit("More");
    assert.deepEqual({ ...chat.sessionStats }, {
      cwd, turns: 3, contextWindow: 1000, lastInput: 50, lastOutput: null,
      totalInput: 150, totalOutput: 25, inputTurns: 2, outputTurns: 1, files: ["a.ts"],
    });
    chat.detach("a.ts");
    assert.deepEqual(chat.sessionStats.files, []);
    assert.equal(requests.length, 3);
    chat.reset();
    assert.equal(chat.lastAnswer, null);
    assert.deepEqual({ ...chat.sessionStats }, {
      cwd, turns: 0, contextWindow: 1000, lastInput: null, lastOutput: null,
      totalInput: 0, totalOutput: 0, inputTurns: 0, outputTurns: 0, files: [],
    });
    const unconfigured = new TuiChat(client, { cwd });
    assert.equal(unconfigured.sessionStats.contextWindow, null);
    for (const contextWindow of [0, -1, 1.5, Infinity]) {
      assert.throws(() => new TuiChat(client, { cwd, contextWindow }), /positive safe integer/);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("TUI skills are explicitly selected, composed in system instructions, and re-read each turn", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-skills-"));
  try {
    const root = path.join(cwd, "skills");
    const review = path.join(root, "careful-review", "SKILL.md");
    await mkdir(path.dirname(review), { recursive: true });
    await writeFile(review, "---\nname: careful-review\ndescription: Check correctness\n---\nREVIEW_BODY");
    await writeFile(path.join(path.dirname(review), "script.js"), "SCRIPT_MUST_NOT_RUN");
    await writeFile(path.join(root, "style.md"), "---\nname: style\n---\nSTYLE_BODY");
    const { client, requests } = clientWith([{ text: "First answer." }, { text: "Second answer." }, { text: "Third answer." }]);
    const chat = new TuiChat(client, { cwd, skillRoots: [root], system: "CUSTOM_SYSTEM" });
    assert.match(await chat.listSkills("correctness"), /careful-review/);
    const selected = await chat.selectSkills(["review", "style", "careful-review"]);
    assert.equal(selected[0]?.matched, "search");
    assert.deepEqual(chat.activeSkillNames, ["careful-review", "style"]);
    assert.equal(requests.length, 0);
    await chat.submit("Review this idea.");
    const system = String(requests[0]!.messages[0]!.content);
    assert.match(system, /CUSTOM_SYSTEM[\s\S]*<skill name="careful-review">\nREVIEW_BODY[\s\S]*<skill name="style">\nSTYLE_BODY/);
    assert.doesNotMatch(system, /SCRIPT_MUST_NOT_RUN|description: Check/);
    assert.doesNotMatch(String(requests[0]!.messages.at(-1)!.content), /REVIEW_BODY/);
    await writeFile(review, "---\nname: careful-review\n---\nUPDATED_REVIEW_BODY");
    await chat.submit("And now?");
    assert.match(String(requests[1]!.messages[0]!.content), /UPDATED_REVIEW_BODY/);
    chat.removeSkill("careful-review");
    await chat.submit("Use style only.");
    assert.doesNotMatch(String(requests[2]!.messages[0]!.content), /REVIEW_BODY/);
    assert.match(String(requests[2]!.messages[0]!.content), /STYLE_BODY/);
    chat.reset();
    assert.deepEqual(chat.activeSkillNames, []);
    assert.equal(requests.length, 3);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("ambiguous, missing and oversized skill selections fail without requests or partial selection", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-skills-"));
  try {
    const root = path.join(cwd, "skills");
    await mkdir(root);
    for (const name of ["first", "second"]) await writeFile(path.join(root, `${name}.md`), `---\nname: ${name}\ndescription: shared rubric\n---\n${name}`);
    const { client, requests } = clientWith([]);
    const chat = new TuiChat(client, { cwd, skillRoots: [root] });
    await chat.selectSkills(["first"]);
    await assert.rejects(chat.selectSkills(["second", "shared"]), (error: unknown) => {
      assert.ok(error instanceof SkillResolutionError);
      assert.deepEqual(error.candidates, ["first", "second"]);
      return true;
    });
    assert.deepEqual(chat.activeSkillNames, ["first"]);
    await assert.rejects(chat.selectSkills(["missing"]), /no skill matches/);
    await writeFile(path.join(root, "second.md"), "x".repeat(MAX_SKILL_BYTES + 1));
    await assert.rejects(chat.selectSkills(["second"]), /skill limit/);
    await writeFile(path.join(root, "first.md"), "x".repeat(MAX_SKILL_BYTES + 1));
    await assert.rejects(chat.submit("hello"), /skill limit/);
    await rm(path.join(root, "first.md"));
    await assert.rejects(chat.submit("hello"), /ENOENT/);
    assert.deepEqual(chat.activeSkillNames, ["first"]);
    assert.equal(requests.length, 0);
    chat.removeSkill("first");
    assert.throws(() => chat.removeSkill("first"), /No active skill/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("mentions can appear anywhere without losing question formatting", () => {
  assert.deepEqual(chatRefs('Explain @src/a.ts, then\ncompare @"name with spaces.ts" with (@src). Email me@host stays text.'), ["src/a.ts", "name with spaces.ts", "src"]);
});

test("individual files can be excluded from attached folders, restored, and explicitly reattached", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-detach-"));
  try {
    await mkdir(path.join(cwd, "src"));
    await writeFile(path.join(cwd, "src", "a.ts"), "EXCLUDED_CONTENT");
    await writeFile(path.join(cwd, "src", "b.ts"), "RETAINED_CONTENT");
    const { client, requests } = clientWith(Array.from({ length: 6 }, () => ({ text: "Answer" })));
    const chat = new TuiChat(client, { cwd });
    await chat.submit("Explain @src");
    chat.detach("src/a.ts");
    assert.deepEqual(chat.attachmentPaths, ["src"]);
    assert.deepEqual(chat.sessionStats.files, ["src/b.ts"]);
    assert.deepEqual(chat.excludedFilePaths, ["src/a.ts"]);
    await chat.submit("Follow up");
    assert.doesNotMatch(String(requests[1]!.messages.at(-1)!.content), /EXCLUDED_CONTENT/);
    assert.match(String(requests[1]!.messages.at(-1)!.content), /RETAINED_CONTENT/);
    chat.restoreFile("src/a.ts");
    await chat.submit("Restored");
    assert.match(String(requests[2]!.messages.at(-1)!.content), /EXCLUDED_CONTENT/);
    chat.detach("src/a.ts");
    await chat.submit("Explicit @src/a.ts");
    assert.match(String(requests[3]!.messages.at(-1)!.content), /EXCLUDED_CONTENT/);
    assert.deepEqual(chat.excludedFilePaths, []);
    chat.detach("src/a.ts");
    await chat.submit("Explicit whole folder @src");
    assert.match(String(requests[4]!.messages.at(-1)!.content), /EXCLUDED_CONTENT/);
    chat.detach("src");
    await chat.submit("Detached everything");
    assert.doesNotMatch(String(requests[5]!.messages.at(-1)!.content), /<file /);
    assert.throws(() => chat.detach("not-attached.ts"), /Not attached/);
    assert.equal(await readFile(path.join(cwd, "src", "a.ts"), "utf8"), "EXCLUDED_CONTENT");
    chat.reset();
    assert.deepEqual(chat.excludedFilePaths, []);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("excluded files do not consume context count or byte budgets", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-exclusion-budget-"));
  try {
    await writeFile(path.join(cwd, "a.ts"), "x".repeat(100));
    await writeFile(path.join(cwd, "b.ts"), "kept");
    const context = await collectContext(["."], { cwd, excludePaths: ["a.ts"], limits: { maxFiles: 1, maxTotalBytes: 5 } });
    assert.deepEqual(context.blocks.map((block) => block.path), ["b.ts"]);
    assert.equal(context.totalBytes, 4);
    assert.equal(context.truncated, false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("excluded folder children cannot be model-selected update targets", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-excluded-update-"));
  try {
    await mkdir(path.join(cwd, "src"));
    await writeFile(path.join(cwd, "src", "a.ts"), "old");
    await writeFile(path.join(cwd, "src", "b.ts"), "keep");
    const { client, requests } = clientWith([{ text: "Answer" }, { text: block("src/a.ts", "old", "new") }]);
    const chat = new TuiChat(client, { cwd });
    await chat.submit("Explain @src");
    chat.detach("src/a.ts");
    const reply = await chat.submit("Suggest changes");
    assert.match(reply.proposalError!, /not an editable, complete attachment/);
    assert.equal(chat.pendingCount, 0);
    assert.equal(requests.length, 2);
    assert.equal(await readFile(path.join(cwd, "src", "a.ts"), "utf8"), "old");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("files can be attached locally, deduplicated and restored before any model request", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-local-attach-"));
  try {
    await mkdir(path.join(cwd, "src"));
    await writeFile(path.join(cwd, "src", "a.ts"), "A_CONTENT");
    await writeFile(path.join(cwd, "src", "b.ts"), "B_CONTENT");
    const { client, requests } = clientWith([{ text: "Answer" }]);
    const chat = new TuiChat(client, { cwd });
    await chat.attach("src");
    await chat.attach("src");
    assert.deepEqual(chat.attachmentPaths, ["src"]);
    assert.deepEqual(chat.sessionStats.files, ["src/a.ts", "src/b.ts"]);
    chat.detach("src/a.ts");
    await chat.attach("src/a.ts");
    assert.deepEqual(chat.excludedFilePaths, []);
    assert.equal(requests.length, 0);
    const before = chat.attachmentPaths;
    await assert.rejects(chat.attach("missing-file.ts"));
    assert.deepEqual(chat.attachmentPaths, before);
    await chat.submit("Explain");
    assert.equal(requests.length, 1);
    assert.match(String(requests[0]!.messages.at(-1)!.content), /A_CONTENT[\s\S]*B_CONTENT/);
    assert.equal(await readFile(path.join(cwd, "src", "a.ts"), "utf8"), "A_CONTENT");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("mention index offers files and folders but excludes secrets and skipped trees", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-index-"));
  try {
    await mkdir(path.join(cwd, "src"));
    await mkdir(path.join(cwd, "node_modules"));
    await writeFile(path.join(cwd, "src", "a.ts"), "source");
    await writeFile(path.join(cwd, ".env"), "SECRET=hidden");
    await writeFile(path.join(cwd, "node_modules", "a.ts"), "dependency");
    const index = await mentionCandidates(cwd);
    assert.ok(index.paths.includes("src/"));
    assert.ok(index.paths.includes("src/a.ts"));
    assert.ok(index.paths.every((file) => !file.includes("node_modules") && !file.includes(".env")));
    assert.equal(index.truncated, false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("ordinary chat retains attachments and allows unsolicited, user-approved updates", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-"));
  try {
    await writeFile(path.join(cwd, "a.ts"), "const a = 1;\n");
    const { client, requests } = clientWith([
      { text: "This defines a constant." },
      { text: `Here is a safer value.\n${block("a.ts", "const a = 1;", "const a = 2;")}` },
      { text: "Done." },
    ]);
    const chat = new TuiChat(client, { cwd });
    await chat.submit("Explain @a.ts please.");
    await chat.submit("What would you improve?");
    assert.equal(requests.length, 2);
    assert.equal(chat.pendingCount, 1);
    assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), "const a = 1;\n");
    await assert.rejects(chat.apply(), /review/);
    assert.match(chat.review()[0]!, /\+const a = 2;/);
    await chat.apply();
    assert.equal(requests.length, 2, "applying an answer is local, not another model request");
    assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), "const a = 2;\n");
    await chat.submit("Explain the new value.");
    const last = requests[2]!.messages.at(-1)!;
    assert.match(String(last.content), /^Explain the new value\.[\s\S]*<file path="a.ts">\nconst a = 2;/);
    assert.ok(requests[2]!.messages.some((message) => String(message.content).includes("approved and applied")));
    for (const request of requests) {
      for (const field of ["tools", "tool_choice", "functions", "function_call", "parallel_tool_calls", "stream"]) {
        assert.equal(field in request, false);
      }
      assert.ok(request.messages.every((message) => ["system", "user", "assistant"].includes(message.role)));
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("pending proposals must be resolved; reject and reset never ask or write", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-"));
  try {
    await writeFile(path.join(cwd, "a.ts"), "old\n");
    const { client, requests } = clientWith([{ text: block("a.ts", "old", "new") }]);
    const chat = new TuiChat(client, { cwd });
    await chat.submit("Check @a.ts");
    await assert.rejects(chat.submit("again"), /pending/);
    await assert.rejects(chat.selectSkills(["review"]), /pending edits/);
    assert.throws(() => chat.removeSkill("review"), /pending edits/);
    assert.throws(() => chat.detach("a.ts"), /pending edits/);
    assert.throws(() => chat.restoreFile("a.ts"), /pending edits/);
    await assert.rejects(chat.attach("a.ts"), /pending edits/);
    chat.reject();
    assert.equal(chat.pendingCount, 0);
    chat.detach("a.ts");
    assert.deepEqual(chat.attachmentPaths, []);
    chat.reset();
    assert.equal(requests.length, 1);
    assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), "old\n");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("truncated responses, malformed updates and unrequested targets cannot write", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-"));
  try {
    await writeFile(path.join(cwd, "a.ts"), "old\n");
    await writeFile(path.join(cwd, "b.ts"), "old\n");
    for (const answer of [
      { text: block("a.ts", "old", "new"), reason: "length" },
      { text: block("a.ts", "old", "new") + '\n<update path="a.ts">' },
      { text: block("b.ts", "old", "new") },
    ]) {
      const { client, requests } = clientWith([answer]);
      const chat = new TuiChat(client, { cwd });
      const reply = await chat.submit("Check @a.ts");
      assert.ok(reply.proposalError);
      assert.equal(chat.pendingCount, 0);
      await assert.rejects(chat.apply());
      assert.equal(requests.length, 1);
    }
    assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), "old\n");
    assert.equal(await readFile(path.join(cwd, "b.ts"), "utf8"), "old\n");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("folder attachments are re-read; snapshot changes invalidate pending edits", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-"));
  try {
    await writeFile(path.join(cwd, "a.ts"), "old\n");
    const { client, requests } = clientWith([{ text: "Explained." }, { text: block("a.ts", "current", "new") }]);
    const chat = new TuiChat(client, { cwd });
    await chat.submit("Explain @.");
    await writeFile(path.join(cwd, "a.ts"), "current\n");
    await chat.submit("Improvements?");
    assert.match(String(requests[1]!.messages.at(-1)!.content), /current/);
    chat.review();
    await writeFile(path.join(cwd, "a.ts"), "user work\n");
    await assert.rejects(chat.apply(), /changed/);
    assert.equal(chat.pendingCount, 0);
    assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), "user work\n");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("in-flight submissions are rejected without an extra request", async () => {
  let resolve!: (completion: ChatCompletion) => void;
  let calls = 0;
  const client: ChatClient = { chat: { completions: { create: () => {
    calls++;
    return new Promise<ChatCompletion>((done) => { resolve = done; });
  } } } };
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-"));
  try {
    const chat = new TuiChat(client, { cwd });
    const pending = chat.submit("hello");
    await assert.rejects(chat.submit("again"), /in progress/);
    // Allow asynchronous context collection to reach the mock transport.
    while (!resolve) await new Promise((done) => setImmediate(done));
    resolve({ id: "test", object: "chat.completion", created: 0, model: "test",
      choices: [{ index: 0, finish_reason: "stop", logprobs: null,
        message: { role: "assistant", content: "hello", refusal: null } }],
    });
    await pending;
    assert.equal(calls, 1);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
