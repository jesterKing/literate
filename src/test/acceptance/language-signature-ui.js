// Warm-server signature UI acceptance: real CDP typing, no triggerParameterHints/provider commands.
const assert = require('node:assert/strict');
const vscode = require('vscode');
const puppeteer = require('puppeteer-core');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
exports.signatureUI = async (port, doc, evidence) => {
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
    try {
        const pages = await browser.pages(); let page;
        for (const candidate of pages) {
            if (await candidate.evaluate(() => !!document.querySelector('.monaco-workbench'))) { page = candidate; break; }
        }
        assert.ok(page, 'Workbench renderer');
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        const needle = 'const greeting = greet("Ada", 2);', replacement = 'const greeting = greet;';
        const offset = doc.getText().indexOf(needle); assert.notEqual(offset, -1);
        assert.equal(await editor.edit(edit => edit.replace(new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + needle.length)), replacement)), true);
        const position = doc.positionAt(offset + replacement.length - 1);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        await page.bringToFront(); await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await delay(1200); assert.equal(vscode.window.state.focused, true);
        await page.keyboard.press('Escape');
        const before = doc.getText();
        async function waitHints(name, parameter) {
            const started = Date.now(); let state;
            do {
                state = await page.evaluate(() => {
                    const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
                    const widgets = [...document.querySelectorAll('.parameter-hints-widget')].filter(visible);
                    return { focused: document.hasFocus(), visible: widgets.length > 0,
                        text: widgets.map(w => w.innerText), active: widgets.flatMap(w => [...w.querySelectorAll('.parameter.active')].map(e => e.textContent)) };
                });
                assert.equal(vscode.window.state.focused && state.focused, true, 'Focused throughout signature observation');
                if (state.visible && state.text.some(text => /greet/.test(text)) && state.active.some(text => text.includes(parameter))) {
                    (evidence.signatureUI ||= []).push({ name, elapsedMs: Date.now() - started, state }); return;
                }
                await delay(75);
            } while (Date.now() - started < 10000);
            (evidence.signatureUI ||= []).push({ name, state }); assert.fail('Rendered signature/active parameter not observed: ' + JSON.stringify(state));
        }
        await page.keyboard.type('('); await waitHints('typing ( opens signature', 'name');
        await page.keyboard.type('"Ada", '); await waitHints('typing comma selects second parameter', 'count');
        assert.equal(doc.getText(), before.slice(0, offset + replacement.length - 1) + '("Ada", ' + before.slice(offset + replacement.length - 1), 'Only real typed input changed source');
        await page.keyboard.press('Escape');
    } finally { await browser.disconnect(); }
};
