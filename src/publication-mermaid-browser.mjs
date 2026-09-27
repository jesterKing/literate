import mermaid from 'mermaid/dist/mermaid.esm.mjs';
import zenuml from '@mermaid-js/mermaid-zenuml/dist/mermaid-zenuml.esm.mjs';
import tidyTree from '@mermaid-js/layout-tidy-tree';
const offlineZenuml = { ...zenuml, loader: async () => {
    const existingStyles = new Set(document.querySelectorAll('style'));
    const definition = await zenuml.loader();
    const bundledFont = '@font-face{font-family:MS Sans Serif;src:url(/fonts/MS%20Sans%20Serif.ttf) format("truetype")}';
    for (const style of document.querySelectorAll('style')) {
        if (!existingStyles.has(style) && style.textContent.includes(bundledFont)) {
            style.textContent = style.textContent.replaceAll(bundledFont, '');
        }
    }
    return definition;
} };
mermaid.registerLayoutLoaders(tidyTree);
globalThis.mermaid = mermaid;
globalThis.publicationMermaidReady = mermaid.registerExternalDiagrams([offlineZenuml]);
