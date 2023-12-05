# How To Develop

* Ensure `yarn` is installed: `npm install -g yarn`
* Ensure `typescript` compiler is installed: `npm install -g typescript`
* Ensure dependencies are installed: `yarn`
* Check linting: `yarn pretest`
* Compile code: `yarn esbuild`

If the code changes in `.literate` files don't automatically rebuild the HTML and designated source files you can run the `VSCode` command `Literate: Process (literate.process)`.

To test the extension it is best to temporarily disable the installed extension
before starting the test. Once disabled go to the Run and Debug panel and select
`Run Extension`. Click the green arrow to start debugging or hit `F5`. This will
open a new VSCode window in which the extension is hosted. Use the extension in
a test folder. Breakpoints set in the `extension.ts` file should hit as normal
in the main VSCode window.