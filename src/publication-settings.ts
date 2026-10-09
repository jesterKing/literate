import type { GenerationDiagnostic, ParsedProject } from './engine';

export interface PublicationFonts {
    body: string;
    heading: string;
    code: string;
    fragment: string;
    note: string;
}
export interface PublicationFontSizes {
    body: number;
    code: number;
    diagram: number;
    rail: number;
}
export const publicationFontSizeBounds = {
    body: { minimum: 8, maximum: 24, defaultValue: 11 },
    code: { minimum: 6, maximum: 24, defaultValue: 10 },
    diagram: { minimum: 8, maximum: 48, defaultValue: 16 },
    rail: { minimum: 7, maximum: 14, defaultValue: 9 }
} as const;
export interface PublicationSettingsResult {
    fonts: PublicationFonts;
    fontSizes: PublicationFontSizes;
    codeLigatures: boolean;
    diagnostics: GenerationDiagnostic[];
}
export function resolvePublicationSettings(project: ParsedProject): PublicationSettingsResult {
    const fonts: PublicationFonts = {
        body: 'Latin Modern Roman', heading: 'Monofur Nerd Font',
        code: 'Lilex Nerd Font', fragment: 'Monofur Nerd Font', note: ''
    };
    const fontSizes: PublicationFontSizes = {
        body: publicationFontSizeBounds.body.defaultValue,
        code: publicationFontSizeBounds.code.defaultValue,
        diagram: publicationFontSizeBounds.diagram.defaultValue,
        rail: publicationFontSizeBounds.rail.defaultValue
    };
    let codeLigatures = true;
    let explicitNote = false;
    const diagnostics: GenerationDiagnostic[] = [];
    const document = project.documents.find(value => value.path === 'index.literate');
    for (const token of document?.tokens ?? []) {
        if (token.type !== 'fence' || token.info.trim() !== 'SETTINGS') { continue; }
        token.content.split('\n').forEach((line: string, index: number) => {
            const match = /^\s*(font-body|font-heading|font-code|font-fragment|font-note|font-code-ligatures|font-size-body|font-size-code|font-size-diagram|font-size-rail)\s*=(.*)$/.exec(line);
            if (!match) { return; }
            const key = match[1];
            const value = match[2].trim();
            const report = (message: string): void => {
                diagnostics.push({ path: document!.path,
                    line: (token.map?.[0] ?? 0) + index + 1, column: 0, message });
            };
            if (key === 'font-code-ligatures') {
                if (value === 'on' || value === 'off') { codeLigatures = value === 'on'; }
                else { report(`Invalid ${key}: expected on or off`); }
            } else if (key.startsWith('font-size-')) {
                const role = key.slice('font-size-'.length) as keyof PublicationFontSizes;
                const bounds = publicationFontSizeBounds[role];
                const size = /^\d+(?:\.\d{1,2})?$/.test(value) ? Number(value) : NaN;
                if (Number.isFinite(size) && size >= bounds.minimum && size <= bounds.maximum) {
                    fontSizes[role] = size;
                } else {
                    const unit = role === 'diagram' ? 'CSS pixels' : 'points';
                    report(`Invalid ${key}: expected ${bounds.minimum}–${bounds.maximum} ${unit}`);
                }
            } else if (/^[A-Za-z0-9][A-Za-z0-9 .-]{0,99}$/.test(value)) {
                const role = key.slice(5) as keyof PublicationFonts;
                fonts[role] = value;
                if (role === 'note') { explicitNote = true; }
            } else {
                report(`Invalid ${key}: font must be a simple family name (1–100 ASCII characters)`);
            }
        });
    }
    if (!explicitNote) { fonts.note = fonts.body; }
    return { fonts, fontSizes, codeLigatures, diagnostics };
}
