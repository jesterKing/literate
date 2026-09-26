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
Many publication tests are also generated from their owning `.literate` chapters;
`literate/publication-screen.literate` owns the HTML/preview/publication integration
tests. Edit those chapters rather than their generated test files. Other tests and
configuration remain ordinary files. Interleave prose with focused
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
still explicitly unsupported by LaTeX export. The screen integration boundary and
M1 acceptance assessment below do not broaden this PDF fixture's guarantees.

## M1 acceptance review

M1 is complete **for the documented supported-subset CLI LaTeX export**, not a
universal book/layout or screen-parity guarantee. Work items 1–7 supply the shared
parsed model/identity policy, controlled Pandoc bridge, styled book renderer,
page references, geometry and transactional portable font companions. Work item 8
is covered by the integration chapter described below; dependencies, commands,
errors and limits are documented here and in README (work item 9). No whole-screen
migration, automatic PDF compilation, extension export action or Mermaid support
is included in this sign-off.

Acceptance criteria, with their evidence and bounds:

1. **Definitions, multiple additions, repeated/cross-chapter references:** the
   publication/model and LaTeX tests cover logical destinations and navigation.
   The portable A4/A5 fixture checks 95 semantic labels and 13 visible linked page
   numbers in each PDF, including the base and two additions.
2. **Escaped tags and highlighter safety:** semantic ranges are bound before
   highlighting; emitter shape/version/reconstruction checks prevent highlight
   output from inventing references. Literal/TeX-safety tests and real-Pandoc
   integration check that only genuine uses produce reference commands. This
   criterion holds for publication, **not visual screen decoration**: the latter
   still decorates escaped tags and is explicitly recorded as an M2 gap.
3. **Unicode, metacharacters, long names, inline positions, indentation and blank
   lines:** automated source/rendering tests plus PDF fixture checks cover these
   cases. Unicode remains font-dependent (Greek is tested in Lilex code, not
   unsupported Latin Modern prose); ligature-enabled copying is not lossless.
   Names beyond 512 code points are rejected, not claimed to fit.
4. **Paper/margin changes update pagination:** A4/20mm and A5/asymmetric margins
   produce 11 and 15 pages; the shared definition moves from page 2 to 3 and the
   final addition from page 11 to 15, with automatically updated page links.
5. **Successful compilation has no unresolved references, clipped fixture code
   or orphaned fragment headings:** final fixture logs are clean; destination,
   bounding-box and 36 heading-boundary checks pass. The 140-line contribution
   spans four pages in each layout. This is bounded fixture acceptance with
   sampled visual review, not proof for every heading/page arrangement, reference
   taller than a page, or unbreakable prose inline-code token.
6. **Tangling and self-hosting:** no tangling/runtime implementation changes are
   needed for this final integration slice. A byte-exact source-output oracle,
   existing engine regressions, full tests and `check:self` protect generation.
   New tests and chapter HTML are regenerated from the authoritative book.
7. **No TeX dependency during export:** the production converter invokes Pandoc
   only; LaTeX generation and headless tests run without invoking a TeX engine.
   PDF compilation belongs solely to the explicit developer harness/commands.
8. **Failure preservation and portable output:** CLI/font/transaction regressions
   cover diagnostics, process failures, protected paths, staging and rollback.
   The PDF harness relocates unmodified TeX and font/license bytes and verifies
   unchanged re-export. Packages still need installation; this host's disclosed
   local `ulem` workaround is not a shipped companion. Images, tables, raw author
   tokens and Mermaid fail explicitly rather than being silently omitted.

No further M1 task is identified within those bounds. Universal Unicode/layout
acceptance and clean-machine compilation without prerequisites remain unproven,
not implicitly accepted. Supported assets currently mean explicit font/license
companions; general publication images/diagrams remain later work. A complete
term/index or note-column layout is not implemented; a separate note-font role
reserves styling without claiming those features.

### Screen integration regression

`literate/publication-screen.literate` tangles
`src/test/headless/publication-screen.test.ts`. It calls `generateProject` for
HTML and `activate(...).extendMarkdownIt(...)` for preview, using the existing VS
Code API fixture and actual Markdown-it/highlight.js rendering. It checks
independent expected labels, bodies, source-token maps, chapter order, additions,
repeated/collision-distinct references, unchanged tangling and identity stability
across prose shifts. Opt-in cases use `renderLatex` with the real `runPandoc`
adapter and decode emitted LaTeX labels/reference destinations back to logical IDs.
Neither a fake renderer nor equality of two publication snapshots substitutes for
rendered-output assertions.

The mapping is canonical document + contribution token index → emitted fragment
block → contribution target → family target. Screens currently have **no fragment
IDs or links**, so this is a source/model correspondence, not clickable target
parity. Tests also expose literal-tag decoration and the compact `js:` delegated
language discrepancy. M2 must replace these explicit boundary assertions when
adding semantic links and normalizing host language info. The plugin test does
not run a VS Code host, test browser clicks, or prove full editor synchronization.

Reproduce the focused and full gates (the latter includes real Pandoc lifecycle
deadlines and generated-file checks):

```sh
yarn generate
yarn compile
LITERATE_TEST_PANDOC=1 node --test out/test/headless/publication-screen.test.js
LITERATE_TEST_PANDOC=1 LITERATE_TEST_PANDOC_LIFECYCLE=1 yarn test
yarn check:self
yarn esbuild
yarn check:generated
git diff --check
```

Portable PDF acceptance is a separate, opt-in `yarn test:publication` run as
specified above; do not describe a headless-suite pass as a fresh PDF build.

The 2026-09-26 integration sign-off ran all seven new integration cases and the
full real-Pandoc/lifecycle suite: **771 passed, zero failures or skips**. Self-host
layout/typecheck/bundle/fixedpoint, extension/preview bundles, generated checks and
whitespace checks passed. A fresh portable acceptance run also passed both A4/A5
fixtures with the counts above and clean final logs, using the explicitly supplied
local font manifest and disclosed `ulem` workaround. No new visual inspection or
clean-machine/font-independent compilation is claimed by this run.

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
