import type { ParsedProject, PublicationLocation } from './engine';

export type PublicationReferenceKind = 'term' | 'fragment' | 'diagram';
export interface PublicationReference {
    kind: PublicationReferenceKind;
    id: string;
}
export interface PublicationDefinition extends PublicationReference {
    target: string;
    definition: PublicationLocation;
}
export type PublicationReferenceResolution =
    | { status: 'resolved'; value: PublicationDefinition }
    | { status: 'missing' | 'ambiguous'; reference: PublicationReference };
const portableId = /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/;

export function parsePublicationReference(fragment: string): PublicationReference | undefined {
    const slash = fragment.indexOf('/');
    if (slash < 1) { return undefined; }
    const kind = fragment.slice(0, slash);
    if (!['term', 'fragment', 'diagram'].includes(kind)) { return undefined; }
    let id: string;
    try { id = decodeURIComponent(fragment.slice(slash + 1)); } catch { return undefined; }
    if (!id || id.length > 200 || /[\x00-\x1f\x7f]/.test(id) || id.trim() !== id) { return undefined; }
    if (kind !== 'fragment' && !portableId.test(id)) { return undefined; }
    return { kind: kind as PublicationReferenceKind, id };
}
export function publicationDefinitions(project: ParsedProject): PublicationDefinition[] {
    const definitions: PublicationDefinition[] = project.annotations.terms.map(term => ({
        kind: 'term', id: term.key, target: term.target, definition: term.at
    }));
    definitions.push(...project.diagrams.map(diagram => ({
        kind: 'diagram' as const, id: diagram.id, target: diagram.target,
        definition: diagram.definition
    })));
    for (const family of project.publication.fragments) {
        const contribution = project.publication.contributions.find(item =>
            family.contributions.includes(item.target));
        if (contribution) {
            definitions.push({ kind: 'fragment', id: family.name, target: family.target,
                definition: contribution.definition });
        }
    }
    return definitions;
}

export function resolvePublicationReference(project: ParsedProject,
    reference: PublicationReference): PublicationReferenceResolution {
    const matches = publicationDefinitions(project).filter(item =>
        item.kind === reference.kind && item.id === reference.id);
    if (!matches.length) { return { status: 'missing', reference }; }
    if (matches.length > 1) { return { status: 'ambiguous', reference }; }
    return { status: 'resolved', value: matches[0] };
}
