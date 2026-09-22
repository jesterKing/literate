# Developing Literate

Use Node.js 22 LTS, Corepack, and the Yarn version pinned in `package.json`.
If Corepack is unavailable, install it with `npm install --global corepack`, then
run `corepack enable`. Do not install a global TypeScript compiler.

```sh
yarn install --immutable
yarn literate generate
yarn test
yarn esbuild
```

## Edit the book, then generate

The authoritative implementations are in `literate/*.literate`.
`src/extension.ts`, `src/grabber.ts`, `src/engine.ts`, `src/cli.ts`,
`src/self-hosting.ts`, `src/symbols.ts`, and `src/mermaid-preview.js` are generated;
commit them together with their literate sources and rendered HTML.
Tests and configuration remain ordinary files. Interleave prose with focused
fragments: at most one function per fragment where practical, splitting larger
functions into named steps. Explain intent and constraints rather than narrating
every statement.

- `yarn build:cli`: bootstrap from generated CLI sources without compiling the extension.
- `yarn build:preview`: bundle the pinned Mermaid dependency and browser preview client locally.
- `yarn esbuild`: build both the extension and browser preview bundles.
- `yarn watch:preview`: rebuild the browser bundle while editing its generated entry (run generation after editing the chapter).
- `yarn literate inspect [root] --json`: locate fragment definitions, references, and outputs.
- `yarn literate generate [root]`: build the CLI, validate, and write changed outputs.
- `yarn literate check [root]`: build the CLI and check outputs without writing.
- `yarn literate self-check [root]`: check current outputs, type-check fresh sources,
  and verify a rebuilt engine reproduces the output. Trusted self-hosting projects only.
- `yarn generate` / `yarn check:generated` / `yarn check:self`: convenience aliases.
- All commands support `--json` for structured results and errors.
- `yarn test`: compile, lint, run headless regression tests, and check generated files.
- `yarn test:extension`: build and run the existing VS Code host test runner
  (may download VS Code and requires a display).

When changing the generator, generate first, then run `yarn literate self-check`
to explicitly verify the fresh sources and the engine's generation fixed point. Review
all generated diffs. Prose-only changes should not change generated TypeScript.

The full workflow and limitations are documented in
[Developing this literate program](literate/development.literate).

## Line endings across platforms

Use **LF on every platform**, including Windows. `.gitattributes` controls Git's
text normalization and checkout line endings; `.editorconfig` supplies matching
UTF-8/LF defaults for supporting editors, and `.vscode/settings.json` sets VS Code's
`files.eol` directly. VS Code does not need an EditorConfig extension just for this
setting. Existing CRLF files may retain their detected ending: use the status-bar
line-ending selector to convert those files to LF before saving.

The shared generator normalizes final source and HTML output to LF, including
source and HTML templates. CLI and extension writes use those same bytes, not the
operating system's newline convention. Generated-file checks deliberately compare
bytes, so a CRLF generated file is stale even if Git hides that difference.
Do not edit generated files to fix this: run `yarn literate generate`.

To investigate a checkout with noisy diffs:

```sh
git status --short
git ls-files --eol
git diff --ignore-space-at-eol
git config --show-origin --get core.autocrlf
git config --show-origin --get core.eol
```

`i/lf` and `w/lf` mean LF in the index and working tree respectively; `w/crlf`
or `w/mixed` identify files needing attention. An unset Git setting produces no
output and exit status 1. The committed `eol=lf` attribute takes precedence over
`core.autocrlf` for matching text files, so no global Git configuration change is
required.

If an older branch has CRLF stored in Git, first commit or back up all real work,
then normalize the index once from the repository root:

```sh
git add --renormalize .
git diff --cached --stat
git diff --cached --ignore-space-at-eol
```

Review before committing this as a separate normalization-only change. This stages
tracked file contents as well as normalizing them, so do not run it over unrelated
uncommitted edits. It does not rewrite existing working-tree files. For an old
checkout that still contains CRLF, a fresh clone after committing the attributes
is the safest way to get a fully LF working tree; preserve any untracked files
before retiring the old checkout. Avoid destructive resets as a line-ending fix.

## Debugging in VS Code

Disable the published Literate extension if installed to avoid conflicts. Do not
regenerate this book with the old generator: the new chapters use explicit literal
delimiter escapes that require the shared engine. Bootstrap with the CLI first.
Run `yarn esbuild-watch`, then select **Run Extension** and press **F5**.
The current F5 prelaunch task compiles TypeScript but does not rebuild the bundle.
Use a disposable workspace in the Extension Development Host and associate
`*.literate` with Markdown.

The CLI reads disk, while the extension uses unsaved editor buffers. Do not run
both generators concurrently against the same project. Template-only edits in
VS Code currently need `Literate: Process`.
