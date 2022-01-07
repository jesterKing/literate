# Change Log

## 0.4.1

* Overhauling literate file processing. There is now one class responsible for
  handling the parsing and rendering of literate files and for creation of
  fragment maps. Different parts use the new central fragment repository. This
  has been done with future enhancements in mind.
* Literate program split up into several documents. TOC, chapter linking and
  similar features have become important, but for now accept that browsing the
  literate program isn't the easiest. Something to be address better through #7,
  #10 and #11.
* Diagnostics don't repeat unnecessarily.

## 0.4.0

* Add hovers when mousing over fragment usage or fragment mention.

## 0.3.0

* Add code completion for code fragments. Typing an opening chevron `<` will
  show all code fragment names known in the current project.
* Completion item detail will show fragment code

## 0.2.4

* Rework introduction
* Improve explanation of high level mechanism of the extension
* Improve fragment regular expressions through using named groups
* Adapt top fragment diagnostic check to take into account named group
* Move to using space indentation, width 2

## 0.2.3

* Move error message from dialog to statusbar. In conjunction with the Problems
  view developers get currently enough information that is already properly
  integrated.

## 0.2.2

* Unbreak extension. Incorrect setup and general inadequate skill level caused
  the extension to no longer function correctly.

## 0.2.1

* Fragment explorer automatically updates on changes made to literate documents
* The `literate.process` command is executed on each literate document change
* Literate document parsing takes into account `TextDocument`s, that is
  documents in text editors that may have changes different from what is on
  disk. This can be especially useful with other extensions in use, like
  linting and lsp interaction

## 0.2.0

* Rewrite code to enable parsing and handling of fragments outside of the
  `literate.process` command
* Add rough version of the fragment explorer

## 0.1.8

* More literate text explaining the workings of the plug-in. Most of the new
  text is about fragments
* Don't bundle node_modules unnecessarily

## 0.1.7

* Add LICENSE file (MIT)
* Bump engines dependency to 1.63.2

## 0.1.6

* Minor fixups and dependency updates (dev)
* Ensure extension works with vscode 1.63.2

## 0.1.5

* Ensure `literate` can be created the literate way

## 0.1.4

* Package improvement was not working out correctly. Revert to old packaging
  mechanism

## 0.1.3

* Package improvement, no functional changes

## 0.1.2

* This time actually have syntax highlighting
  in the code fragments

## 0.1.1

* Keep syntax highlighting in generated HTML

## 0.1.0

* Resolve #3: Honor indentation in code fragments

## 0.0.9

* Resolve #2: Write out HTML files for literate programs
* Resolve #1: Don't add src in generated code file path

## 0.0.8

* Complex fragment setup saving was broken. Works again.

## 0.0.7

* Allow to specify file name on top code fragment. Use paths relative to the
  workspace. Subfolders can be part of the path. To save code for `<<Name of
  Fragment.*>>` to `CodeFile.cs` use:

~~~literate
```csharp : &lt;&lt;Name of Fragment.*&gt;&gt;= ./CodeFile.cs
// code here
```
~~~

## 0.0.6

* Make _all_ hljs classes black text by default for now

## 0.0.5

* Disable decorating generated code with #line

## 0.0.4

* Add Markdown contribution to render our code fences
* fragment tags are cleaned up from highlightjs rendering
* Start with simple styling using old white background with all black text

## 0.0.0 .. 0.0.3

* Simple code fragments through code fences (tripple backtick or tripple tilde)
* A code fence creates a new fragment on the info line
* A code fence extends an existing fragment on the info line
* Code fences/blocks reference fragments by using their tags
