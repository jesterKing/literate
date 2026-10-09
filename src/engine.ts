import MarkdownIt = require('markdown-it');
import Token = require('markdown-it/lib/token');
import hljs from 'highlight.js';
import { collectAnnotations, PublicationAnnotations } from './publication-annotations';
import { renderScreenCode, renderScreenContribution, screenIndex, renderScreenAnnotation,
    installScreenTermLinks, renderScreenIndexes, screenTermUseAnchors, screenStyle, renderScreenExploration } from './publication-screen';
import { defaultThemeName, getTheme, themeCss } from './themes';

export interface SourceDocument { path: string; text: string; }
export interface GenerationDiagnostic { path: string; line: number; column: number; message: string; code?: string; }
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
    publication: PublicationModel;
}

export interface PublicationLocation { path: string; line: number; column: number; }
export interface PublicationModel {
    documents: { path: string; contributions: string[] }[];
    fragments: { name: string; target: string; contributions: string[] }[];
    contributions: PublicationContribution[];
}
export interface PublicationContribution {
    target: string;
    fragmentTarget: string;
    kind: 'definition' | 'append';
    language: string;
    definition: PublicationLocation;
    tokenIndex: number;
    content: string;
    segments: PublicationSegment[];
}
export type PublicationSegment =
    | { kind: 'text'; text: string }
    | { kind: 'reference'; text: string; name: string;
        start: number; end: number; at: PublicationLocation; modifier?: string;
        resolution: { kind: 'resolved'; target: string } | { kind: 'missing' } };
export const discoveryExcludedDirectories: readonly string[] = Object.freeze([
    '.git', 'node_modules', 'out', 'dist', '.yarn', '.vscode-test'
]);

type Location = PublicationLocation;
interface Header { name: string; language: string; append: boolean; output?: string; template?: string; }
interface Part { content: string; location: Location; definition: Location; columns: number[]; }
interface Fragment { header: Header; parts: Part[]; location: Location; }

export interface ParsedProject {
    annotations: PublicationAnnotations;
    documents: readonly ParsedDocument[];
    diagnostics: GenerationDiagnostic[];
    inspection: ProjectInspection;
    publication: PublicationModel;
}
export interface ParsedDocument {
    path: string;
    source: string;
    tokens: readonly Token[];
    blocks: readonly ParsedDocumentBlock[];
}
export type ParsedDocumentBlock =
    | { kind: 'markdown'; tokenStart: number; tokenEnd: number }
    | { kind: 'contribution'; target: string; tokenIndex: number };
interface CollectionPolicy {
    diagnostics: GenerationDiagnostic[];
    acceptInputs(sourceKeys: Set<string>): void;
    settings(documents: SourceDocument[]): void;
    loadTemplate(path: string, location: Location): string | undefined;
    setAuthors(value: string): void;
    setHtmlTemplate(value: string): void;
    reserve(path: string, location: Location): void;
}
function publicationEncode(value: string): string {
    let encoded = '';
    for (let index = 0; index < value.length; index++) {
        encoded += value.charCodeAt(index).toString(16).padStart(4, '0');
    }
    return encoded;
}
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

export function resolveProjectTheme(documents: SourceDocument[]): { name: string; diagnostics: GenerationDiagnostic[] } {
    let name = defaultThemeName;
    const diagnostics: GenerationDiagnostic[] = [];
    const document = documents.find(value => safeRelativePath(value.path) === 'index.literate');
    if (!document) { return { name, diagnostics }; }
    const nul = sourceNulDiagnostic(document);
    if (nul) { return { name, diagnostics: [nul] }; }
    for (const token of new MarkdownIt().parse(document.text, {})) {
        if (token.type !== 'fence' || token.info.trim() !== 'SETTINGS') { continue; }
        token.content.split('\n').forEach((line: string, index: number) => {
            const match = /^\s*theme\s*=(.*)$/.exec(line);
            if (!match) { return; }
            const value = match[1].trim();
            if (getTheme(value)) { name = value; }
            else {
                diagnostics.push({ path: 'index.literate', line: (token.map?.[0] || 0) + index + 1,
                    column: 0, message: `Unknown theme: ${value}` });
            }
        });
    }
    return { name, diagnostics };
}

/** Replacement values are literal and are never scanned for more placeholders. */
function substitute(template: string, values: Record<string, string>): string {
    return template.replace(/\[(CODE|CONTENT|AUTHORS|THEME|TITLE|PREVIEW)\]/g, (match, key: string) =>
        Object.prototype.hasOwnProperty.call(values, key.toLowerCase()) ? values[key.toLowerCase()] : match);
}

function defaultTemplate(_themeName: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>[TITLE]</title>
  <meta name="description" content="A Literate Program written with the Literate Programming vscode extension by Nathan 'jesterKing' Letwory and contributors" />
  <meta property="og:description" content="A Literate Program written with the Literate Programming vscode extension by Nathan 'jesterKing' Letwory and contributors" />
  [THEME]
  [AUTHORS]
</head>
<body>
[CONTENT]
[PREVIEW]
</body>
</html>`;
}

function collectProject(documents: SourceDocument[], policy?: CollectionPolicy) {
    const diagnostics = policy?.diagnostics ?? [];
    const report = (location: Location, message: string, code?: string): void => {
        diagnostics.push({ ...location, message, ...(code === undefined ? {} : { code }) });
    };
    const md = new MarkdownIt();
    const sources = new Map<string, SourceDocument>();
    const sourceKeys = new Set<string>();
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
    policy?.acceptInputs(sourceKeys);
    const tokens = new Map<string, Token[]>();
    for (const document of sources.values()) { tokens.set(document.path, md.parse(document.text, {})); }
    const order = orderSourceDocuments(Array.from(sources.values())).map(document => document.path);
    const inspection: ProjectInspection = { documents: order, templates: [], fragments: [] };
    const referencedTemplates = new Set<string>();
    const loadTemplate = (value: string, location: Location): string | undefined => {
        const path = safeRelativePath(value);
        if (!path) { report(location, `Invalid template path: ${value}`); return undefined; }
        referencedTemplates.add(path);
        return policy?.loadTemplate(path, location);
    };
    policy?.settings(Array.from(sources.values()));
    for (const token of tokens.get('index.literate') || []) {
        if (token.type !== 'fence' || token.info.trim() !== 'SETTINGS') { continue; }
        token.content.split('\n').forEach((line: string, index: number) => {
            const match = /^\s*(authors|template)\s*=(.*)$/.exec(line);
            if (!match) { return; }
            const value = match[2].trim();
            if (match[1] === 'authors') { policy?.setAuthors(value); }
            else {
                const loaded = loadTemplate(value, { path: 'index.literate', line: (token.map?.[0] || 0) + index + 1, column: 0 });
                if (loaded !== undefined) { policy?.setHtmlTemplate(loaded); }
            }
        });
    }
    const fragments = new Map<string, Fragment>();
    const headers = new Map<Token, Header>();
    const accepted: { header: Header; part: Part; tokenIndex: number }[] = [];
    const sourceTemplates = new Map<string, string>();
    const reserve = (value: string, location: Location): string | undefined => {
        const path = safeRelativePath(value);
        if (!path) { report(location, `Invalid output path: ${value}`); return undefined; }
        policy?.reserve(path, location);
        return path;
    };
    for (const path of order) {
        const sourceLines = sources.get(path)!.text.split(/\r\n|\r|\n/);
        if (policy) { reserve(path.replace(/\.literate$/, '.html'), { path, line: 0, column: 0 }); }
        for (const [tokenIndex, token] of (tokens.get(path) || []).entries()) {
            if (token.type !== 'fence' || token.info.trim() === 'SETTINGS'
                || /^(TERM|NOTE)(?:\s|$)/.test(token.info.trim()) || !token.info.includes('<<')) { continue; }
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
                else {
                    fragment.parts.push(part);
                    accepted.push({ header, part, tokenIndex });
                }
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
            accepted.push({ header, part, tokenIndex });
        }
    }
    function* references(part: Part) {
        for (const tag of scanFragmentTags(part.content)) {
            const before = part.content.slice(0, tag.start);
            const prefix = before.slice(before.lastIndexOf('\n') + 1);
            const line = before.split('\n').length - 1;
            const at = { path: part.location.path, line: part.location.line + line, column: prefix.length + part.columns[line] };
            yield { ...tag, at, prefix };
        }
    }
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
            for (const { name, at } of references(part)) {
                entry.references.push({ name, ...at });
            }
        }
        inspection.fragments.push(entry);
    }
    const publication: PublicationModel = {
        documents: order.map(path => ({ path, contributions: [] })),
        fragments: Array.from(fragments.keys(), name => ({
            name, target: 'f-' + publicationEncode(name), contributions: []
        })),
        contributions: []
    };
    const publicationDocuments = new Map(publication.documents.map(document => [document.path, document]));
    const publicationFamilies = new Map(publication.fragments.map(fragment => [fragment.name, fragment]));
    const contributionOrdinals = new Map<string, number>();
    for (const { header, part, tokenIndex } of accepted) {
        const family = publicationFamilies.get(header.name)!;
        const key = publicationEncode(header.name) + '-' + publicationEncode(part.definition.path);
        const ordinal = (contributionOrdinals.get(key) || 0) + 1;
        contributionOrdinals.set(key, ordinal);
        const target = 'c-' + key + '-' + ordinal;
        const segments: PublicationSegment[] = [];
        let cursor = 0;
        for (const { name, start, end, modifier, at } of references(part)) {
            if (start > cursor) { segments.push({ kind: 'text', text: part.content.slice(cursor, start) }); }
            const target = publicationFamilies.get(name)?.target;
            const textEnd = end + (modifier?.length || 0);
            segments.push({
                kind: 'reference', text: part.content.slice(start, textEnd), name, start, end, at,
                ...(modifier === undefined ? {} : { modifier }),
                resolution: target === undefined ? { kind: 'missing' } : { kind: 'resolved', target }
            });
            cursor = textEnd;
        }
        if (cursor < part.content.length) { segments.push({ kind: 'text', text: part.content.slice(cursor) }); }
        publication.contributions.push({
            target, fragmentTarget: family.target, kind: header.append ? 'append' : 'definition',
            language: header.language, definition: { ...part.definition }, tokenIndex,
            content: part.content, segments
        });
        family.contributions.push(target);
        publicationDocuments.get(part.definition.path)!.contributions.push(target);
    }
    const contributionsByTarget = new Map(publication.contributions.map(value => [value.target, value]));
    const parsedDocuments: ParsedDocument[] = order.map(path => {
        const documentTokens = tokens.get(path)!;
        const targets = new Map(publicationDocuments.get(path)!.contributions.map(target => {
            const contribution = contributionsByTarget.get(target)!;
            return [contribution.tokenIndex, target] as const;
        }));
        const blocks: ParsedDocumentBlock[] = [];
        let cursor = 0;
        for (const [tokenIndex, target] of targets) {
            if (cursor < tokenIndex) { blocks.push({ kind: 'markdown', tokenStart: cursor, tokenEnd: tokenIndex }); }
            blocks.push({ kind: 'contribution', target, tokenIndex });
            cursor = tokenIndex + 1;
        }
        if (cursor < documentTokens.length) {
            blocks.push({ kind: 'markdown', tokenStart: cursor, tokenEnd: documentTokens.length });
        }
        return { path, source: sources.get(path)!.text, tokens: documentTokens, blocks };
    });
    const annotations = collectAnnotations(parsedDocuments.map(document => ({
        path: document.path, text: document.source, tokens: document.tokens
    })));
    diagnostics.push(...annotations.diagnostics);
    const parsed: ParsedProject = { documents: parsedDocuments, diagnostics, inspection, publication, annotations };
    return { parsed, md, tokens, order, fragments, headers, sourceTemplates, references };
}

export function parseProject(documents: SourceDocument[]): ParsedProject {
    return collectProject(documents).parsed;
}
/** Pure, atomic generation. Diagnostic positions are zero-based. */
export function generateProject(documents: SourceDocument[], templates: Record<string, string> = {}): GenerationResult {
    const diagnostics: GenerationDiagnostic[] = [];
    const files: GeneratedFile[] = [];
    const report = (location: Location, message: string, code?: string): void => {
        diagnostics.push({ ...location, message, ...(code === undefined ? {} : { code }) });
    };
    const templateMap = new Map<string, string>();
    const templateKeys = new Set<string>();
    const outputs = new Set<string>();
    let inputKeys = new Set<string>();
    let projectTheme = { name: defaultThemeName, diagnostics: [] as GenerationDiagnostic[] };
    let authors = '';
    let htmlTemplate = '';
    const policy: CollectionPolicy = {
        acceptInputs(sourceKeys) {
            for (const key of Object.keys(templates).sort()) {
                const path = safeRelativePath(key);
                const location = { path: key, line: 0, column: 0 };
                if (!path) { report(location, 'Invalid template path'); continue; }
                if (templateKeys.has(pathKey(path))) { report(location, `Duplicate template path: ${path}`); continue; }
                templateKeys.add(pathKey(path));
                templateMap.set(path, templates[key]);
            }
            inputKeys = new Set([...sourceKeys, ...templateKeys]);
        },
        settings(sources) {
            projectTheme = resolveProjectTheme(sources);
            diagnostics.push(...projectTheme.diagnostics);
            htmlTemplate = defaultTemplate(projectTheme.name);
        },
        loadTemplate(path, location) {
            if (!templateMap.has(path)) { report(location, `Missing template: ${path}`); return undefined; }
            return templateMap.get(path);
        },
        setAuthors(value) { authors = value; },
        setHtmlTemplate(value) { htmlTemplate = value; },
        diagnostics,
        reserve(path, location) {
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
        }
    };
    const collected = collectProject(documents, policy);
    const { md, tokens, order, fragments, headers, sourceTemplates, references } = collected;
    const { inspection, publication } = collected.parsed;
    const escape = (value: string): string => md.utils.escapeHtml(value);
    type Reference = ReturnType<typeof references> extends Generator<infer T> ? T : never;
    function* expandParts(parts: Part[]): Generator<Reference, string, string> {
        let content = '';
        for (const part of parts) {
            let cursor = 0;
            for (const reference of references(part)) {
                content += part.content.slice(cursor, reference.start);
                const replacement = (yield reference).replace(/\n$/, '');
                const indent = /[ \t]*$/.exec(reference.prefix)?.[0] || '';
                content += replacement.replace(/\n/g, () => '\n' + indent);
                cursor = reference.end + (reference.modifier?.length || 0);
            }
            content += part.content.slice(cursor);
        }
        return content;
    }
    const expanded = new Map<string, string>();
    const active = new Set<string>();
    type ExpansionFrame = {
        name: string;
        expansion: Generator<Reference, string, string>;
        step: IteratorResult<Reference, string>;
    };
    const frames: ExpansionFrame[] = [];
    const push = (name: string) => {
        const expansion = expandParts(fragments.get(name)!.parts);
        active.add(name);
        frames.push({ name, expansion, step: expansion.next() });
    };
    for (const fragment of fragments.values()) {
        if (expanded.has(fragment.header.name)) { continue; }
        push(fragment.header.name);
        while (frames.length) {
            const frame = frames[frames.length - 1];
            if (frame.step.done) {
                const content = frame.step.value;
                expanded.set(frame.name, content);
                active.delete(frame.name);
                frames.pop();
                const parent = frames[frames.length - 1];
                if (parent) { parent.step = parent.expansion.next(content); }
                continue;
            }
            const { name, modifier, at } = frame.step.value;
            if (modifier) { report(at, `Invalid definition operator on reference: ${name}`); }
            if (expanded.has(name)) {
                frame.step = frame.expansion.next(expanded.get(name)!);
            } else if (!fragments.has(name)) {
                report(at, `Missing fragment: ${name}`, 'missing-fragment');
                frame.step = frame.expansion.next('');
            } else if (active.has(name)) {
                report(at, `Fragment cycle: ${frames.map(value => value.name).concat(name).join(' -> ')}`);
                frame.step = frame.expansion.next('');
            } else {
                push(name);
            }
        }
    }
    if (diagnostics.length) { return { files: [], diagnostics, inspection, publication }; }
    for (const fragment of fragments.values()) {
        if (!fragment.header.output) { continue; }
        const code = expanded.get(fragment.header.name)!.replace(/\\<</g, () => '<<');
        files.push({ path: fragment.header.output, content: substitute(sourceTemplates.get(fragment.header.name) ?? '[CODE]', { code }) });
    }
    const annotations = collected.parsed.annotations;
    installScreenTermLinks(md);
    md.renderer.rules.fence = (fenceTokens: Token[], index: number, _options, env) => {
        const token = fenceTokens[index];
        if (token.info.trim() === 'SETTINGS') { return ''; }
        const annotation = screenIndex(publication, annotations).annotationLines.get(env.path)?.get(token.map?.[0] ?? -1);
        if (annotation?.tokenIndex === index) { return renderScreenAnnotation(annotation, env.literateScreen); }
        const header = headers.get(token);
        const language = header?.language || token.info.trim().split(/\s+/)[0];
        const code = token.content.replace(/\\<</g, () => '<<');
        if (!header && language === 'mermaid') { return `<pre class="literate-mermaid">\n${escape(code)}</pre>\n`; }
        const part = screenIndex(publication).tokens.get(env.path)?.get(index);
        const rendered = part ? renderScreenCode(part, publication, 'html')
            : language && hljs.getLanguage(language) ? hljs.highlight(code, { language }).value : escape(code);
        const block = `<pre><code>${rendered}</code></pre>\n`;
        if (!header) { return block; }
        const label = escape(`<<${header.name}>>=${header.append ? '+' : ''} ${header.output ? header.output + ' $' : ''}`);
        return part ? renderScreenContribution(part, publication, 'html',
            `<<${header.name}>>=${header.append ? '+' : ''} ${header.output ? header.output + ' $' : ''}`.trimEnd(), block)
            : `<div class="codefragment">\n<div class="fragmentname">${label}</div>\n<div class="code">\n${block}\n</div>\n</div>`;
    };
    const metaAuthors = authors.split(';').map(author => `<meta name="author" content="${escape(author)}">`).join('');
    const theme = `<style>${themeCss(getTheme(projectTheme.name)!)}${annotations.terms.length || annotations.notes.length ? screenStyle : ''}</style>`;
    for (const path of order) {
        const documentTokens = tokens.get(path)!;
        const literateScreen = { model: publication, annotations, path, format: 'html' as const };
        const literateUseTargets = screenTermUseAnchors(documentTokens, annotations, path);
        const rendered = md.renderer.render(documentTokens, md.options, { path, literateScreen, literateUseTargets })
            + renderScreenIndexes(literateScreen, order) + renderScreenExploration(publication, path, 'html');
        const wrapper = `<div class="literate-document" data-literate-theme="${escape(projectTheme.name)}">${rendered}</div>`;
        const content = htmlTemplate.includes('[THEME]') ? wrapper : theme + wrapper;
        const output = safeRelativePath(path.replace(/\.literate$/, '.html'))!;
        const heading = documentTokens.findIndex(token => token.type === 'heading_open' && token.tag === 'h1');
        const title = heading >= 0 && documentTokens[heading + 1]?.type === 'inline'
            ? documentTokens[heading + 1].content.trim() || path : path;
        const depth = output.split('/').length - 1;
        const preview = `<script defer src="${'../'.repeat(depth) || './'}out/mermaid-preview.js"></script>`;
        files.push({ path: output, content: substitute(htmlTemplate, {
            content, authors: metaAuthors, theme, title: escape(title), preview
        }) });
    }
    for (const file of files) { file.content = file.content.replace(/\r\n|\r/g, '\n'); }
    return { files, diagnostics, inspection, publication };
}
/** @internal Collected source graph for the pure language projection adapter. */
export function collectLanguageProject(documents: SourceDocument[], templates: Record<string, string>) {
    const diagnostics: GenerationDiagnostic[] = [];
    const report = (location: Location, message: string): void => { diagnostics.push({ ...location, message }); };
    const templateMap = new Map<string, string>();
    const templateKeys = new Set<string>();
    const outputs = new Set<string>();
    let inputKeys = new Set<string>();
    return collectProject(documents, {
        diagnostics,
        acceptInputs(sourceKeys) {
            for (const key of Object.keys(templates).sort()) {
                const path = safeRelativePath(key);
                const location = { path: key, line: 0, column: 0 };
                if (!path) { report(location, 'Invalid template path'); continue; }
                if (templateKeys.has(pathKey(path))) { report(location, `Duplicate template path: ${path}`); continue; }
                templateKeys.add(pathKey(path));
                templateMap.set(path, templates[key]);
            }
            inputKeys = new Set([...sourceKeys, ...templateKeys]);
        },
        settings(sources) { diagnostics.push(...resolveProjectTheme(sources).diagnostics); },
        loadTemplate(path, location) {
            if (!templateMap.has(path)) { report(location, `Missing template: ${path}`); }
            return templateMap.get(path);
        },
        setAuthors() {},
        setHtmlTemplate() {},
        reserve(path, location) {
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
        }
    });
}
