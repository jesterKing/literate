# Change Log

## 0.1.0

* Resolve #3: Honor indentation in code fragments

## 0.0.9

* Resolve #2: Write out HTML files for literate programs
* Resolve #1: Don't add src in generated code file path

## 0.0.8

* Complex fragment setup saving was broken. Works again.

## 0.0.7

* Allow to specify file name on top code fragment. Use paths relative to the workspace. Subfolders can be part of the path. To save code for `<<Name of Fragment.*>>` to `CodeFile.cs` use:
<pre>
```csharp : &lt;&lt;Name of Fragment.*&gt;&gt;= ./CodeFile.cs
// code here
```</pre>

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