/* Literate Programming by Nathan 'jesterKing' Letwory */

import { TextDecoder } from 'util';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

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
const FENCE = '```';
const OPENING = '<<';
const CLOSING = '>>';

let htmlTemplateFile : vscode.Uri | undefined = undefined;
let authors = '';
interface WriteRenderCallback {
  (
    fname : string,
    folderUri : vscode.Uri,
    content : string
  ) : Promise<void>
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
const emptyState : GrabbedState =
{
  literateFileName : '',
  literateUri : vscode.Uri.file('not_valid_for_literate'),
  gstate: new StateCore('', createMarkdownItParserForLiterate(), '')
};
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
   * Uri to source template filename.
   */
  templateFileName: vscode.Uri | undefined;
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
interface TokenUsage
{
  token : Token | undefined,
}

const emptyToken : TokenUsage =
{
  token : undefined,
};

//let HTML_ENCODED_FRAGMENT_TAG_RE = /(&lt;&lt.*?&gt;&gt;)/g;
const FRAGMENT_USE_IN_CODE_RE =
  /(?<indent>[ \t]*)<<(?<tagName>.+)>>(?<root>=)?(?<add>\+)?/g;
const FRAGMENT_RE =
  /(?<lang>[^:]*)(?<colon>:)?.*<<(?<tagName>.+)>>(?<root>=)?(?<add>\+)?\s*(?<fileName>.*\s+\$)?(?<extraSettings>\s+.*)?/;
const FRAGMENT_HTML_CLEANUP_RE= /(<span.class="hljs-.+?">)(.*?)(<\/span>)/g;
const FRAGMENT_HTML_RE= /(&lt;&lt;.+?&gt;&gt;)/g;

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
    public readonly fragmentInformation : FragmentInformation | undefined
  )
  {
    super(label, collapsibleState);
    this.tooltip = tooltip;
    this.description = description;
    this.iconPath = this.parentName ?
              new vscode.ThemeIcon('code')
              : new vscode.ThemeIcon('book');
    this.contextValue = 'literate_fragment';
    if(this.fragmentInformation
      && this.fragmentInformation.tokens[0]
      && this.fragmentInformation.tokens[0].map)
    {
      const range = new vscode.Range(
        this.fragmentInformation.tokens[0].map[0], 0,
        this.fragmentInformation.tokens[0].map[0], 0
        );
      this.command = {
        command: 'vscode.open',
        title: 'Browse to fragment',
        tooltip: 'Browse to fragment',
        arguments: [
          this.fragmentInformation.env.literateUri,
          {
            selection: range,
            preserveFocus: false
          }
        ]
      };
    }
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
                fragmentInfo));
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
                  fragmentInfo
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
    let fragmentLocation = this.fragmentRepository.getFragmentTagLocation(document, currentLine, position);
    if(fragmentLocation.fragment && !fragmentLocation.root)
    {
      let fragment = fragmentLocation.fragment;
      let range = fragmentLocation.range;
      return new vscode.Hover(
        new vscode.MarkdownString(`~~~ ${fragment.lang}\n${fragment.code}\n~~~`, true),
        range
        );
    }
    return null;
  }
}

function protectFragmentTags(rendered : string) {
  function cleanHighlights(match : string, _: number, __: string)
  {
    let internal = match.replaceAll(FRAGMENT_HTML_CLEANUP_RE, "$2");
    return `<span class="literate-tag-name">${internal}</span>`;
  }
  return rendered
    .replaceAll(
      FRAGMENT_HTML_RE,
      cleanHighlights
    );
}

function renderCodeFence(tokens : Token[],
             idx : number,
             options : MarkdownIt.Options,
             env : any,
             slf : Renderer) {
  let rendered = '';
  if (oldFence && tokens[idx].info.indexOf("SETTINGS")<0) {
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
          fileName = fileName || '';
          fileName = fileName.trim();
          rendered = protectFragmentTags(rendered);
          rendered =
`<div class="codefragment">
<div class="fragmentname">&lt;&lt;${name}&gt;&gt;${root}${add} ${fileName}</div>
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
  const foundLiterateFiles = await getLiterateFileUris(workspaceFolder);
  try {
    for (let fl of foundLiterateFiles) {
      const text = await getFileContent(fl);
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
          let colon = match.groups.colon;
          let name = match.groups.tagName;
          let root = match.groups.root;
          let add = match.groups.add;
          let fileName = match.groups.fileName;
          let extraSettings = match.groups.extraSettings;
          if(lang && !match.groups.colon) {
            let msg = `Missing colon for fragment: ${name}. ${env.literateFileName}${linenumber}`;
            const diag = createErrorDiagnostic(token, msg);
            updateDiagnostics(env.literateUri, diagnostics, diag);
          }
          
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
            if (fragments.has(name)) {
              if(!overwriteAttempts.includes(name))
              {
                let msg = `Trying to overwrite existing fragment fragment ${name}. ${env.literateFileName}${linenumber}`;
                const diag = createErrorDiagnostic(token, msg);
                updateDiagnostics(env.literateUri, diagnostics, diag);
                overwriteAttempts.push(name);
              }
            }
            else {
              if (!fileName && name.indexOf(".*") > -1 ) {
                if(!missingFilenames.includes(name)) {
                  let msg = `Expected filename for star fragment ${name}`;
                  const diag = createErrorDiagnostic(token, msg);
                  updateDiagnostics(env.literateUri, diagnostics, diag);
                  missingFilenames.push(name);
                }
              }
              if(fileName && name.indexOf(".*")===-1) {
                  let msg = `Unexpected filename for non-star fragment ${name}`;
                  const diag = createErrorDiagnostic(token, msg);
                  updateDiagnostics(env.literateUri, diagnostics, diag);
              }
              if(fileName) {
                fileName = fileName.replace(/\s+\$/, "");
              }
              let sourceTemplateUri : vscode.Uri | undefined = undefined;
              if(extraSettings) {
                let settings = extraSettings.split(";");
                for(let setting of settings)
                {
                  setting = setting.trim();
                  if(setting.startsWith("template"))
                  {
                    let settingParts = setting.split("=");
                    const sourceTemplateFilePattern : vscode.RelativePattern = new vscode.RelativePattern(workspaceFolder, settingParts[1]);
                    const _foundSourceTemplateFile = await vscode.workspace
                      .findFiles(sourceTemplateFilePattern)
                      .then(files => Promise.all(files.map(file => file)));
                    if(_foundSourceTemplateFile.length===1)
                    {
                      sourceTemplateUri = _foundSourceTemplateFile[0];
                    }
                  }
                }
              }
              let code = token.content;
              let fragmentInfo: FragmentInformation = {
                lang: lang,
                literateFileName: env.literateFileName,
                sourceFileName: fileName,
                templateFileName: sourceTemplateUri,
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
            let range = fragmentUsageRange(fragmentInfo.tokens[0], tagName);
            const diag = createErrorDiagnostic(fragmentInfo.tokens[0], msg, range);
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
    if (name.endsWith(".*")) {
      let fragmentInfo = fragments.get(name) || undefined;
      if (fragmentInfo && fragmentInfo.sourceFileName) {
        let sourceTemplate = '[CODE]';
        if(fragmentInfo.templateFileName) {
          sourceTemplate = await getFileContent(fragmentInfo.templateFileName);
        }
        let code = sourceTemplate.replace("[CODE]", fragmentInfo.code);
        let fixed = '';
        if(os.platform()==='win32')
        {
          const lf2crlf = /([^\r])\n/g;
          fixed = code.replaceAll(lf2crlf, '$1\r\n');
        } else {
          const crlf2lf = /\r\n/g;
          fixed = code.replaceAll(crlf2lf, '\n');
        }
        const encoded = Buffer.from(fixed, 'utf-8');
        let fileName = fragmentInfo.sourceFileName.trim();
        const fileUri = vscode.Uri.joinPath(folderUri, fileName);
        try {
          await vscode.workspace.fs.writeFile(fileUri, encoded);
        } catch(writeError)
        {
          console.log(writeError);
        }
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
export class FragmentLocation
{
  readonly rangeExclusive : vscode.Range;
  readonly valid : boolean;

  constructor(
    public readonly name : string,
    public readonly uri: vscode.Uri,
    public readonly range : vscode.Range,
    public readonly fragment : FragmentInformation | undefined,
    public readonly root : string | undefined,
    public readonly add : string | undefined
  )
  {
    this.valid = uri.fsPath.indexOf('not_valid_for_literate')===-1;
    if(name.startsWith(OPENING)) {
      this.rangeExclusive = new vscode.Range(
        range.start.line, range.start.character + 2,
        range.end.line, range.end.character - 2
      );
    }
    else
    {
      this.rangeExclusive = range;
    }
  }
}
const unsetFragmentLocation =
    new FragmentLocation(
      '',
      vscode.Uri.file('not_valid_for_literate'),
      new vscode.Range(0,0,0,0),
      undefined,
      undefined,
      undefined
    );

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
                                         writeOutHtml,
                                         grabbedStateList.list,
                                         this.md);
              this.diagnostics.clear();
              fragments.map = await handleFragments(folder,
                                                    grabbedStateList.list,
                                                    this.diagnostics,
                                                    false,
                                                    undefined);
              this.diagnostics.clear();
              await handleFragments(folder,
                                    grabbedStateList.list,
                                    this.diagnostics,
                                    true,
                                    writeSourceFiles);
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
      if(key === workspaceFolder.name)
      {
        fragmentMap = value;
        }
      }
    );
  
    return fragmentMap;
  }

  getFragmentTagLocation(
    document : vscode.TextDocument,
    currentLine : vscode.TextLine,
    position : vscode.Position
  ) : FragmentLocation
  {
    const workspaceFolder : vscode.WorkspaceFolder | undefined = determineWorkspaceFolder(document);
    const matchesOnLine = [...currentLine.text.matchAll(FRAGMENT_USE_IN_CODE_RE)];
    for(const match of matchesOnLine)
    {
      if(!match || !match.groups) {
        continue;
      }
      const tagName = `${OPENING}${match.groups.tagName}${CLOSING}`;
      const foundIndex = currentLine.text.indexOf(tagName);
      if(foundIndex>-1) {
        if(foundIndex <= position.character && position.character <= foundIndex + tagName.length)
        {
          const startPosition = new vscode.Position(currentLine.lineNumber, foundIndex);
          const endPosition = new vscode.Position(currentLine.lineNumber, foundIndex + tagName.length);
          let range : vscode.Range = new vscode.Range(startPosition, endPosition);
          let fragment : FragmentInformation | undefined;
          if(workspaceFolder) {
            const fragments = theOneRepository.getFragments(workspaceFolder).map;
            fragment = fragments.get(match.groups.tagName) || undefined;
          }
          return new FragmentLocation(match.groups.tagName, document.uri, range, fragment, match.groups.root, match.groups.add);
        }
      }
    }
  
    return unsetFragmentLocation;
  }
  getTokenAtPosition(
    document : vscode.TextDocument,
    range : vscode.Range
  ) : TokenUsage
  {
    const workspaceFolder : vscode.WorkspaceFolder | undefined = determineWorkspaceFolder(document);
    if(!workspaceFolder)
    {
      return emptyToken;
    }
    const state = this.getDocumentState(document);
    for(const token of state.gstate.tokens)
    {
      if(token.map) {
        const tokenRange = new vscode.Range(token.map[0], 0, token.map[1], 1024);
        if(tokenRange.contains(range))
        {
          let tokenUsage : TokenUsage = {
            token : token,
          };
          return tokenUsage;
        }
      }
    }
    return emptyToken;
  }
  getWorkspaceState(workspaceFolder : vscode.WorkspaceFolder) : GrabbedStateList
  {
    let grabbedState : GrabbedStateList = new GrabbedStateList();
    this.grabbedStateForWorkspaceFolders.forEach(
      (value, key, _) =>
      {
        if(key === workspaceFolder.name)
        {
          grabbedState = value;
          }
        }
      );
  
    return grabbedState;
  }
  getDocumentState(document: vscode.TextDocument) : GrabbedState
  {
    let grabbedState : GrabbedState = emptyState;
    const ws = determineWorkspaceFolder(document);
    if(ws) {
      const workspaceState = this.getWorkspaceState(ws);
      for(const state of workspaceState.list)
      {
        if(document.uri.path === state.literateUri.path)
        {
          grabbedState = state;
        }
      }
    }
  
    return grabbedState;
  }
  getReferenceLocations(
    workspaceFolder : vscode.WorkspaceFolder,
    fragmentName : string
  ) : vscode.Location[]
  {
    const fragmentTag = OPENING+fragmentName+CLOSING;
    let locations = new Array<vscode.Location>();
    let grabbedStateList = this.getWorkspaceState(workspaceFolder).list;
  
    for(const grabbedState of grabbedStateList)
    {
      for(const token of grabbedState.gstate.tokens)
      {
        if(token.map)
        {
          if(token.content.indexOf(fragmentTag) > -1)
          {
            const lines = token.content.split("\n");
            let idx = token.type === 'fence' ? 1 : 0;
            for(const line of lines) {
              let offset = line.indexOf(fragmentTag);
              while(offset>-1) {
                let range = new vscode.Range(
                  token.map[0] + idx,
                  offset,
                  token.map[0] + idx,
                  offset + fragmentTag.length
                );
                let location = new vscode.Location(grabbedState.literateUri, range);
                locations.push(location);
                offset = line.indexOf(fragmentTag, offset + 5);
              }
              idx++;
            }
          }
        }
      }
    }
    return locations;
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
export class LiterateRenameProvider implements vscode.RenameProvider
{
    constructor(public readonly repository : FragmentRepository) {}

    public async provideRenameEdits(
        document : vscode.TextDocument,
        position : vscode.Position,
        newName : string,
        _ : vscode.CancellationToken
    )
    {
        let workspaceEdit = new vscode.WorkspaceEdit();
        const workspaceFolder : vscode.WorkspaceFolder | undefined = determineWorkspaceFolder(document);
        if(!workspaceFolder) { return workspaceEdit; }
        let fragmentLocation = this.repository.getFragmentTagLocation(
          document,
          document.lineAt(position.line),
          position
        );
        if(fragmentLocation.valid)
        {
            const foundLiterateFiles = await getLiterateFileUris(workspaceFolder);
            try {
                for (let fl of foundLiterateFiles) {
                    const text = await getFileContent(fl);
                    const lines = text.split("\n");
                    let lineNumber = 0;
                    for(const line of lines)
                    {
                        let fromIdx = 0;
                        while(true)
                        {
                            let foundIdx = line.indexOf(fragmentLocation.name, fromIdx);
                            if(foundIdx===-1)
                            {
                                break;
                            }
                            let foundRange = new vscode.Range(lineNumber, foundIdx, lineNumber, foundIdx + fragmentLocation.name.length);
                            workspaceEdit.replace(
                                fl,
                                foundRange,
                                newName
                            );
                            fromIdx += foundIdx + fragmentLocation.name.length;
        
                        }
                        lineNumber++;
                    }
                }
            } catch(error)
            {
                console.log(error);
            }
        }
        
        return workspaceEdit;
    }
}
export class LiterateCodeActionProvider implements vscode.CodeActionProvider
{
    constructor(public readonly repository : FragmentRepository) {}
    public provideCodeActions(
        document : vscode.TextDocument,
        _: vscode.Range,
        context : vscode.CodeActionContext,
        __ : vscode.CancellationToken
    ) : Thenable<vscode.CodeAction[]>
    {
        let codeActions = new Array<vscode.CodeAction>();
        for(const diag of context.diagnostics)
        {
            if(diag.message.indexOf("Could not find fragment")>-1)
            {
                let fragmentLocation = this.repository.getFragmentTagLocation(document, document.lineAt(diag.range.start), diag.range.start);
                let action = new vscode.CodeAction(`Create fragment for ${OPENING}${fragmentLocation.name}${CLOSING}`, context.only ? context.only : vscode.CodeActionKind.Refactor);
                action.command = {command: 'literate.create_fragment_for_tag', title: `Create fragment for ${OPENING}${fragmentLocation.name}${CLOSING}`, arguments : [diag.range]};
                codeActions.push(action);
            }
        }
        return Promise.resolve(codeActions);
    }
}
export class LiterateDefinitionProvider implements vscode.DefinitionProvider
{
    constructor(
        private readonly repository : FragmentRepository
    ) {}
    public provideDefinition
        (
            document : vscode.TextDocument,
            position : vscode.Position,
            _ : vscode.CancellationToken
        )
    {
        const fragmentLocation = this.repository.getFragmentTagLocation(
            document,
            document.lineAt(position),
            position
        );
        if(fragmentLocation && fragmentLocation.fragment)
        {
            let map = fragmentLocation.fragment.tokens[0].map;
            if(map) {
                let definitionPosition = new vscode.Position(map[0], 0);
                return new vscode.Location(
                    fragmentLocation.fragment.env.literateUri,
                    definitionPosition
                );
            }
        }
        return null;
    }
}
export class LiterateReferenceProvider implements vscode.ReferenceProvider
{
    constructor(
        private readonly repository : FragmentRepository
    ) {}
    public async provideReferences(
        document : vscode.TextDocument,
        position : vscode.Position,
        __: { includeDeclaration : boolean},
        _ : vscode.CancellationToken
    )
    {
        const fragmentLocation = this.repository.getFragmentTagLocation(
            document,
            document.lineAt(position),
            position
        );
    
        const workspaceFolder = determineWorkspaceFolder(document);
    
        if(workspaceFolder)
        {
            return await this.repository.getReferenceLocations(
                workspaceFolder,
                fragmentLocation.name
            );
        }
    
        return null;
    
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
  theOneRepository = new FragmentRepository(context);
  await theOneRepository.processLiterateFiles(undefined);
  context.subscriptions.push(theOneRepository);
  let literateProcessDisposable = vscode.commands.registerCommand(
    'literate.process',
    async function () {
      theOneRepository.processLiterateFiles(undefined);
      return vscode.window.setStatusBarMessage("Literate Process completed", 5000);
  });
  
  context.subscriptions.push(literateProcessDisposable);
  let literateCreateFragmentForTagDisposable = vscode.commands.registerCommand(
    'literate.create_fragment_for_tag',
    async function (range? : vscode.Range) {
      createFragmentForTag(range);
    }
  );
  
  context.subscriptions.push(literateCreateFragmentForTagDisposable);
  let literateSplitFragmentDisposable = vscode.commands.registerCommand(
    'literate.split_fragment',
    async function (position? : vscode.Position) {
      splitFragment(position);
    }
  );
  
  context.subscriptions.push(literateSplitFragmentDisposable);
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
      vscode.languages.registerDefinitionProvider(
          'markdown',
          new LiterateDefinitionProvider(theOneRepository)
      )
  );
  context.subscriptions.push(
      vscode.languages.registerReferenceProvider(
          'markdown',
          new LiterateReferenceProvider(theOneRepository)
      )
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider('markdown', new FragmentHoverProvider(theOneRepository))
  );

  context.subscriptions.push(
    vscode.languages.registerRenameProvider('markdown', new LiterateRenameProvider(theOneRepository))
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider('markdown', new LiterateCodeActionProvider(theOneRepository))
  );
  console.log('Ready to do some Literate Programming');

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
function createErrorDiagnostic(token: Token, message: string, range? : vscode.Range) : vscode.Diagnostic {
  range = range ? range : fragmentRange(token);
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
 * Give the location of the last line in the literate document that contains the
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
function fragmentUsageRange(token : Token, tagName : string) : vscode.Range
{
  let startLineNumber = locationOfFragment(token);
  const lines = token.content.split('\n');
  let index : number = 0;
  for(const line of lines)
  {
    startLineNumber++;
    index = line.indexOf(tagName);
    if(index > -1)
    {
      break;
    }
  }
  let start = new vscode.Position(startLineNumber, index - 2);
  let end = new vscode.Position(startLineNumber, index + tagName.length + 2);
  return new vscode.Range(start, end);
}
async function getLiterateFileUris(
  workspaceFolder : vscode.WorkspaceFolder
) : Promise<vscode.Uri[]>
{
  const literateFilesInWorkspace : vscode.RelativePattern =
        new vscode.RelativePattern(workspaceFolder, '**/*.literate');
  const _foundLiterateFiles = await vscode.workspace
        .findFiles(literateFilesInWorkspace)
        .then(files => Promise.all(files.map(file => file)));
  let foundLiterateFiles = new Array<vscode.Uri>();
  const index = _foundLiterateFiles.find(uri => uri.path.endsWith('index.literate'));
  if(!index)
  {
    return _foundLiterateFiles;
  }
  const md = createMarkdownItParserForLiterate();
  const text = await getFileContent(index);
  const env: GrabbedState = { literateFileName: 'index.literate', literateUri: index, gstate: new StateCore('', md, {}) };
  const _ = md.render(text, env);
  let links = new Array<string>();
  let bulletListOpen = false;
  let idx = 0;
  for(let token of env.gstate.tokens)
  {
    if(token.type==='bullet_list_open')
    {
      bulletListOpen = true;
    }
    if(token.type==='bullet_list_close')
    {
      bulletListOpen = false;
    }
    if(bulletListOpen && token.type==='list_item_open')
    {
      let inline = env.gstate.tokens[idx+2];
      if(inline.children && inline.children[0].attrs)
      {
        try {
          const currentUri = inline.children[0].attrs[0][1];
          let path = currentUri.replace("html", "literate");
          const foundUri = _foundLiterateFiles.find(uri => uri.path.endsWith(path));
          if(foundUri)
          {
            foundLiterateFiles.push(foundUri);
          }
        } catch(_) {}
      }
    }
    idx++;
  }
  const finalCheck = foundLiterateFiles.find(uri => uri.path.endsWith('index.literate'));
  if(!finalCheck)
  {
    foundLiterateFiles.splice(0, 0, index);
  }
  for(let token of env.gstate.tokens)
  {
    if(token.type==='fence' && token.tag==='code' && token.info.indexOf("SETTINGS")>=0)
    {
      const lines = token.content.split("\n");
      for(let line of lines) {
        line = line.trim();
        if(line.startsWith("template")) {
          let parts = line.split("=");
          const templateFileInWorkspace : vscode.RelativePattern =
          new vscode.RelativePattern(workspaceFolder, parts[1]);
          const _foundHtmlTemplateFile = await vscode.workspace
            .findFiles(templateFileInWorkspace)
            .then(files => Promise.all(files.map(file => file)));
          console.log(_foundHtmlTemplateFile);
          if(_foundHtmlTemplateFile.length===1) {
            htmlTemplateFile = _foundHtmlTemplateFile[0];
          }
        }
        else if(line.startsWith("authors")) {
          let parts = line.split("=");
          authors = parts[1];
        }
      }
    }
  }
  return foundLiterateFiles;
}
async function writeOutHtml
      (fname : string,
       folderUri : vscode.Uri,
       rendered : string) : Promise<void>
{
  let html = '';
  const getContent = async () => {
    let _html = '';
    if(htmlTemplateFile) {
      _html = await getFileContent(htmlTemplateFile);
    } else {
      _html =
`<html>
<head>
  <meta name="description" content="A Literate Program written with the Literate Programming vscode extension by Nathan 'jesterKing' Letwory and contributors" />
  <meta property="og:description" content="A Literate Program written with the Literate Programming vscode extension by Nathan 'jesterKing' Letwory and contributors" />
  <link rel="stylesheet" type="text/css" href="./style.css">
  [AUTHORS]
</head>
<body>
[CONTENT]
</body>
</html>`;
    }
    return _html;
  };
  html = await getContent();

  let authorlist = authors.split(";");
  let metaAuthors = '';
  for(let author of authorlist) {
    metaAuthors += `<meta name="author" content="${author}">`;
  }

  html = html
    .replace("[CONTENT]", rendered)
    .replace("[AUTHORS]", metaAuthors);

  if(os.platform()==='win32'){
    const lf2crlf = /([^\r])\n/g;
    html = html.replaceAll(lf2crlf, '$1\r\n');
  } else {
    const crlf2lf = /\r\n/g;
    html = html.replaceAll(crlf2lf, '\n');
  }
  const encoded = Buffer.from(html, 'utf-8');
  fname = fname.replace(".literate", ".html");
  const fileUri = vscode.Uri.joinPath(folderUri, fname);
  return Promise.resolve(vscode.workspace.fs.writeFile(fileUri, encoded));
};
async function getFileContent(
  file : vscode.Uri
) : Promise<string>
{
  const currentContent = (() =>
      {
          for(const textDocument of vscode.workspace.textDocuments) {
              if(vscode.workspace.asRelativePath(file) === vscode.workspace.asRelativePath(textDocument.uri)) {
                  return textDocument.getText();
              }
          }
          return '';
      }
  )();
  const content = currentContent ? null : await vscode.workspace.fs.readFile(file);
  const text = currentContent ? currentContent : new TextDecoder('utf-8').decode(content);
  return text;
}
function createFragmentForTag(range? : vscode.Range)
{
  let activeEditor = vscode.window.activeTextEditor;
  if(activeEditor)
  {
    const document = activeEditor.document;
    const position = range ? range.start : activeEditor.selection.active;
    const fragmentLocation = theOneRepository.getFragmentTagLocation(
      document,
      document.lineAt(position),
      position);
    const tokenUsage = theOneRepository.getTokenAtPosition(
      document,
      fragmentLocation.range);
    if(tokenUsage.token && tokenUsage.token.map)
    {
      let workspaceEdit = new vscode.WorkspaceEdit();
      let langId : string = 'LANGID';
      if(tokenUsage.token.type === 'fence' && tokenUsage.token.map)
      {
        let match = tokenUsage.token.info.match(FRAGMENT_RE);
        if(match && match.groups) {
          langId = match.groups.lang;
        }
      }
      let newFragment = `\n${FENCE} ${langId} : ${OPENING}${fragmentLocation.name}${CLOSING}=\n${FENCE}\n`;
      workspaceEdit.insert(
        document.uri,
        new vscode.Position(tokenUsage.token.map[1], 0),
        newFragment
        );
      vscode.workspace.applyEdit(workspaceEdit);
    }
  }
}
function splitFragment(position_? : vscode.Position)
{
  let activeEditor = vscode.window.activeTextEditor;
  if(activeEditor)
  {
    const document = activeEditor.document;
    const position = position_ ? position_ : activeEditor.selection.active;
    const tokenUsage = theOneRepository.getTokenAtPosition(
      document,
      new vscode.Range(position, position));
    if(tokenUsage.token && tokenUsage.token.type === 'fence')
    {
      let match = tokenUsage.token.info.match(FRAGMENT_RE);
      if(match && match.groups)
      {
        let langId = match.groups.lang.trim();
        let tagName = match.groups.tagName.trim();
        let textToInsert = `${FENCE}\n\n${FENCE}${langId} : ${OPENING}${tagName}${CLOSING}=+\n`;
        let workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.insert(
          document.uri,
          new vscode.Position(position.line+1, 0),
          textToInsert
          );
        vscode.workspace.applyEdit(workspaceEdit);
      }
    }
  }
}
export function deactivate() {}
