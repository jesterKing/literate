# Developing Literate

Use Node.js 22 LTS (>=22.12), Corepack, and the Yarn version pinned in `package.json`.
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
`literate/publication-screen.literate` owns `src/publication-screen.ts` and the
HTML/preview/publication integration tests. Edit those chapters rather than their generated test files. Other tests and
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
diagnosis. The `latex` CLI command never invokes TeX; this historical relocation
harness explicitly runs
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
reference taller than a page. Full-book Mermaid export is covered separately by
M3 below. The screen integration boundary and historical M1 acceptance assessment
do not broaden this PDF fixture's guarantees.

## Opt-in portable image acceptance

```sh
yarn test:assets --font-manifest /absolute/path/to/font-project/fonts.json \
  --ulem /absolute/path/to/existing/ulem.sty
```

The optional `--ulem` and explicit local font manifest use the same contract as
`test:publication`. This harness additionally requires `pdftocairo` and `pdftoppm`.
It creates trusted wide/tall vector PDFs and real PNG/JPEG fixtures, exports with
the production CLI/Pandoc, checks deduplication and unchanged re-export, moves the
export directory and hides source images before LuaLaTeX compilation. No browser,
font, package or host installation is performed. All subprocesses have timeouts.

Evidence is retained in a fresh ignored `out/assets-acceptance-*`: export JSON,
relocated PDFs/TeX/companions, final logs, Poppler XML, per-figure SVG and 144-dpi
PPM measurements, and `acceptance.json`. Both A4 and A5 use asymmetric
18/16/22/20 mm margins. Checks cover plain and list/quote-contained figures,
10:1 wide and 1:15 tall aspect ratios, body bounds, reduced nested width,
caption/figure co-location, no vector rasterization, and clean final compiler
logs. A separate oversized-caption fixture must fail with the explicit caption
budget error rather than producing clipped output. Pixel measurements allow rounding tolerance; this is a bounded fixture,
not a general PDF parser or proof for arbitrary image contents or captions.
A full-height figure may leave a preceding heading on the previous page.

Normal tests inject filesystem, converter and transaction adapters. They require
neither Pandoc, TeX nor a browser and cover unsafe/missing inputs, content naming,
limits, input aliases, converter failure and rollback after image installation
alongside text and font changes. Mermaid rendering and browser-failure acceptance
are separate from this image harness; see M3 below.

## M3 Mermaid acceptance

M3 adds transactional local PNG/JPEG/PDF and generated Mermaid SVG+PDF companions
to explicit CLI LaTeX export. See [README](README.md#m3-explicit-mermaid-vector-export)
for browser requirements, source restrictions and caps. Ordinary generation and
extension use do not launch the publication browser; there is still no extension
export action or automatic book PDF compilation.

Run the opt-in checks with **Node >=22.12 on POSIX**, checkout development
dependencies (`puppeteer-core`, no browser download), and an explicitly installed,
sandbox-capable system Chromium:

```sh
yarn test:mermaid --browser /usr/bin/chromium-browser \
  --font-manifest /absolute/path/to/font-project/fonts.json \
  --ulem /absolute/path/to/existing/ulem.sty --full-repo
yarn test:browser-security /usr/bin/chromium-browser
node src/test/acceptance/mermaid-families.mjs /usr/bin/chromium-browser
```

`test:mermaid` builds the CLI and uses the publication harness's Python/Pandoc/
LuaLaTeX/font prerequisites plus Poppler's `pdfimages`; `--ulem` remains the
optional, disclosed local workaround above. The family runner needs compiled
modules, the worker bundle, `pdfinfo` and `pdfimages` (run `yarn compile` and
`yarn build:mermaid-worker` first when invoking it alone). Browser rendering uses
system sans fonts, not the portable book-font manifest.

`yarn install --immutable` currently succeeds with a transitive peer warning:
`@zenuml/core` does not provide Tailwind to `@headlessui/tailwindcss`. Publication
imports ZenUML's prebundled ESM, not that CSS-build plugin; the offline bundle and
browser checks above pass without adding a Tailwind toolchain. The warning is
not suppressed. New renderer packages declare MIT licenses; Puppeteer Core
uses Apache-2.0, and its license remains in the installed dependency.

Retained acceptance evidence:

- `out/mermaid-families-4Ayxrs`: **39 family/dialect fixtures passed**, using the
  full pinned Mermaid 12 bundle with ZenUML and tidy-tree registration, no family
  allowlist. This is not exhaustive coverage of every theme/family configuration.
- `out/mermaid-security-c8c2oN`: security checks passed with **zero trap hits**.
- `out/mermaid-acceptance-on87g_rc`: portable A4/A5 six-figure fixtures passed:
  wide/tall flowcharts, nested list/quote variants, sequence and ER diagrams,
  deterministic re-export, relocation and no rasterization in the compiled PDFs.
  The full repository's **eight diagrams** also exported, relocated and compiled,
  but its final log has **61 issues: 52 missing-glyph entries and nine overfull
  lines**. This proves compilation, **not clean full-book typography**.

The historical M3 full test result was **918 passed, 2 skipped**; it is not the
final M4 test count. Normal tests use injected adapters and do not launch Chromium; these opt-in browser/PDF checks
are separate evidence, not implied by a headless-suite pass. Each harness retains
its own ignored `out/` evidence directory for diagnosis.

## M4 PDF acceptance

M4 is finished for explicit CLI PDF publication; see
[README](README.md#m4-explicit-pdf-book-compilation) for the command, package list,
limits, cancellation/transaction contract, and trusted-input restriction. The
`latex` `.tex` export is unchanged. M3 added exportable diagrams, not an explicit
book PDF command; M4 now supplies `pdf`. No extension publication commands exist
yet (M5), and neither ordinary generation nor saves compile PDFs.

Run the production-CLI acceptance harness explicitly:

```sh
yarn test:pdf --font-manifest /absolute/path/to/font-project/fonts.json \
  --ulem /absolute/path/to/existing/ulem.sty \
  --browser /usr/bin/chromium-browser
```

The font manifest is required and uses the same default-family/native four-face
Lilex fixture contract as `test:publication`. `--ulem` is optional: if the host
lacks that package, it exposes an existing local `ulem.sty` through an absolute
`TEXINPUTS` directory, preserving system lookup. It does not install anything or
add an exporter companion. `--browser` is optional and explicit; omit it to skip
Mermaid checks. There is no browser discovery or download fallback.

Use Node >=22.12 on POSIX and Python 3 without `-O`. In addition to Pandoc,
`latexmk`, `lualatex`, `kpsewhich`, the README's TeX packages and the fixture fonts,
the harness requires Poppler's `pdfinfo`, `pdftohtml`, `pdftotext`, `pdffonts`, and
`pdftocairo`; Mermaid checks also need `pdfimages` and `pdftoppm`. The harness
performs no tool/font/package downloads or installations and no source generation.
Normal headless tests use injected adapters and need no TeX or browser.

Each run prints a fresh ignored `out/pdf-acceptance-*` directory with fixture
inputs, CLI JSON/stderr, inspection reports and `acceptance.json`. Retained build
paths are recorded in `publication.buildDirectory`; browser cases may retain
stages in the system temporary directory to avoid Unix socket path-length limits.
These paths can lie outside the evidence directory. The caller must clean up all
retained stages, including potentially sensitive fonts/assets and logs.

Real evidence in `out/pdf-acceptance-57gcx3f_` records **10/10 checks passed**, no
failures or skips:

- A4 produced **11 pages**, A5 **16 pages**, with geometry/caption bounds, 95
  semantic labels and **13 visible linked page references** checked in each.
  The shared definition moved from page 2 to 3 and the final addition from page
  11 to 15. The fixture includes PDF/PNG images and captions, breakable code,
  native font faces, and clean final fixture logs.
- Optional Mermaid A4/A5 cases checked vector diagrams and geometry through the
  production `pdf` command, not a separate manual compilation step.
- An rc-execution control proved the marker was effective; rc-ignore verified
  that the production compiler ignored rc files, including during preflight.
- Success published only the requested PDF. Default cleanup removed stages;
  retained builds contained TeX/logs/auxiliaries and font/asset companions.
- Real compilation failures preserved a previously published PDF, both with
  retained builds and with default cleanup.

A separate full-repository production `pdf` invocation produced
`out/m4-book/book.pdf`: **298 A4 pages**. Its JSON result,
`out/m4-book-result.json`, reports **15 distinct warnings** for missing glyphs and
overfull boxes. This proves successful publication and warning reporting,
**not clean full-book typography**; do not conflate it with the clean bounded
fixture. Neither evidence set promises byte-identical PDFs or arbitrary-font,
Unicode, layout, or theme coverage.

The final `LITERATE_TEST_PANDOC=1 yarn test` run records **1,062 passed, 2 skipped,
0 failed** in `out/m4-tests-final.log`, including compiler-lifetime and publication
cancellation tests. `yarn check:self`, `yarn esbuild` and `git diff --check` also
passed. The real PDF acceptance above is separate from the headless-suite result.

## M1 acceptance review

This is the historical M1 sign-off; M3's image/diagram support is assessed above.
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
   criterion now also holds for the shared semantic screen renderer introduced
   in M2; escaped lookalikes receive no reference links.
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
   local `ulem` workaround is not a shipped companion. Unsupported images, tables,
   raw author tokens and Mermaid failed explicitly in M1 rather than being silently omitted.

No further M1 task is identified within those bounds. Universal Unicode/layout
acceptance and clean-machine compilation without prerequisites remain unproven,
not implicitly accepted. Portable local PNG/JPEG/PDF images are covered separately
by the image acceptance harness above; Mermaid rendering is covered by M3. A complete
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

The mapping is canonical document + accepted contribution → emitted fragment
block → contribution target → family target. M2 now asserts actual screen IDs and
relative links, not only model correspondence. Literal examples stay unlinked;
compact/spaced headers share normalized language delegation. The plugin test does
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

The historical M1 integration sign-off on 2026-09-26 ran all seven integration cases and the
full real-Pandoc/lifecycle suite: **771 passed, zero failures or skips**. Self-host
layout/typecheck/bundle/fixedpoint, extension/preview bundles, generated checks and
whitespace checks passed. A fresh portable acceptance run also passed both A4/A5
fixtures with the counts above and clean final logs, using the explicitly supplied
local font manifest and disclosed `ulem` workaround. No new visual inspection or
clean-machine/font-independent compilation is claimed by this run.

## M2 screen acceptance

The implementation covers the required fragment rendering/navigation scope:

- One shared screen renderer consumes engine publication segments and the guarded
  whole-block highlight.js emitter; it never discovers uses from rendered HTML.
  LaTeX's strict missing-target/modifier policy remains unchanged; preview permits
  incomplete inputs without inventing destinations.
- Family and contribution IDs are emitted once at their accepted declarations.
  Generated pages use percent-encoded, chapter-relative HTML links; preview uses
  logical-ID local anchors and extension-owned capability links across chapters.
  Cross-file navigation opens the canonical source document with an explicit
  selection, independently of the host's Markdown link preference;
  `data-literate-target` preserves the common identity. Previous/Base/Next controls are outside code,
  with native anchors, descriptive accessible names and existing focus CSS.
- Tests call actual `generateProject` and `activate().extendMarkdownIt` paths.
  Independent literal anchors/hrefs cover punctuation collisions, repeated and
  cross-document uses, nested paths with reserved URL characters, additions,
  prose shifts, literal escaped nonlinks, whole-block syntax, normalized fence
  languages, all palettes and source-map attributes. Existing tests cover normal
  fences and Mermaid. Current source, cached host tokens, unsaved/empty buffers,
  missing definitions and remote snapshot refresh are exercised without render
  I/O or output writes. Real Pandoc tests check LaTeX's logical destinations.

### Current extension-owned navigation acceptance

The native-line-link blocker described in the historical investigation below is
resolved by the authorized extension-owned route. One `registerUriHandler` per
activation accepts only `vscode://jesterking.literate/navigate/<session>/<token>`
(using `env.uriScheme`). Both opaque components contain 24 random bytes. Complete
URIs are passed to `env.asExternalUri`; the returned URI, including its encoded
window-routing query, is never reconstructed or modified.

Capabilities bind workspace object identity and an accepted logical family or
contribution, never a caller-supplied file, line, action or command. On use the
handler checks scheme, authority, exact path shape, session/map membership,
workspace membership and trust; it rediscovers sources and overlays canonical
current buffers over a separate, disk-only snapshot. Every overlay is rebuilt
without mutating that base, including after document opening: discarding another
input restores its saved definition instead of retaining its old empty/dirty text.
It rejects unsafe paths, symlink components, missing files and missing targets,
then opens the canonical document and rechecks the current model and authorization
before `showTextDocument(document, { selection })`. Filesystem
providers do not supply atomic path/open transactions; this is not a sandbox for
concurrent hostile filesystem mutation.

Rendering remains synchronous and does no filesystem I/O. Pending/rejected URLs
are text, never `#L` fallbacks. Successful resolution schedules a coalesced refresh.
The cache retains at most 4,096 entries and resolves at most 16 URLs concurrently.
Removal deletes both token entries and reverse keys, prunes queued resolutions and
recomputes the expiry timer. Re-adding the same URI can mint new capabilities;
old tokens and late responses remain invalid.

`env.asExternalUri` does not promise indefinite URL validity. Successful results
have a 60-second cache lifetime, managed by one earliest-expiry timer per activation.
Expiry clears ready URLs and schedules one coalesced refresh; only targets rendered
again resolve again, retaining their token and caching the new returned URI verbatim.
Pending requests are shared. Failed resolutions have a 60-second on-demand retry
cooldown, not an automatic retry timer. Saturation never evicts/remints on refresh.
Removal and disposal cancel expiry work; late resolution cannot revive entries or
timers. A URL invalidated before expiry can fail until renewal, and a failed renewal
needs another render after cooldown. The API provides no invalidation notification,
so this is bounded cache recovery, not a guarantee of continuous route validity.
Untrusted workspaces mint/open none, while native local anchors still work.
Generated HTML remains native and needs no navigation JavaScript. There is no
command URI, shipped socket, custom webview bridge or injected click handler.

The bounded acceptance harness passed on **unmodified installed VS Code 1.138.0**
on 2026-09-27, using `/usr/share/code/code`, this worktree's extension bundle and
a fresh disposable profile. It checked:

- Native Tab/Enter, trusted click events, accessible names and a visible 2px focus
  outline; local declaration scrolling before/after unsaved line shifts 123 → 125.
- Cross-file capability navigation to the actual declaration at zero-based line 4.
- An unsaved two-line destination edit, then the **same capability** selecting the
  actual declaration at line 6 in the **same TextDocument object**. Disk bytes stayed
  unchanged; the URI had no fragment and exactly one document identity existed.
- Real Chromium pointer input to the same dirty destination, not synthetic
  `element.click()` (which the host can treat differently). The harness switched
  from `inEditor` to `inPreview` between cross-file keyboard activations.

The host exited successfully with `M2_HOST_NAVIGATION_PASS 1.138.0`. Port 9333 was
checked closed. Evidence is `out/m2-host/workspace/navigation-evidence.json`;
reproduction command and remaining manual coverage appear below. Earlier patched
host diagnostics are not this acceptance result. Their copy was preserved under
ignored `.vscode-test/m2-patched-markdown-extension` so root compilation cannot
accidentally include its TypeScript sources.

After the independent-review fixes, final validation on 2026-09-27 passed the full
real-Pandoc/lifecycle suite: **812 tests, zero failures or skips**, including
**48 screen cases**. New regressions cover workspace removal/re-addition, discarding
another input while opening a duplicate definition, opaque URL renewal, cooldowns,
idle entries, late completions and cancellation of live expiry timers. Renewal
uses a mocked resolver and Node 22's virtual clock; the fresh unmodified-host run
above validates navigation but does not force actual platform URL invalidation.

Self-host layout/typecheck/bundle/fixedpoint, extension/preview bundles, generated
checks and whitespace checks passed. ESLint retains the pre-existing `#39` test
helper naming warning (zero errors); Node emits its expected experimental MockTimers
warning for virtual-clock tests. No new PDF compilation, physical-keyboard or
screen-reader acceptance is claimed.

### Historical native-link validation (superseded contract)

The following recovery results and protocol investigation describe the earlier
native-line implementation, **not the current navigation contract**. They explain
why capability navigation was necessary; their `inEditor` requirements and dirty
buffer limitations do not apply to current semantic fragment links.

M2 recovery validation on 2026-09-27: the focused screen integration suite passed
all **25 cases**, and `LITERATE_TEST_PANDOC=1 LITERATE_TEST_PANDOC_LIFECYCLE=1 yarn test`
passed **789 tests, zero failures or skips**, including both converter deadlines.
`check:self` passed layout/typecheck/bundle/fixedpoint; `esbuild`, generated-file
checks and `git diff --check` passed. ESLint reports the pre-existing test-helper
naming warning for the HTML entity key `#39` (no lint errors). The first full run
caught a standalone-preview theme regression in the recovery changes; it was fixed
before the passing run. Independent review then exposed resolver, scaling and
preview-alias gaps; the figures above are the subsequent passing validation.
The expanded real-webview keyboard/click acceptance below also passed on
2026-09-27. That test/prose-only follow-up reran the **25 focused cases** with real
Pandoc, compile, lint, extension bundles, self-hosting, generated-file and whitespace
checks. The **789-test full run** above is the preceding runtime-fix validation,
not a newly repeated full run for the harness changes. No fresh portable PDF
compilation, physical-keyboard walkthrough or assistive-technology acceptance is claimed.

Recovery regressions additionally cover raw NUL input before host normalization,
rejected duplicate/orphan declarations, complete-header matching for unfamiliar
cached tokens, rendered root settings/empty source, and workspace isolation.
Semantic/theme refresh now follows installation of the new source snapshot.
Review regressions additionally cover one-based cross-file source locations,
unsaved declaration shifts, host language aliases and deterministic linear syntax
leaf visits. A once-per-snapshot weak index supplies family, contribution, ordinal,
source-line and token lookups to both screen adapters.

A local warmed render-only benchmark (five samples, median, whole-block JavaScript
highlighting plus semantic links, excluding parsing) measured 1,000/2,000/4,000/8,000
references at **9.22/14.92/34.55/70.96 ms**. These are local observations, not CI
performance thresholds. The regression counts actual syntax-leaf reads and rejects
linear model searches during rendering, avoiding timing flakiness.

### Preview protocol investigation and corrected navigation contract

Earlier inspection of VS Code **1.96.0** source established the rendering and
webview contracts at these pinned locations. It did **not** prove that generated
IDs survive the language-service link resolver:

- [`preview-src/index.ts`](https://github.com/microsoft/vscode/blob/1.96.0/extensions/markdown-language-features/preview-src/index.ts):
  local `#` anchors pass through; relative link clicks post `openLink` to the host.
- [`src/preview/preview.ts`](https://github.com/microsoft/vscode/blob/1.96.0/extensions/markdown-language-features/src/preview/preview.ts):
  `inPreview` carries a resolver-supplied fragment into the destination preview;
  the resolver may omit that fragment, so this alone proves no target jump.
- [`preview-src/scroll-sync.ts`](https://github.com/microsoft/vscode/blob/1.96.0/extensions/markdown-language-features/preview-src/scroll-sync.ts):
  destination IDs are found on `code-line` elements with `data-line`. Both family
  and contribution targets satisfy that contract for local anchors. Source-map
  markup alone cannot repair a fragment discarded before the destination opens.
- [`src/markdownEngine.ts`](https://github.com/microsoft/vscode/blob/1.96.0/extensions/markdown-language-features/src/markdownEngine.ts):
  parsing may be cached and rendering gets a fresh `env.currentDocument`.
  The plugin's weak token/source association and synchronous render-time project
  overlay respect that boundary; the host fence consumes `options.highlight`.

No custom command URI, injected navigation script, asynchronous Markdown-it API,
filesystem access during rendering or global editor setting is introduced.
The host's built-in preview JavaScript still handles cross-document opening;
“no JavaScript dependency” here means no **Literate/optional expansion** script,
not a claim that VS Code's own preview can run without its host runtime.
The installed **1.138.0** `dist/serverWorkerMain.js` was then inspected at
`parseLocationInfoFromFragment` and `resolveLinkTarget`. It accepts `#L5` as
zero-based line 4, column 0, but discards unknown generated fragment IDs absent
from source headings/HTML IDs. Its `dist/extension.js` preview handler forwards
only the resolver's fragment in `inPreview`, ignoring source positions. Therefore
**exact cross-file navigation is supported in `inEditor`, not `inPreview`**.
Native line links now select the source declaration, with no injected navigation
script. Third-party fence rules must honor the supplied highlight option to retain
semantic code-use links. No minimum-version host run is claimed.

### Earlier installed-host rendering smoke test

A bounded `@vscode/test-electron.runTests` run used the installed
`/usr/share/code/code` (**VS Code 1.138.0**, Linux arm64), this worktree's bundled
extension, and an isolated workspace/profile under ignored `out/m2-host/`.
No VS Code download or user-setting changes were needed. The temporary harness
called the real `markdown.api.render` with actual `TextDocument` objects after
activating Literate and reloading Markdown plugins. It passed checks for:

- Nested chapter-relative definition links and literal escaped nonlinks.
- Family and contribution IDs with host `code-line`/`data-line` attributes.
- Addition navigation's descriptive labels.
- Rerendering a caller after emptying its destination in an unsaved editor buffer.

The process exited successfully with `M2_HOST_RENDER_PASS 1.138.0`; the local
harness and evidence are in `out/m2-host/run.cjs` and
`out/m2-host/workspace/evidence.json`. These ignored files are disposable local
evidence, not part of the committed test suite. This exercises the real host
renderer, **not webview link clicks or assistive technology**. The pinned 1.96
protocol investigation above remains source-level evidence, not a 1.96 host run.

### Real webview navigation acceptance

On **2026-09-27**, the generated `src/test/acceptance/screen-host.js` harness
(authoritative chapter: `literate/publication-screen.literate`) passed against
installed VS Code **1.138.0**, Linux arm64. It configured only an isolated fixture
workspace for Markdown and `inEditor`, opened a real Markdown webview, and used
test-only DevTools input with no mocked host APIs. The passing scope is:

- Seed focus on the preceding native anchor, dispatch Chromium **Tab**, and assert
  that the intended link receives focus, has `tabIndex=0`, matches `:focus-visible`,
  has the expected descriptive `aria-label`, and displays a solid nonzero outline.
- Dispatch **Enter**, assert it produces a trusted native click, and verify that a
  distant same-document definition actually scrolls into the viewport. VS Code's
  webview handles local anchors with `scrollIntoView`, not a URL-hash change.
- Prepend two lines through `WorkspaceEdit` without saving. Assert the document is
  dirty and disk bytes unchanged; wait for the real preview's source map to move
  from zero-based line **123 to 125**. Repeat Tab/Enter and viewport assertions for
  the same logical local target, and check the dirty source's declaration line.
- Activate `./../base.literate#L5` with Tab/Enter and, separately, the retained native
  click test. Assert the active editor's file, zero-based selection line **4**, and
  actual declaration text on that line. The destination is saved in this scenario.
- Check semantic highlighting of a `jsonc` fragment in the actual host.

The run exited successfully with `M2_HOST_NAVIGATION_PASS 1.138.0` and structured
check results. Evidence includes focus/outline values, local scroll geometry and
source-map lines. This is browser keyboard-event and host-navigation acceptance,
not physical-keyboard or screen-reader testing; ARIA names are asserted as DOM
attributes, not as spoken output.

Reproduce after `yarn generate && yarn compile && yarn esbuild` using an installed
host (adjust the executable path for your machine). The harness requires a host
with Node's `fetch`/`WebSocket` APIs, a graphical session and free loopback port 9333.
The command is bounded at 90 seconds; no host download is requested. DevTools is
local test infrastructure, not a shipped extension feature. Do not expose its port.

```sh
mkdir -p out/m2-host/workspace
timeout 90s node -e 'const profile=require("node:fs").mkdtempSync(process.cwd()+"/out/m2-host/profile-");require("@vscode/test-electron").runTests({vscodeExecutablePath:"/usr/share/code/code",extensionDevelopmentPath:process.cwd(),extensionTestsPath:process.cwd()+"/src/test/acceptance/screen-host.js",launchArgs:[process.cwd()+"/out/m2-host/workspace","--user-data-dir="+profile,"--extensions-dir="+process.cwd()+"/out/m2-host/extensions","--disable-extensions","--disable-workspace-trust","--skip-welcome","--skip-release-notes","--no-sandbox","--remote-debugging-port=9333"]}).catch(e=>{console.error(e);process.exitCode=1})'
```

A fresh disposable profile per run prevents restored dirty editors from changing
the fixture. The path guard prevents accidental use against another workspace. Use only
this disposable profile with `--no-sandbox`; it is a test-launch flag, not a normal
VS Code recommendation. Evidence is written to ignored
`out/m2-host/workspace/navigation-evidence.json`. The earlier render-only smoke
result is historical and was insufficient to detect the original navigation bug.

### Dirty cross-file reopening limitation observed during acceptance

Bounded diagnosis on **2026-09-27** identified a protocol-shape mismatch in the
installed **1.138.0** build (`7debcd0e2acdea1c52de81bf9ee1620444407dda`):

- The real `markdown/resolveLinkTarget` trace returns a fragment-free file URI and
  `positionOrRange: { start: { line: 6, character: 0 }, end: ... }` for `#L7`.
- The bundled Markdown extension's `openDocumentLink` reads **`position`**, not
  `positionOrRange`. Its fallback reparses the raw numeric fragment, reattaches it
  to the otherwise-canonical URI, and calls `vscode.open` with that URI and selection.
- VS Code exposes separate `TextDocument` identities for the plain URI, `#L5`, and
  `#L7`. A clean first navigation looks correct. A first navigation to an already
  dirty canonical buffer can also copy its current contents into a new identity;
  this is not reliable identity preservation or synchronization.
- Opening `#L5`, typing two unsaved lines with the actual editor `type` command,
  then following `#L7` reproduced the failure: selection line 6 contained the saved
  closing fence (or `END` in the minimal fixture), not the moved declaration. The
  original dirty document remained independently open and disk bytes were unchanged.

The failure was reproduced with ordinary `.md` links in a fresh host where
**Literate was not installed**. `.literate` association, workspace-root paths,
relative paths and percent-encoded filenames do not explain the identity split.
`#7`, `#l7`, `#L7,1`, `#%4C7` and `#%37` also retain fragment-qualified identities;
encoding is not a reliable workaround. A no-fragment link reuses the canonical
buffer but supplies no declaration position. Raw absolute `file:` links did not
activate the expected editor in the bounded probe and are not a validated fix.

Two supported API controls worked: `showTextDocument(existingDocument, { selection })`
and `vscode.open(canonicalUri, { selection })` preserved the intended dirty buffer.
However, the inspected native preview-link route calls its own resolver/opener;
those controls alone do not give Literate a supported interception hook.

A **diagnostic-only copy** of the built-in Markdown extension was then adapted to
read the resolver's `positionOrRange` start as the opener's expected position. With
no Literate runtime changes, both the minimal `.md` test and the actual Literate
preview passed: Tab/Enter on `#L5`, an unsaved two-line edit, then Tab/Enter on the
newly rendered `#L7` reused the **same canonical dirty document**, selected the
actual declaration, and left exactly one document identity open for that file.
This validates the root cause and a small host-side correction, not a production
host patch or universal host-version guarantee. The installed host was not modified;
range handling and broader upstream regression coverage remain part of a proper
host fix. No command URI or custom Literate navigation runtime was introduced.

Disposable scripts, trace logs and JSON evidence are under ignored `out/m2-host/`:
`dirty-probe.cjs`, `dirty-lifecycle-probe.cjs`, `native-only-probe.cjs`, and
`patched-literate-probe.cjs`; their evidence is in the `workspace/` subdirectory.
All launches used fresh profiles, 90-second bounds and exited; the debug port was
checked closed afterward. These diagnosis runs do **not** replace the earlier
runtime test suite, and the patched-host result does **not** count as passing
unsaved navigation on the unmodified installed host.

The user subsequently authorized extension-owned navigation. The implementation
and unmodified-host acceptance above resolve this blocker without a host patch
or a narrower saved-target contract. A syntax-only native href change was not used.

### Remaining manual host acceptance

The automated browser checks above do not replace this remaining manual coverage:

1. Associate `.literate` with Markdown. With preview/editor scrolling enabled,
   open `literate/publication-screen.literate`. Repeat on the minimum
   supported host version; the automated keyboard/click run used 1.138.0 only.
2. Use Tab and Enter on a use, definition label and each available Previous/Base/
   Next control. Check local and cross-chapter destinations, including a nested
   chapter. Verify visible focus and the link's accessible name with a screen
   reader; verify local preview scrolling and cross-file source selection at the
   declaration. Semantic cross-file links always select the source editor; they do
      not open a destination preview, regardless of the Markdown link setting.
3. Insert prose above a declaration and edit a use without saving. Check editor
   selection/scroll synchronization, links, blank lines and indentation. Change
   a definition in another open buffer, empty it, then restore it. Check that the
   preview refreshes without a save or output workflow change.
4. Check a light and dark palette, an ordinary code fence, and an existing Mermaid
   diagram. Disable optional third-party preview/expansion extensions and repeat.
5. Open generated HTML with scripting disabled: fragment navigation must still
   work. Mermaid rendering itself is outside this no-script navigation claim.

Implementation, automated contract acceptance and the installed-host keyboard/click test
are separate from this remaining manual UX validation. The optional fragment index, heading-ID parity and Mermaid
asset work were outside M2's scope (M3 now covers LaTeX diagram assets). No new portable PDF build is implied by
M2's real-Pandoc tests; the earlier M1 PDF evidence above remains historical.

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
