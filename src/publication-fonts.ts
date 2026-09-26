import { createHash } from 'crypto';
import { posix } from 'path';
import { safeRelativePath } from './engine';

export const fontFaces = ['regular', 'bold', 'italic', 'boldItalic'] as const;
export type FontFace = string | { file: string; slant: number };
export type PortableFont = Record<typeof fontFaces[number], FontFace>;
export interface FontPlan {
    fonts: Record<string, PortableFont>;
    inputs: string[];
    files: { path: string; content: Uint8Array }[];
}
export interface FontInputIO {
    requireFile(path: string): Promise<void>;
    read(path: string): Promise<Uint8Array>;
}
export const fontFile = (face: FontFace): string => typeof face === 'string' ? face : face.file;
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
function object(value: unknown, where: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${where}: expected a JSON object`);
    }
    return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) { throw new Error(`${where}: unknown field ${key}`); }
    }
}
function inputPath(value: unknown, where: string, font = false): string {
    const result = typeof value === 'string' ? safeRelativePath(value) : undefined;
    if (!result) { throw new Error(`${where}: expected a safe root-relative file path`); }
    if (font && !/\.(ttf|otf)$/i.test(result)) {
        throw new Error(`${where}: expected a .ttf or .otf font file`);
    }
    return result;
}
export function checkFontFace(value: unknown, face: typeof fontFaces[number], where: string,
    filePath: (value: unknown, where: string) => string): FontFace {
    if (!value || typeof value !== 'object') { return filePath(value, where); }
    if (face !== 'italic' && face !== 'boldItalic') {
        throw new Error(`${where}: synthesis is only supported for italic and boldItalic`);
    }
    const choice = object(value, where);
    keys(choice, ['file', 'slant'], where);
    if (typeof choice.slant !== 'number' || !Number.isFinite(choice.slant) ||
        choice.slant < 0.01 || choice.slant > 0.3) {
        throw new Error(`${where}.slant: expected a finite number from 0.01 through 0.3`);
    }
    return { file: filePath(choice.file, `${where}.file`), slant: choice.slant };
}
export async function planFonts(manifestPath: string, output: string,
    selected: readonly string[], io: FontInputIO): Promise<FontPlan> {
    const context = `Font manifest ${manifestPath}`;
    await io.requireFile(manifestPath);
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(await io.read(manifestPath)).toString('utf8')); }
    catch (error) { throw new Error(`${context}: cannot read JSON: ${String(error)}`); }
    const manifest = object(parsed, context);
    keys(manifest, ['version', 'families'], context);
    if (manifest.version !== 1) { throw new Error(`${context}: version must be 1`); }
    const families = object(manifest.families, `${context}.families`);
    const entries = new Map<string, { faces: PortableFont; licenses: string[] }>();
    const inputs = new Set([manifestPath]);
    for (const family of Object.keys(families).sort()) {
        const where = `${context}.families[${JSON.stringify(family)}]`;
        if (!/^[A-Za-z0-9][A-Za-z0-9 .-]{0,99}$/.test(family)) {
            throw new Error(`${where}: expected a simple family name`);
        }
        const entry = object(families[family], where);
        keys(entry, [...fontFaces, 'licenses'], where);
        const faces = {} as PortableFont;
        for (const face of fontFaces) {
            faces[face] = checkFontFace(entry[face], face, `${where}.${face}`,
                (value, location) => inputPath(value, location, true));
            inputs.add(fontFile(faces[face]));
        }
        if (!Array.isArray(entry.licenses) || !entry.licenses.length) {
            throw new Error(`${where}.licenses: expected a nonempty array of license file paths`);
        }
        const licenses = entry.licenses.map((value, index) => inputPath(value, `${where}.licenses[${index}]`));
        licenses.forEach(value => inputs.add(value));
        entries.set(family, { faces, licenses });
    }
    for (const family of selected) {
        if (!entries.has(family)) {
            throw new Error(`${context}: selected family ${JSON.stringify(family)} is missing; add all four faces and licenses`);
        }
    }
    for (const input of inputs) {
        try { await io.requireFile(input); }
        catch (error) { throw new Error(`${context}: input ${JSON.stringify(input)}: ${String(error)}`); }
    }
    const directory = `lit-fonts-${digest(posix.basename(output))}`;
    const plan: FontPlan = { fonts: Object.create(null), inputs: [...inputs], files: [] };
    for (const family of [...new Set(selected)].sort()) {
        const entry = entries.get(family)!;
        const faces = {} as PortableFont;
        const copy = async (source: string, identity: string, extension: string): Promise<string> => {
            const name = `${directory}/${digest(family + ':' + identity)}${extension}`;
            plan.files.push({ path: posix.join(posix.dirname(output), name), content: await io.read(source) });
            return name;
        };
        for (const face of fontFaces) {
            const choice = entry.faces[face];
            const source = fontFile(choice);
            const file = await copy(source, face, posix.extname(source).toLowerCase());
            faces[face] = typeof choice === 'string' ? file : { file, slant: choice.slant };
        }
        for (const [index, license] of entry.licenses.entries()) {
            await copy(license, `license-${index}`, '.license.txt');
        }
        plan.fonts[family] = faces;
    }
    return plan;
}
