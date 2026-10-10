import { safeRelativePath } from './engine';

export const publicationWorkspaceManifest = 'literate-workspace.json';

export interface PublicationProject {
    id: string;
    title: string;
    root: string;
    entry: string;
    pdf?: string;
}

export interface PublicationWorkspace {
    schemaVersion: 1;
    publications: PublicationProject[];
}
const identifier = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;

function fields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
    const extra = Object.keys(value).filter(key => !allowed.includes(key));
    if (extra.length) { throw new Error(`${label} has unknown field: ${extra[0]}`); }
}

function text(value: unknown, label: string, maximum: number): string {
    if (typeof value !== 'string' || !value || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) {
        throw new Error(`${label} must be a nonempty string of at most ${maximum} characters`);
    }
    return value;
}

function projectPath(value: unknown, label: string): string {
    const input = text(value, label, 1024);
    const normalized = safeRelativePath(input);
    if (!normalized) { throw new Error(`${label} is not a safe relative path: ${input}`); }
    return normalized;
}

function collision(left: string, right: string): boolean {
    const a = left.toLowerCase(), b = right.toLowerCase();
    return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}
export function parsePublicationWorkspace(source: string): PublicationWorkspace {
    if (source.length > 1024 * 1024) { throw new Error('Workspace manifest exceeds 1 MiB'); }
    let parsed: unknown;
    try { parsed = JSON.parse(source); }
    catch (error) { throw new Error(`Invalid workspace manifest JSON: ${error instanceof Error ? error.message : String(error)}`); }
    if (!object(parsed)) { throw new Error('Workspace manifest must be an object'); }
    fields(parsed, ['schemaVersion', 'publications'], 'Workspace manifest');
    if (parsed.schemaVersion !== 1) { throw new Error('Workspace manifest schemaVersion must be 1'); }
    if (!Array.isArray(parsed.publications) || !parsed.publications.length || parsed.publications.length > 1000) {
        throw new Error('Workspace manifest publications must contain 1 to 1000 entries');
    }
    const publications = parsed.publications.map((value, index): PublicationProject => {
        const label = `Publication ${index + 1}`;
        if (!object(value)) { throw new Error(`${label} must be an object`); }
        fields(value, ['id', 'title', 'root', 'entry', 'pdf'], label);
        const id = text(value.id, `${label} id`, 100);
        if (!identifier.test(id)) { throw new Error(`${label} id is invalid: ${id}`); }
        const root = projectPath(value.root, `${label} root`);
        const title = value.title === undefined ? id : text(value.title, `${label} title`, 200);
        const entry = value.entry === undefined ? 'index.literate' : projectPath(value.entry, `${label} entry`);
        const pdf = value.pdf === undefined ? undefined : projectPath(value.pdf, `${label} pdf`);
        if (!entry.endsWith('.literate')) { throw new Error(`${label} entry must end in .literate`); }
        if (pdf !== undefined && !pdf.endsWith('.pdf')) { throw new Error(`${label} pdf must end in .pdf`); }
        return { id, title, root, entry, ...(pdf === undefined ? {} : { pdf }) };
    });
    for (let index = 0; index < publications.length; index++) {
        const current = publications[index];
        for (let earlier = 0; earlier < index; earlier++) {
            const previous = publications[earlier];
            if (current.id.toLowerCase() === previous.id.toLowerCase()) {
                throw new Error(`Publication id conflicts with ${previous.id}: ${current.id}`);
            }
            if (collision(current.root, previous.root)) {
                throw new Error(`Publication root overlaps ${previous.root}: ${current.root}`);
            }
            if (current.pdf && previous.pdf && current.pdf.toLowerCase() === previous.pdf.toLowerCase()) {
                throw new Error(`Publication PDF conflicts with ${previous.pdf}: ${current.pdf}`);
            }
        }
    }
    return { schemaVersion: 1, publications };
}
export function selectPublication(workspace: PublicationWorkspace, id?: string): PublicationProject {
    if (id === undefined) {
        if (workspace.publications.length === 1) { return workspace.publications[0]; }
        throw new Error(`Select a publication: ${workspace.publications.map(item => item.id).join(', ')}`);
    }
    const selected = workspace.publications.find(item => item.id === id);
    if (!selected) {
        throw new Error(`Unknown publication ${id}; available publications: ${workspace.publications.map(item => item.id).join(', ')}`);
    }
    return selected;
}

export function publicationForPath(workspace: PublicationWorkspace,
    workspacePath: string): PublicationProject | undefined {
    const normalized = safeRelativePath(workspacePath);
    if (!normalized) { return undefined; }
    return workspace.publications.find(item => normalized === item.root || normalized.startsWith(item.root + '/'));
}
