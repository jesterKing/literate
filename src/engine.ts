import MarkdownIt = require('markdown-it');
import Token = require('markdown-it/lib/token');
import hljs from 'highlight.js';

export interface SourceDocument { path: string; text: string; }
export interface GenerationDiagnostic { path: string; line: number; column: number; message: string; }
export interface GeneratedFile { path: string; content: string; }
export interface ProjectInspection { documents: string[]; templates: string[]; fragments: FragmentInspection[]; }
export interface FragmentInspection {
    name: string;
    language: string;
    output?: string;
    template?: string;
    definitions: { path: string; line: number; column: number }[];
    references: { name: string; path: string; line: number; column: number }[];
}
export interface GenerationResult {
    files: GeneratedFile[];
    diagnostics: GenerationDiagnostic[];
    inspection: ProjectInspection;
}

export const discoveryExcludedDirectories: readonly string[] = Object.freeze([
    '.git', 'node_modules', 'out', 'dist', '.yarn', '.vscode-test'
]);

interface Location { path: string; line: number; column: number; }
interface Header { name: string; language: string; append: boolean; output?: string; template?: string; }
interface Part { content: string; location: Location; definition: Location; columns: number[]; }
interface Fragment { header: Header; parts: Part[]; location: Location; }

/** Canonical workspace-relative POSIX path; never permits escaping the workspace. */
export function safeRelativePath(value: string): string | undefined {
    if (!value || /^(?:\/|[a-zA-Z]:)/.test(value) || /[\\\x00-\x1f]/.test(value)) { return undefined; }
    const parts: string[] = [];
    for (const part of value.split('/')) {
        if (!part || part === '.') { continue; }
        if (part === '..') {
            if (!parts.length) { return undefined; }
            parts.pop();
        } else {
            if (/[<>:"|?*]/.test(part) || /[. ]$/.test(part)) { return undefined; }
            const device = part.split('.')[0].replace(/ +$/, '');
            if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$/i.test(device)) { return undefined; }
            parts.push(part);
        }
    }
    return parts.length ? parts.join('/') : undefined;
}

/** Paths are already normalized before computing portable collision keys. */
function pathKey(path: string): string { return path.toLowerCase(); }

function ancestorConflict(left: string, right: string): boolean {
    return left.startsWith(right + '/') || right.startsWith(left + '/');
}

const fragmentHeader = /^\s*(?:(\S+)\s*:\s*|:\s*)?<<([^<>\r\n]+)>>=(\+)?\s*(.*?)\s*$/;
const outputFilename = /^(.*?)\s+\$(?:\s+|$)|^\$(?:\s+|$)/;

function sourceNulDiagnostic(document: SourceDocument): GenerationDiagnostic | undefined {
    const offset = document.text.indexOf('\0');
    if (offset < 0) { return undefined; }
    const lines = document.text.slice(0, offset).split(/\r\n|\r|\n/);
    return {
        path: document.path, line: lines.length - 1, column: lines[lines.length - 1].length,
        message: 'Invalid output path or source text: NUL characters are not allowed'
    };
}

export interface FragmentTag { name: string; start: number; end: number; modifier?: string; }

export function scanFragmentTags(text: string): FragmentTag[] {
    const tags: FragmentTag[] = [];
    const pattern = /\\<<|<<([^<>\r\n]+)>>(=\+?|\+)?/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
        if (match[1] === undefined) { continue; }
        tags.push({ name: match[1], start: match.index,
            end: match.index + match[1].length + 4, modifier: match[2] });
    }
    return tags;
}
export interface FragmentHeader {
    name: string; language: string; append: boolean; remainder: string;
    tagStart: number; tagEnd: number;
}

export function parseFragmentHeader(info: string): FragmentHeader | undefined {
    const match = fragmentHeader.exec(info);
    if (!match || !match[2].trim()) { return undefined; }
    const afterLanguage = match[1] ? info.indexOf(match[1]) + match[1].length : 0;
    const tagStart = info.indexOf('<<', afterLanguage);
    return { name: match[2], language: match[1] || '', append: !!match[3], remainder: match[4],
        tagStart, tagEnd: tagStart + match[2].length + 4 };
}
/** Index first, then linked documents, then remaining paths sorted; preserves input objects. */
export function orderSourceDocuments(documents: SourceDocument[]): SourceDocument[] {
    const paths = new Map<string, number>();
    for (const document of documents) {
        const diagnostic = sourceNulDiagnostic(document);
        if (diagnostic) { throw new Error(`${diagnostic.path}: ${diagnostic.message}`); }
    }
    const canonical = (document: SourceDocument): string => safeRelativePath(document.path) ?? document.path;
    paths.set('index.literate', 0);
    const index = documents.find(document => canonical(document) === 'index.literate');
    if (index) {
        for (const token of new MarkdownIt().parse(index.text, {})) {
            for (const child of token.children || []) {
                if (child.type !== 'link_open') { continue; }
                const href = child.attrGet('href');
                if (!href) { continue; }
                let target = href.split(/[?#]/)[0];
                try { target = decodeURIComponent(target); } catch { continue; }
                const path = safeRelativePath(target.replace(/\.html$/, '.literate'));
                if (path && !paths.has(path)) { paths.set(path, paths.size); }
            }
        }
    }
    return [...documents].sort((a, b) => {
        const left = canonical(a), right = canonical(b);
        const rank = (paths.get(left) ?? paths.size) - (paths.get(right) ?? paths.size);
        return rank || (left < right ? -1 : left > right ? 1 : 0);
    });
}

/** Discover template dependencies only. Invalid paths or NUL source text throw ordinary Errors. */
export function templateReferences(documents: SourceDocument[]): string[] {
    const references = new Set<string>();
    const md = new MarkdownIt();
    const add = (value: string): void => {
        const path = safeRelativePath(value);
        if (!path) { throw new Error(`Invalid relative path: ${value}`); }
        references.add(path);
    };
    for (const document of documents) {
        const diagnostic = sourceNulDiagnostic(document);
        if (diagnostic) { throw new Error(`${diagnostic.path}: ${diagnostic.message}`); }
        for (const token of md.parse(document.text, {})) {
            if (token.type !== 'fence') { continue; }
            if (token.info.trim() === 'SETTINGS') {
                if (safeRelativePath(document.path) === 'index.literate') {
                    for (const line of token.content.split('\n')) {
                        const setting = /^\s*template\s*=(.*)$/.exec(line);
                        if (setting) { add(setting[1].trim()); }
                    }
                }
                continue;
            }
            const header = fragmentHeader.exec(token.info);
            if (!header) { continue; }
            let settings = header[4];

            const filename = outputFilename.exec(settings);
            if (filename) { settings = settings.slice(filename[0].length); }
            for (const setting of settings.split(';').map(value => value.trim()).filter(Boolean)) {
                const template = /^template\s*=\s*(.*)$/.exec(setting);
                if (template) { add(template[1].trim()); }
            }
        }
    }
    return Array.from(references).sort();
}

/** Replacement values are literal and are never scanned for more placeholders. */
function substitute(template: string, values: Record<string, string>): string {
    return template.replace(/\[(CODE|CONTENT|AUTHORS)\]/g, (match, key: string) =>
        Object.prototype.hasOwnProperty.call(values, key.toLowerCase()) ? values[key.toLowerCase()] : match);
}

const defaultTemplate = `<!DOCTYPE html>
<html>
<head>
  <meta name="description" content="A Literate Program written with the Literate Programming vscode extension by Nathan 'jesterKing' Letwory and contributors" />
  <meta property="og:description" content="A Literate Program written with the Literate Programming vscode extension by Nathan 'jesterKing' Letwory and contributors" />
  <link rel="stylesheet" type="text/css" href="./style.css">
  [AUTHORS]
</head>
<body>
[CONTENT]
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
</script>
</body>
</html>`;

/** Pure, atomic generation. Diagnostic positions are zero-based. */
export function generateProject(documents: SourceDocument[], templates: Record<string, string> = {}): GenerationResult {
    const diagnostics: GenerationDiagnostic[] = [];
    const files: GeneratedFile[] = [];
    const report = (location: Location, message: string): void => {
        diagnostics.push({ ...location, message });
    };
    const md = new MarkdownIt();
    const escape = (value: string): string => md.utils.escapeHtml(value);
    const sources = new Map<string, SourceDocument>();
    const templateMap = new Map<string, string>();
    const sourceKeys = new Set<string>();
    const templateKeys = new Set<string>();
    for (const document of documents) {
        const path = safeRelativePath(document.path);
        const location = { path: document.path, line: 0, column: 0 };
        if (!path) { report(location, 'Invalid source path'); continue; }
        if (sourceKeys.has(pathKey(path))) { report(location, `Duplicate source document: ${path}`); continue; }
        sourceKeys.add(pathKey(path));
        const nul = sourceNulDiagnostic(document);
        if (nul) { diagnostics.push(nul); continue; }
        sources.set(path, { path, text: document.text });
    }
    for (const key of Object.keys(templates).sort()) {
        const path = safeRelativePath(key);
        const location = { path: key, line: 0, column: 0 };
        if (!path) { report(location, 'Invalid template path'); continue; }
        if (templateKeys.has(pathKey(path))) { report(location, `Duplicate template path: ${path}`); continue; }
        templateKeys.add(pathKey(path));
        templateMap.set(path, templates[key]);
    }
    const tokens = new Map<string, Token[]>();
    for (const document of sources.values()) { tokens.set(document.path, md.parse(document.text, {})); }
    const order = orderSourceDocuments(Array.from(sources.values())).map(document => document.path);
    const inspection: ProjectInspection = { documents: order, templates: [], fragments: [] };
    const referencedTemplates = new Set<string>();
    const loadTemplate = (value: string, location: Location): string | undefined => {
        const path = safeRelativePath(value);
        if (!path) { report(location, `Invalid template path: ${value}`); return undefined; }
        referencedTemplates.add(path);
        if (!templateMap.has(path)) { report(location, `Missing template: ${path}`); return undefined; }
        return templateMap.get(path);
    };
    let authors = '';
    let htmlTemplate = defaultTemplate;
    for (const token of tokens.get('index.literate') || []) {
        if (token.type !== 'fence' || token.info.trim() !== 'SETTINGS') { continue; }
        token.content.split('\n').forEach((line: string, index: number) => {
            const match = /^\s*(authors|template)\s*=(.*)$/.exec(line);
            if (!match) { return; }
            const value = match[2].trim();
            if (match[1] === 'authors') { authors = value; }
            else {
                const loaded = loadTemplate(value, { path: 'index.literate', line: (token.map?.[0] || 0) + index + 1, column: 0 });
                if (loaded !== undefined) { htmlTemplate = loaded; }
            }
        });
    }
    const fragments = new Map<string, Fragment>();
    const headers = new Map<Token, Header>();
    const sourceTemplates = new Map<string, string>();
    const outputs = new Set<string>();
    const inputKeys = new Set([...sourceKeys, ...templateKeys]);
    const reserve = (value: string, location: Location): string | undefined => {
        const path = safeRelativePath(value);
        if (!path) { report(location, `Invalid output path: ${value}`); return undefined; }
        const key = pathKey(path);
        if (inputKeys.has(key)) { report(location, `Output collides with input: ${path}`); }
        if (outputs.has(key)) { report(location, `Duplicate output path: ${path}`); }
        for (const input of inputKeys) {
            if (ancestorConflict(key, input)) { report(location, `Output/input ancestor conflict: ${path} and ${input}`); }
        }
        for (const output of outputs) {
            if (ancestorConflict(key, output)) { report(location, `Output ancestor conflict: ${path} and ${output}`); }
        }
        outputs.add(key);
        return path;
    };
    for (const path of order) {
        const sourceLines = sources.get(path)!.text.split(/\r\n|\r|\n/);
        reserve(path.replace(/\.literate$/, '.html'), { path, line: 0, column: 0 });
        for (const token of tokens.get(path) || []) {
            if (token.type !== 'fence' || token.info.trim() === 'SETTINGS' || !token.info.includes('<<')) { continue; }
            const line = token.map?.[0] || 0;
            const location = { path, line, column: Math.max(0, sourceLines[line].indexOf(token.markup)) };
            const match = fragmentHeader.exec(token.info);
            if (!match) { report(location, 'Invalid fragment header (expected language colon and <<name>>= or =+)'); continue; }
            const header: Header = { language: match[1] || '', name: match[2], append: !!match[3] };
            if (!header.name.trim()) { report(location, 'Empty fragment name'); continue; }
            let remainder = match[4];
            const filename = outputFilename.exec(remainder);
            if (filename) {
                header.output = (filename[1] || '').trim();
                remainder = remainder.slice(filename[0].length);
                if (!header.output) { report(location, 'Invalid output path: empty filename'); }
            }
            for (const setting of remainder.split(';').map(value => value.trim()).filter(Boolean)) {
                const template = /^template\s*=\s*(.+)$/.exec(setting);
                if (!template || header.template !== undefined) { report(location, `Invalid fragment setting: ${setting}`); }
                else { header.template = template[1].trim(); }
            }
            headers.set(token, header);
            if (header.template !== undefined) {
                const templatePath = safeRelativePath(header.template);
                if (templatePath) { referencedTemplates.add(templatePath); }
            }
            const part: Part = {
                content: token.content, location: { path, line: location.line + 1, column: 0 }, definition: location,
                columns: token.content.split('\n').map((bodyLine, index) => {
                    const original = sourceLines[location.line + 1 + index] || '';
                    return original.length - bodyLine.length;
                })
            };
            if (header.append) {
                if (header.output !== undefined || header.template !== undefined) { report(location, 'Append fragments cannot specify output or template'); }
                const fragment = fragments.get(header.name);
                if (!fragment) { report(location, `Cannot append to missing fragment: ${header.name}`); }
                else { fragment.parts.push(part); }
                continue;
            }
            if (fragments.has(header.name)) { report(location, `Duplicate fragment: ${header.name}`); continue; }
            if (header.name.endsWith('.*')) {
                if (!header.output) { report(location, `Missing filename for top-level fragment: ${header.name}`); }
                else { header.output = reserve(header.output, location); }
            } else if (header.output !== undefined || header.template !== undefined) {
                report(location, `Only top-level fragments may specify output or template: ${header.name}`);
            }
            if (header.template !== undefined) {
                const template = loadTemplate(header.template, location);
                if (template !== undefined) { sourceTemplates.set(header.name, template); }
            }
            fragments.set(header.name, { header, parts: [part], location });
        }
    }
    const replaceReferences = (part: Part, replace: (name: string, modifier: string | undefined, at: Location, prefix: string) => string): string => {
        let result = '', cursor = 0;
        for (const tag of scanFragmentTags(part.content)) {
            const before = part.content.slice(0, tag.start);
            const prefix = before.slice(before.lastIndexOf('\n') + 1);
            const line = before.split('\n').length - 1;
            const at = { path: part.location.path, line: part.location.line + line, column: prefix.length + part.columns[line] };
            result += part.content.slice(cursor, tag.start) + replace(tag.name, tag.modifier, at, prefix);
            cursor = tag.end + (tag.modifier?.length || 0);
        }
        return result + part.content.slice(cursor);
    };
    inspection.templates = Array.from(referencedTemplates).sort();
    for (const { header, parts } of fragments.values()) {
        const entry: FragmentInspection = {
            name: header.name, language: header.language,
            definitions: parts.map(part => ({ ...part.definition })), references: []
        };
        if (header.output !== undefined) {
            const output = safeRelativePath(header.output);
            if (output) { entry.output = output; }
        }
        if (header.template !== undefined) {
            const template = safeRelativePath(header.template);
            if (template) { entry.template = template; }
        }
        for (const part of parts) {
            replaceReferences(part, (name, _modifier, at) => {
                entry.references.push({ name, ...at });
                return '';
            });
        }
        inspection.fragments.push(entry);
    }
    const expanded = new Map<string, string>();
    const visiting: string[] = [];
    const expand = (name: string, location: Location): string => {
        if (expanded.has(name)) { return expanded.get(name)!; }
        const fragment = fragments.get(name);
        if (!fragment) { report(location, `Missing fragment: ${name}`); return ''; }
        if (visiting.includes(name)) { report(location, `Fragment cycle: ${visiting.concat(name).join(' -> ')}`); return ''; }
        visiting.push(name);
        const content = fragment.parts.map(part => replaceReferences(part, (reference, modifier, at, prefix) => {
            if (modifier) { report(at, `Invalid definition operator on reference: ${reference}`); }
            const replacement = expand(reference, at).replace(/\n$/, '');
            const indent = /^[ \t]*$/.test(prefix) ? prefix : (/[ \t]*$/.exec(prefix)?.[0] || '');
            return replacement.replace(/\n/g, () => '\n' + indent);
        })).join('');
        visiting.pop();
        expanded.set(name, content);
        return content;
    };

    for (const fragment of fragments.values()) { expand(fragment.header.name, fragment.location); }
    if (diagnostics.length) { return { files: [], diagnostics, inspection }; }
    for (const fragment of fragments.values()) {
        if (!fragment.header.output) { continue; }
        const code = expanded.get(fragment.header.name)!.replace(/\\<</g, () => '<<');
        files.push({ path: fragment.header.output, content: substitute(sourceTemplates.get(fragment.header.name) ?? '[CODE]', { code }) });
    }
    md.renderer.rules.fence = (fenceTokens: Token[], index: number) => {
        const token = fenceTokens[index];
        if (token.info.trim() === 'SETTINGS') { return ''; }
        const header = headers.get(token);
        const language = header?.language || token.info.trim().split(/\s+/)[0];
        const code = token.content.replace(/\\<</g, () => '<<');
        if (!header && language === 'mermaid') { return `<pre class="mermaid">\n${escape(code)}</pre>\n`; }
        let rendered = language && hljs.getLanguage(language)
            ? hljs.highlight(code, { language }).value : escape(code);
        if (header) {
            rendered = rendered.replace(/<span class="hljs-comment">.*?<\/span>/gs, () => '');
            rendered = rendered.replace(/&lt;&lt;.*?&gt;&gt;/g, (tag: string) =>
                `<span class="literate-tag-name">${tag.replace(/<\/?span\b[^>]*>/g, () => '')}</span>`);
        }
        const block = `<pre><code>${rendered}</code></pre>\n`;
        if (!header) { return block; }
        const label = escape(`<<${header.name}>>=${header.append ? '+' : ''} ${header.output ? header.output + ' $' : ''}`);
        return `<div class="codefragment">\n<div class="fragmentname">${label}</div>\n<div class="code">\n${block}\n</div>\n</div>`;
    };
    const metaAuthors = authors.split(';').map(author => `<meta name="author" content="${escape(author)}">`).join('');
    for (const path of order) {
        const content = md.renderer.render(tokens.get(path)!, md.options, {});
        files.push({ path: safeRelativePath(path.replace(/\.literate$/, '.html'))!, content: substitute(htmlTemplate, { content, authors: metaAuthors }) });
    }
    for (const file of files) { file.content = file.content.replace(/\r\n|\r/g, '\n'); }
    return { files, diagnostics, inspection };
}
