# Security policy

## Reporting a vulnerability

Email **mat@codehaus.co** with the details. Please do not open a public issue
for anything exploitable. Expect an acknowledgement within a few working days.

## Threat model

`ask` sends the file contents you name to a third-party LLM endpoint. That is
its whole purpose, so the security properties worth stating are about what it
will *not* do.

### What the tool guarantees

| Guarantee | Enforced by |
| --- | --- |
| No tool / function calling is ever requested | `OneShotRequest` in `src/chat.ts` is the SDK params type with `tools`, `tool_choice`, `functions`, `function_call`, `parallel_tool_calls`, `stream` removed — setting one is a compile error |
| One completion per CLI invocation or TUI submission | No model-driven execution loop; TUI SDK retries are disabled; asserted in chat/controller tests |
| Only one SDK method is reachable | `createClient` returns a one-method `ChatClient`, not the SDK client |
| The model cannot choose what it reads | Context comes only from `@paths` and `-f` flags you pass |
| Nothing is written to your source tree unless you authorize it | CLI `/write` and `/create` explicitly name targets. TUI `<update>` proposals require diff review and `/apply`; session storage is separate |
| Git is the CLI's only subprocess executable | `src/git.ts` centralises hardened metadata/diff calls; fsmonitor, optional index writes, lazy fetches and configured diff/filter execution are disabled |
| Credentials are not attached by accident | `.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa`, `credentials.json` and similar are skipped even when named explicitly, unless `--include-secrets` |
| You can see the payload before sending | `--dry-run` prints the exact JSON body; `--show-context` lists attachments and never calls the API |

### What it does not protect against

- **Data egress is the point.** Anything you attach reaches the configured
  endpoint. Check your provider's retention and training terms, and prefer an
  endpoint your organisation already approves via `OPENAI_BASE_URL`.
- **Prompt injection in attached files.** Terminal control sequences are
  sanitised for display, but the model can still produce misleading advice or
  unsafe code. Treat a review of untrusted code as untrusted output, and never
  pipe it into a shell.
- **Binary and minified content.** Skipped by heuristics (extension list, NUL
  byte sniffing), not guarantees. Use `--show-context` when in doubt.
- **Secret detection.** The credential filter is filename-based. It will not
  catch a key pasted into `src/config.ts`.

## TUI update proposals

`ask-tui` uses the same tool-free request type as the CLI. It sends one completion
per user submission, with SDK retries disabled. `<update>` blocks are response
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

The TUI shows proposed diffs before enabling `/apply`. These diffs visibly escape
control characters rather than stripping terminal escape sequences and their
payloads: code that will be written cannot be concealed inside an OSC/DCS string.
Approval applies the whole
pending batch and **may replace dirty or untracked files without a Git undo copy**;
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
The fixed Node launcher spawns Bun with `--no-env-file` and an absolute
`--config=<bundled bunfig.toml>` path. This skips automatic repository/global
runtime configuration and disables runtime dependency
auto-installation. Repository `.env*` values cannot masquerade as trusted exports
before Ask enforces its allowlist. Use `ask-tui` or `pnpm tui`: checks inside a Bun
entry point alone cannot prevent a hook from executing before that entry point.
Direct development invocations require both `--no-env-file` and
`--config=<absolute path to src/tui/bunfig.toml>`; never supply additional preloads
or `--env-file`.

`/new` clears model history and destroys the visible transcript's native
renderables, including previous answers and diff panels. It clears selection
while retaining the user's theme and layout preferences.

## Shell completion and hints

The `@` widget and TAB completion explicitly quote selected filenames for Bash
rather than relying on readline's incomplete default filename quoting. TAB handles
Bash's native `@` word breaks, and both entry paths decline quoted/nested shell
contexts rather than evaluating them. fzf candidate streams are NUL-delimited,
including Git's `-z` output, so filename quotes/backslashes/newlines remain data.
Interactive regression tests press TAB and ENTER in a real Bash PTY and verify
the received arguments and absence of command-substitution side effects.

## Git subprocesses

All CLI Git commands use an argument-array wrapper with `--no-pager`,
`--no-optional-locks`, `--no-lazy-fetch`, `--literal-pathspecs`, and
`-c core.fsmonitor=false`. The child environment discards all inherited `GIT_*`
overrides (including alternate index/worktree locations), loader variables such
as `LD_*`/`DYLD_*`, shell startup variables, `NODE_OPTIONS`, and Ask/OpenAI
configuration. Only known-safe Git controls are reintroduced. Shell completion
uses equivalent restrictions in a subshell, leaving the interactive environment
unchanged. The Git executable selected by the user's `PATH` is trusted; this is
not a sandbox for a substituted Git binary.

`git status` is not used for write safety: it can run clean/process filters even
with fsmonitor disabled. The check compares HEAD/index object IDs and modes,
verifies that the undo blob exists locally, and hashes raw worktree bytes in
process. Missing promisor objects never trigger fetching or remote helpers.
Filtered/CRLF-normalised files are conservatively considered dirty if raw bytes
differ from the stored blob; no configured transformation is executed to decide.

Diff previews use `--no-index --no-ext-diff --no-textconv` plus an explicit null
Git directory and null attributes file, with system attributes disabled. This
isolation is necessary because `--no-index` alone still consults attributes and
can run clean/process filters. Only exit code 1 is accepted as a normal differing
patch; other failures do not emit arbitrary partial stdout as a valid diff.

Git must support the safety options, including `--no-lazy-fetch`. Older or
unavailable builds fail closed rather than retrying without those options.
Tests exercise malicious configuration with harmless marker programs, check
that helpers stay unexecuted, and verify that read-only queries leave index
contents and modification time unchanged.

## Context paths

File and directory references are canonicalised before reading or walking them.
A symlink that redirects outside the canonical working directory is skipped,
including a link in a parent component or an explicitly referenced directory.
Credential-name filtering checks both the supplied path and the canonical target.
`--include-secrets` bypasses only that filename filter, not symlink containment.
Explicitly named outside paths without redirecting links remain supported.
Directory walks continue to skip nested symlink entries.

Canonicalisation failures do not fall back to the unchecked lexical path. Files
are opened by canonical name with `O_NOFOLLOW` where available; their type and
device/inode identity, along with path resolution, are checked before reading
through the same handle. Detected replacements are skipped. These checks reduce
replacement races but are not a filesystem sandbox against a process actively
swapping parent directories throughout validation; portable Node APIs do not
provide an atomic directory-relative containment primitive.

## Terminal output

Answers, compacted summaries and diff previews shown on a TTY have ESC/C1 control
sequences removed before the CLI adds its own ANSI styling. This includes OSC
clipboard/title/hyperlink operations and CSI cursor/erase operations. `--raw`,
`--no-color` and `NO_COLOR` do not disable sanitisation. Single-line metadata and
diagnostics visibly escape control characters, including embedded line breaks;
Unicode direction-format controls are made visible as well. Spinner labels are
escaped separately from the spinner's trusted erase sequence.

Redirected answers and patches remain unrendered and unsanitised, including when
`FORCE_COLOR` is set. They remain untrusted if later displayed or executed by
another program. JSON displayed on a terminal escapes DEL/C1 and Unicode format
controls in addition to JSON's standard C0 escapes, preserving parsed values.
Session storage, API payloads and file writes retain the original data: escaping
is a presentation boundary, not a rewrite of the model's answer or source files.

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
Pasted newlines are data, not submission events. Clipboard text is not sent to
the model until the user submits the prompt, and a changed draft/cursor/selection
causes a delayed host read to be discarded rather than overwriting user input.

TUI footer/sidebar usage comes from provider-reported counts. Missing usage is
not treated as zero, and partial session totals are labelled. Context-window
capacity is explicitly configured with `--context-window`, never guessed or
looked up through an additional request; it is display-only.

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

`--skill <name>` reads a `SKILL.md` from disk and appends it to the system
prompt. Two things follow from that:

- **A skill changes how the model behaves**, so treat a skills directory like
  code you run: review a skill before using it, particularly one you did not
  write. `ask --dry-run` prints the exact system prompt that will be sent.
- **Only `SKILL.md` is read.** Bundled scripts and assets are never executed or
  uploaded; nothing in a skill can cause `ask` to run a command. Skills are
  chosen by the CLI, never by the model — a model that could load a skill on
  demand would be making a tool call.

Skills are capped at 128 KB each. Discovery and loading read regular files through
a bounded buffer, at most 128 KB plus one overflow-detection byte; growing files
cannot defeat the bound. Oversized files can be listed by their bounded metadata
prefix but cannot be submitted. The CLI reports selection on stderr so an inexact
match cannot silently change the instructions.

The TUI uses the same discovery and loader. `--skill` and `/skill <name>` are
explicit user selections; `/skills` only lists/searches locally, without a model
request. Selected instruction files are re-read on each submission, and their
actual loaded size is checked rather than trusting cached discovery metadata.
Missing or oversized files prevent the request. `/unskill <name>` removes a skill
from future system prompts; `/new` also clears selected skills. Earlier chat
answers remain after removing a skill, so start a new conversation to eliminate
that history. Skills cannot grant the model tools or bypass update validation
and user approval. Bundled scripts/assets are never executed or auto-attached.

## Session data at rest

Interactive runs keep a conversation thread so follow-ups need no `@references`.
This is the tool's only persistent state, and its only write.

- **Location**: `$XDG_STATE_HOME/ask/sessions/<hash>.json` (or `ASK_STATE_DIR`),
  deliberately outside any repository. Mode `0600`, directory `0700`.
- **Contents**: your questions, the `@refs` as typed, and the model's answers.
  **Not** file contents — those are re-read from disk for each request, so the
  thread never becomes a second copy of your source.
- **Never attachable**: `.ask/` is in the skip rules and the state directory
  lives outside the tree, so a session cannot be fed back in as context.
- **Expiry and pruning**: idle threads are discarded after 2 hours
  (`ASK_SESSION_TTL`); oldest turns are dropped past 32k tokens.
- **Compaction**: `ask /compact` sends the thread to the model once and replaces
  it with the summary. The prior thread is kept alongside as
  `<hash>.pre-compact.json`, same permissions, removed by `ask /new`.
- **Clearing**: `ask /new`, or delete the files. `--no-session` / `ASK_SESSION=0`
  disables the feature entirely; piped and scripted runs never use it.

Sessions do not change the one-request property: each invocation still issues
exactly one chat completion, with no tools.

## Writing to a file

`--write` is the only feature that modifies your source tree, and it is opt-in
per invocation. The model is not given a tool and does not choose to write: it
returns text, and the CLI writes that text to the one file you attached, after
checks that fail closed.

The checks exist for specific failure modes rather than as ceremony:

- **A truncated response is refused outright** (`finish_reason: length`). Writing
  one would silently remove the end of the file.
- **A file truncated by the context caps is refused**, because the model never
  saw the part it would be deleting.
- **A response under 25% of the original size is refused**, which catches a model
  answering with a fragment or a comment instead of the file.
- **The file must match HEAD and the index without transformations**, with a
  local undo blob available. Raw bytes (and executable mode on POSIX) are checked
  without invoking filters. `--force` bypasses this, at which point recovery is
  your responsibility.
- **The target is named, not inferred.** `/write <path>` states which file is
  being replaced; other attached files are read-only references. A target that
  does not exist, is not a regular file, or was excluded by the skip rules is
  refused before the request is sent.
- **Symlink targets and symlinked parents are refused**, including dangling links
  and links to files inside the repository. `lstat` distinguishes the link from
  its referent. An already-symlinked cwd/shared ambient ancestor is canonicalised
  rather than treated as a target-path link. `--force` cannot bypass this check.
- **The target is revalidated against a snapshot.** Device/inode identity, version
  metadata, parent-directory identities and exact context bytes are checked before
  the request and again afterwards. A newer edit, replacement, deletion or link
  swap is refused, even if the response is unchanged or Git reports a clean file.

Writes use a same-directory, exclusively created staging file, then revalidate
the target before renaming the completed file over its directory entry. Opening
the original never uses `O_TRUNC`; no-follow flags are used where supported.
Staging failures leave the original intact. A final-component symlink appearing
in the last validation/rename gap is replaced rather than followed. Ordinary
permissions and ownership are preserved, set-ID bits are dropped, and other hard
links keep the old contents. ACLs and extended attributes are not copied.

The final validation and rename are not an atomic compare-and-swap. As with
context collection, portable Node APIs do not guarantee safety against a process
actively swapping parent directories throughout the operation. Temporary-file
cleanup is best effort if a parent is moved or the process is interrupted.

`--diff` performs the same request and prints a patch without writing, which is
the safe way to inspect an edit first. It uses private copies of the captured
original and proposed contents rather than asking Git to reopen the target path.

`/create <path>` writes a *new* file. git is not the safety net there because
creating destroys nothing; instead the path must not already exist, parent
directories are never created implicitly, and the write uses an exclusive-create
flag so a file appearing between the check and the write cannot be overwritten.
A truncated or empty response is refused as above.

## Key handling

Automatically discovered `.env` files are restricted to `OPENAI_API_KEY`,
`OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, and `ASK_MODEL`, including
files found relative to the install location. They cannot inject arbitrary
subprocess environment variables or redirect session/skill storage. Duplicate
canonical paths are loaded once; when loader candidates have different policies,
their allowlists are intersected before any values are applied. Ignored keys are
reported by name only. Explicitly exported shell variables retain precedence.

Before a normal request or `/compact`, the CLI refuses an endpoint sourced from
an automatic `.env` file unless `--base-url` explicitly selects the destination.
An exported `OPENAI_BASE_URL` also takes precedence over file values. The refusal
applies whether the file supplies a key, the key comes from the shell or CLI,
or a local endpoint needs no key: choosing a key does not authorize sending code
or history to a repository-selected destination. Offline previews do not send
requests and remain available.

Both request paths also refuse a non-loopback `http://` endpoint before creating
the API client. HTTPS and recognised loopback HTTP endpoints are allowed.
`--allow-insecure-http` explicitly opts a single invocation into cleartext
transport; it does not bypass the `.env` endpoint-source check. Offline previews
remain available for inspecting requests without sending them.

`OPENAI_API_KEY` is read from the environment or a local `.env`, which is
gitignored. The key is only ever sent to the configured endpoint as an
`Authorization` header, is never logged, and never appears in `--dry-run` or
`--json` output.

## Supply chain

- Release Please uses the built-in `GITHUB_TOKEN` to maintain a version/changelog
  PR on `main`. Merging that PR creates the version tag and GitHub Release. A
  separate job with `actions: write` explicitly dispatches publication at that
  tag; it has no npm token. The GitHub Release exists before npm publication, so
  the tagged publication workflow's result determines whether publication and
  artifact upload completed.
- `@codehaus-au/ask` is published to npm from version-tagged GitHub Actions runs.
  The granular `NPM_TOKEN` repository secret is mapped to `NODE_AUTH_TOKEN` only
  for publishing the already built and installation-tested tarball. Lifecycle
  scripts are disabled in that step, the destination registry is explicit, and
  npm provenance is generated using the job's OIDC permission. The same tarball
  is attached to the GitHub Release. Manual runs on branches perform validation
  and a dry-run without an npm publishing secret; version-tagged runs may publish.
- Two runtime dependencies, pinned by `pnpm-lock.yaml`: `openai` (the official
  SDK) and `marked` (markdown parsing for terminal rendering, itself
  dependency-free). Neither has transitive dependencies, so the whole tree is
  three packages and readable.
- All GitHub Actions are pinned to commit SHAs, with Dependabot keeping them
  current.
- CI runs `pnpm audit`, Trivy (vulns, secrets, misconfig), TruffleHog over full
  git history, CodeQL, actionlint and zizmor. Releases carry a CycloneDX SBOM
  and a signed build-provenance attestation.
