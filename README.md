# literate README

**Literate Programming** for Visual Studio Code.

This extension is inspired by the work done by [Physically Based Rendering: From
Theory To Implementation](http://www.pbr-book.org) by Matt Pharr, Wenzel Jakob,
and Greg Humphreys.

The ultimate goal is to have automatic HTML and code generation as you type.
HTML preview is already essentially available through the Markdown preview
feature of Visual Studio Code. Code generation exists, but that has to be run
manually still.

Note: enabling this extension will inject the literate style CSS developed for
this extension. Disable this extension in workspaces where you don't want the
style to influence Markdown document previews.

## Features

Use the literate programming paradigm to write your programs. Documents that end
with the extension `.literate` will be processed.

Literate documents are written with regular Markdown. The CommonMark
specification is followed through the use of the markdown-it library. The code
fence has been extended to include fragment identifiers and their related
settings.

Code fragments can be created by adding `<<some identifying string>>=` to the
info line of a code fence.

Adding to existing fragments is done through `<<some identifying string>>=+`.

A top-level code fragment has a `.*` at the end of the identifying string:
`<<some identifying string.*>>=`. The top-level fragment should include a file
name: `<<some top level.*>>= ./CodeFile.cs`. The file name is relative to the
workspace folder. It can contain subfolders, which will be automatically created
during code generation .

Code fragments can reference other code fragments in code by using the code
fragment tag `<<some identifying string>>`.

If a fragment use is indented the indentation will be maintained for its
realization. This makes it suitable for use with languages like Python that use
indentation to denote scope.

The command `Literate: Process` (`literate.process`) will process all
`.literate` documents found in the (first) workspace folder.

## Credits

Extension author: Nathan `jesterKing` Letwory