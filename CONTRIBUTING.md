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
`src/extension.ts`, `src/grabber.ts`, `src/engine.ts`, and `src/cli.ts` are generated;
commit them together with their literate sources and rendered HTML.
Tests and configuration remain ordinary files.

- `yarn literate generate [root]`: build the CLI, validate, and write changed outputs.
- `yarn literate check [root]`: build the CLI and check outputs without writing.
- `yarn generate` / `yarn check:generated`: convenience aliases.
- `yarn test`: compile, lint, run headless regression tests, and check generated files.
- `yarn test:extension`: build and run the existing VS Code host test runner
  (may download VS Code and requires a display).

When changing the generator, generate first, then run `yarn literate check` to
rebuild the new generator and verify that it reproduces its own output. Review
all generated diffs. Prose-only changes should not change generated TypeScript.

The full workflow and limitations are documented in
[Developing this literate program](literate/development.literate).

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
