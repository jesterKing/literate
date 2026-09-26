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
`src/self-hosting.ts`, `src/symbols.ts`, `src/themes.ts`, `src/output-transactions.ts`,
and `src/mermaid-preview.js` are generated;
commit them together with their literate sources and rendered HTML.
Tests and configuration remain ordinary files. Interleave prose with focused
fragments: at most one function per fragment where practical, splitting larger
functions into named steps. Aim for roughly 10–25 lines per code block; review
blocks approaching 30 lines for a useful conceptual split. This applies to data
catalogues and stylesheets as well as functions. Diagram source is different:
judge the rendered diagram's readability rather than its fence length.

Let the prose lead: introduce the problem, explain the design choice or invariant,
then show the fragment that implements it. Connect each step to what comes next.
Do not merely split blocks to meet a line count or narrate every statement. The
chapter should read as a knowledge book, not a source listing with captions.

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

## Opt-in portable publication acceptance

Normal `yarn test` needs neither TeX nor fonts. For a real production-CLI export,
relocation, compilation and PDF inspection run:

```sh
yarn test:publication --font-manifest /absolute/path/to/font-project/fonts.json
```

This developer harness requires Python 3 (standard library only), Node, Pandoc,
`latexmk`, LuaLaTeX, the packages listed in README, and Poppler's `pdfinfo`,
`pdftohtml`, `pdftotext`, and `pdffonts` on PATH. The supplied version-1 manifest
must sit at its font project's root, with paths relative to that directory.
Supply the default Latin Modern Roman, Monofur Nerd Font and **native four-face
Lilex Nerd Font** mappings and licenses; this is a deliberately font-specific
acceptance fixture, not a test of arbitrary font substitutions. No fonts are
searched for, downloaded, installed or included in the repository.

If the host lacks `ulem`, `--ulem /absolute/path/to/ulem.sty` explicitly copies an
existing local package into each compile directory. It is a disclosed local
TeX dependency workaround, not an exporter companion. Nothing is installed
globally. The harness uses private TeX caches, disables shell escape, imposes
subprocess timeouts, and compiles only its generated trusted fixture. Do not use
Python's `-O` mode: acceptance checks use assertions.

Each run creates and prints a fresh ignored `out/layout-acceptance-*` directory.
It retains fixture inputs, export/re-export JSON, byte-identical relocated TeX
and font/license companions, build/final logs, PDFs, Poppler XML/text/font/link
evidence, and (on success) `acceptance.json`. Failed runs remain available for
diagnosis. The CLI itself still never invokes TeX; the harness explicitly runs
`latexmk -lualatex -interaction=nonstopmode -halt-on-error -file-line-error
-no-shell-escape book.tex` after export and relocation.

Checks cover A4/20mm versus A5/top18/right16/bottom22/left20mm, different pagination
and updated reference pages, nested list/quote contributions, 36 short fragment
heading boundary samples, a 140-line breakable block, long names/tokens, repeated
and cross-chapter references, two additions, explicit blank lines and indentation,
literal escaped tags, adversarial TeX-looking text, native italic comments, all
four embedded Lilex faces, companion/input hashes, unchanged re-export, destinations
and visible linked page numbers. Missing glyphs, warnings and over/underfull boxes
fail acceptance. Text bounding boxes check width and code height with a 4pt
allowance for microtype protrusion/Poppler rounding. PDF action parsing is specific
to these LuaTeX fixtures, not a general PDF parser. Visual review remains useful;
for example `pdftoppm -f 2 -l 3 -scale-to 1200 -png book.pdf review`.

This is bounded fixture acceptance, not a universal pagination or Unicode claim.
Latin Modern Roman lacks Greek lambda; the fixture tests Greek in Lilex code and
accented Latin in prose. Long unbreakable **inline prose code** can still overrun
(Pandoc's `texttt`), unlike breakable fenced code. Ligatures remain enabled and
PDF copying is not source-lossless. The harness does not test every palette,
font, supported geometry, maximum-length heading at every page position, or a
reference taller than a page. The repository's Mermaid-containing full book is
still explicitly unsupported by LaTeX export; HTML/preview publication-target
integration and final milestone sign-off are separate work.

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
After installing dependencies, select **Run Extension** and press **F5**.
Its prelaunch task uses the default **Build extension and preview** task to run
`yarn generate && yarn compile && yarn esbuild` from the repository root. This
regenerates sources from the authoritative book, type-checks them, and builds both
`out/main.js` and `out/mermaid-preview.js` before launching. The task finishes;
no watcher or separate manual bundle build is required. **Extension Tests** uses
that same default build task.

Ordinary edits need one generation pass. When changing the generator itself, also
run `yarn literate self-check` after generation to verify the rebuilt engine's
fixed point, as described above.

Contributed commands and views activate the extension implicitly on the supported
VS Code versions (1.96 and newer). The `markdown.markdownItPlugins` contribution
is retained so Markdown preview can load the extension's Markdown plugin.

Use a disposable workspace in the Extension Development Host and associate
`*.literate` with Markdown.

The CLI reads disk, while the extension uses unsaved editor buffers. Do not run
both generators concurrently against the same project. Referenced template edits
and external input changes now trigger generation; filesystem events are debounced.
Use `Literate: Process` to explicitly refresh a project at any time.
