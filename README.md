# literate README

*Literate* programming for Visual Studio Code.

## Features

Note: enabling this extension will inject the literate style CSS developed for
this extension. Disable this extension in workspaces where you don't want the
style to influence Markdown document previews.

Use the literate programming paradigm to write your programs. Documents that end
with the extension `.literate` will be processed.

Literate documents are written with regular Markdown. The CommonMark specification
is followed through the use of the markdown-it library.

Code fragments can be created by adding `<<some identifying string>>=` to the
info line of a code fence.

Adding to existing fragments is done through `<<some identifying string>>=+`.

A top-level code fragment has a `.*` at the end of the identifying string:
`<<some identifying string.*>>=`.

Code fragments can reference other code fragments in code by using the code
fragment tag `<<some identifying string>>`.

The command `Literate: Process` (`literate.process`) will process all
`.literate` documents found in the (first) workspace folder.