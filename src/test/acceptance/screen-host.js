const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connect(url) {
    const socket = new WebSocket(url), pending = new Map();
    let id = 0;
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = event => {
        const value = JSON.parse(event.data), entry = pending.get(value.id);
        if (entry) {
            pending.delete(value.id); clearTimeout(entry.timer);
            value.error ? entry.reject(value.error) : entry.resolve(value.result);
        }
    };
    return { close: () => socket.close(), send(method, params = {}, sessionId) {
        return new Promise((resolve, reject) => {
            const next = ++id;
            const timer = setTimeout(() => { pending.delete(next); reject(new Error(method + ' timed out')); }, 5000);
            pending.set(next, { resolve, reject, timer });
            socket.send(JSON.stringify({ id: next, method, params, sessionId }));
        });
    } };
}
function observePreviewLink(href, action) {
    const docs = [document, ...Array.from(document.querySelectorAll('iframe')).map(frame => {
        try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    for (const doc of docs) {
        const links = Array.from(doc.querySelectorAll('a[href]'));
        const index = links.findIndex(value => value.getAttribute('href') === href);
        if (index < 0) { continue; }
        const link = links[index], target = href.startsWith('#') ? doc.getElementById(href.slice(1)) : null;
        if (action === 'prepare') {
            if (!links[index - 1]) { throw new Error('keyboard fixture needs a preceding anchor'); }
            links[index - 1].focus();
            doc.__m2ClickTrusted = false;
            doc.addEventListener('click', event => { doc.__m2ClickTrusted = event.isTrusted; }, { once: true, capture: true });
        }
        if (action === 'point') { link.scrollIntoView({ block: 'center' }); }
        const rect = link.getBoundingClientRect();
        const style = doc.defaultView.getComputedStyle(link);
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
                    focused: doc.activeElement === link, focusVisible: link.matches(':focus-visible'),
            label: link.getAttribute('aria-label'), tabIndex: link.tabIndex, outline: style.outlineStyle,
            outlineWidth: style.outlineWidth, hash: doc.defaultView.location.hash,
            scrollY: doc.defaultView.scrollY, top: target?.getBoundingClientRect().top,
            height: doc.defaultView.innerHeight, line: target?.getAttribute('data-line'),
                        trustedClick: doc.__m2ClickTrusted, ready: doc.readyState === 'complete' };
    }
    return null;
}
async function observeLink(client, sessionId, href, action = 'inspect') {
    const result = await client.send('Runtime.evaluate', {
        expression: `(${observePreviewLink.toString()})(${JSON.stringify(href)}, ${JSON.stringify(action)})`,
        returnByValue: true
    }, sessionId);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result?.value;
}
async function findRenderedLink(client, href, line) {
    for (let attempt = 0; attempt < 60; attempt++) {
        const { targetInfos } = await client.send('Target.getTargets');
        for (const target of targetInfos.filter(value => ['iframe', 'page'].includes(value.type))) {
            const { sessionId } = await client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
            const value = await observeLink(client, sessionId, href);
            if (value?.ready && (line === undefined || value.line === String(line))) { return sessionId; }
            await client.send('Target.detachFromTarget', { sessionId });
        }
        await delay(200);
    }
    assert.fail('current rendered link/source map was not found in the real webview');
}
async function pressKey(client, sessionId, key, code) {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key,
        windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
        ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) }, sessionId);
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key,
        windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }, sessionId);
}
async function keyboardLink(client, href, label, line) {
    const sessionId = await findRenderedLink(client, href, line);
    try {
        const before = await observeLink(client, sessionId, href, 'prepare');
        await pressKey(client, sessionId, 'Tab', 9);
        const focus = await observeLink(client, sessionId, href);
        assert.equal(focus.focused, true, 'Tab reaches the intended native anchor');
        assert.equal(focus.focusVisible, true);
        assert.equal(focus.tabIndex, 0);
        assert.equal(focus.label, label);
        assert.equal(focus.outline, 'solid');
        assert.ok(parseFloat(focus.outlineWidth) > 0);
        await pressKey(client, sessionId, 'Enter', 13);
        assert.equal((await observeLink(client, sessionId, href)).trustedClick, true);
        const local = line === undefined ? undefined
            : await assertLocalDestination(client, sessionId, href, line, before.scrollY);
        return { href, label, tab: true, enter: true, trustedClick: true,
            focusVisible: true, outline: `${focus.outlineWidth} ${focus.outline}`, local };
    } finally { await client.send('Target.detachFromTarget', { sessionId }); }
}
async function assertLocalDestination(client, sessionId, href, line, beforeScroll) {
    let after;
    for (let attempt = 0; attempt < 50; attempt++) {
        after = await observeLink(client, sessionId, href);
        if (after.top >= -1 && after.top < after.height && after.scrollY > beforeScroll + 100) { break; }
        await delay(100);
    }
    assert.equal(after.line, String(line));
    assert.ok(after.top >= -1 && after.top < after.height, JSON.stringify(after));
    assert.ok(after.scrollY > beforeScroll + 100, 'Enter scrolls to the distant local declaration');
    return { sourceLine: line, beforeScroll, afterScroll: after.scrollY,
        targetTop: after.top, viewportHeight: after.height };
}
async function prependUnsaved(document) {
    const disk = await fs.readFile(document.uri.fsPath, 'utf8');
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0), 'Unsaved prose.\n\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(document.isDirty, true);
    assert.equal(await fs.readFile(document.uri.fsPath, 'utf8'), disk);
}
async function exerciseHostNavigation(client, doc, base, localLine, href) {
    const local = '#f-006c006f00630061006c', checks = [];
    checks.push(await keyboardLink(client, local, 'Definition of local', localLine));
    await prependUnsaved(doc);
    assert.match(doc.lineAt(localLine + 2).text, /<<local>>=/);
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
    checks.push(await keyboardLink(client, local, 'Definition of local', localLine + 2));
    checks.push(await keyboardLink(client, href, 'Definition of target'));
    await assertEditorDestination(base, 4);
    checks.push({ destination: 'base.literate', zeroBasedLine: 4, canonical: true });
    await prependUnsaved(base);
    await vscode.workspace.getConfiguration('markdown').update('preview.openMarkdownLinks', 'inPreview', vscode.ConfigurationTarget.Workspace);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
    checks.push(await keyboardLink(client, href, 'Definition of target'));
    await assertEditorDestination(base, 6);
    checks.push({ destination: 'base.literate', zeroBasedLine: 6, sameDirtyDocument: true });

    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
    const sessionId = await findRenderedLink(client, href);
    try {
        const point = await observeLink(client, sessionId, href, 'point');
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 }, sessionId);
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 }, sessionId);
    } finally { await client.send('Target.detachFromTarget', { sessionId }); }
    await assertEditorDestination(base, 6);
    checks.push({ click: true, destination: 'base.literate', zeroBasedLine: 6, sameDirtyDocument: true });
    return checks;
}
async function prepareHostFixture() {
    const root = vscode.workspace.workspaceFolders[0].uri;
    assert.equal(root.fsPath, path.resolve(__dirname, '../../../out/m2-host/workspace'));
    const fence = (header, body) => '```' + header + '\n' + body + '\n```\n';
    const baseText = '# Definitions\n\nProse before destination.\n\n' + fence('text: <<target>>=', 'base');
    await fs.mkdir(path.join(root.fsPath, 'nested'), { recursive: true });
    await fs.writeFile(path.join(root.fsPath, 'index.literate'), '[Use](nested/use.html)\n[Base](base.html)\n');
    const source = fence('jsonc : <<caller>>=', '{"v":"<<local>> <<target>>"}')
        + 'Spacer paragraph.\n\n'.repeat(60) + fence('text: <<local>>=', 'local value')
        + 'Trailing paragraph.\n\n'.repeat(30);
    const localLine = source.slice(0, source.indexOf('```text: <<local>>=')).split('\n').length - 1;
    await fs.writeFile(path.join(root.fsPath, 'nested/use.literate'), source);
    await fs.writeFile(path.join(root.fsPath, 'base.literate'), baseText);
    await vscode.workspace.getConfiguration('files').update('associations', { '*.literate': 'markdown' }, vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration('markdown').update('preview.openMarkdownLinks', 'inEditor', vscode.ConfigurationTarget.Workspace);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'nested/use.literate'));
    const base = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'base.literate'));
    return { root, doc, base, localLine };
}
exports.run = async () => {
    const { root, doc, base, localLine } = await prepareHostFixture();
    await vscode.extensions.getExtension('jesterking.literate').activate();
    await vscode.commands.executeCommand('markdown.api.reloadPlugins');
    const html = await vscode.commands.executeCommand('markdown.api.render', doc);
    assert.doesNotMatch(html, /#L\d+/);
    assert.match(html, /hljs-string/);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
    const version = await (await fetch('http://127.0.0.1:9333/json/version')).json();
    const client = await connect(version.webSocketDebuggerUrl);
    try {
        const href = await hostCapability(doc);
        const checks = await exerciseHostNavigation(client, doc, base, localLine, href);
        await fs.writeFile(path.join(root.fsPath, 'navigation-evidence.json'), JSON.stringify({
            date: '2026-09-27', version: vscode.version, modes: ['inEditor', 'inPreview'], checks, screenReader: false
        }, null, 2));
        console.log('M2_HOST_NAVIGATION_PASS', vscode.version, JSON.stringify(checks));
    } finally { client.close(); }
};
async function assertEditorDestination(document, line) {
    const file = document.uri.fsPath;
    for (let attempt = 0; attempt < 50; attempt++) {
        const editor = vscode.window.activeTextEditor;
        if (editor?.document.uri.fsPath === file && editor.selection.active.line === line) {
                    assert.match(editor.document.lineAt(line).text, /<<target>>=/, 'selected line is the actual declaration');
            assert.equal(editor.document, document, 'navigation reuses the canonical TextDocument object');
            assert.equal(editor.document.uri.fragment, '');
            assert.equal(vscode.workspace.textDocuments.filter(doc => !doc.isClosed && doc.uri.fsPath === file).length, 1);
            return;
                }
        await delay(100);
    }
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, file);
    assert.equal(vscode.window.activeTextEditor?.selection.active.line, line);
}
async function hostCapability(document) {
    for (let attempt = 0; attempt < 50; attempt++) {
        const html = await vscode.commands.executeCommand('markdown.api.render', document);
        const href = html.match(/href="([^"]+)" data-literate-target="f-007400610072006700650074"/);
        if (href) {
            assert.match(href[1], /^vscode:\/\/jesterking\.literate\/navigate\/[a-f0-9]{48}\/[a-f0-9]{48}/);
            return href[1].replace(/&amp;/g, '&');
        }
        await delay(100);
    }
    assert.fail('external capability URL did not resolve');
}
