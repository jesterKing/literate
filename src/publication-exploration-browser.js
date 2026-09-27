'use strict';

// Closure-free: standalone HTML embeds this source without the module wrapper.
function initializePublicationExploration(document) {
    const view = document.defaultView;
    if (!view || document.__literateExploration) { return; }
    document.__literateExploration = true;
    const limits = { payload: 1048576, layers: 8, bytes: 262144, panels: 200, parts: 200, segments: 4096 };
    const roots = new Map();
    const controls = new Map();
    const panels = new Map();
    const encoder = new view.TextEncoder();
    const own = (object, key) => object && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
    const record = value => value && typeof value === 'object' && !Array.isArray(value);
    const identifier = value => typeof value === 'string' && value.length <= 4096 && /^[A-Za-z0-9_-]+$/.test(value);
    const connected = node => !!node && document.documentElement.contains(node);
    let usedBytes = 0, serial = 0, focused;
    const element = (tag, text) => {
        const node = document.createElement(tag);
        if (text !== undefined) { node.textContent = text; }
        return node;
    };
    function inPanel(node) {
        for (let parent = node; parent; parent = parent.parentNode) { if (panels.has(parent)) { return true; } }
        return false;
    }
    function safeHref(href, target, baseline = false) {
        if (typeof href !== 'string' || href.length > 4096 || /[\s\u0000-\u001f\u007f\\]/.test(href)) { return undefined; }
        if (identifier(target) && href === '#' + target) { return href; }
        if (identifier(target) && href.endsWith('#' + target)) {
            const path = href.slice(0, -target.length - 1);
            if (path.startsWith('./') && path.endsWith('.html') && path.slice(2).split('/').every(
                part => /^(?:[A-Za-z0-9_~.!'()*-]|%[0-9a-fA-F]{2})+$/.test(part))) { return href; }
        }
        if (/^vscode(?:-insiders)?:\/\/jesterking\.literate\/navigate\/[a-f0-9]{48}\/[a-f0-9]{48}(?:\?[^#]*)?$/.test(href)) { return href; }
        // HTTPS transport shapes belong to the host. Never authorize one from JSON alone.
        if (baseline && /^https:\/\//.test(href)) {
            try {
                const url = new view.URL(href);
                if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) { return href; }
            } catch (_) { /* Invalid URLs remain plain text. */ }
        }
        return undefined;
    }
    function linkFor(context, model, target) {
        if (context.links.has(target)) { return context.links.get(target); }
        return safeHref(own(model.families, target)?.href, target);
    }
    function focusWithin(control) {
        const active = document.activeElement;
        if (control.button === active || control.panel?.contains(active)) { return true; }
        return focused?.top === control && (!active || active === document.body || !connected(active));
    }
    function close(control) {
        if (!control.panel) { return; }
        for (const child of [...control.children]) { destroy(child); }
        const cost = panels.get(control.panel)?.cost;
        if (cost !== undefined) { usedBytes -= cost; panels.delete(control.panel); }
        control.panel.remove(); control.panel = undefined;
        control.button.setAttribute('aria-expanded', 'false');
        control.button.removeAttribute('aria-controls');
        control.note.textContent = '';
    }
    function destroy(control) {
        close(control);
        controls.delete(control.use);
        control.parent?.children.delete(control);
        control.context.controls.delete(control.use);
        control.button.remove(); control.note.remove();
    }
    function restore(request) {
        if (!request) { return; }
        const replacement = controls.get(request.use) || [...controls.values()].find(control =>
            !control.parent && control.target === request.target);
        const anchor = [request.use.querySelector('a'), request.context.root.querySelector('a'),
            ...document.querySelectorAll('a')].find(node => connected(node) && node.getAttribute('href'));
        const destination = replacement?.button || anchor;
        focused = undefined;
        if (destination) { destination.focus(); }
    }
    // Account for serialized text/attributes without constructing candidate DOM or expanded strings.
    function escapedCost(text) {
        if (typeof text !== 'string' || text.length > limits.bytes) { return Infinity; }
        let cost = encoder.encode(text).length;
        for (const character of text) {
            if (character === '&') { cost += 4; }
            else if (character === '<' || character === '>') { cost += 3; }
            else if (character === '"' || character === "'") { cost += 5; }
        }
        return cost;
    }
    function plan(control) {
        const { model, target, path, context } = control;
        const family = own(model.families, target);
        if (model.unavailable) { return { reason: 'Exploration data is unavailable.' }; }
        if (!identifier(target) || !record(family) || typeof family.name !== 'string' || family.name.length > 1024 || !Array.isArray(family.parts)) {
            return { reason: 'Fragment is unavailable in this snapshot.' };
        }
        if (path.includes(target)) { return { reason: 'Cycle: this fragment is already open on this path.' }; }
        if (path.length >= limits.layers) { return { reason: 'Exploration is limited to eight layers.' }; }
        if (panels.size >= limits.panels) { return { reason: 'Exploration panel limit reached; collapse a panel first.' }; }
        const failure = { reason: 'Exploration DOM budget or contribution limit reached. No code was truncated.' };
        if (family.parts.length > limits.parts) { return failure; }
        const parts = [], seen = new Set();
        let cost = 512 + escapedCost(family.name), count = 0;
        for (const id of family.parts) {
            if (!identifier(id) || seen.has(id)) { return failure; }
            seen.add(id);
            const segments = own(model.parts, id);
            if (!Array.isArray(segments) || (count += segments.length) > limits.segments) { return failure; }
            cost += 96;
            const entries = [];
            for (const segment of segments) {
                if (!record(segment) || typeof segment.text !== 'string') { return failure; }
                const reference = segment.reference === true;
                const destination = segment.target === undefined ? '' : segment.target;
                if (reference && destination !== '' && !identifier(destination)) { return failure; }
                const href = reference ? linkFor(context, model, destination) : undefined;
                cost += 96 + escapedCost(segment.text);
                if (reference) {
                    cost += 1024 + escapedCost(segment.text.slice(0, 512)) + escapedCost(destination) * 2;
                    if (href) { cost += escapedCost(href); }
                }
                if (cost + usedBytes > limits.bytes) { return failure; }
                entries.push({ text: segment.text, reference, target: destination, href });
            }
            if (cost + usedBytes > limits.bytes) { return failure; }
            parts.push(entries);
        }
        return cost + usedBytes <= limits.bytes ? { name: family.name, parts, cost } : failure;
    }
    function open(control) {
        const accepted = plan(control);
        if (accepted.reason) { control.note.textContent = accepted.reason + ' Definition links remain available.'; return; }
        const candidate = element('span');
        candidate.style.display = 'block';
        candidate.setAttribute('role', 'group');
        candidate.setAttribute('aria-label', 'Unexpanded fragment ' + accepted.name);
        candidate.append(element('span', 'Unexpanded fragment — plain text; explore references separately.\n'));
        for (const entries of accepted.parts) {
            const code = element('span'); code.style.whiteSpace = 'pre-wrap';
            for (const entry of entries) {
                const text = element(entry.href ? 'a' : 'span', entry.text);
                if (entry.href) { text.setAttribute('href', entry.href); text.setAttribute('data-literate-target', entry.target); }
                code.append(text);
                if (entry.reference) {
                    text.setAttribute('data-literate-explore', entry.target);
                    enhance(text, control.context, [...control.path, control.target], control);
                }
            }
            candidate.append(code);
        }
        do { candidate.id = 'literate-exploration-' + (++serial); } while (document.getElementById(candidate.id));
        // Diagnostic metadata is never read back for ownership or accounting.
        candidate.setAttribute('data-literate-panel-bytes', String(accepted.cost));
        usedBytes += accepted.cost;
        panels.set(candidate, { cost: accepted.cost, owner: control });
        control.panel = candidate;
        control.note.textContent = ''; control.note.after(candidate);
        control.button.setAttribute('aria-controls', candidate.id);
        control.button.setAttribute('aria-expanded', 'true');
    }
    function signature(use) {
        const anchor = use.matches('a') ? use : use.querySelector('a');
        return [use.getAttribute('data-literate-explore'), use.textContent.slice(0, 512), anchor,
            anchor?.getAttribute('href'), anchor?.getAttribute('data-literate-target')];
    }
    function enhance(use, context, path = [], parent) {
        const identity = signature(use);
        const button = element('button', 'Explore fragment'); button.type = 'button';
        button.setAttribute('aria-label', 'Explore ' + identity[1]);
        button.setAttribute('aria-expanded', 'false');
        const note = element('span'); note.setAttribute('role', 'status');
        use.after(button, note);
        const control = { use, context, model: context.model, identity, target: identity[0], path,
            button, note, parent, children: new Set(), panel: undefined };
        controls.set(use, control);
        if (parent) { parent.children.add(control); } else { context.controls.set(use, control); }
        button.addEventListener('click', () => {
            scan();
            if (controls.get(use) !== control) { return; }
            if (control.panel) {
                if (focusWithin(control)) { button.focus(); }
                close(control);
            } else { open(control); }
        });
        return control;
    }
    function readModel(source) {
        try {
            if (source.length > limits.payload || encoder.encode(source).length > limits.payload) { throw new Error('payload limit'); }
            const model = JSON.parse(source);
            if (!record(model) || model.version !== 1 || !record(model.parts) || !record(model.families)) { throw new Error('invalid model'); }
            return model;
        } catch (_) { return { unavailable: true }; }
    }
    function baselineLinks(root) {
        const links = new Map();
        for (const anchor of root.querySelectorAll('a')) {
            if (inPanel(anchor)) { continue; }
            const target = anchor.getAttribute('data-literate-target');
            if (!identifier(target)) { continue; }
            const href = safeHref(anchor.getAttribute('href'), target, true);
            links.set(target, links.has(target) && links.get(target) !== href ? undefined : href);
        }
        return links;
    }
    function scan() {
        let request;
        const retire = control => {
            if (focusWithin(control)) { request = control; }
            destroy(control);
        };
        const live = new Set(document.querySelectorAll('.literate-document'));
        for (const [root, context] of roots) {
            if (!live.has(root)) {
                for (const control of [...context.controls.values()]) { retire(control); }
                roots.delete(root);
            }
        }
        for (const root of live) {
            const payload = root.querySelector('script.literate-exploration-data[type="application/json"]');
            let context = roots.get(root);
            if (!payload) {
                if (context) { for (const control of [...context.controls.values()]) { retire(control); } roots.delete(root); }
                continue;
            }
            const source = payload.textContent;
            const links = baselineLinks(root);
            if (!context) {
                context = { root, payload, source, links, model: readModel(source), controls: new Map() };
                roots.set(root, context);
            } else {
                const changed = context.payload !== payload || context.source !== source;
                const relink = links.size !== context.links.size || [...links].some(([key, value]) =>
                                    !context.links.has(key) || context.links.get(key) !== value);
                if (changed || relink) { for (const control of [...context.controls.values()]) { retire(control); } }
                if (changed) { context.model = readModel(source); }
                Object.assign(context, { payload, source, links });
            }
            const uses = new Set([...root.querySelectorAll('[data-literate-explore]')].filter(use => !inPanel(use)));
            for (const [use, control] of [...context.controls]) {
                const identity = signature(use);
                if (!uses.has(use) || control.button.previousSibling !== use || control.note.previousSibling !== control.button
                    || identity.some((value, index) => value !== control.identity[index])) { retire(control); }
            }
            for (const use of uses) { if (!controls.has(use)) { enhance(use, context); } }
        }
        for (const control of [...controls.values()]) {
            if (!control.parent || controls.get(control.use) !== control) { continue; }
            const identity = signature(control.use);
            if (!connected(control.use) || control.button.previousSibling !== control.use
                || identity.some((value, index) => value !== control.identity[index])) {
                let top = control;
                while (top.parent) { top = top.parent; }
                if (focusWithin(top)) { request = top; }
                close(top);
            }
        }
        for (const [panel, { owner }] of [...panels]) {
            if (!connected(panel)) {
                let top = owner;
                while (top.parent) { top = top.parent; }
                if (focusWithin(top)) { request = top; }
                close(owner);
            }
        }
        restore(request);
    }
    document.addEventListener('focusin', event => {
        focused = undefined;
        for (const control of controls.values()) {
            if (!control.parent && (control.button === event.target || control.panel?.contains(event.target))) {
                focused = { top: control }; break;
            }
        }
    });
    scan();
    document.addEventListener('DOMContentLoaded', scan);
    view.addEventListener('vscode.markdown.updateContent', scan);
    new view.MutationObserver(scan).observe(document.documentElement, {
        childList: true, characterData: true, subtree: true, attributes: true,
        attributeFilter: ['data-literate-explore', 'data-literate-target', 'href', 'type', 'class']
    });
}

if (typeof module !== 'undefined' && module.exports) { module.exports = { initializePublicationExploration }; }
if (typeof document !== 'undefined') { initializePublicationExploration(document); }
