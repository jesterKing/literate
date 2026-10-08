import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateProject, GeneratedFile, GenerationResult, SourceDocument } from '../../engine';

const root = path.resolve(__dirname, '../../..');
let cached: GenerationResult | undefined;

function sources(): SourceDocument[] {
    const chapters = fs.readdirSync(path.join(root, 'literate'))
        .filter(name => name.endsWith('.literate')).sort()
        .map(name => ({ path: `literate/${name}`,
            text: fs.readFileSync(path.join(root, 'literate', name), 'utf8') }));
    return [{ path: 'index.literate', text: fs.readFileSync(path.join(root, 'index.literate'), 'utf8') }, ...chapters];
}

export function authoritativeBook(): GenerationResult {
    if (!cached) {
        const template = fs.readFileSync(path.join(root, 'tssrc.template'), 'utf8');
        cached = generateProject(sources(), { 'tssrc.template': template });
    }
    return cached;
}

export function generatedFromBook(output: string): GeneratedFile {
    const result = authoritativeBook();
    if (result.diagnostics.length) {
        throw new Error(`Authoritative book has ${result.diagnostics.length} generation diagnostics`);
    }
    const generated = result.files.find(file => file.path === output);
    if (!generated) { throw new Error(`Authoritative book does not emit ${output}`); }
    return generated;
}
