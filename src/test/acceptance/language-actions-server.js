// Controlled protocol fixture, NOT an installed CSS language server.
// No workspace I/O: diagnostics and edit-only actions use synchronized in-memory text.
const documents = new Map();
let buffer = Buffer.alloc(0);
const send = message => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`); process.stdout.write(body);
};
function diagnostic(uri) {
    const text = documents.get(uri)?.text;
    if (!text) { return; }
    const offset = text.indexOf('colr: red;'); if (offset < 0) { return; }
    const lines = text.slice(0, offset).split('\n'), line = lines.length - 1, character = lines[line].length;
    return { range: { start: { line, character }, end: { line, character: character + 4 } },
        severity: 2, code: 'unknownProperties', source: 'acceptance-css', message: "Controlled fixture: unknown property 'colr'" };
}
function handle(message) {
    const { id, method, params = {} } = message;
    let result = null;
    switch (method) {
        case 'initialize':
            result = { capabilities: { positionEncoding: 'utf-16', textDocumentSync: { openClose: true, change: 1 },
                diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
                codeActionProvider: { codeActionKinds: ['quickfix'], resolveProvider: false } },
                serverInfo: { name: 'literate-acceptance-controlled-css', version: '1' } };
            break;
        case 'textDocument/didOpen': documents.set(params.textDocument.uri, params.textDocument); return;
        case 'textDocument/didChange': {
            if (params.contentChanges.length !== 1 || params.contentChanges[0].range !== undefined) {
                throw new Error('Controlled fixture requires negotiated full document synchronization');
            }
            documents.set(params.textDocument.uri, { ...params.textDocument, text: params.contentChanges[0].text }); return;
        }
        case 'textDocument/didClose': documents.delete(params.textDocument.uri); return;
        case 'textDocument/diagnostic': {
            const item = diagnostic(params.textDocument.uri); result = { kind: 'full', items: item ? [item] : [] }; break;
        }
        case 'textDocument/codeAction': {
            const uri = params.textDocument.uri, item = diagnostic(uri);
            result = item && params.context?.triggerKind === 1
                && params.context.diagnostics.some(d => d.code === item.code && JSON.stringify(d.range) === JSON.stringify(item.range))
                && JSON.stringify(params.range) === JSON.stringify(item.range)
                ? [{ title: "Controlled CSS: rename to 'color'", kind: 'quickfix', diagnostics: [item],
                    edit: { changes: { [uri]: [{ range: item.range, newText: 'color' }] } } }] : [];
            break;
        }
        case 'shutdown': break;
        case 'exit': process.exit(0); return;
        case 'initialized': case '$/cancelRequest': return;
        default:
            if (id !== undefined) { send({ id, error: { code: -32601, message: 'Unsupported fixture method: ' + method } }); }
            return;
    }
    if (id !== undefined) { send({ id, result }); }
}
process.stdin.on('data', data => {
    try {
        buffer = Buffer.concat([buffer, data]);
        if (buffer.length > 4 * 1024 * 1024) { throw new Error('Fixture input limit exceeded'); }
        while (true) {
            const end = buffer.indexOf('\r\n\r\n'); if (end < 0) { return; }
            const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString());
            if (!match) { throw new Error('Missing Content-Length'); }
            const length = Number(match[1]); if (buffer.length < end + 4 + length) { return; }
            const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
            buffer = buffer.subarray(end + 4 + length); handle(message);
        }
    } catch (error) { console.error(error); process.exit(1); }
});
process.stdin.on('end', () => process.exit(0));
// Independent fail-safe in addition to the host launcher's owned-process-group bound.
setTimeout(() => process.exit(2), 180000).unref();
