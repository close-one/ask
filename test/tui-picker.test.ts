import assert from "node:assert/strict";
import test from "node:test";
import { filterPopupItems, isFileCandidateVisible, SLASH_COMMANDS, type PopupItem } from "../src/tui/picker.ts";

const commands: PopupItem[] = SLASH_COMMANDS.map((entry) => ({ kind: "command", value: entry.value, label: entry.value, description: entry.description }));

test("command completion searches names and descriptions, case-insensitively", () => {
  assert.equal(filterPopupItems(commands, "").length, commands.length);
  assert.equal(filterPopupItems(commands, "review")[0]?.value, "/review");
  assert.equal(filterPopupItems(commands, "skil")[0]?.value, "/skill");
  assert.equal(filterPopupItems(commands, "skill")[0]?.value, "/skill");
  assert.equal(filterPopupItems(commands, "skills")[0]?.value, "/skills");
  assert.deepEqual(filterPopupItems(commands, "REMOVE SKILL").map((item) => item.value), ["/unskill"]);
  assert.deepEqual(filterPopupItems(commands, "clipboard").map((item) => item.value), ["/copy"]);
  assert.deepEqual(filterPopupItems(commands, "definitely-not-a-command"), []);
  assert.equal(new Set(SLASH_COMMANDS.map((entry) => entry.value)).size, SLASH_COMMANDS.length);
});

test("hidden file/folder candidates require an explicit dot-prefixed filename component", () => {
  assert.equal(isFileCandidateVisible("normal.ts", ""), true);
  assert.equal(isFileCandidateVisible("src/normal.ts", "normal.ts"), true);
  for (const candidate of [".prettierrc", ".config/", ".config/settings.ts", "src/.hidden.ts"]) {
    assert.equal(isFileCandidateVisible(candidate, ""), false);
    assert.equal(isFileCandidateVisible(candidate, "hidden"), false);
    assert.equal(isFileCandidateVisible(candidate, "normal.ts"), false);
    assert.equal(isFileCandidateVisible(candidate, "./"), false);
    assert.equal(isFileCandidateVisible(candidate, "."), true);
  }
  assert.equal(isFileCandidateVisible("src/.hidden.ts", "src/."), true);
  assert.equal(isFileCandidateVisible("src/.hidden.ts", "src/.hid"), true);
  assert.equal(isFileCandidateVisible("src/.hidden.ts", "src/hidden"), false);
  assert.equal(isFileCandidateVisible(".config/settings.ts", ".config/set"), true);
  assert.equal(isFileCandidateVisible(".config/.nested/file.ts", ".config/"), false);
  assert.equal(isFileCandidateVisible(".config/.nested/file.ts", ".config/."), true);
});
