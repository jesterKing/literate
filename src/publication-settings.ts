import type { GenerationDiagnostic, ParsedProject } from './engine';

export interface PublicationFonts {
    body: string;
    heading: string;
    code: string;
    fragment: string;
    note: string;
}
export interface PublicationSettingsResult {
    fonts: PublicationFonts;
    codeLigatures: boolean;
    diagnostics: GenerationDiagnostic[];
}
export function resolvePublicationSettings(project: ParsedProject): PublicationSettingsResult {
    const fonts: PublicationFonts = {
        body: 'Latin Modern Roman', heading: 'Monofur Nerd Font',
        code: 'D2CodingLigature Nerd Font Propo', fragment: 'Monofur Nerd Font', note: ''
    };
    let codeLigatures = true;
    let explicitNote = false;
    const diagnostics: GenerationDiagnostic[] = [];
    const document = project.documents.find(value => value.path === 'index.literate');
    for (const token of document?.tokens ?? []) {
        if (token.type !== 'fence' || token.info.trim() !== 'SETTINGS') { continue; }
        token.content.split('\n').forEach((line: string, index: number) => {
            const match = /^\s*(font-body|font-heading|font-code|font-fragment|font-note|font-code-ligatures)\s*=(.*)$/.exec(line);
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
    return { fonts, codeLigatures, diagnostics };
}
