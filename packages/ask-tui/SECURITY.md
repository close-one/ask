# Security policy — ask-tui

## Reporting a vulnerability

Email **mat@codehaus.co** with the details. Please do not open a public issue
for anything exploitable. Expect an acknowledgement within a few working days.

## Scope

`ask-tui` is built on `@codehaus-au/ask` and depends on the exact same version.
Context collection, secret skipping, symlink handling, endpoint selection,
layered configuration (untrusted projects cannot choose the endpoint or use `{env:}`), the tool-free request type and terminal sanitising
are the core package's code, so its
[security policy](https://github.com/codehausau/ask/blob/main/packages/ask/SECURITY.md)
applies here too. This document covers what the TUI adds.

| Guarantee | Enforced by |
| --- | --- |
| One logical completion per submission | No model-driven execution loop; SDK transport retries resend the same body, at most twice |
| Nothing is written unless you approve it | `<update>` proposals require a diff review and `/apply` |
| Repository runtime hooks never run | The Node launcher runs Bun by absolute path, never from the working directory or a relative `PATH` entry, with `--no-env-file` and a bundled `--config`, so repository/global `bunfig.toml` preloads are skipped |
| A question cannot attach an unintended file | Typed mentions must name an existing path or glob (no fuzzy search); pasted text is escaped so it never contains mentions |
| You see what you approve | Proposals are summarised first; only files shown with `/review` can be applied, file by file; files that run code are flagged |

## TUI update proposals

`ask-tui` uses the same tool-free request type and retry policy as the CLI. It
requests one logical completion per user submission. Transient failures can
trigger up to two SDK transport retries of the identical body, including the
same messages and attachment snapshot. These are not new conversation turns;
timeouts apply per attempt, and exiting cancels the request and retries.
`<update>` blocks are response
text, not function calls. Parsing them never performs I/O. The application does
not feed execution results back to the model or issue automatic follow-up requests.
The model is free to *suggest* changes; only the user can approve local writes.

The TUI retains user-selected resolved file/folder references and re-reads them
for each submission. Current contents are appended after the user message. Chat
history is kept only in memory and is not shared with the CLI session store.

Actionable targets must exactly match complete attachments from that request
inside the working directory. Truncated attachments, symbolic links, invalid
UTF-8 and failed write snapshots are read-only. Blocks must use the strict
SEARCH/REPLACE grammar; examples in Markdown fences are ignored. Each nonempty
SEARCH must occur exactly once in the original file, and edits cannot overlap.
Any invalid block or non-`stop` completion disables the whole proposal.

After a reply the TUI lists the proposed files with line counts and flags paths
that run code or change automation (CI workflows, package scripts, build files,
git hooks, shell scripts, dotfiles). `/apply` only writes files whose diff was
shown with `/review`, and can approve or reject file by file. Each diff is built
from the exact edit ranges, one section per edit with fixed context, so unchanged
lines between edits are never shown as changed and a small change cannot be
buried in a long rewrite. These diffs visibly escape
control characters rather than stripping terminal escape sequences and their
payloads: code that will be written cannot be concealed inside an OSC/DCS string.
Approval **may replace dirty or untracked files without a Git undo copy**;
unlike CLI `/write`, explicit review is the authorization. All snapshots are
preflighted first, then each file uses `src/safe-write.ts` for stale-target checks
and atomic replacement. This is not a multi-file transaction: later I/O failures
can leave earlier files written, and errors report those paths. Parent-path
replacement defenses have the same portable-filesystem limitations described below.
Review proposed edits as untrusted code and keep your own backups or commits.

OpenTUI adds a native dependency and its transitive dependencies. It is loaded
only by the Bun TUI entry point, never by the existing Node CLI. Code blocks are
rendered without Tree-sitter, so displaying an answer does not download parsers.
Network endpoint provenance and remote-HTTP protections match the CLI; exiting
the TUI cancels an in-flight completion request.
The fixed Node launcher resolves Bun to an absolute path (`ASK_BUN`, or a `PATH`
search that skips empty and relative entries and any directory inside the working
directory), then spawns it without a shell, with `--no-env-file` and an absolute
`--config=<bundled bunfig.toml>` path. This skips automatic repository/global
runtime configuration and disables runtime dependency
auto-installation. Bun's own `.env` loading is disabled, so a repository's `.env*`
files are never read, by Bun or by Ask. Use `ask-tui` or `pnpm tui`: checks inside a Bun
entry point alone cannot prevent a hook from executing before that entry point.
Direct development invocations require both `--no-env-file` and
`--config=<absolute path to src/bunfig.toml>`; never supply additional preloads
or `--env-file`.

`/new` clears model history and destroys the visible transcript's native
renderables, including previous answers and diff panels. It clears selection
while retaining the user's theme and layout preferences.

## Saved preferences

Confirming a theme in `/theme` is the only way `ask-tui` writes configuration
(previews do not). It writes only the user's global `tui.json` (or `tui.jsonc`),
never a project or `--config` file, and changes only the `theme` value,
validated as for loading. It refuses a file
that every user can write or another user owns, keeps the file's permissions
(new files are owner-only), and writes atomically. API keys are never written.

## Clipboard, usage and context popups

The TUI emits a clipboard-write OSC52 sequence only after the user invokes
Ctrl+C or Command/Super+C with a selection, or `/copy`. Copied answers are display-sanitised first; selecting text
copies the visible selection. Model responses cannot trigger clipboard writes
on their own. No external clipboard executable is launched. OSC52 support and
clipboard policy are controlled by the user's terminal/multiplexer; native mouse
selection is available with `--no-mouse` when OSC52 is unavailable.

Forwarded Command/Super+C also explicitly copies a selection (and never exits).
Ctrl+V and forwarded Command/Super+V read plain text through OpenTUI's native
host clipboard API, lazily and only in response to the user's shortcut. Reads
are limited to 1 MiB and two seconds, and cancelled on exit. No external clipboard
utility is spawned. SSH/remote sessions refuse host reads to avoid accessing the
wrong machine's clipboard; use native terminal paste instead. Native paste is
routed to the composer exactly once, using OpenTUI's ANSI-stripping paste handler.
Pasted newlines are data, not submission events. Pasted text also has any `@` that
would start a mention escaped as `\@`, so pasted code cannot attach files. Clipboard text is not sent to
the model until the user submits the prompt, and a changed draft/cursor/selection
causes a delayed host read to be discarded rather than overwriting user input.

TUI footer/sidebar usage comes from provider-reported counts. Missing usage is
not treated as zero, and partial session totals are labelled. Context-window
capacity is explicitly configured with `--context-window`, never guessed or
looked up through an additional request. When set, it bounds each request by
trimming the oldest history locally (or refusing an oversized message before
sending); it never changes server settings.

Slash completion and context-management popups are local UI actions, not model
tools. Detaching references or removing skills only changes future request
assembly; it never deletes source files or automatically calls the model. Files
excluded from an attached folder are omitted before reading/budget accounting
and cannot be actionable update targets in that request. Restoring exclusions
requires an explicit user action or a new explicit file/folder mention. Changing
context is refused while a request/write or edit proposal is pending. Removing
context cannot erase information already quoted in prior answers; `/new` clears
that conversation history.

## Skills

The TUI uses the same discovery and loader. `--skill` and `/skill <name>` are
explicit user selections; `/skills` only lists/searches locally, without a model
request. Selected instruction files are re-read on each submission, and their
actual loaded size is checked rather than trusting cached discovery metadata.
Missing or oversized files prevent the request. `/unskill <name>` removes a skill
from future system prompts; `/new` also clears selected skills. Earlier chat
answers remain after removing a skill, so start a new conversation to eliminate
that history. Skills cannot grant the model tools or bypass update validation
and user approval. Bundled scripts/assets are never executed or auto-attached.

## Supply chain

- Published separately from `@codehaus-au/ask`, so the CLI does not carry the
  TUI's dependencies. The dependency on `@codehaus-au/ask` is pinned to the exact
  version released from the same commit (pnpm rewrites `workspace:*` when
  packing); both packages are released together by the same workflows.
- Runtime dependency on `@opentui/core`, which brings native platform packages
  and transitive dependencies (see `pnpm-lock.yaml`), and requires Bun 1.3.14+.
- Releases follow the same process as the core package: SHA-pinned actions,
  a tested tarball published with provenance, an SBOM and a build-provenance
  attestation.
