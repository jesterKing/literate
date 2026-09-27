import MarkdownIt = require('markdown-it');
import type { PublicationModel, PublicationContribution } from './engine';
import { highlightContribution } from './publication-highlight';
const escapeHtml = new MarkdownIt().utils.escapeHtml;
export type ScreenFormat = 'html' | 'preview';
export type PreviewDestination = (target: string) => string | undefined;
export function screenHref(from: string, to: string, target: string, format: ScreenFormat,
    previewDestination?: PreviewDestination): string | undefined {
    if (from === to) { return '#' + target; }
    if (format === 'preview') { return previewDestination?.(target); }
    const base = from.split('/'); base.pop();
    const destination = to.split('/');
    while (base.length && base[0] === destination[0]) { base.shift(); destination.shift(); }
    const relative = [...base.map(() => '..'), ...destination];
    if (format === 'html') { relative[relative.length - 1] = relative[relative.length - 1].replace(/\.literate$/, '.html'); }
    return './' + relative.map(encodeURIComponent).join('/') + '#' + target;
}
function screenLink(href: string | undefined, label: string, text: string, target: string): string {
    if (href === undefined) { return escapeHtml(text); }
    return `<a class="literate-tag-name" href="${escapeHtml(href)}" data-literate-target="${target}" aria-label="${escapeHtml(label)}">${escapeHtml(text)}</a>`;
}
const screenIndexes = new WeakMap<PublicationModel, ReturnType<typeof buildScreenIndex>>();
export function screenIndex(model: PublicationModel) {
    let index = screenIndexes.get(model);
    if (!index) { index = buildScreenIndex(model); screenIndexes.set(model, index); }
    return index;
}
function buildScreenIndex(model: PublicationModel) {
    const families = new Map(model.fragments.map(family => [family.target, family]));
    const parts = new Map(model.contributions.map(part => [part.target, part]));
    const ordinals = new Map<string, number>();
    const tokens = new Map<string, Map<number, PublicationContribution>>();
    const lines = new Map<string, Map<number, PublicationContribution>>();
    for (const family of model.fragments) {
        family.contributions.forEach((target, index) => ordinals.set(target, index));
    }
    for (const part of model.contributions) {
        for (const [map, key] of [[tokens, part.tokenIndex], [lines, part.definition.line]] as const) {
            if (!map.has(part.definition.path)) { map.set(part.definition.path, new Map()); }
            map.get(part.definition.path)!.set(key, part);
        }
    }
    return { families, parts, ordinals, tokens, lines };
}
export function previewLanguage(language: string): string {
    switch (language.toLowerCase()) {
        case 'shell': return 'sh';
        case 'py3': return 'python';
        case 'tsx': case 'typescriptreact': return 'jsx';
        case 'json5': case 'jsonc': return 'json';
        case 'c#': case 'csharp': return 'cs';
        default: return language;
    }
}
export function renderScreenCode(part: PublicationContribution, model: PublicationModel, format: ScreenFormat,
    destination?: PreviewDestination): string {
    const language = format === 'preview' ? previewLanguage(part.language) : part.language;
    const display = highlightContribution(language === part.language ? part : { ...part, language }, true);
    const syntax = screenSyntax(display);
    const index = screenIndex(model);
    let cursor = 0, output = '';
    for (const ref of display.references) {
        output += syntax(cursor, ref.start);
        const family = index.families.get(ref.target);
        const base = index.parts.get(family?.contributions[0] || '');
        const text = display.text.slice(ref.start, ref.end);
        output += base ? screenLink(screenHref(part.definition.path, base.definition.path, ref.target, format, destination),
            `Definition of ${ref.name}`, text, ref.target) : escapeHtml(text);
        cursor = ref.end;
    }
    return output + syntax(cursor, display.text.length);
}
function screenSyntax(display: ReturnType<typeof highlightContribution>) {
    let index = 0;
    return (start: number, end: number): string => {
        const output: string[] = [];
        while (index < display.spans.length) {
            const span = display.spans[index];
            if (span.end <= start) { index++; continue; }
            if (span.start >= end) { break; }
            const left = Math.max(start, span.start), right = Math.min(end, span.end);
            const scope = span.scope.split('.')[0];
            if (left < right && scope !== 'comment') {
                const text = escapeHtml(display.text.slice(left, right));
                output.push(scope ? `<span class="hljs-${escapeHtml(scope)}">${text}</span>` : text);
            }
            if (span.end > end) { break; }
            index++;
        }
        return output.join('');
    };
}

export function renderScreenContribution(part: PublicationContribution, model: PublicationModel,
    format: ScreenFormat, label: string, code: string, destination?: PreviewDestination): string {
    const index = screenIndex(model);
    const family = index.families.get(part.fragmentTarget)!;
    const base = index.parts.get(family.contributions[0])!;
    const source = format === 'preview' ? ` class="code-line" data-line="${part.definition.line}"` : '';
    const familyAnchor = base.target === part.target ? `<span id="${family.target}"${source}></span>` : '';
    const heading = screenLink(screenHref(part.definition.path, base.definition.path, family.target, format, destination),
        `Definition of ${family.name}`, label, family.target);
    const navigation = screenNavigation(part, model, format, destination);
    return `<div class="codefragment">\n<div class="fragmentname${format === 'preview' ? ' code-line' : ''}" id="${part.target}"${format === 'preview' ? ` data-line="${part.definition.line}"` : ''}>${familyAnchor}${heading}</div>\n`
        + `<div class="code">\n${code}\n</div>\n${navigation}</div>`;
}
function screenNavigation(part: PublicationContribution, model: PublicationModel, format: ScreenFormat,
    destination?: PreviewDestination): string {
    const lookup = screenIndex(model);
    const family = lookup.families.get(part.fragmentTarget)!;
    const index = lookup.ordinals.get(part.target)!;
    const items: [string, string | undefined][] = [
        ['Previous', family.contributions[index - 1]], ['Base', family.contributions[0]],
        ['Next', family.contributions[index + 1]]
    ];
    const links = items.filter(([, target]) => target && target !== part.target).map(([label, target]) => {
        const destinationPart = lookup.parts.get(target!)!;
        return screenLink(screenHref(part.definition.path, destinationPart.definition.path, destinationPart.target, format, destination),
            `${label} contribution of ${family.name}`, label, destinationPart.target);
    });
    return links.length ? `<nav class="fragment-navigation" aria-label="${escapeHtml('Contributions of ' + family.name)}">${links.join(' · ')}</nav>\n` : '';
}
