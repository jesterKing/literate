# Real VS Code acceptance: LSP groups 1–4 and narrow code actions

## Latest code-action acceptance (2026-09-29)

**23/23 checks passed; exit 0, no timeout. All original 18 checks still pass unchanged.** Installed Mason CSS command actions are rejected; a controlled stdio server exercises the positive edit-only path through the real VS Code host.

Final evidence: `out/language-groups-host-xzrPg0/`:

- `evidence.json`: all 23 passing checks, exact real and controlled protocol assertions, accepted mapped edits, and before/after source.
- `server-traces.json`: TS7/CSS/HTML and controlled-server protocol streams.
- `launch.json`: source hashes, server configuration, controlled-server hash, and isolated bundle hash.
- `baseline.json`, `runner.json`, `host.log`: fixture integrity, successful process outcome and cleanup, and host output.
- After the run, every recorded top-level production source hash and the copied manifest still matched the repository.

### Deterministic real CSS probe and blocker

`node src/test/acceptance/language-css-actions-probe.js` ran the installed Mason CSS executable directly with a 15-second bound. Evidence: `out/language-css-actions-probe-weegFk/evidence.json`. This probe is separate from, and not a substitute for, the subsequent real VS Code host checks.

Fixture `.typo { colr: red; }` produces diagnostic `unknownProperties`, message `Unknown property: 'colr'`. In the host it resides in the named `css action body` fragment, separated from the root fragment by prose. The provider maps its source range back to generated `style.css`, line 1, characters 4–8, and sends an invoked quickfix request with the real diagnostic.

Both probe and host receive three legacy Commands: `Rename to 'color'`, `Rename to 'clear'`, and `Rename to 'clip'`, each with `command: "_css.applyCodeAction"` and edit-shaped arguments. The installed server's handler calls `doCodeActions`, which wraps its internal edits as Commands even when literal CodeAction support is advertised. Current production `src/language-actions.ts` intentionally rejects any `command` member and accepts only eager `WorkspaceEdit.changes` targeting the current generated document and fragment.

Thus `vscode.executeCodeActionProvider` correctly returns **no Mason CSS actions**. The test does not translate or execute `_css.applyCodeAction`. A controlled local stdio protocol fixture then returns one eager `WorkspaceEdit.changes` quick fix. Through the real VS Code provider, it maps `colr` back into the named fragment, applies only `colr` → `color`, leaves unrelated buffers unchanged, and clears its diagnostic.

### New checks and observed outcomes

- **PASS:** real CSS `unknownProperties` diagnostic maps exactly to `colr` in the current fragment.
- **PASS:** real Mason command actions are observed and rejected without mutating source or disk.
- **PASS:** the controlled edit-only quick fix maps and applies exactly one `colr` → `color` source edit, leaves unrelated buffers unchanged, permits normal generation settling, and clears its diagnostic.
- **PASS:** cross-fragment and prose requests return no actions.
- **PASS:** native `Create fragment for <<acceptance missing>>` still coexists with the language provider. Its request is read-only; applying its single source-URI edit inserts exactly `~~~ css : <<acceptance missing>>=` after the fence and clears the native diagnostic. Other buffers stay unchanged. This is a **native** fix, not a substitute for the blocked server-backed application.
- The final existing fixture-integrity check still passes: physical sources/config/templates remain byte/mtime identical. Ordinary edit-triggered generated outputs are permitted only by the original allowlist. No generated-file cleanup masks request effects.

### Isolated configuration and limitations

The CSS fixture explicitly configures `css.validate: true` and `css.lint.unknownProperties: "warning"` through the existing language-server configuration setting. Without an explicit CSS object the installed server received `null`, logged a `validProperties` error, and returned empty diagnostics; that initial run is retained at `out/language-groups-host-VBvfnC/`.

The isolated profile sets `chat.disableAIFeatures: true`. Without it, this VS Code build adds an unrelated built-in `inlineChat.start` “Fix” action to the aggregate provider results; that run is retained at `out/language-groups-host-AgXiSb/`. No provider results are filtered by the harness, and ordinary user settings are untouched.

Code-action acceptance uses the actual VS Code provider API, not the rendered lightbulb menu. Native and server providers are tested sequentially in the same host; the intentionally missing fragment invalidates language projection during the native case. Adversarial cross-file/resource operations and stale replies still require controlled headless tests. The automatic completion baseline below is historical and was **not rerun for this code-action snapshot**; the expanded suite did rerun its existing rendered signature test and all 18 original checks.

Implementation files: `language-actions-host.js` adds the action checks; `language-actions-server.js` is the controlled edit-only stdio fixture; `language-css-actions-probe.js` supplies the standalone real-server probe; the groups runner adds the named fragment and isolated configuration. No production or shared build files are written by acceptance.

## Previous groups 1–4 acceptance (2026-09-28)

VS Code **1.138.0**, installed Linux ARM64 host, actual stdio language servers:

- TS7: `/home/jesterking/.vscode/extensions/typescriptteam.native-preview-0.20260708.2-linux-arm64/lib/tsc --lsp --stdio`.
- Mason: `/home/jesterking/.local/share/nvim/mason/bin/vscode-css-language-server --stdio` and `vscode-html-language-server --stdio`.

**Final expanded suite: 18/18 passed; exit 0, no timeout.** The previous Mason CSS snippet blocker is resolved in this snapshot.

Evidence directory: `out/language-groups-host-vKuS4Q/`.

- `evidence.json`: individual checks, raw VS Code provider results, mapped navigation targets, diagnostic events/ranges, rendered signature observations, accepted CSS/HTML snippets and selections.
- `server-traces.json`: actual server stdin/stdout/stderr, including initialization capabilities and completion/resolve replies. The harness observes protocol bytes without changing them.
- `launch.json`: executable arguments, SHA-256 of every copied top-level source file and the isolated bundle.
- `baseline.json`, `runner.json`, `host.log`: physical fixture inventory, bounded process outcome/cleanup, host logs.
- Bundle SHA-256: `3a596ba2da279b6ce7f6a22daab1753645d21823ca4d28d8de8f1a080891f8b1` (identical in the successful automatic baseline).
- After both suites, all recorded top-level production source hashes and the copied `extension/package.json` still matched the repository. The copied manifest includes resource-scoped `literate.languageDiagnostics`, default `true`. Index chapter wiring is not exercised by this language-host suite.

### Passing coverage

- TS7 background diagnostic 2322 appears on cold document open (505 ms observed), before **any** completion, hover, signature or navigation provider request. It maps to `broken` in the original Markdown code fragment through a physical multiline wrapper; no generated files are created on open.
- Fixing the unsaved source clears that previously observed error. Reintroducing it two lines later updates its mapped position and retains it while idle. Unsaved wrapper-header edits preserve the original source diagnostic location. None of these diagnostic checks issue a language-provider command or move the cursor.
- Signature provider returns `greet(name: string, count: number): string`, with active second argument and safe documentation.
- Real CDP typing `(` renders the signature with active `name: string` (154 ms observed); typing `"Ada", ` switches to `count: number` (155 ms). No explicit signature trigger/provider command is used by the UI check. Auto-closing brackets/quotes are disabled in this isolated profile so source equality checks can match exactly the typed characters.
- Actual TS7 `completionItem/resolve` supplies documentation for a multiline JSDoc member. Its completion still replaces only mapped `doc`, with no command or additional edits.
- Definitions map locally, to a physical `.ts` dependency, and back into an imported `.literate` overlay. Type definition, implementation, and references map to original source; references include distinct declaration/call ranges. Generated `main.ts`/`overlay.ts` targets are rejected by the assertions.
- Mason HTML `class="$1"` survives as a real `SnippetString`, inserts exactly `class=""` into Markdown, preserves all surrounding source, and leaves the caret inside the live first tabstop.
- Mason CSS `rgb(${1:red}, ${2:green}, ${3:blue})` survives as a real `SnippetString` from a list containing safe `itemDefaults`, inserts `rgb(red, green, blue)` only into the mapped source span, and records `red` selected as the first placeholder. The existing snippet acceptance assertion passed without relaxation.
- Mason CSS command-bearing property items (including `display`) remain rejected and are never executed, even though safe list defaults are now supported.
- Provider queries preserve disk inventory and document text/version. Normal edit-triggered generation is allowed only for named fixture outputs, never cleaned to conceal language-request side effects. Physical source/dependency/template/config files remain byte/mtime identical.

### Resolved previous blocker: Mason CSS snippets

The final CSS value fixture receives and successfully accepts this real server snippet (range omitted here; full reply is in `server-traces.json`):

```json
{
  "label": "rgb",
  "textEdit": {
    "newText": "rgb(${1:red}, ${2:green}, ${3:blue})"
  },
  "insertTextFormat": 2
}
```

The enclosing completion list contains `itemDefaults.editRange` even though the item has an explicit `textEdit.range`. Previously, rejecting the entire list caused `Missing rgb` in `out/language-groups-host-46Amon/`. With the production owner's safe-defaults support, **“style.literate real Mason snippet completion and mapped snippet insertion” now passes**. The observed source is `color: rgb(red, green, blue);`; the recorded selection spans `red` (zero-based line 4, characters 15–18). No production changes were made by this acceptance rerun.

## Automatic completion UI baseline

**12/12 existing assertions passed**, exit 0, no timeout.

Final passing evidence: `out/language-auto-host-sXqtV5/` (`evidence.json`, `launch.json`, `server-traces.json`, `runner.json`, `host.log`).

This used the exact same isolated extension under `out/language-groups-host-vKuS4Q/extension` as the final expanded suite; both launch records contain the identical bundle SHA-256. It exercised real keyboard input and rendered suggestions: cold constructor `this.`, filtering `li`, Enter acceptance, method completion, quiet prose/header/tag/ordinary Markdown, cursor/focus/Escape cancellation, resource opt-out, and unchanged physical fixtures.

The first baseline attempt on this same snapshot, `out/language-auto-host-8uxdrB/`, exited 1 after an editor-focus setup failure in the fence-header case and a subsequent reset failure. Its evidence and host log are retained. One bounded rerun with identical arguments and no harness changes passed all 12 assertions. This focus-dependent failure is not concealed by the final passing result.

`LANGUAGE_AUTO_HOST_DIAGNOSTICS=false` was explicit in this baseline, preserving the existing assertion that **first typing launches a cold server**. Default-enabled background diagnostics are covered separately in the expanded suite. This is not evidence that completion and diagnostics work concurrently under every timing interleaving. Existing baseline assertions were not weakened.

## Reproduce

From the repository root:

```sh
node src/test/acceptance/language-groups-host-run.js
```

The runner snapshots current sources, verifies they did not change during the build, and bundles only inside a fresh `out/language-groups-host-*/extension`. It does not run a shared build, generate production sources, install/download anything, or modify ordinary VS Code profiles. Optional absolute executable overrides: `LANGUAGE_GROUPS_CODE`, `LANGUAGE_GROUPS_TYPESCRIPT`, `LANGUAGE_GROUPS_CSS`, `LANGUAGE_GROUPS_HTML`.

To rerun the automatic UI baseline against a built isolated snapshot, set:

```sh
LANGUAGE_AUTO_HOST_EXTENSION=/home/jesterking/dev/li/worktrees/literate/waxen-sequoia/literate/out/language-groups-host-vKuS4Q/extension LANGUAGE_AUTO_HOST_DIAGNOSTICS=false LANGUAGE_AUTO_HOST_TYPESCRIPT=/home/jesterking/.vscode/extensions/typescriptteam.native-preview-0.20260708.2-linux-arm64/lib/tsc LANGUAGE_AUTO_HOST_TYPESCRIPT_ARGS='["--lsp","--stdio"]' node src/test/acceptance/language-auto-host-run.js
```

Both launchers bound execution, terminate their owned process groups, and remove isolated profiles/extensions directories while retaining fixtures, bundle snapshots and evidence. CDP binds to loopback and is used only during the isolated run. Do not run UI suites concurrently: they require workbench focus.

## Scope and limitations

- Only `src/test/acceptance/language*` source/docs were edited. The latest code-action extension preserves all original assertions and adds five checks. Shared `out/main.js` and production sources were not written. Parallel work was left untouched; no commit was made.
- Navigation is tested through actual VS Code provider commands, not the rendered peek/go-to interface. Signature UI is warm-server; cold signature UI is not claimed.
- No hover is used anywhere in the expanded suite. Diagnostic idle retention is sampled for two seconds, not a long-duration soak.
- Real servers are not adversarial fixtures: stale/malicious replies, cancellation races, untrusted workspace behavior, and snippet security policy need separate headless tests.
- The existing TS/Zig hover harness was read and left unchanged, but not rerun here; this task's evidence is TS7 plus Mason CSS/HTML and the automatic UI baseline.
- Evidence under `out/` is local/untracked. Earlier run directories include fixture-development failures (not additional production findings): an HTML output collision, inline JSDoc without server documentation, an unsuitable CSS context, and auto-closing bracket behavior.
