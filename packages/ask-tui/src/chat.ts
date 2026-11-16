// UI-independent chat controller. Only submit() can ask the model, exactly once.
import path from "node:path";
import { askOnce, buildRequest, DEFAULT_MODEL, type ChatClient, type HistoryMessage, type TokenField } from "@codehaus-au/ask/internal/chat";
import { collectContext, type ContextResult, type LimitOverrides } from "@codehaus-au/ask/internal/context";
import { applyUpdates, captureEditableFiles, parseUpdates, prepareUpdates, UPDATE_SYSTEM, updateDiff, type ProposedUpdate } from "./updates.ts";
import { discoverSkills, filterSkills, loadSkill, renderSkills, resolveSkill, skillSearchPaths, type LoadedSkill, type SkillSummary } from "@codehaus-au/ask/internal/skills";
import { terminalField } from "@codehaus-au/ask/internal/terminal";
import { resolveRef } from "@codehaus-au/ask/internal/refs";
import { chatRefs } from "./mentions.ts";
export { chatRefs } from "./mentions.ts";

function containsPath(parent: string, file: string): boolean {
  const relative = path.relative(parent, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export interface TuiChatOptions {
  readonly cwd: string;
  readonly model?: string;
  readonly system?: string;
  readonly baseURL?: string | undefined;
  readonly maxTokens?: number | undefined;
  readonly temperature?: number | undefined;
  readonly tokenField?: TokenField | undefined;
  readonly limits?: LimitOverrides;
  readonly skillRoots?: readonly string[];
  /** Explicit model capacity; never inferred from a model name or endpoint. */
  readonly contextWindow?: number | undefined;
}

function attachmentMessage(text: string, context: ContextResult): string {
  return [text, ...context.blocks.map((block) =>
    `<file path=${JSON.stringify(block.path)}${block.truncated ? ' truncated="true"' : ""}>\n${block.text}\n</file>`),
  ].join("\n\n");
}

export interface ChatReply {
  readonly text: string;
  readonly context: ContextResult;
  readonly status: string;
  readonly proposalError: string | null;
}

export interface TuiSessionStats {
  readonly cwd: string;
  readonly turns: number;
  readonly contextWindow: number | null;
  readonly lastInput: number | null;
  readonly lastOutput: number | null;
  readonly totalInput: number;
  readonly totalOutput: number;
  readonly inputTurns: number;
  readonly outputTurns: number;
  readonly files: readonly string[];
}

export class TuiChat {
  private readonly client: ChatClient;
  private readonly options: TuiChatOptions;
  private readonly history: HistoryMessage[] = [];
  private attachments: string[] = [];
  private pending: ProposedUpdate[] = [];
  private reviewed = false;
  private busy = false;
  private skills: LoadedSkill[] = [];
  private turns = 0;
  private lastInput: number | null = null;
  private lastOutput: number | null = null;
  private totalInput = 0;
  private totalOutput = 0;
  private inputTurns = 0;
  private outputTurns = 0;
  private files: string[] = [];
  private excludedFiles = new Set<string>();

  constructor(client: ChatClient, options: TuiChatOptions) {
    this.client = client;
    this.options = options;
    if (options.contextWindow !== undefined && (!Number.isSafeInteger(options.contextWindow) || options.contextWindow <= 0)) {
      throw new Error("Context window must be a positive safe integer.");
    }
  }

  get attachmentPaths(): readonly string[] { return this.attachments.map((file) => path.relative(this.options.cwd, file) || "."); }
  get pendingCount(): number { return this.pending.length; }
  get activeSkillNames(): readonly string[] { return this.skills.map((skill) => skill.name); }
  get excludedFilePaths(): readonly string[] { return [...this.excludedFiles].map((file) => path.relative(this.options.cwd, file)); }
  get lastAnswer(): string | null { return this.history.findLast((message) => message.role === "assistant")?.content ?? null; }
  get sessionStats(): TuiSessionStats {
    return {
      cwd: this.options.cwd, turns: this.turns, contextWindow: this.options.contextWindow ?? null,
      lastInput: this.lastInput, lastOutput: this.lastOutput,
      totalInput: this.totalInput, totalOutput: this.totalOutput,
      inputTurns: this.inputTurns, outputTurns: this.outputTurns, files: [...this.files],
    };
  }

  private get skillRoots(): readonly string[] { return this.options.skillRoots ?? skillSearchPaths(this.options.cwd); }

  availableSkills(): Promise<SkillSummary[]> { return discoverSkills(this.skillRoots); }

  async listSkills(term = ""): Promise<string> {
    const available = filterSkills(await this.availableSkills(), term);
    return [
      "Skills (* = active; select with /skill <name>, remove with /unskill <name>)",
      ...available.map((skill) => `${this.skills.some((active) => active.file === skill.file) ? "*" : " "} ${terminalField(skill.name)} — ${terminalField(skill.description)}`),
      ...(available.length ? [] : ["No matching skills."]),
      "Search paths:", ...this.skillRoots.map((root) => `  ${terminalField(root)}`),
    ].join("\n");
  }

  /** User selection only. Validate the whole batch before changing active skills. */
  async selectSkills(terms: readonly string[]): Promise<readonly LoadedSkill[]> {
    if (this.busy || this.pending.length) throw new Error("Finish the current request or resolve pending edits first.");
    if (!terms.length) return [];
    this.busy = true;
    try {
      const available = await discoverSkills(this.skillRoots);
      const selected: LoadedSkill[] = [];
      for (const term of terms) {
        const summary = resolveSkill(term, available);
        selected.push(await loadSkill(summary, summary.name === term ? "name" : "search"));
      }
      const byName = new Map(this.skills.map((skill) => [skill.name, skill]));
      for (const skill of selected) byName.set(skill.name, skill);
      this.skills = [...byName.values()];
      return selected;
    } finally { this.busy = false; }
  }

  removeSkill(name: string): void {
    if (this.busy || this.pending.length) throw new Error("Finish the current request or resolve pending edits first.");
    if (!this.skills.some((skill) => skill.name === name)) throw new Error(`No active skill named ${JSON.stringify(name)}. Use /unskill or /context to view active skills.`);
    this.skills = this.skills.filter((skill) => skill.name !== name);
  }

  async submit(text: string, onContextReady?: () => void): Promise<ChatReply> {
    if (this.busy) throw new Error("A request or write is already in progress.");
    if (this.pending.length) throw new Error("Review and /apply or /reject the pending edits before asking again.");
    if (!text.trim()) throw new Error("Enter a question.");
    this.busy = true;
    try {
      // Keep the user's selected file, rather than silently resolving a different
      // skill if discovery precedence changes. Missing/oversized skills fail closed.
      const skills = await Promise.all(this.skills.map((skill) => loadSkill(skill, skill.matched)));
      const added = await Promise.all(chatRefs(text).map((ref) => resolveRef(ref, { cwd: this.options.cwd })));
      const addedPaths = added.flatMap((resolution) => resolution.paths);
      // A fresh explicit mention restores that file/folder. Merely retaining an
      // old folder reference must not silently undo the user's file exclusions.
      const excluded = new Set([...this.excludedFiles].filter((file) => !addedPaths.some((ref) => containsPath(ref, file))));
      const refs = [...this.attachments, ...addedPaths];
      const context = await collectContext(refs, {
        cwd: this.options.cwd, limits: this.options.limits ?? {}, excludePaths: [...excluded],
      });
      // Store resolved paths, not fuzzy names that could silently match another file.
      const attachments = [...new Set(context.resolutions.flatMap((resolution) => resolution.paths))];
      const files = await captureEditableFiles(context.blocks, this.options.cwd);
      // Attachment selection is local state, not dependent on provider success.
      // Publish it after validation but before starting the network request.
      this.attachments = attachments;
      this.excludedFiles = excluded;
      this.files = context.blocks.map((block) => block.path);
      onContextReady?.();
      const result = await askOnce(this.client, buildRequest({
        prompt: attachmentMessage(text, context),
        model: this.options.model ?? DEFAULT_MODEL,
        system: [this.options.system, renderSkills(skills), UPDATE_SYSTEM].filter(Boolean).join("\n\n"),
        history: this.history,
        baseURL: this.options.baseURL,
        maxTokens: this.options.maxTokens,
        temperature: this.options.temperature,
        tokenField: this.options.tokenField,
      }));
      this.turns++;
      this.lastInput = result.usage.input;
      this.lastOutput = result.usage.output;
      if (result.usage.input !== null) { this.totalInput += result.usage.input; this.inputTurns++; }
      if (result.usage.output !== null) { this.totalOutput += result.usage.output; this.outputTurns++; }
      this.history.push({ role: "user", content: text }, { role: "assistant", content: result.text });
      let proposalError: string | null = null;
      try {
        if (result.finishReason !== "stop") {
          throw new Error(`Edits disabled: incomplete or unexpected response (${result.finishReason ?? "unknown"}).`);
        }
        this.pending = prepareUpdates(parseUpdates(result.text), files);
      } catch (error) {
        this.pending = [];
        proposalError = error instanceof Error ? error.message : String(error);
      }
      this.reviewed = false;
      return {
        text: result.text, context, proposalError,
        status: `${result.model} · ${context.blocks.length} file(s) · skills ${skills.map((skill) => terminalField(skill.name)).join(", ") || "none"} · tokens ${result.usage.input ?? "?"} in / ${result.usage.output ?? "?"} out`,
      };
    } finally { this.busy = false; }
  }

  review(): string[] {
    if (!this.pending.length) throw new Error("No pending edits.");
    this.reviewed = true;
    return this.pending.map(updateDiff);
  }

  async apply(): Promise<string[]> {
    if (this.busy) throw new Error("A request or write is already in progress.");
    if (!this.pending.length || !this.reviewed) throw new Error("Use /review before /apply.");
    this.busy = true;
    const pending = this.pending;
    // Failed/partially applied proposals must not be retried against stale snapshots.
    this.pending = [];
    this.reviewed = false;
    try {
      const paths = await applyUpdates(pending);
      this.history.push({ role: "user", content: `Local edit decision: approved and applied updates to ${JSON.stringify(paths)}.` });
      return paths;
    } catch (error) {
      this.history.push({ role: "user", content: `Local edit application failed; do not assume any proposal applied. ${String(error)}` });
      throw error;
    } finally { this.busy = false; }
  }

  reject(): void {
    if (this.busy) throw new Error("A request or write is already in progress.");
    this.pending = [];
    this.reviewed = false;
    this.history.push({ role: "user", content: "Local edit decision: rejected pending proposals; no files were written." });
  }

  /** Explicit local attachment selection, with no model request or file writes. */
  async attach(ref: string): Promise<ContextResult> {
    if (this.busy || this.pending.length) throw new Error("Finish the current request or resolve pending edits first.");
    this.busy = true;
    try {
      const added = await resolveRef(ref, { cwd: this.options.cwd });
      const excluded = new Set([...this.excludedFiles].filter((file) => !added.paths.some((parent) => containsPath(parent, file))));
      const context = await collectContext([...new Set([...this.attachments, ...added.paths])], {
        cwd: this.options.cwd, limits: this.options.limits ?? {}, excludePaths: [...excluded],
      });
      this.attachments = [...new Set(context.resolutions.flatMap((resolution) => resolution.paths))];
      this.files = context.blocks.map((block) => block.path);
      this.excludedFiles = excluded;
      return context;
    } finally { this.busy = false; }
  }

  detach(target: string): void {
    if (this.busy || this.pending.length) throw new Error("Finish the current request or resolve pending edits first.");
    const absolute = path.resolve(this.options.cwd, target.replace(/^@/, ""));
    const knownFile = this.files.some((file) => path.resolve(this.options.cwd, file) === absolute);
    if (!this.attachments.includes(absolute) && !knownFile) throw new Error(`Not attached: ${JSON.stringify(target)}`);
    this.attachments = this.attachments.filter((file) => file !== absolute);
    if (knownFile) this.excludedFiles.add(absolute);
    this.files = this.files.filter((file) => {
      const name = path.resolve(this.options.cwd, file);
      return !this.excludedFiles.has(name) && this.attachments.some((ref) => containsPath(ref, name));
    });
  }

  restoreFile(target: string): void {
    if (this.busy || this.pending.length) throw new Error("Finish the current request or resolve pending edits first.");
    const absolute = path.resolve(this.options.cwd, target);
    if (!this.excludedFiles.delete(absolute)) throw new Error(`Not excluded: ${JSON.stringify(target)}`);
    if (!this.attachments.some((ref) => containsPath(ref, absolute))) this.attachments.push(absolute);
  }

  reset(): void {
    if (this.busy) throw new Error("A request or write is already in progress.");
    this.history.length = 0;
    this.attachments = [];
    this.pending = [];
    this.reviewed = false;
    this.skills = [];
    this.turns = 0;
    this.lastInput = null;
    this.lastOutput = null;
    this.totalInput = 0;
    this.totalOutput = 0;
    this.inputTurns = 0;
    this.outputTurns = 0;
    this.files = [];
    this.excludedFiles.clear();
  }
}
