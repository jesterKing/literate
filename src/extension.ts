/* Literate Programming by Nathan 'jesterKing' Letwory */

import { TextDecoder } from 'util';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import StateCore = require('markdown-it/lib/rules_core/state_core');
import Token = require('markdown-it/lib/token');
import MarkdownIt = require("markdown-it");
import Renderer = require('markdown-it/lib/renderer');

// `import` here fails so instead we require the highlight module
// this way. Not sure why import fails. It would be great to find
// out the reason.
const hljs = require('highlight.js');

import { grabberPlugin } from './grabber';
let oldFence : Renderer.RenderRule | undefined;
interface WriteRenderCallback {
  (
    fname : string,
    folderUri : vscode.Uri,
    content : string
  ) : Thenable<void>
};
interface WriteSourceCallback {
  (
    workspaceFolder : vscode.WorkspaceFolder,
    fragments : Map<string, FragmentInformation>
  ) : Thenable<void>
};

interface GrabbedState {
  literateFileName: string;
  literateUri: vscode.Uri;
  gstate: StateCore;
}
/**
 * Interface denoting a fragment and related information
 */
interface FragmentInformation {
  /**
   * Programming language identifier for fragment.
   */
  lang: string;
  /**
   * Filename of literate file.
   */
  literateFileName: string;
  /**
   * Filename of target source file. This is set when the fragment
   * is a top fragment.
   */
  sourceFileName: string;
  /**
   * The code fragment.
   */
  code: string;
  /**
   * List of tokens that make up the entire code fragment.
   */
  tokens: Token[];
  /**
   * The GrabbedState related to this fragment.
   */
  env: GrabbedState;
}

//let HTML_ENCODED_FRAGMENT_TAG_RE = /(&lt;&lt.*?&gt;&gt;)/g;
let FRAGMENT_USE_IN_CODE_RE =
  /(?<indent>[ \t]*)<<(?<tagName>.+)>>(?<root>=)?(?<add>\+)?/g;
let FRAGMENT_RE =
  /(?<lang>.*):.*<<(?<tagName>.+)>>(?<root>=)?(?<add>\+)?\s*(?<fileName>.*)/;

class FragmentNode extends vscode.TreeItem
{
  constructor (
    public readonly label : string,
    public readonly tooltip : vscode.MarkdownString,
    public readonly description : string,
    public readonly collapsibleState : vscode.TreeItemCollapsibleState,
    public readonly folderName: string,
    public readonly parentName : string | undefined,
    public readonly workspaceFolder : vscode.WorkspaceFolder,
    public readonly textDocument : vscode.TextDocument | undefined
  )
  {
    super(label, collapsibleState);
    this.tooltip = tooltip;
    this.description = description;
    this.iconPath = this.parentName ?
              new vscode.ThemeIcon('code')
              : new vscode.ThemeIcon('book');
    this.contextValue = 'literate_fragment';
  }
}

export class FragmentNodeProvider implements vscode.TreeDataProvider<FragmentNode>
{
  private _onDidChangeTreeData:
    vscode.EventEmitter<
      FragmentNode |
      undefined |
      void
    > = new vscode.EventEmitter<FragmentNode | undefined | void>();
  readonly onDidChangeTreeData :
    vscode.Event<
      FragmentNode |
      undefined |
      void
    > = this._onDidChangeTreeData.event;
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(element : FragmentNode): vscode.TreeItem {
    return element;
  }
  async getChildren(element? : FragmentNode): Promise<FragmentNode[]>
  {
    if(!vscode.workspace.workspaceFolders ||
      (
        vscode.workspace.workspaceFolders &&
        vscode.workspace.workspaceFolders.length < 1
      )) {
      vscode.window.showInformationMessage('No fragments in empty workspace');
      return Promise.resolve([]);
    }
    if(!element)
    {
      let arr = new Array<FragmentNode>();
      for(const wsFolder of vscode.workspace.workspaceFolders)
      {
          arr.push(
          new FragmentNode(
            wsFolder.name,
            new vscode.MarkdownString('$(book) (workspace folder)', true),
            'Workspace folder containing a literate project',
            vscode.TreeItemCollapsibleState.Collapsed,
            wsFolder.name,
            undefined,
            wsFolder,
            undefined));
      }
      return Promise.resolve(arr);
    }
    else
    {
      const folderName : string = element.folderName;
      const fldr : vscode.WorkspaceFolder = element.workspaceFolder;
      let arr = new Array<FragmentNode>();
      const fragments = theOneRepository.getFragments(fldr).map;
      for(const fragmentName of fragments.keys() )
      {
        if(!element.parentName) {
          let fragmentType : vscode.MarkdownString;
          let fragmentInfo = fragments.get(fragmentName) || undefined;
          if (fragmentInfo) {
            if(fragmentName.indexOf(".*") >= 0)
            {
              fragmentType = new vscode.MarkdownString(
                        `$(globe): ${fragmentInfo.literateFileName}`,
                        true);
            }
            else
            {
              fragmentType = new vscode.MarkdownString(
                        `$(code): ${fragmentInfo.literateFileName}`,
                        true);
            }
              arr.push(
              new FragmentNode(
                fragmentName,
                fragmentType,
                fragmentInfo.literateFileName,
                vscode.TreeItemCollapsibleState.Collapsed,
                folderName,
                element.label,
                element.workspaceFolder,
                undefined));
          }
        }
        else if (fragmentName === element.label) {
          let fragmentInfo = fragments.get(fragmentName) || undefined;
          if (fragmentInfo) {
            const casesToReplace = [...fragmentInfo.code.matchAll(FRAGMENT_USE_IN_CODE_RE)];
            for (let match of casesToReplace) {
              if(!match || !match.groups)
              {
                continue;
              }
              let tag = match[0];
              let ident = match.groups.ident;
              let tagName = match.groups.tagName;
              let root = match.groups.root;
              let add = match.groups.add;
              arr.push(
                new FragmentNode(
                  tagName,
                          new vscode.MarkdownString(`$(symbol-file) ${fragmentInfo.literateFileName}`, true),
                  fragmentName,
                  vscode.TreeItemCollapsibleState.Collapsed,
                  folderName,
                  element.label,
                  element.workspaceFolder,
                  undefined
                )
              );
            }
          }
        }
      }
      
      return Promise.resolve(arr);
    }
  }
}

export class FragmentExplorer {
  private fragmentView : vscode.TreeView<FragmentNode>;
  constructor(context : vscode.ExtensionContext) {
    const fragmentNodeProvider = new FragmentNodeProvider();
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider(
        'fragmentExplorer',
        fragmentNodeProvider
      )
    );
    this.fragmentView = vscode.window.createTreeView(
                  'fragmentExplorer',
                  {
                    treeDataProvider : fragmentNodeProvider
                  });

    context.subscriptions.push(
      vscode.commands.registerCommand(
                'fragmentExplorer.refreshEntry',
                () => fragmentNodeProvider.refresh())
              );
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(
      _ => {
        fragmentNodeProvider.refresh();
      }
    ));
    context.subscriptions.push(this.fragmentView);
  }
}

export class FragmentHoverProvider implements vscode.HoverProvider {
  readonly fragmentRepository : FragmentRepository;
  constructor(repository : FragmentRepository)
  {
    this.fragmentRepository = repository;
  }
  public async provideHover(
    document : vscode.TextDocument,
    position : vscode.Position,
    _: vscode.CancellationToken
  )
  {
    const currentLine = document.lineAt(position.line);
    const workspaceFolder : vscode.WorkspaceFolder | undefined = determineWorkspaceFolder(document);
    if(!workspaceFolder) { return null; }
    const matchesOnLine = [...currentLine.text.matchAll(FRAGMENT_USE_IN_CODE_RE)];
    for(const match of matchesOnLine)
    {
      if(!match || !match.groups) {
        continue;
      }
      const foundIndex = currentLine.text.indexOf(match[0]);
      if(foundIndex>-1) {
        let fragments = this.fragmentRepository.getFragments(workspaceFolder).map;
        if(foundIndex <= position.character && position.character <= foundIndex + match[0].length && fragments.has(match.groups.tagName))
        {
          const startPosition = new vscode.Position(currentLine.lineNumber, foundIndex);
          const endPosition = new vscode.Position(currentLine.lineNumber, foundIndex + match[0].length);
          let range : vscode.Range = new vscode.Range(startPosition, endPosition);
          let fragment = fragments.get(match.groups.tagName) || undefined;
          if (fragment && !match.groups.root) {
            return new vscode.Hover(
              new vscode.MarkdownString(`~~~ ${fragment.lang}\n${fragment.code}\n~~~`, true),
              range);
          }
        }
      }
    }
    return null;
  }
}
function renderCodeFence(tokens : Token[],
             idx : number,
             options : MarkdownIt.Options,
             env : any,
             slf : Renderer) {
  let rendered = '';
  if (oldFence) {
    rendered = oldFence(tokens, idx, options, env, slf);

    let token = tokens[idx];
    if (token.info) {
      const match = token.info.match(FRAGMENT_RE);
      if (match && match.groups) {
        let lang = match.groups.lang.trim();
        let name = match.groups.tagName;
        let root = match.groups.root;
        let add = match.groups.add;
        let fileName = match.groups.fileName;
        if (name) {
          root = root || '';
          add = add || '';
          rendered =
`<div class="codefragment">
<div class="fragmentname">&lt;&lt;${name}&gt;&gt;${root}${add}</div>
<div class="code">
${rendered}
</div>
</div>`;
        }
      }
    }
  }

  return rendered;
};

function createMarkdownItParserForLiterate() : MarkdownIt
{
  const md : MarkdownIt = new MarkdownIt({
          highlight: function(str: string, lang: string, attrs: string) {
            if(lang && hljs.getLanguage(lang)) {
              return '<pre><code>' +
              hljs.highlight(str, {language : lang}).value +
              '</code></pre>';
            }
            return '<pre title="' + attrs + '">' + md.utils.escapeHtml(str) + '</pre>';
          }
      
        })
        .use(grabberPlugin);
      
      oldFence = md.renderer.rules.fence;
      md.renderer.rules.fence = renderCodeFence;
  return md;
}

async function iterateLiterateFiles(workspaceFolder : vscode.WorkspaceFolder,
                                    writeHtml : WriteRenderCallback
                                                | undefined
                                                | null,
                                    envList : Array<GrabbedState>,
                                    md : MarkdownIt)
{
  const literateFilesInWorkspace : vscode.RelativePattern =
            new vscode.RelativePattern(workspaceFolder, '**/*.literate');
  const foundLiterateFiles = await vscode.workspace
            .findFiles(literateFilesInWorkspace)
            .then(files => Promise.all(files.map(file => file)));
  try {
    for (let fl of foundLiterateFiles) {
      const currentContent = (() =>
        {
          for(const textDocument of vscode.workspace.textDocuments) {
            if(vscode.workspace.asRelativePath(fl) === vscode.workspace.asRelativePath(textDocument.uri)) {
              return textDocument.getText();
            }
          }
          return '';
        }
      )();
      const content = currentContent ? null : await vscode.workspace.fs.readFile(fl);
      const text = currentContent ? currentContent : new TextDecoder('utf-8').decode(content);
      const fname = path.relative(workspaceFolder.uri.path, fl.path);
      const env: GrabbedState = { literateFileName: fname, literateUri: fl, gstate: new StateCore('', md, {}) };
      envList.push(env);
      const rendered = md.render(text, env);
      if(writeHtml)
      {
        await writeHtml(fname, workspaceFolder.uri, rendered);
      }
    }
  } catch (error) {
    console.log(error);
  }
}
async function handleFragments(
  workspaceFolder : vscode.WorkspaceFolder,
  envList : Array<GrabbedState>,
  diagnostics : vscode.DiagnosticCollection,
  extrapolateFragments : boolean,
  writeSource : WriteSourceCallback | undefined) : Promise<Map<string, FragmentInformation>>
{
  const folderUri = workspaceFolder.uri;
  const fragments = new Map<string, FragmentInformation>();
  const overwriteAttempts = new Array<string>();
  const missingFilenames = new Array<string>();
  const addingToNonExistant = new Array<string>();
  for (let env of envList) {
    for (let token of env.gstate.tokens) {
      if (token.type === 'fence') {
        const linenumber = locationOfFragment(token);
        const match = token.info.match(FRAGMENT_RE);
        if (match && match.groups) {
          let lang = match.groups.lang.trim();
          let name = match.groups.tagName;
          let root = match.groups.root;
          let add = match.groups.add;
          let fileName = match.groups.fileName;
          if (root && add) {
            if (fragments.has(name)) {
              let fragmentInfo = fragments.get(name) || undefined;
              if(fragmentInfo && fragmentInfo.code) {
                let additionalCode = token.content;
                fragmentInfo.code = `${fragmentInfo.code}${additionalCode}`;
                fragmentInfo.tokens.push(token);
                fragments.set(name, fragmentInfo);
              }
            } else {
              if(!addingToNonExistant.includes(name)) {
                let msg = `Trying to add to non-existant fragment ${name}. ${env.literateFileName}:${linenumber}`;
                const diag = createErrorDiagnostic(token, msg);
                updateDiagnostics(env.literateUri, diagnostics, diag);
                addingToNonExistant.push(name);
              }
            }
          }
          if (root && !add) {
            if (fragments.has(name) && !overwriteAttempts.includes(name)) {
              let msg = `Trying to overwrite existing fragment fragment ${name}. ${env.literateFileName}${linenumber}`;
              const diag = createErrorDiagnostic(token, msg);
              updateDiagnostics(env.literateUri, diagnostics, diag);
              overwriteAttempts.push(name);
            } else {
              if (!fileName && name.indexOf(".*") > -1 && !missingFilenames.includes(name)) {
                let msg = `Expected filename for star fragment ${name}`;
                const diag = createErrorDiagnostic(token, msg);
                updateDiagnostics(env.literateUri, diagnostics, diag);
                missingFilenames.push(name);
              } else {
                let code = token.content;
                let fragmentInfo: FragmentInformation = {
                  lang: lang,
                  literateFileName: env.literateFileName,
                  sourceFileName: fileName,
                  code: code,
                  tokens: [token],
                  env: env,
                };
                fragments.set(name, fragmentInfo);
              }
            }
          }
        }
      }
    }
  }

  if(extrapolateFragments)
  {
    // for now do several passes
    let pass: number = 0;
    const rootIncorrect = new Array<string>();
    const addIncorrect = new Array<string>();
    const fragmentNotFound = new Array<string>();
    do {
      pass++;
      let fragmentReplaced = false;
      for (let fragmentName of fragments.keys()) {
        let fragmentInfo = fragments.get(fragmentName) || undefined;
        if (!fragmentInfo) {
          continue;
        }
    
        const casesToReplace = [...fragmentInfo.code.matchAll(FRAGMENT_USE_IN_CODE_RE)];
        for (let match of casesToReplace) {
          if(!match || !match.groups) {
            continue;
          }
          let tag = match[0];
          let indent = match.groups.indent;
          let tagName = match.groups.tagName;
          let root = match.groups.root;
          let add = match.groups.add;
          if (root && !rootIncorrect.includes(tag)) {
            let msg = `Found '=': incorrect fragment tag in fragment, ${tag}`;
            const diag = createErrorDiagnostic(fragmentInfo.tokens[0], msg);
            updateDiagnostics(fragmentInfo.env.literateUri, diagnostics, diag);
            rootIncorrect.push(tag);
          }
          if (add && !addIncorrect.includes(tag)) {
            let msg = `Found '+': incorrect fragment tag in fragment: ${tag}`;
            const diag = createErrorDiagnostic(fragmentInfo.tokens[0], msg);
            updateDiagnostics(fragmentInfo.env.literateUri, diagnostics, diag);
            addIncorrect.push(tag);
          }
          if (!fragments.has(match.groups.tagName) && tagName !== "(?<tagName>.+)" && !fragmentNotFound.includes(tagName)) {
            let msg = `Could not find fragment ${tag} (${tagName})`;
            const diag = createErrorDiagnostic(fragmentInfo.tokens[0], msg);
            updateDiagnostics(fragmentInfo.env.literateUri, diagnostics, diag);
            fragmentNotFound.push(tagName);
          }
          let fragmentToReplaceWith = fragments.get(tagName) || undefined;
          if (fragmentToReplaceWith) {
            let code = fragmentToReplaceWith.code;
            let lines = code.split("\n").slice(0, -1);
            let indentedLines = lines.flatMap(function (e, _) {
              return indent + e;
    
            });
            let newcode = indentedLines.join("\n");
            fragmentReplaced = true;
            fragmentInfo.code = fragmentInfo.code.replace(tag, newcode);
            fragments.set(fragmentName, fragmentInfo);
          }
        }
      }
      if(!fragmentReplaced) {
        break;
      }
    }
    while (pass < 25);
  }

  if(writeSource) {
    writeSource(workspaceFolder, fragments);
  }

  return Promise.resolve(fragments);
}
async function writeSourceFiles(workspaceFolder : vscode.WorkspaceFolder,
                fragments : Map<string, FragmentInformation>)
{
  const folderUri = workspaceFolder.uri;
  /* now write out the source files. */
  for(const name of fragments.keys()) {
    if (name.indexOf(".*") >= 0) {
      let fragmentInfo = fragments.get(name) || undefined;
      if (fragmentInfo) {
        let fileName = fragmentInfo.sourceFileName.trim();
        const encoded = Buffer.from(fragmentInfo.code, 'utf-8');
        const fileUri = vscode.Uri.joinPath(folderUri, fileName);
        await vscode.workspace.fs.writeFile(fileUri, encoded);
      }
    }
  }
}
class FragmentMap {
  map : Map<string, FragmentInformation>;
  
  constructor()
  {
    this.map = new Map<string, FragmentInformation>();
  }

  clear()
  {
    this.map.clear();
  }

  dispose()
  {
    this.map.clear();
  }
};
class GrabbedStateList {
  list : Array<GrabbedState>;

  constructor()
  {
    this.list = new Array<GrabbedState>();
  }

  clear()
  {
    this.list = new Array<GrabbedState>();
  }
  
  dispose()
  {
    while(this.list.length>0)
    {
      this.list.pop();
    }
  }
};

export class FragmentRepository {
  private md : MarkdownIt;
  readonly fragmentsForWorkspaceFolders : Map<string, FragmentMap>;
  readonly grabbedStateForWorkspaceFolders : Map<string, GrabbedStateList>;
  readonly diagnostics : vscode.DiagnosticCollection;
  constructor(
    context : vscode.ExtensionContext
  )
  {
    this.md = createMarkdownItParserForLiterate();
    this.fragmentsForWorkspaceFolders = new Map<string, FragmentMap>();
    this.grabbedStateForWorkspaceFolders = new Map<string, GrabbedStateList>();
    this.diagnostics = vscode.languages.createDiagnosticCollection('literate');
    context.subscriptions.push(this.diagnostics);
  
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(
        async (e : vscode.TextDocumentChangeEvent) =>
        {
          if(!(e.contentChanges.length>0 && e.contentChanges[0].text.startsWith('<')))
          {
            await this.processLiterateFiles(e.document);
          }
        }
      )
    );
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(
        async (e : vscode.WorkspaceFoldersChangeEvent) =>
        {
          for(const addedWorkspaceFolder of e.added) {
            await this.processLiterateFiles(addedWorkspaceFolder);
          }
          for(const removedWorkspaceFolder of e.removed)
          {
            this.fragmentsForWorkspaceFolders.delete(removedWorkspaceFolder.name);
            this.grabbedStateForWorkspaceFolders.delete(removedWorkspaceFolder.name);
          }
        }
      )
    );
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(
        async (e : vscode.WorkspaceFoldersChangeEvent) =>
        {
          for(const addedWorkspaceFolder of e.added) {
            await this.processLiterateFiles(addedWorkspaceFolder);
          }
          for(const removedWorkspaceFolder of e.removed)
          {
            this.fragmentsForWorkspaceFolders.delete(removedWorkspaceFolder.name);
            this.grabbedStateForWorkspaceFolders.delete(removedWorkspaceFolder.name);
          }
        }
      )
    );
  }
  async processLiterateFiles(
    trigger :
      vscode.WorkspaceFolder
      | vscode.TextDocument
      | undefined) {
        const workspaceFolders : Array<vscode.WorkspaceFolder> | undefined = (() => {
          if(trigger)
          {
            if("eol" in trigger) {
              const ws = determineWorkspaceFolder(trigger);
              if(ws)
              {
                return [ws];
              }
            } 
            else
            {
              return [trigger];
            }
            if("eol" in trigger) {
              const ws = determineWorkspaceFolder(trigger);
              if(ws)
              {
                return [ws];
              }
            } else {
              return [trigger];
            }
          }
          if(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length>0) {
            let folders = new Array<vscode.WorkspaceFolder>();
            for(const ws of vscode.workspace.workspaceFolders)
            {
              folders.push(ws);
            }
            return folders;
          }
          return undefined;
        }
        )();
        if(workspaceFolders) {
          const writeOutHtml : WriteRenderCallback =
              (fname : string,
               folderUri : vscode.Uri,
               rendered : string) : Thenable<void> => {
            const html =
        `<html>
          <head>
            <link rel="stylesheet" type="text/css" href="./style.css">
          </head>
          <body>
          ${rendered}
          </body>
        </html>`;
            const encoded = Buffer.from(html, 'utf-8');
            fname = fname.replace(".literate", ".html");
            const fileUri = vscode.Uri.joinPath(folderUri, fname);
            return Promise.resolve(vscode.workspace.fs.writeFile(fileUri, encoded));
          };
          for(const folder of workspaceFolders)
          {
            if(!this.fragmentsForWorkspaceFolders.has(folder.name))
            {
              this.fragmentsForWorkspaceFolders.set(folder.name, new FragmentMap());
            }
            if(!this.grabbedStateForWorkspaceFolders.has(folder.name))
            {
              this.grabbedStateForWorkspaceFolders.set(folder.name, new GrabbedStateList());
            }
            const fragments = this.fragmentsForWorkspaceFolders.get(folder.name);
            const grabbedStateList = this.grabbedStateForWorkspaceFolders.get(folder.name);
            if(fragments && grabbedStateList) {
              fragments.clear();
              grabbedStateList.clear();
              await iterateLiterateFiles(folder,
                                         writeOutHtml, /*     writeHtml : WriteRenderCallback*/
                                         grabbedStateList.list,
                                         this.md);
              this.diagnostics.clear();
              fragments.map = await handleFragments(folder, grabbedStateList.list, this.diagnostics, false, undefined);
              this.diagnostics.clear();
              await handleFragments(folder, grabbedStateList.list, this.diagnostics, true, writeSourceFiles);
            }
          }
        }
  }

  getFragments(workspaceFolder : vscode.WorkspaceFolder) : FragmentMap
  {
    let fragmentMap : FragmentMap = new FragmentMap();
    this.fragmentsForWorkspaceFolders.forEach(
      (value, key, _) =>
      {
        if(key===workspaceFolder.name)
        {
          fragmentMap = value;
        }
      }
    );
  
    return fragmentMap;
  }

  dispose() {
    for(let fragmentMap of this.fragmentsForWorkspaceFolders.values())
    {
      fragmentMap.dispose();
    }
    this.fragmentsForWorkspaceFolders.clear();

    for(let grabbedState of this.grabbedStateForWorkspaceFolders.values())
    {
      grabbedState.dispose();
    }
    this.grabbedStateForWorkspaceFolders.clear();
  }
}
function determineWorkspaceFolder(document : vscode.TextDocument) : vscode.WorkspaceFolder | undefined
{
  if(!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0)
  {
    return undefined;
  }
  for(const ws of vscode.workspace.workspaceFolders)
  {
    const relativePath = path.relative(ws.uri.toString(), document.uri.toString());
    if(!relativePath.startsWith('..'))
    {
      return ws;
    }
  }
  return undefined;
}
let theOneRepository : FragmentRepository;
export async function activate(context: vscode.ExtensionContext) {
  const rootPath = (vscode.workspace.workspaceFolders && (vscode.workspace.workspaceFolders.length > 0))
    ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined;

  console.log('Ready to do some Literate Programming');
  const diagnostics = vscode.languages.createDiagnosticCollection('literate');

  theOneRepository = new FragmentRepository(context);
  await theOneRepository.processLiterateFiles(undefined);
  context.subscriptions.push(theOneRepository);

  let literateProcessDisposable = vscode.commands.registerCommand(
    'literate.process',
    async function () {
      theOneRepository.processLiterateFiles(undefined);
      return vscode.window.setStatusBarMessage("Literate Process completed", 5000);
  });
  new FragmentExplorer(context);
  const completionItemProvider =
    vscode.languages.registerCompletionItemProvider('markdown', {
      async provideCompletionItems(
        document : vscode.TextDocument,
        ..._
      )
      {
        let completionItems : Array<vscode.CompletionItem> =
            new Array<vscode.CompletionItem>();
        const workspaceFolder : vscode.WorkspaceFolder | undefined = determineWorkspaceFolder(document);
        if(!workspaceFolder) { return []; }
        await theOneRepository.processLiterateFiles(workspaceFolder);
        let fragments = theOneRepository.getFragments(workspaceFolder).map;
        for(const fragmentName of fragments.keys())
        {
          const fragment : FragmentInformation | undefined = fragments.get(fragmentName);
          if(!fragment) {
            continue;
          }
          const fragmentCompletion = new vscode.CompletionItem(fragmentName);
          fragmentCompletion.detail = fragment.code;
          fragmentCompletion.kind = vscode.CompletionItemKind.Reference;
          completionItems.push(fragmentCompletion);
        }
        return completionItems;
      }
  }, '<');
  context.subscriptions.push(completionItemProvider);

  context.subscriptions.push(
    vscode.languages.registerHoverProvider('markdown', new FragmentHoverProvider(theOneRepository))
  );

  if (vscode.window.activeTextEditor) {
    updateDiagnostics(vscode.window.activeTextEditor.document.uri, diagnostics, undefined);
  }
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor) {
      updateDiagnostics(editor.document.uri, diagnostics, undefined);
    }
  }));

  context.subscriptions.push(literateProcessDisposable);

  return {
    extendMarkdownIt(md: any) {
      md.use(grabberPlugin);
      oldFence = md.renderer.rules.fence;
      md.renderer.rules.fence = renderCodeFence;
      return md;
    }
  };
};
function updateDiagnostics(
  uri: vscode.Uri,
  collection: vscode.DiagnosticCollection,
  diagnostic : vscode.Diagnostic | undefined): void {
  if (uri) {
    if (diagnostic) {
      const diags = Array.from(collection.get(uri) || []);
      diags.push(diagnostic);
      collection.set(uri, diags);
    }
  } else {
    collection.clear();
  }
}

/**
 * Create diagnostic for a given token with message.
 * @param token Token that carries the faulty code fragment
 * @param message Error message
 */
function createErrorDiagnostic(token: Token, message: string) : vscode.Diagnostic {
  let range = fragmentRange(token);
  let diagnostic: vscode.Diagnostic = {
    severity: vscode.DiagnosticSeverity.Error,
    message: message,
    range: range
  };

  return diagnostic;
}

/**
 * Give the location of the line in the Markup document that contains the
 * tag declaration.
 * @param token Token to extract code location from
 */
function locationOfFragment(token: Token): number {
  let linenumber = token.map ? (token.map[0]) : -1;
  return linenumber;
}

/**
 * Give the location of the last line in the Markup document that contains the
 * code fragment.
 * @param token Token to extract code location from
 */
function locationOfFragmentEnd(token: Token): number {
  let linenumber = token.map ? (token.map[1] ) : -1;
  return linenumber;
}


/**
 * Give range for the code fragment, including tag.
 * @param token Token to create range for
 */
function fragmentRange(token: Token): vscode.Range {
  let startTagName = token.info.indexOf("<<") + 2;
  let endTagName = token.info.indexOf(">>") - 1;
  let start = new vscode.Position(locationOfFragment(token), startTagName);
  let end = new vscode.Position(locationOfFragmentEnd(token), endTagName);
  let range: vscode.Range = new vscode.Range(start, end);
  return range;
}
export function deactivate() {}
