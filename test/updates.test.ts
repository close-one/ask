import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectContext } from "../src/context.ts";
import { applyUpdates, captureEditableFiles, parseUpdates, prepareUpdates, updateDiff } from "../src/tui/updates.ts";

export function update(target: string, search: string, replacement: string): string {
  return `<update path=${JSON.stringify(target)}>\n<<<<<<< SEARCH\n${search}\n=======\n${replacement}\n>>>>>>> REPLACE\n</update>`;
}

test("update parser accepts prose and multiple blocks, preserves exact whitespace", () => {
  assert.deepEqual(parseUpdates(`Explanation.\n${update("a.ts", "  old\nline", "  new\nline")}\n${update("a.ts", "other", "")}`), [
    { path: "a.ts", search: "  old\nline", replacement: "  new\nline" },
    { path: "a.ts", search: "other", replacement: "" },
  ]);
  assert.deepEqual(parseUpdates("An ordinary answer."), []);
  assert.deepEqual(parseUpdates(`\`\`\`text\n${update("a", "old", "new")}\n\`\`\``), []);
  assert.deepEqual(parseUpdates(`~~~~\n${update("a", "old", "new")}\n~~~~`), []);
});

test("malformed, nested, empty and incomplete proposals fail closed", () => {
  for (const text of [
    '<update path="a">', update("a", "", "new"),
    update("a", "old", "new").replace("=======", "------"),
    update("a", "old", "new").replace("</update>", ""),
    update("a", "old", "<update path=\"b\">"),
    '</update>', '<update path="a" extra="yes">',
    update("a\nforged", "old", "new"),
    update("a", "old", "\ud800"),
  ]) assert.throws(() => parseUpdates(text), Error, text);
});

test("diff previews make final-newline changes explicit", () => {
  assert.match(updateDiff({ path: "a.ts", original: "one", proposed: "one\n" }), /-one\n\\ No newline at end of file\n\+one$/);
  assert.match(updateDiff({ path: "a.ts", original: "one\n", proposed: "" }), /@@ -1,1 \+0,0 @@\n-one$/);
});

test("updates validate all original matches and do not cascade", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-updates-"));
  try {
    await writeFile(path.join(cwd, "a.ts"), "one\ntwo\nthree\n");
    const files = await captureEditableFiles((await collectContext(["a.ts"], { cwd })).blocks, cwd);
    const edits = prepareUpdates(parseUpdates(update("a.ts", "one", "ONE") + "\n" + update("a.ts", "three", "THREE")), files);
    assert.equal(edits[0]?.proposed, "ONE\ntwo\nTHREE\n");
    assert.match(updateDiff(edits[0]!), /-one\n-two\n-three\n\+ONE\n\+two\n\+THREE/);
    assert.throws(() => prepareUpdates(parseUpdates(update("a.ts", "ONE", "next")), files), /exactly once/);
    assert.throws(() => prepareUpdates(parseUpdates(update("a.ts", "one\ntwo", "x") + "\n" + update("a.ts", "two", "y")), files), /Overlapping/);
    assert.throws(() => prepareUpdates(parseUpdates(update("other.ts", "one", "x")), files), /not an editable/);
    assert.throws(() => prepareUpdates(parseUpdates(update("./a.ts", "one", "x")), files), /not an editable/);
    assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), "one\ntwo\nthree\n");
    await applyUpdates(edits);
    assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), "ONE\ntwo\nTHREE\n");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("non-unique and overlapping substring occurrences are rejected", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-updates-"));
  try {
    await writeFile(path.join(cwd, "a.ts"), "aaa");
    const files = await captureEditableFiles((await collectContext(["a.ts"], { cwd })).blocks, cwd);
    assert.throws(() => prepareUpdates(parseUpdates(update("a.ts", "aa", "b")), files), /exactly once/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("truncated files, symlinks, invalid UTF-8 and outside-tree paths are read-only", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-updates-"));
  const outside = await mkdtemp(path.join(tmpdir(), "ask-outside-"));
  try {
    await writeFile(path.join(cwd, "a.ts"), "original\n");
    await writeFile(path.join(cwd, "bad.ts"), Buffer.from([0xff, 0xfe]));
    await symlink("a.ts", path.join(cwd, "link.ts"));
    await writeFile(path.join(outside, "b.ts"), "outside");
    const context = await collectContext(["a.ts", "bad.ts", "link.ts", path.join(outside, "b.ts")], { cwd });
    const files = await captureEditableFiles(context.blocks.map((block) => block.path === "a.ts" ? { ...block, truncated: true } : block), cwd);
    assert.equal(files.size, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("stale multi-file proposal is refused before any file is written", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-updates-"));
  try {
    await writeFile(path.join(cwd, "a.ts"), "original\n");
    await writeFile(path.join(cwd, "b.ts"), "original\n");
    const files = await captureEditableFiles((await collectContext(["a.ts", "b.ts"], { cwd })).blocks, cwd);
    const edits = prepareUpdates(parseUpdates(update("a.ts", "original", "changed") + "\n" + update("b.ts", "original", "changed")), files);
    await writeFile(path.join(cwd, "b.ts"), "user work\n");
    await assert.rejects(applyUpdates(edits), /changed/);
    assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), "original\n");
    assert.equal(await readFile(path.join(cwd, "b.ts"), "utf8"), "user work\n");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
