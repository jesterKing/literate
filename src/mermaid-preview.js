import mermaid from 'mermaid';
import { getTheme, defaultThemeName, themeCss, mermaidTheme } from './themes';

const selector = 'pre.literate-mermaid';
const states = new WeakMap();
let nextContainer = 0;
let pending = false;
let running = false;
function diagramId(state) {
    let id;
    do {
        id = `literate-mermaid-${state.container}-${++state.attempt}`;
    } while (document.getElementById(id) || document.getElementById(`d${id}`));
    return id;
}
function theme() {
    const wrapper = document.querySelector('.literate-document');
    return getTheme(wrapper?.getAttribute('data-literate-theme'))?.name || defaultThemeName;
}

function applyTheme() {
    let sheet = document.getElementById('literate-theme-style');
    if (!sheet) {
        sheet = document.createElement('style');
        sheet.id = 'literate-theme-style';
        document.head.appendChild(sheet);
    }
    const css = themeCss(getTheme(theme()));
    if (sheet.textContent !== css) { sheet.textContent = css; }
}
function configuration(currentTheme) {
    return {
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        maxTextSize: 50000,
        maxEdges: 500,
        ...mermaidTheme(getTheme(currentTheme)),
        fontFamily: 'sans-serif',
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        secure: ['secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering',
            'maxTextSize', 'maxEdges', 'theme', 'themeVariables', 'fontFamily', 'htmlLabels', 'flowchart']
    };
}

mermaid.initialize(configuration(defaultThemeName));
function validateSource(source) {
    if (source.length > 50000) { throw new Error('Diagram exceeds the 50000 character limit.'); }
    if (/%%\s*\{/.test(source) || /^\s*---(?:\s|$)/.test(source)) {
        throw new Error('Mermaid directives and frontmatter are disabled in this preview.');
    }
}
function stateFor(element) {
    let state = states.get(element);
    if (!state) {
        state = { container: ++nextContainer, attempt: 0 };
        states.set(element, state);
    }
    if (state.markup !== element.innerHTML) {
        state.source = element.textContent || '';
        state.markup = element.innerHTML;
        state.completedTheme = undefined;
    }
    return state;
}
function isCurrent(element, state, markup, currentTheme) {
    return element.isConnected && element.matches(selector)
        && element.innerHTML === markup && state.markup === markup
        && theme() === currentTheme;
}
function showError(element, source, error) {
    const message = error instanceof Error ? error.message : String(error);
    element.textContent = `Mermaid diagram could not be rendered: ${message}\n\n${source}`;
    element.setAttribute('role', 'alert');
    element.setAttribute('aria-label', 'Mermaid diagram rendering error');
}
async function renderElement(element, currentTheme) {
    const state = stateFor(element);
    if (state.completedTheme === currentTheme) { return; }
    const markup = element.innerHTML;
    let result;
    let failure;
    try {
        validateSource(state.source);
        mermaid.initialize(configuration(currentTheme));
        result = await mermaid.render(diagramId(state), state.source);
    } catch (error) {
        failure = error;
    }
    if (!isCurrent(element, state, markup, currentTheme)) { return; }
    if (result) {
        element.innerHTML = result.svg;
        element.removeAttribute('role');
        element.removeAttribute('aria-label');
    } else {
        showError(element, state.source, failure);
    }
    state.markup = element.innerHTML;
    state.completedTheme = currentTheme;
}
async function drain() {
    running = true;
    try {
        while (pending) {
            pending = false;
            for (const element of document.querySelectorAll(selector)) {
                if (element.isConnected) { await renderElement(element, theme()); }
            }
        }
    } finally {
        running = false;
    }
}

function schedule() {
    applyTheme();
    pending = true;
    if (!running) { void drain(); }
}
function start() {
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
        attributes: true, subtree: true, attributeFilter: ['data-literate-theme']
    });
    window.addEventListener('vscode.markdown.updateContent', schedule);
    schedule();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
    start();
}
