import { createHash } from 'crypto';
import { posix } from 'path';
import { safeRelativePath, ParsedProject } from './engine';
import { preparePandoc, PublicationAsset } from './publication-pandoc';
import type { FontInputIO } from './publication-fonts';
import type { DiagramBytes } from './publication-mermaid';
export const maximumAssetBytes = 32 * 1024 * 1024;
export interface AssetPlan {
    inputs: string[];
    files: { path: string; content: Uint8Array }[];
    paths: Map<string, string>;
}
export const assetKey = (asset: PublicationAsset): string => JSON.stringify([asset.kind, asset.at.path, asset.source]);
const hash = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
export function assetInput(asset: PublicationAsset): string {
    let source: string;
    try { source = decodeURIComponent(asset.source); }
    catch { throw new Error('Image path has invalid URI escaping'); }
    const invalid = (value: string): boolean => !value || /^[\/]/.test(value) || /[\\:?#\u0000-\u001f\u007f]/.test(value);
    if (invalid(asset.source) || invalid(source)) {
        throw new Error('Image requires a local relative path without queries or fragments');
    }
    const result = safeRelativePath(posix.join(posix.dirname(asset.at.path), source));
    if (!result) { throw new Error('Image path escapes the project or is not portable'); }
    return result;
}
function assetFormat(input: string, bytes: Uint8Array): string {
    if (!bytes.length || bytes.length > maximumAssetBytes) { throw new Error('Image must be 1–33554432 bytes'); }
    const data = Buffer.from(bytes);
    const ext = posix.extname(input).toLowerCase();
    if (ext === '.png' && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) { return 'png'; }
    if (/^\.jpe?g$/.test(ext) && data[0] === 255 && data[1] === 216 && data[2] === 255) { return 'jpg'; }
    if (ext === '.pdf' && data.subarray(0, 5).toString('ascii') === '%PDF-') { return 'pdf'; }
    throw new Error('Image must be PNG, JPEG or PDF with a matching signature; SVG is unsupported');
}
export async function planAssets(assets: readonly PublicationAsset[], output: string, io: FontInputIO,
    render?: (assets: PublicationAsset[]) => Promise<Map<string, DiagramBytes>>): Promise<AssetPlan> {
    if (assets.length > 1024) { throw new Error('Publication exceeds 1024 image requests'); }
    const directory = `lit-assets-${hash(posix.basename(output))}`;
    const plan: AssetPlan = { inputs: [], files: [], paths: new Map() };
    const inputs = new Map<string, string>(), files = new Set<string>();
    let total = 0;
    const add = (content: Uint8Array, extension: string): string => {
        const companion = `${directory}/${hash(content)}.${extension}`;
        if (!files.has(companion)) {
            total += content.length;
            if (total > 128 * 1024 * 1024) { throw new Error('Publication images exceed 128 MiB'); }
            files.add(companion);
            plan.files.push({ path: posix.join(posix.dirname(output), companion), content });
        }
        return companion;
    };
    for (const asset of assets.filter(asset => asset.kind === 'image')) {
        try {
            const input = assetInput(asset);
            let companion = inputs.get(input);
            if (!companion) {
                await io.requireFile(input);
                const content = await io.read(input);
                companion = add(content, assetFormat(input, content));
                inputs.set(input, companion);
            }
            plan.paths.set(assetKey(asset), companion);
        } catch (error) { throw new Error(`${asset.at.path}:${asset.at.line + 1}: ${String(error)}`); }
    }
    plan.inputs = [...inputs.keys()];
    const diagrams = assets.filter(asset => asset.kind === 'mermaid');
    if (diagrams.length) {
        if (!render) { throw new Error('Mermaid publication requires an explicit browser renderer'); }
        const rendered = await render(diagrams);
        for (const asset of diagrams) {
            const bytes = rendered.get(asset.source);
            if (!bytes || bytes.pdf.length > 16 * 1024 * 1024 || bytes.svg.length > 4 * 1024 * 1024
                || !Buffer.from(bytes.svg).toString('utf8').startsWith('<svg')) {
                throw new Error(`${asset.at.path}:${asset.at.line + 1}: Missing or invalid Mermaid artifacts`);
            }
            assetFormat('diagram.pdf', bytes.pdf);
            plan.paths.set(assetKey(asset), add(bytes.pdf, 'pdf'));
            add(bytes.svg, 'svg');
        }
    }
    return plan;
}
export function collectAssets(project: ParsedProject): {
    assets: PublicationAsset[]; diagnostics: ReturnType<typeof preparePandoc>['diagnostics'];
} {
    const assets: PublicationAsset[] = [];
    const prepared = preparePandoc(project, () => [], asset => { assets.push(asset); return []; });
    return { assets, diagnostics: prepared.diagnostics };
}
