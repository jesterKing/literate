"""Opt-in inline-code PDF probes; no generation, build, font installation or download.

Requires Node + repository TypeScript dependencies, Pandoc, LuaLaTeX, pdftotext,
pdftohtml and the configured default publication fonts. Runs the authoritative
literate renderer in memory; all evidence stays in a fresh ignored out directory.
An optional --ulem points to an existing package fixture, not a replacement font.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[3]
# Test-only loader: assemble the authoritative book in memory; never write generated sources.
LOADER = r'''
const fs = require('fs'), ts = require('typescript'), path = require('path');
let latex;
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(
    file === path.resolve('src/publication-latex.ts') && latex ? latex : fs.readFileSync(file, 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }
).outputText, file);
const { generateProject } = require('./src/engine.ts');
const names = fs.readdirSync('literate').filter(name => name.endsWith('.literate')).sort();
const documents = [{ path: 'index.literate', text: fs.readFileSync('index.literate', 'utf8') },
    ...names.map(name => ({ path: `literate/${name}`, text: fs.readFileSync(`literate/${name}`, 'utf8') }))];
const result = generateProject(documents, { 'tssrc.template': fs.readFileSync('tssrc.template', 'utf8') });
if (result.diagnostics.length) { throw new Error(`book diagnostics: ${result.diagnostics.length}`); }
latex = result.files.find(file => file.path === 'src/publication-latex.ts').content;
delete require.cache[path.resolve('src/publication-latex.ts')];
require('./src/test/headless/publication-polish.test.ts');
'''


def run(args, cwd, transcript, env=None):
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
    transcript.write_bytes(result.stdout)
    assert result.returncode == 0, f'{args[0]} failed; see {transcript}'


def inspect_spaces(pdf, evidence):
    bbox = pdf.with_suffix('.bbox.html')
    run(['pdftotext', '-bbox', pdf, bbox], evidence, pdf.with_name(pdf.stem + '-bbox-transcript.txt'))
    words = ET.parse(bbox).findall('.//{http://www.w3.org/1999/xhtml}word')

    def word(text):
        found = [item for item in words if item.text == text]
        assert len(found) == 1, (pdf.name, text, len(found))
        return found[0]

    gaps = {}
    for label, count in [('One', 1), ('Two', 2), ('Four', 4)]:
        left, right = word(f'Space{label}A'), word(f'Space{label}B')
        assert abs(float(left.attrib['yMin']) - float(right.attrib['yMin'])) < 0.01, pdf.name
        gap = float(right.attrib['xMin']) - float(left.attrib['xMax'])
        # The selected monospaced font supplies the advance; never normalize text whitespace.
        advance = (float(left.attrib['xMax']) - float(left.attrib['xMin'])) / len(left.text)
        assert abs(gap - count * advance) < 0.05, (pdf.name, count, gap, advance)
        gaps[str(count)] = gap
    return gaps


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ulem', type=Path)
    args = parser.parse_args()
    evidence = Path(tempfile.mkdtemp(prefix='polish-acceptance-', dir=REPO / 'out'))
    print(evidence, flush=True)
    if args.ulem:
        shutil.copyfile(args.ulem.resolve(), evidence / 'ulem.sty')
    env = dict(os.environ, LITERATE_POLISH_EVIDENCE=str(evidence))
    run(['node', '-e', LOADER], REPO, evidence / 'headless.txt', env)
    results = []
    for tex in sorted(evidence.glob('*.tex')):
        baseline = tex.stem.endswith('-baseline')
        for pass_number in range(2):
            run(['lualatex', '-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape',
                 tex.name], evidence, evidence / f'{tex.stem}-pass{pass_number}.txt')
        log = tex.with_suffix('.log').read_text()
        overfull = re.findall(r'Overfull [^\n]+', log)
        assert bool(overfull) == baseline, (tex.name, overfull)
        assert 'Missing character:' not in log, tex.name
        assert 'Token not allowed in a PDF string' not in log, tex.name
        spacing = None
        if not baseline:
            spacing = inspect_spaces(tex.with_suffix('.pdf'), evidence)
            run(['pdftotext', '-layout', tex.with_suffix('.pdf'), tex.with_suffix('.txt')],
                evidence, evidence / f'{tex.stem}-text-transcript.txt')
            text = tex.with_suffix('.txt').read_text()
            compact = re.sub(r'\s+', '', text)
            long_path = 'out/publication-probe/highlighting/' + 'long-directory/' * 16 + 'ENDPATH.cjs'
            assert compact.count(long_path) == 3, tex.name  # prose, nested prose, fence
            for marker in ['HeadingCode', 'BoldCode', 'ItalicCode', 'BothCode', 'StrikeCode',
                           'NOT-A-FILE', 'café', 'Shared', 'Caller']:
                assert marker in compact, (tex.name, marker)
            run(['pdftohtml', '-xml', '-hidden', '-i', tex.with_suffix('.pdf'), tex.with_suffix('.xml')],
                evidence, evidence / f'{tex.stem}-xml-transcript.txt')
            xml = ET.parse(tex.with_suffix('.xml'))
            fonts = {font.attrib['id']: font.attrib['family'] for font in xml.findall('.//fontspec')}
            for marker, bold, italic in [('BoldCode', True, False), ('ItalicCode', False, True),
                                         ('BothCode', True, True)]:
                found = [item for item in xml.findall('.//text') if ''.join(item.itertext()) == marker]
                assert len(found) == 1, (tex.name, marker)
                item = found[0]
                assert 'LilexNF' in fonts[item.attrib['font']], (tex.name, marker)
                assert (item.find('.//b') is not None) == bold, (tex.name, marker)
                assert (item.find('.//i') is not None) == italic, (tex.name, marker)
            scale = 72 / 25.4 * 1.5
            width = 210 if tex.name.startswith('A4') else 148
            for item in xml.findall('.//text'):
                left, item_width = float(item.attrib['left']), float(item.attrib['width'])
                assert left >= 20 * scale - 6 and left + item_width <= (width - 20) * scale + 6, (
                    tex.name, ''.join(item.itertext()), left, item_width)
        results.append({'fixture': tex.name, 'overfull': overfull, 'spaceGapsPt': spacing})
    assert len(results) == 12
    (evidence / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    print('PASS: six A4/A5 palette fixtures, six overflowing controls, text, measured spaces, font styles and horizontal bounds')


if __name__ == '__main__':
    main()
