import type Token = require('markdown-it/lib/token');
import { parseAnnotationBody, resolveTermHref, PublicationAnnotations } from './publication-annotations';
import type {
    GenerationDiagnostic, ParsedDocument, ParsedProject,
    PublicationContribution, PublicationLocation
} from './engine';
export type PandocAttr = [string, string[], [string, string][]];
export interface PandocDocument {
// eslint-disable-next-line @typescript-eslint/naming-convention -- Pandoc's wire-format key.
    'pandoc-api-version': [1, 23, 1];
    meta: Record<string, never>;
    blocks: PandocBlock[];
}
export interface PandocPreparationResult {
    document?: PandocDocument;
    diagnostics: GenerationDiagnostic[];
}
export type PandocInline =
    | { t: 'RawInline'; c: ['latex', string] }
    | { t: 'Str'; c: string }
    | { t: 'Space' | 'SoftBreak' | 'LineBreak' }
    | { t: 'Code'; c: [PandocAttr, string] }
    | { t: 'Emph' | 'Strong' | 'Strikeout'; c: PandocInline[] }
    | { t: 'Link'; c: [PandocAttr, PandocInline[], [string, string]] };
export type PandocListAttributes = [number, { t: 'Decimal' }, { t: 'Period' | 'OneParen' }];
export type PandocLeafBlock =
    | { t: 'Plain' | 'Para'; c: PandocInline[] }
    | { t: 'Header'; c: [number, PandocAttr, PandocInline[]] }
    | { t: 'HorizontalRule' }
    | { t: 'CodeBlock'; c: [PandocAttr, string] }
    | { t: 'RawBlock'; c: ['latex', string] };
export type PandocBlock = PandocLeafBlock
    | { t: 'BlockQuote'; c: PandocBlock[] }
    | { t: 'BulletList'; c: PandocBlock[][] }
    | { t: 'OrderedList'; c: [PandocListAttributes, PandocBlock[][]] }
    | { t: 'Div'; c: [PandocAttr, PandocBlock[]] };
type PendingBlock = PandocLeafBlock
    | { t: 'Contribution'; part: PublicationContribution }
    | { t: 'Asset'; asset: PublicationAsset }
    | { t: 'BlockQuote'; c: PendingBlock[] }
    | { t: 'BulletList'; c: PendingBlock[][] }
    | { t: 'OrderedList'; c: [PandocListAttributes, PendingBlock[][]] }
    | { t: 'Div'; c: [PandocAttr, PendingBlock[]] };
export interface PublicationAsset {
    kind: 'image' | 'mermaid'; source: string; caption: string; at: PublicationLocation;
}
export type AssetRenderer = (asset: PublicationAsset) => PandocBlock[];
type ContributionRenderer = (part: PublicationContribution) => PandocBlock[];
const maximumNesting = 128;
function emptyAttributes(): PandocAttr { return ['', [], []]; }
function report(
    diagnostics: GenerationDiagnostic[], at: PublicationLocation, code: string, message: string
): void {
    diagnostics.push({ ...at, code, message });
}
function tokenLocation(document: ParsedDocument, token?: Token, fallback = 0): PublicationLocation {
    return { path: document.path, line: token?.map?.[0] ?? fallback, column: 0 };
}
function unsupported(diagnostics: GenerationDiagnostic[], at: PublicationLocation, type: string): void {
    const raw = /^(html|raw|tex|latex)(_|$)/.test(type);
    report(diagnostics, at, raw ? 'unsupported-raw-content' : 'unsupported-pandoc-token',
        raw ? `Raw author content is unsupported: ${type}` : `Unsupported Markdown token: ${type}`);
}
interface Dependency { target: string; at: PublicationLocation; }
function validateReferences(project: ParsedProject, diagnostics: GenerationDiagnostic[]): void {
    const families = new Map(project.publication.fragments.map(family => [family.target, family]));
    const edges = new Map<string, Dependency[]>();
    for (const family of families.values()) { edges.set(family.target, []); }
    for (const part of project.publication.contributions) {
        for (const segment of part.segments) {
            if (segment.kind !== 'reference') { continue; }
            if (segment.modifier !== undefined) {
                report(diagnostics, segment.at, 'invalid-reference-modifier',
                    `Invalid definition operator on reference: ${segment.name}`);
            }
            if (segment.resolution.kind === 'missing' || !families.has(segment.resolution.target)) {
                report(diagnostics, segment.at, 'missing-fragment', `Missing fragment: ${segment.name}`);
            } else {
                edges.get(part.fragmentTarget)?.push({ target: segment.resolution.target, at: segment.at });
            }
        }
    }
    validateCycles(edges, families, diagnostics);
}
function validateCycles(
    edges: Map<string, Dependency[]>, families: Map<string, { name: string }>,
    diagnostics: GenerationDiagnostic[]
): void {
    const active = new Set<string>(), finished = new Set<string>();
    for (const target of edges.keys()) {
        if (finished.has(target)) { continue; }
        const stack = [{ target, index: 0 }];
        active.add(target);
        while (stack.length) {
            const frame = stack[stack.length - 1];
            const edge = edges.get(frame.target)![frame.index++];
            if (!edge) {
                active.delete(frame.target); finished.add(frame.target); stack.pop();
            } else if (active.has(edge.target)) {
                report(diagnostics, edge.at, 'fragment-cycle',
                    `Fragment cycle through: ${families.get(edge.target)!.name}`);
            } else if (!finished.has(edge.target)) {
                active.add(edge.target); stack.push({ target: edge.target, index: 0 });
            }
        }
    }
}
interface DocumentDestination {
    id: string;
    headings: Map<string, string[]>;
    tokens: Map<Token, string>;
}
type PublicationTargets = Map<string, DocumentDestination>;
function headingSlug(inline?: Token): string {
    const text = (inline?.children ?? []).map(token => {
        if (token.type === 'text' || token.type === 'code_inline') { return token.content; }
        return token.type === 'softbreak' || token.type === 'hardbreak' ? ' ' : '';
    }).join('');
    return text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
        .trim().replace(/\s+/gu, '-').normalize('NFC') || 'section';
}
function headingDestinations(document: ParsedDocument): DocumentDestination {
    const groups = new Map<string, Token[]>();
    document.tokens.forEach((token, index) => {
        if (token.type !== 'heading_open') { return; }
        const slug = headingSlug(document.tokens[index + 1]);
        const group = groups.get(slug) ?? [];
        group.push(token); groups.set(slug, group);
    });
    const destination: DocumentDestination = {
        id: documentTarget(document.path), headings: new Map(), tokens: new Map()
    };
    const reserved = new Set(groups.keys());
    for (const [base, tokens] of groups) {
        allocateHeadings(document.path, base, tokens, reserved, destination);
    }
    return destination;
}
function allocateHeadings(path: string, base: string, tokens: Token[], reserved: Set<string>,
    destination: DocumentDestination): void {
    const slugs: string[] = [];
    let ordinal = 1;
    for (const token of tokens) {
        let slug = base;
        if (tokens.length > 1) {
            do { slug = base + '-' + ordinal++; } while (reserved.has(slug));
        }
        reserved.add(slug); slugs.push(slug);
        const id = 'h-' + documentTarget(path).slice(2) + '-' + documentTarget(slug).slice(2);
        destination.tokens.set(token, id);
        destination.headings.set(slug, [id]);
    }
    if (tokens.length > 1) { destination.headings.set(base, slugs); }
}
function documentTarget(path: string): string {
    let encoded = 'd-';
    for (let index = 0; index < path.length; index++) {
        encoded += path.charCodeAt(index).toString(16).padStart(4, '0');
    }
    return encoded;
}
function localDocumentPath(href: string, source: string): string | undefined {
    if (!href || /[?#\\\x00-\x20\x7f]/.test(href) || href.startsWith('/')) { return undefined; }
    let decoded: string;
    try { decoded = decodeURIComponent(href); } catch { return undefined; }
    if (/[?#\\\x00-\x1f\x7f]/.test(decoded) || decoded.startsWith('/')) { return undefined; }
    if (!/\.(html|literate)$/.test(decoded)) { return undefined; }
    const parts = source.split('/').slice(0, -1);
    for (const part of decoded.split('/')) {
        if (!part || part === '.') { continue; }
        if (part === '..') { if (!parts.length) { return undefined; } parts.pop(); }
        else { parts.push(part); }
    }
    return parts.join('/').replace(/\.html$/, '.literate');
}
function safeExternalLink(href: string): boolean {
    try {
        if (/[\\\x00-\x20\x7f]/.test(href) || /[\x00-\x1f\x7f]/.test(decodeURIComponent(href))) { return false; }
        const url = new URL(href);
        if (/^https?:\/\//i.test(href)) { return !!url.hostname; }
        return /^mailto:/i.test(href) && url.protocol === 'mailto:' && !!url.pathname;
    } catch { return false; }
}
function linkDestination(
    href: string, document: ParsedDocument, targets: PublicationTargets,
    diagnostics: GenerationDiagnostic[], at: PublicationLocation
): string | undefined {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        if (safeExternalLink(href)) { return href; }
    } else {
        const resolved = localLinkDestination(href, document, targets, diagnostics, at);
        if (resolved !== undefined) { return resolved || undefined; }
    }
    report(diagnostics, at, 'unsupported-publication-link',
        `Unsupported link (expected safe HTTP/HTTPS/mailto or an included document/heading without query): ${href}`);
    return undefined;
}
function localLinkDestination(href: string, document: ParsedDocument, targets: PublicationTargets,
    diagnostics: GenerationDiagnostic[], at: PublicationLocation): string | undefined {
    const hash = href.indexOf('#');
    const path = hash === 0 ? document.path : localDocumentPath(hash < 0 ? href : href.slice(0, hash), document.path);
    let slug: string | undefined;
    if (hash >= 0) {
        try { slug = decodeURIComponent(href.slice(hash + 1)).normalize('NFC'); } catch { return undefined; }
        if (!slug || /[?#\\\x00-\x20\x7f]/.test(slug)) { return undefined; }
    }
    if (path === undefined) { return undefined; }
    const destination = targets.get(path);
    if (!destination) {
        report(diagnostics, at, 'missing-publication-document', `Document is not included: ${path}`);
        return '';
    }
    if (slug === undefined) { return '#' + destination.id; }
    return headingLinkDestination(destination, slug, path, diagnostics, at);
}
function headingLinkDestination(destination: DocumentDestination, slug: string, path: string,
    diagnostics: GenerationDiagnostic[], at: PublicationLocation): string {
    const matches = destination.headings.get(slug);
    if (!matches) {
        report(diagnostics, at, 'missing-publication-heading', `Missing heading: ${path}#${slug}`);
    } else if (matches.length > 1) {
        report(diagnostics, at, 'ambiguous-publication-heading',
            `Ambiguous heading: ${path}#${slug}; use ${matches.map(value => '#' + value).join(', ')}`);
    } else { return '#' + matches[0]; }
    return '';
}
interface InlineReader {
    annotations: PublicationAnnotations;
    publication: ParsedProject['publication'];
    document: ParsedDocument;
    tokens: readonly Token[];
    index: number;
    at: PublicationLocation;
    targets: PublicationTargets;
    diagnostics: GenerationDiagnostic[];
}
function textInlines(text: string): PandocInline[] {
    return text.split(/([ \t\r\n]+)/).filter(Boolean).map(value =>
        /^[ \t\r\n]+$/.test(value) ? { t: 'Space' } : { t: 'Str', c: value });
}
function readInlines(reader: InlineReader, stop?: string, depth = 0): PandocInline[] {
    const result: PandocInline[] = [];
    if (depth > maximumNesting) {
        report(reader.diagnostics, reader.at, 'publication-nesting-limit', 'Inline nesting exceeds 128 levels');
        reader.index = reader.tokens.length;
        return result;
    }
    while (reader.index < reader.tokens.length) {
        const token = reader.tokens[reader.index++];
        if (stop && token.type === stop) { return result; }
        switch (token.type) {
            case 'text':
                        for (const inline of textInlines(token.content)) { result.push(inline); }
                        break;
            case 'literate_fragment_use': result.push(readFragmentUse(reader, token)); break;
            case 'code_inline': result.push({ t: 'Code', c: [emptyAttributes(), token.content] }); break;
            case 'softbreak': result.push({ t: 'SoftBreak' }); break;
            case 'hardbreak': result.push({ t: 'LineBreak' }); break;
            case 'em_open': result.push({ t: 'Emph', c: readInlines(reader, 'em_close', depth + 1) }); break;
            case 'strong_open': result.push({ t: 'Strong', c: readInlines(reader, 'strong_close', depth + 1) }); break;
            case 's_open': result.push({ t: 'Strikeout', c: readInlines(reader, 's_close', depth + 1) }); break;
            case 'link_open': result.push(readLink(reader, token, depth)); break;
            default: unsupported(reader.diagnostics, reader.at, token.type);
        }
    }
    if (stop) { report(reader.diagnostics, reader.at, 'invalid-markdown-structure', `Missing ${stop}`); }
    return result;
}
function readFragmentUse(reader: InlineReader, token: Token): PandocInline {
    const name = String(token.meta?.name || '');
    const family = reader.publication.fragments.find(item => item.name === name);
    const occurrence = String(token.meta?.occurrenceTarget || '');
    const annotation = token.meta?.annotation === 'rail' ? 'rail' : 'none';
    if (!family || !occurrence) {
        report(reader.diagnostics, reader.at, 'missing-fragment', `Missing fragment referenced from prose: ${name}`);
    }
    return { t: 'Link', c: [['', ['lit-fragment-use'], [
        ['data-target', family?.target || ''], ['data-occurrence', occurrence], ['data-annotation', annotation]
    ]], textInlines(token.content), ['#' + (family?.target || ''), '']] };
}
function readLink(reader: InlineReader, token: Token, depth: number): PandocInline {
    const original = token.attrGet('href') ?? '';
    const term = original.startsWith('term:');
    const resolved = term ? resolveTermHref(reader.annotations, original) : undefined;
    if (term && !resolved) {
        report(reader.diagnostics, reader.at, 'annotation-missing', `Unresolved TERM link: ${original}`);
    }
    const href = term ? '#' + (resolved ?? '') : linkDestination(original, reader.document,
        reader.targets, reader.diagnostics, reader.at);
    const label = readInlines(reader, 'link_close', depth + 1);
    return { t: 'Link', c: [['', term ? ['lit-term-use'] : [], []], label,
        [href ?? '', token.attrGet('title') ?? '']] };
}
interface BlockReader {
    annotations: PublicationAnnotations;
    publication: ParsedProject['publication'];
    annotationBody?: boolean;
    document: ParsedDocument;
    index: number;
    contributions: Map<number, PublicationContribution>;
    assets: boolean;
    targets: PublicationTargets;
    diagnostics: GenerationDiagnostic[];
}
function contributionIndex(
    document: ParsedDocument, parts: Map<string, PublicationContribution>, diagnostics: GenerationDiagnostic[]
): Map<number, PublicationContribution> {
    const result = new Map<number, PublicationContribution>();
    for (const block of document.blocks) {
        if (block.kind !== 'contribution') { continue; }
        const part = parts.get(block.target), token = document.tokens[block.tokenIndex];
        if (!part || part.tokenIndex !== block.tokenIndex || part.definition.path !== document.path
            || token?.type !== 'fence' || result.has(block.tokenIndex)) {
            report(diagnostics, tokenLocation(document, token), 'invalid-publication-snapshot',
                `Invalid contribution binding: ${block.target}`);
        } else { result.set(block.tokenIndex, part); }
    }
    return result;
}
function readBlocks(reader: BlockReader, stop?: string, depth = 0): PendingBlock[] {
    const result: PendingBlock[] = [];
    const tokens = reader.document.tokens;
    if (depth > maximumNesting) {
        report(reader.diagnostics, tokenLocation(reader.document, tokens[reader.index]),
            'publication-nesting-limit', 'Block nesting exceeds 128 levels');
        reader.index = tokens.length;
        return result;
    }
    while (reader.index < tokens.length) {
        const index = reader.index++, token = tokens[index];
        if (stop && token.type === stop) { return result; }
        result.push(...readBlock(reader, token, index, depth));
    }
    if (stop) {
        report(reader.diagnostics, tokenLocation(reader.document, tokens[tokens.length - 1]),
            'invalid-markdown-structure', `Missing ${stop}`);
    }
    return result;
}
function readBlock(reader: BlockReader, token: Token, index: number, depth: number): PendingBlock[] {
    switch (token.type) {
        case 'paragraph_open': return readParagraph(reader, token);
        case 'heading_open': return [readHeading(reader, token)];
        case 'hr': return [{ t: 'HorizontalRule' }];
        case 'blockquote_open': return [{ t: 'BlockQuote', c: readBlocks(reader, 'blockquote_close', depth + 1) }];
        case 'bullet_list_open': return [{ t: 'BulletList', c: readList(reader, 'bullet_list_close', depth + 1) }];
        case 'ordered_list_open': return [readOrderedList(reader, token, depth)];
        case 'fence': return readFence(reader, token, index);
        case 'code_block': return [{ t: 'CodeBlock', c: [emptyAttributes(), token.content] }];
        default: unsupported(reader.diagnostics, tokenLocation(reader.document, token), token.type); return [];
    }
}
function readParagraph(reader: BlockReader, opening: Token): PendingBlock[] {
    const inline = reader.document.tokens[reader.index];
    const children = inline?.children ?? [];
    const image = children.length === 1 && children[0].type === 'image' ? children[0] : undefined;
    if (!image || !reader.assets) {
        return [{ t: opening.hidden ? 'Plain' : 'Para', c: readTextBlock(reader, opening) }];
    }
    const at = tokenLocation(reader.document, inline);
    const caption = image.children ?? [];
    if (caption.some(child => child.type !== 'text')) {
        report(reader.diagnostics, at, 'unsupported-image-caption', 'Image alt text must be plain text');
    }
    reader.index++;
    if (reader.document.tokens[reader.index]?.type === 'paragraph_close') { reader.index++; }
    else { report(reader.diagnostics, at, 'invalid-markdown-structure', 'Expected paragraph_close'); }
    return [{ t: 'Asset', asset: { kind: 'image', at, source: image.attrGet('src') ?? '',
        caption: image.attrGet('title') || caption.map(child => child.content).join('') } }];
}
function readTextBlock(reader: BlockReader, opening: Token): PandocInline[] {
    const token = reader.document.tokens[reader.index];
    const at = tokenLocation(reader.document, token, opening.map?.[0] ?? 0);
    const stop = opening.type === 'heading_open' ? 'heading_close' : 'paragraph_close';
    if (token?.type !== 'inline') {
        report(reader.diagnostics, at, 'invalid-markdown-structure', `Expected inline after ${opening.type}`);
        return [];
    }
    reader.index++;
    const result = readInlines({ document: reader.document, tokens: token.children ?? [],
        index: 0, at, targets: reader.targets, diagnostics: reader.diagnostics,
        annotations: reader.annotations, publication: reader.publication });
    if (reader.document.tokens[reader.index]?.type === stop) { reader.index++; }
    else { report(reader.diagnostics, at, 'invalid-markdown-structure', `Expected ${stop}`); }
    return result;
}
function readHeading(reader: BlockReader, token: Token): PandocLeafBlock {
    const level = /^h[1-6]$/.test(token.tag) ? Number(token.tag.slice(1)) : 0;
    if (!level) {
        report(reader.diagnostics, tokenLocation(reader.document, token), 'invalid-markdown-structure', 'Invalid heading level');
    }
    const headingChildren = reader.document.tokens[reader.index]?.children || [];
    if (headingChildren.some(child => child.type === 'link_open' && child.attrGet('href')?.startsWith('term:'))) {
        report(reader.diagnostics, tokenLocation(reader.document, token), 'annotation-heading',
            'TERM links in headings are unsupported: use a prose link below the heading to avoid moving rail markers');
    }
    if (headingChildren.some(child => child.type === 'literate_fragment_use' && child.meta?.annotation === 'rail')) {
        report(reader.diagnostics, tokenLocation(reader.document, token), 'annotation-heading',
            'Rail fragment references in headings are unsupported: use a prose reference below the heading');
    }
    const id = reader.targets.get(reader.document.path)!.tokens.get(token)!;
    return { t: 'Header', c: [level, [id, [], []], readTextBlock(reader, token)] };
}
function readList(reader: BlockReader, stop: string, depth: number): PendingBlock[][] {
    const result: PendingBlock[][] = [], tokens = reader.document.tokens;
    while (reader.index < tokens.length) {
        const token = tokens[reader.index++];
        if (token.type === stop) { return result; }
        if (token.type === 'list_item_open') { result.push(readBlocks(reader, 'list_item_close', depth)); }
        else { unsupported(reader.diagnostics, tokenLocation(reader.document, token), token.type); }
    }
    report(reader.diagnostics, tokenLocation(reader.document, tokens[tokens.length - 1]),
        'invalid-markdown-structure', `Missing ${stop}`);
    return result;
}
function readOrderedList(reader: BlockReader, token: Token, depth: number): PendingBlock {
    const start = Number(token.attrGet('start') ?? '1');
    if (!Number.isSafeInteger(start) || start < 0 || !['.', ')'].includes(token.markup)) {
        report(reader.diagnostics, tokenLocation(reader.document, token), 'invalid-markdown-structure', 'Invalid ordered-list marker');
    }
    const attributes: PandocListAttributes = [start, { t: 'Decimal' }, { t: token.markup === ')' ? 'OneParen' : 'Period' }];
    return { t: 'OrderedList', c: [attributes, readList(reader, 'ordered_list_close', depth + 1)] };
}
function readFence(reader: BlockReader, token: Token, index: number): PendingBlock[] {
    if (token.info.trim() === 'SETTINGS') { return []; }
    if (!reader.annotationBody && /^(TERM|NOTE)(?:\s|$)/.test(token.info.trim())) {
        return readAnnotation(reader, index);
    }
    const part = reader.contributions.get(index);
    const language = part?.language ?? token.info.trim().split(/\s+/)[0];
    if (language.toLowerCase() === 'mermaid') {
        if (!part && reader.assets && token.info.trim().toLowerCase() === 'mermaid') {
            return [{ t: 'Asset', asset: { kind: 'mermaid', source: token.content, caption: '',
                at: tokenLocation(reader.document, token) } }];
        }
        report(reader.diagnostics, tokenLocation(reader.document, token), 'unsupported-mermaid',
            'Mermaid requires an ordinary fence and a publication asset renderer');
        return [];
    }
    if (part) { return [{ t: 'Contribution', part }]; }
    return [{ t: 'CodeBlock', c: [['', language ? [language] : [], []], token.content] }];
}
function readAnnotation(reader: BlockReader, index: number): PendingBlock[] {
    const matches = (item: { at: PublicationLocation; tokenIndex: number }): boolean =>
        item.at.path === reader.document.path && item.tokenIndex === index;
    const term = reader.annotations.terms.find(matches);
    const note = reader.annotations.notes.find(matches);
    const item = term ?? note;
    if (!item) {
        report(reader.diagnostics, tokenLocation(reader.document, reader.document.tokens[index]),
            'annotation-binding', 'Annotation fence has no shared annotation binding');
        return [];
    }
    const tokens = parseAnnotationBody(item.body);
    for (const token of tokens) {
        if (token.map) { token.map = [item.at.line + 1 + token.map[0], item.at.line + 1 + token.map[1]]; }
    }
    const body = readBlocks({ ...reader, annotationBody: true, assets: false,
        document: { ...reader.document, tokens }, index: 0, contributions: new Map() });
    return [{ t: 'Div', c: [[item.target, [term ? 'lit-term' : 'lit-note'], []], body] }];
}
function materialize(
    pending: PendingBlock[], render: ContributionRenderer, diagnostics: GenerationDiagnostic[], asset?: AssetRenderer
): PandocBlock[] {
    const result: PandocBlock[] = [];
    for (const block of pending) {
        if (diagnostics.length) { break; }
        switch (block.t) {
            case 'Asset':
                try { result.push(...asset!(block.asset)); }
                catch (error) { report(diagnostics, block.asset.at, 'asset-render-failed', String(error)); }
                break;
            case 'Contribution':
                for (const rendered of renderPart(block.part, render, diagnostics)) { result.push(rendered); }
                break;
            case 'BlockQuote': result.push({ t: 'BlockQuote', c: materialize(block.c, render, diagnostics, asset) }); break;
            case 'BulletList': result.push({ t: 'BulletList', c: block.c.map(item => materialize(item, render, diagnostics, asset)) }); break;
            case 'OrderedList': result.push({ t: 'OrderedList', c: [block.c[0],
                block.c[1].map(item => materialize(item, render, diagnostics, asset))] }); break;
            case 'Div': result.push({ t: 'Div', c: [block.c[0], materialize(block.c[1], render, diagnostics, asset)] }); break;
            default: result.push(block);
        }
    }
    return result;
}
function renderPart(
    part: PublicationContribution, render: ContributionRenderer, diagnostics: GenerationDiagnostic[]
): PandocBlock[] {
    try {
        const blocks = render(part);
        if (!Array.isArray(blocks)) { throw new Error('Contribution renderer must return a block array'); }
        return blocks;
    } catch (error) {
        report(diagnostics, part.definition, 'contribution-render-failed',
            `Contribution renderer failed: ${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
}
export function preparePandoc(
    project: ParsedProject, renderContribution: (part: PublicationContribution) => PandocBlock[],
    renderAsset?: AssetRenderer
): PandocPreparationResult {
    const diagnostics = project.diagnostics.map(diagnostic => ({ ...diagnostic }));
    if (diagnostics.length) { return { diagnostics }; }
    diagnostics.push(...project.annotations.diagnostics.map(diagnostic => ({ ...diagnostic })));
    if (diagnostics.length) { return { diagnostics }; }
    validateReferences(project, diagnostics);
    const targets = new Map(project.documents.map(document => [document.path, headingDestinations(document)]));
    const parts = new Map(project.publication.contributions.map(part => [part.target, part]));
    const pending: PendingBlock[] = project.documents.map(document => {
        const contributions = contributionIndex(document, parts, diagnostics);
        const body = readBlocks({ document, index: 0, contributions, targets, diagnostics,
            annotations: project.annotations, publication: project.publication, assets: !!renderAsset });
        return { t: 'Div', c: [[targets.get(document.path)!.id, [], []], body] };
    });
    if (diagnostics.length) { return { diagnostics }; }
    const blocks = materialize(pending, renderContribution, diagnostics, renderAsset);
    if (diagnostics.length) { return { diagnostics }; }
// eslint-disable-next-line @typescript-eslint/naming-convention -- Pandoc's wire-format key.
    return { document: { 'pandoc-api-version': [1, 23, 1], meta: {}, blocks }, diagnostics };
}
