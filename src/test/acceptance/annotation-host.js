// Real installed-host M6 acceptance; launch with annotation-host-run.js.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const target = key => 'annotation-term-' + key.split('').map(c => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
async function connect(port) {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const socket = new WebSocket(version.webSocketDebuggerUrl), pending = new Map();
    let id = 0;
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CDP connection timeout')), 5000);
        socket.onopen = () => { clearTimeout(timer); resolve(); };
        socket.onerror = error => { clearTimeout(timer); reject(error); };
    });
    socket.onmessage = event => {
        const value = JSON.parse(event.data), entry = pending.get(value.id);
        if (entry) { pending.delete(value.id); clearTimeout(entry.timer);
            if (entry.method === 'Target.detachFromTarget' && value.error?.message === 'No session with given id') {
                entry.resolve({}); // Navigation may already have disposed the old preview target.
            } else { value.error ? entry.reject(new Error(`${entry.method}: ${JSON.stringify(value.error)}`)) : entry.resolve(value.result); } }
    };
    return { close: () => socket.close(), send(method, params = {}, sessionId) {
        return new Promise((resolve, reject) => {
            const next = ++id;
            const timer = setTimeout(() => { pending.delete(next); reject(new Error(`${method} timed out`)); }, 5000);
            pending.set(next, { resolve, reject, timer, method });
            socket.send(JSON.stringify({ id: next, method, params, sessionId }));
        });
    } };
}
// Executed inside the actual native Markdown webview, never a synthetic DOM.
function inspect(marker, selector, action) {
    const docs = [document, ...Array.from(document.querySelectorAll('iframe')).map(frame => {
        try { return frame.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const doc = docs.find(doc => doc.querySelector('.literate-document')?.textContent.includes(marker));
    if (!doc || doc.readyState !== 'complete') { return null; }
    const link = selector ? doc.querySelector(selector) : null;
    if ((action === 'prepare' || action === 'point') && !link) { throw new Error(`Missing preview anchor: ${selector}`); }
    if (action === 'prepare') {
        const links = Array.from(doc.querySelectorAll('a[href]'));
        const previous = links[links.indexOf(link) - 1];
        if (!previous) { throw new Error('Missing preceding keyboard anchor'); }
        previous.focus(); doc.__m6Trusted = null;
        doc.addEventListener('click', event => { doc.__m6Trusted = event.isTrusted; }, { once: true, capture: true });
    }
    if (action === 'point') {
        link.scrollIntoView({ block: 'center' }); doc.__m6Trusted = null;
        doc.addEventListener('click', event => { doc.__m6Trusted = event.isTrusted; }, { once: true, capture: true });
    }
    const rect = link?.getBoundingClientRect(), style = link && doc.defaultView.getComputedStyle(link);
    return { html: doc.querySelector('.literate-document').outerHTML,
        indexes: Array.from(doc.querySelectorAll('.literate-screen-index')).map(el => ({ label: el.getAttribute('aria-label'), text: el.textContent })),
        annotations: Array.from(doc.querySelectorAll('.literate-annotation')).map(el => ({ id: el.id, line: el.getAttribute('data-line'), text: el.textContent })),
        links: Array.from(doc.querySelectorAll('.literate-document a')).map(el => ({ text: el.textContent, href: el.getAttribute('href'), target: el.getAttribute('data-literate-target') })),
        unresolved: Array.from(doc.querySelectorAll('.literate-term-unresolved')).map(el => ({ text: el.textContent, tag: el.tagName, tabIndex: el.tabIndex })),
        unsafe: doc.querySelectorAll('.literate-annotation script, .literate-annotation img, .literate-annotation [onerror]').length,
        executed: doc.defaultView.__m6Unsafe === true,
        link: link && { href: link.getAttribute('href'), focused: doc.activeElement === link, focusVisible: link.matches(':focus-visible'),
            tabIndex: link.tabIndex, outline: style.outlineStyle, width: style.outlineWidth, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        trusted: doc.__m6Trusted };
}
async function observe(client, session, marker, selector, action) {
    const result = await client.send('Runtime.evaluate', { returnByValue: true,
        expression: `(${inspect.toString()})(${JSON.stringify(marker)},${JSON.stringify(selector || '')},${JSON.stringify(action || '')})` }, session);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result?.value;
}
async function preview(client, document, marker, predicate = () => true) {
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('markdown.showPreview', document.uri);
    for (let attempt = 0; attempt < 60; attempt++) {
        const { targetInfos } = await client.send('Target.getTargets');
        for (const target of targetInfos.filter(t => ['page', 'iframe'].includes(t.type))) {
            try {
                const { sessionId } = await client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                const value = await observe(client, sessionId, marker);
                if (value && predicate(value)) { return { session: sessionId, value }; }
                await client.send('Target.detachFromTarget', { sessionId });
            } catch (error) {
                // Native preview refresh can destroy a target while discovery is in flight.
                if (!/No session with given id|No target with given id|Session closed|Cannot find context/.test(error.message)) { throw error; }
            }
        }
        await delay(150);
    }
    assert.fail(`Native preview not ready: ${marker}`);
}
async function key(client, session, key, code) {
    for (const type of ['keyDown', 'keyUp']) {
        await client.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code,
            nativeVirtualKeyCode: code, ...(key === 'Enter' && type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) }, session);
    }
}
async function activateLink(client, session, marker, selector, keyboard) {
    let state = await observe(client, session, marker, selector, keyboard ? 'prepare' : 'point');
    assert.match(state.link.href, /^vscode:\/\/jesterking\.literate\/navigate\/[a-f0-9]{48}\/[a-f0-9]{48}/);
    assert.doesNotMatch(state.link.href, /#L\d+/);
    if (keyboard) {
        await key(client, session, 'Tab', 9);
        state = await observe(client, session, marker, selector);
        assert.equal(state.link.focused, true); assert.equal(state.link.focusVisible, true);
        assert.equal(state.link.tabIndex, 0);
        assert.notEqual(state.link.outline, 'none'); assert.ok(parseFloat(state.link.width) > 0);
        await key(client, session, 'Enter', 13);
    } else {
        for (const type of ['mousePressed', 'mouseReleased']) {
            await client.send('Input.dispatchMouseEvent', { type, x: state.link.x, y: state.link.y, button: 'left', clickCount: 1 }, session);
        }
    }
    const after = await observe(client, session, marker, selector);
    assert.equal(after.trusted, true, 'Browser-generated trusted click');
    return { modality: keyboard ? 'CDP Tab/Enter after instrumented preceding-anchor focus' : 'CDP mouse press/release after instrumented scrollIntoView',
        href: state.link.href, trustedClick: after.trusted, focus: keyboard ? state.link : undefined };
}
async function destination(document, declaration) {
    const line = document.getText().split('\n').findIndex(text => text === declaration);
    assert.ok(line >= 0);
    for (let attempt = 0; attempt < 60; attempt++) {
        const editor = vscode.window.activeTextEditor;
        if (editor?.document === document && editor.selection.active.line === line) {
            assert.equal(document.uri.fragment, '');
            assert.equal(vscode.workspace.textDocuments.filter(doc => !doc.isClosed && doc.uri.fsPath === document.uri.fsPath).length, 1);
            return { path: path.basename(document.uri.fsPath), line, declaration, canonical: true, dirty: document.isDirty };
        }
        await delay(100);
    }
    assert.fail(`Expected canonical ${document.uri.fsPath}:${line}; got ${vscode.window.activeTextEditor?.document.uri} line ${vscode.window.activeTextEditor?.selection.active.line}`);
}
exports.run = async () => {
    const run = process.env.M6_HOST_RUN;
    assert.ok(run && path.basename(run).startsWith('m6-host-'));
    assert.equal(path.dirname(run), path.resolve(__dirname, '../../../out'));
    const root = path.join(run, 'workspace');
    assert.equal(vscode.workspace.workspaceFolders?.length, 1);
    assert.equal(vscode.workspace.workspaceFolders[0].uri.fsPath, root);
    const evidence = { version: vscode.version, date: new Date().toISOString(), checks: [],
        modality: { activation: 'real development extension out/main.js', preview: 'native markdown.showPreview via command API; CDP DOM inspection',
            edits: 'WorkspaceEdit unsaved canonical TextDocument', physicalKeyboard: false, screenReader: false, navigationMocked: false } };
    let client;
    try {
        assert.match(vscode.version, /^1\.138\./);
        const fence = (header, body) => '```' + header + '\n' + body + '\n```\n';
        const texts = {
            'index.literate': '# M6RootMarker\n\n[Chapter](chapter.html)\n\n[Root prose](term:root-key) and [Cross prose](term:chapter-key).\n\n'
                + fence('TERM root-key "Shared display"', 'Root definition with [Body cross](term:chapter-key).')
                + '\n' + fence('NOTE', 'Safe **strong** and *emphasis* and `code`. [Note cross](term:chapter-key).\n\n- List item\n\n<script>window.__m6Unsafe=true</script>\n<img src=x onerror="window.__m6Unsafe=true">\n\n[Unknown body](term:missing-body)')
                + '\n[Unknown prose](term:missing-prose).\n\n' + fence('text: <<root-fragment>>=', 'root'),
            'chapter.literate': '# M6ChapterMarker\n\n[Previous](#m6chaptermarker) [Back root](term:root-key).\n\n'
                + fence('TERM chapter-key "Shared display"', 'Chapter definition with [Body root](term:root-key).')
                + '\n' + fence('NOTE', 'Chapter safe note.') + '\n' + fence('text: <<chapter-fragment>>=', 'chapter')
        };
        for (const [name, text] of Object.entries(texts)) { await fs.writeFile(path.join(root, name), text); }
        const docs = {};
        for (const name of Object.keys(texts)) { docs[name] = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, name))); }
        const extension = vscode.extensions.getExtension('jesterking.literate');
        assert.ok(extension); assert.equal(extension.extensionPath, path.resolve(__dirname, '../../..'));
        await extension.activate(); assert.equal(extension.isActive, true);
        await vscode.commands.executeCommand('markdown.api.reloadPlugins');
        client = await connect(Number(process.env.M6_CDP_PORT));
        const rootDoc = docs['index.literate'], chapter = docs['chapter.literate'];
        let view = await preview(client, rootDoc, 'M6RootMarker', value => value.indexes.length === 2
            && ['Cross prose', 'Body cross', 'Note cross'].every(text => value.links.some(link => link.text === text && link.href?.startsWith('vscode://'))));
        await fs.writeFile(path.join(run, 'root-before.json'), JSON.stringify(view.value, null, 2));
        assert.deepEqual(view.value.indexes.map(index => index.label), ['Term index', 'Fragment index']);
        assert.equal(view.value.annotations.find(a => a.id === target('root-key')).text.includes('Shared display'), true);
        const definitions = view.value.links.filter(link => link.text === 'Shared display');
        assert.deepEqual(new Set(definitions.map(link => link.target)), new Set([target('root-key'), target('chapter-key')]));
        for (const label of ['Cross prose', 'Body cross', 'Note cross']) {
            const link = view.value.links.find(link => link.text === label);
            assert.equal(link?.target, target('chapter-key')); assert.match(link.href, /^vscode:\/\//);
        }
        assert.equal(view.value.links.find(link => link.text === 'Root prose')?.href, '#' + target('root-key'));
        assert.equal(view.value.unsafe, 0); assert.equal(view.value.executed, false);
        assert.match(view.value.html, /&lt;script&gt;/); assert.match(view.value.html, /<strong>strong<\/strong>/);
        assert.match(view.value.html, /<em>emphasis<\/em>/); assert.match(view.value.html, /<code>code<\/code>/);
        assert.match(view.value.html, /<li>List item<\/li>/);
        assert.deepEqual(view.value.unresolved.map(item => item.text).sort(), ['Unknown body', 'Unknown prose']);
        for (const item of view.value.unresolved) { assert.equal(item.tag, 'SPAN'); assert.equal(item.tabIndex, -1); }
        assert.doesNotMatch(view.value.html, /href="(?:term:|[^"]*#L\d+)/);
        assert.match(view.value.indexes[0].text, /Reference 1/); assert.match(view.value.indexes[1].text, /root-fragment.*chapter-fragment/s);
        evidence.checks.push('root-only term/fragment indexes, distinct keys with identical display, prose/body links, escaped unsafe note body, tolerant inert unknown terms');
        const selector = `.literate-term a[data-literate-target="${target('chapter-key')}"]`;
        evidence.checks.push(await activateLink(client, view.session, 'M6RootMarker', selector, true));
        evidence.checks.push(await destination(chapter, '```TERM chapter-key "Shared display"'));
        await client.send('Target.detachFromTarget', { sessionId: view.session });
        view = await preview(client, chapter, 'M6ChapterMarker', value =>
            ['Back root', 'Body root'].every(text => value.links.some(link => link.text === text && link.href?.startsWith('vscode://'))));
        assert.deepEqual(view.value.indexes, []);
        assert.equal(view.value.annotations.filter(a => a.text.includes('Chapter safe note')).length, 1);
        assert.equal(view.value.links.find(link => link.text === 'Body root')?.target, target('root-key'));
        await fs.writeFile(path.join(run, 'chapter.json'), JSON.stringify(view.value, null, 2));
        evidence.checks.push(await activateLink(client, view.session, 'M6ChapterMarker', `a[data-literate-target="${target('root-key')}"]`, false));
        evidence.checks.push(await destination(rootDoc, '```TERM root-key "Shared display"'));
        await client.send('Target.detachFromTarget', { sessionId: view.session });
        const edit = new vscode.WorkspaceEdit();
        const dirty = 'Unsaved source shift.\n\n\n' + texts['chapter.literate'].replace('TERM chapter-key "Shared display"', 'TERM chapter-key "Changed dirty title"');
        edit.replace(chapter.uri, new vscode.Range(chapter.positionAt(0), chapter.positionAt(chapter.getText().length)), dirty);
        assert.equal(await vscode.workspace.applyEdit(edit), true); assert.equal(chapter.isDirty, true);
        assert.equal(await fs.readFile(chapter.uri.fsPath, 'utf8'), texts['chapter.literate']);
        view = await preview(client, rootDoc, 'M6RootMarker', value => value.indexes[0]?.text.includes('Changed dirty title'));
        await fs.writeFile(path.join(run, 'root-dirty.json'), JSON.stringify(view.value, null, 2));
        evidence.checks.push(await activateLink(client, view.session, 'M6RootMarker', `.literate-note a[data-literate-target="${target('chapter-key')}"]`, false));
        evidence.checks.push(await destination(chapter, '```TERM chapter-key "Changed dirty title"'));
        await client.send('Target.detachFromTarget', { sessionId: view.session });
        view = await preview(client, chapter, 'M6ChapterMarker', value => value.annotations.some(a => a.text.includes('Changed dirty title')));
        const annotation = view.value.annotations.find(a => a.id === target('chapter-key'));
        assert.equal(Number(annotation.line), dirty.split('\n').findIndex(line => line.startsWith('```TERM')));
        assert.deepEqual(view.value.indexes, []);
        await fs.writeFile(path.join(run, 'chapter-dirty.json'), JSON.stringify(view.value, null, 2));
        await client.send('Target.detachFromTarget', { sessionId: view.session });
        evidence.checks.push('dirty canonical TERM title and +3-line source shift update root index and chapter source map; real click resolves current declaration without saving');
        assert.equal(chapter.isDirty, true); assert.equal(await fs.readFile(chapter.uri.fsPath, 'utf8'), texts['chapter.literate']);
        evidence.ok = true; console.log('M6_HOST_ANNOTATION_PASS', vscode.version);
    } catch (error) { evidence.ok = false; evidence.failure = error.stack || String(error); throw error; }
    finally { client?.close(); await fs.writeFile(path.join(run, 'acceptance.json'), JSON.stringify(evidence, null, 2)); }
};
