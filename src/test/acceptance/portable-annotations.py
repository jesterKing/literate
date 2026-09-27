"""Opt-in M6 acceptance against the production CLI; no downloads or installs.

Example: python3 src/test/acceptance/portable-annotations.py --font-manifest
out/portable-font-lilex/project/fonts.json --ulem out/portable-font-lilex/relocated/ulem.sty
Evidence and failures are preserved in a fresh ignored out directory.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('portable_layout', Path(__file__).with_name('portable-layout.py'))
layout = importlib.util.module_from_spec(spec)
# Reuse the explicit-input copier without creating files beside this harness.
bytecode = sys.dont_write_bytecode
try:
    sys.dont_write_bytecode = True
    spec.loader.exec_module(layout)
finally:
    sys.dont_write_bytecode = bytecode


def fixture(project):
    (project / 'index.literate').write_text('''# Annotation acceptance

[Definitions](chapter.literate).

Forward [FirstUse](term:alpha), repeated [AgainUse](term:alpha), and
crossfile [OtherUse](term:beta).

```NOTE
PlainSentinel is a plain note.
```

```NOTE
- ListFirst
- ListSecond

**BoldSentinel** and *ItalicSentinel* with `CodeSentinel`.
```

```js : <<Sample>>=
const FragmentBase = 1;
```

''' + '\n\n'.join('BodySentinel paragraph %d. ' % i +
        'Ordinary prose keeps annotations on distinct physical pages. ' * 12 for i in range(18)) + '''

Later [LaterUse](term:alpha).
''')
    (project / 'chapter.literate').write_text('''# Definitions

```TERM alpha "Shared label"
AlphaDefinition is the first definition.
```

# Second definition

```TERM beta "Shared label"
BetaDefinition is the second definition.
```

```js : <<Sample>>=+
const FragmentAddition = 2;
```
''')


def run(command, cwd, output, env, success=True):
    result = subprocess.run([str(x) for x in command], cwd=cwd, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=240)
    output.write_bytes(result.stdout)
    assert (result.returncode == 0) == success, f'Unexpected exit {result.returncode}: {output}'
    return result.stdout.decode()


def inspect(folder, paper, env):
    certificate = (folder / 'book.litrail').read_text()
    assert re.match(r'stable [a-f0-9]{32}\n', certificate), certificate
    aux = (folder / 'book.aux').read_text()
    assert '\\LitRailState{' + certificate.split()[1] + '}' in aux
    records = [tuple(map(int, row)) for row in re.findall(
        r'\\LitRailPrevious\{(\d+)\}\{(\d+)\}\{(\d+)\}\{(\d+)\}\{(\d+)\}', aux)]
    bounds = [tuple(map(int, line.split()[1].split(',')))
              for line in certificate.splitlines() if line.startswith('bounds ')]
    assert records and bounds
    summary = re.search(r'pages (\d+) uses (\d+) entries (\d+)', certificate)
    assert summary and tuple(map(int, summary.groups()[1:])) == (len(records), len(bounds))
    uses = Counter((r[2], r[1]) for r in records)
    entries = Counter((b[0], b[1]) for b in bounds)
    assert all(n == 1 for n in entries.values()), entries
    assert set(entries) == set(uses), (entries, uses)
    assert any(n >= 2 for n in uses.values()), 'No same-page repeated term fixture'
    assert any(len({p for p, i in entries if i == index}) >= 2 for _, index in entries), 'No other-page reuse'
    run(['pdftotext', '-bbox', 'book.pdf', 'words.html'], folder, folder / 'bbox.log', env)
    run(['pdftotext', '-layout', 'book.pdf', 'book.txt'], folder, folder / 'text.log', env)
    ns = {'h': 'http://www.w3.org/1999/xhtml'}
    pages = ET.parse(folder / 'words.html').findall('.//h:page', ns)
    mm = 72 / 25.4
    sp = 72 / 72.27 / 65536
    width, height, left, right, top, bottom = (210, 297, 20, 20, 20, 20) if paper == 'a4' else (148, 210, 20, 16, 18, 22)
    rail_x = (width - right - 25) * mm
    body_right = rail_x - 5 * mm
    by_page = defaultdict(list)
    for page, index, x, y, w, h in bounds:
        x, y, w, h = [v * sp for v in (x, y, w, h)]
        assert abs(x - rail_x) < .05 and abs(w - 25 * mm) < .05
        assert y >= top * mm - .05 and y + h <= (height - bottom) * mm + .05
        by_page[page].append((x, y, x + w, y + h, index))
    rail_words = defaultdict(list)
    found = defaultdict(list)
    for number, page in enumerate(pages, 1):
        assert abs(float(page.get('width')) - width * mm) < 1
        assert abs(float(page.get('height')) - height * mm) < 1
        boxes = sorted(by_page[number], key=lambda b: b[1])
        for a, b in zip(boxes, boxes[1:]):
            assert a[3] + 2 * mm <= b[1] + .1, ('overlap', a, b)
        for word in page.findall('h:word', ns):
            text = ''.join(word.itertext())
            x0, y0, x1, y1 = [float(word.get(k)) for k in ('xMin', 'yMin', 'xMax', 'yMax')]
            found[text.rstrip('.,;:')].append(number)
            if x0 >= rail_x - .5:
                matches = [b for b in boxes if x0 >= b[0] - .5 and x1 <= b[2] + .5 and y0 >= b[1] - 1 and y1 <= b[3] + 1]
                assert len(matches) == 1, ('word outside certified rail', number, text, (x0, y0, x1, y1), boxes)
                rail_words[(number, matches[0][4])].append(text)
            elif top * mm <= y0 <= (height - bottom) * mm:
                assert x0 >= left * mm - 2 and x1 <= body_right + 2, ('body/gap overlap', number, text, x0, x1)
    assert set(rail_words) == set(entries)
    for marker in ['PlainSentinel', 'ListFirst', 'ListSecond', 'BoldSentinel', 'ItalicSentinel', 'CodeSentinel',
                   'AlphaDefinition', 'BetaDefinition', 'FirstUse', 'AgainUse', 'OtherUse', 'LaterUse']:
        assert marker in found, marker
    assert found['FirstUse'] == found['AgainUse']
    assert found['FirstUse'] != found['LaterUse']
    text = (folder / 'book.txt').read_text()
    assert 'Term index' in text and 'Fragment index' in text
    fragment_index = text.split('Fragment index', 1)[1]
    assert 'Sample' in fragment_index
    for marker in ['FragmentBase', 'FragmentAddition']:
        assert str(found[marker][0]) in fragment_index, ('missing fragment page', marker)
    tex = (folder / 'book.tex').read_text()
    declarations = re.findall(r'\\LitRailBuild\{(\d+)\}\{[A-Z]+\}\{(lit-[a-f0-9]+)\}', tex)
    assert len(declarations) == 2 and declarations[0][1] != declarations[1][1], declarations
    definition_pages = [found['AlphaDefinition'][0], found['BetaDefinition'][0]]
    assert definition_pages[0] != definition_pages[1]
    for (index, target), expected_page in zip(declarations, definition_pages):
        assert r'\label{' + target + '}' in tex
        assert r'\pageref*{' + target + '}' in tex.split(r'\chapter*{Term index}')[1]
        for (page, entry), words in rail_words.items():
            if entry == int(index):
                assert str(expected_page) in words, ('definition-page reference', words, expected_page)
    assert len({records[i][1] for i in range(3)}) == 2, 'Same labels must resolve to distinct term keys'
    log = (folder / 'book.log').read_text()
    assert not re.search(r'undefined references|Missing character|Overfull|Rerun to get', log), 'Unresolved or overflowing final log'
    return {'pages': len(pages), 'uses': len(records), 'entries': len(bounds), 'certificate': certificate}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--font-manifest', required=True, type=Path)
    parser.add_argument('--ulem', type=Path, help='Existing local ulem.sty, exposed only through TEXINPUTS')
    args = parser.parse_args()
    for tool in ['node', 'pandoc', 'latexmk', 'lualatex', 'pdftotext']:
        if not shutil.which(tool):
            parser.error(f'Required tool not found: {tool}')
    root = Path(tempfile.mkdtemp(prefix='annotations-acceptance-', dir=REPO / 'out'))
    print(f'Evidence: {root}', flush=True)
    env = dict(os.environ)
    if args.ulem:
        assert args.ulem.is_file() and args.ulem.name == 'ulem.sty'
        env['TEXINPUTS'] = str(args.ulem.resolve().parent) + os.pathsep + env.get('TEXINPUTS', '')
    project = root / 'project'
    project.mkdir()
    fixture(project)
    layout.copy_manifest(args.font_manifest.resolve(), project)
    report = {}

    def cli(mode, name, flags, success=True):
        command = ['node', REPO / 'out/cli-entry.js', mode, project, '--output',
                   'book.pdf' if mode == 'pdf' else 'export/book.tex', '--font-manifest', 'fonts.json', '--json']
        if mode == 'pdf':
            command += ['--keep-build']
        result = json.loads(run(command + flags, REPO, root / (name + '.json'), env, success))
        assert result['ok'] == success, result
        return result

    for paper in ['a4', 'a5']:
        flags = ['--paper', paper]
        if paper == 'a5':
            flags += ['--margin-top', '18mm', '--margin-right', '16mm', '--margin-bottom', '22mm', '--margin-left', '20mm']
        result = cli('pdf', paper, flags)
        build = Path(result['publication']['buildDirectory'])
        retained = list(build.rglob('book.litrail'))
        assert len(retained) == 1
        folder = root / ('compiled-' + paper)
        shutil.copytree(retained[0].parent, folder)
        assert (folder / 'book.pdf').read_bytes() == (project / 'book.pdf').read_bytes()
        report[paper] = inspect(folder, paper, env)
        cli('latex', 'export-' + paper, flags)
        source = project / 'export'
        before = layout.digest_tree(source)
        repeated = cli('latex', 'repeat-' + paper, flags)
        assert all(x['status'] == 'current' for x in repeated['outputs'])
        relocated = root / ('relocated-' + paper)
        shutil.copytree(source, relocated)
        tex = (relocated / 'book.tex').read_text()
        assert str(project) not in tex and not list(relocated.rglob('*.lua'))
        # Hide all source/export inputs while compiling: only shipped companions may resolve.
        hidden = root / 'hidden-project'
        project.rename(hidden)
        try:
            output = run(['latexmk', '-norc', '-lualatex', '-interaction=nonstopmode', '-halt-on-error',
                          '-file-line-error', '-no-shell-escape', '-e', '$max_repeat = 5;', 'book.tex'],
                         relocated, relocated / 'build.txt', env)
        finally:
            hidden.rename(project)
        passes = [int(n) for n in re.findall(r"Run number (\d+) of rule 'lualatex'", output)]
        assert passes and max(passes) <= 5, passes
        report['relocated-' + paper] = inspect(relocated, paper, env)
        report['relocated-' + paper]['passes'] = max(passes)
        assert report['relocated-' + paper]['certificate'] == report[paper]['certificate']
        assert all(layout.digest_tree(relocated)[p] == digest for p, digest in before.items())
        print(f'PASS {paper}: production PDF and relocated LaTeX', flush=True)

    previous = hashlib.sha256((project / 'book.pdf').read_bytes()).hexdigest()
    result = cli('pdf', 'default-a5-rejected', ['--paper', 'a5'], False)
    assert not result.get('outputs') and not result.get('publication', {}).get('buildDirectory'), result
    assert re.search(r'80|geometry|body', json.dumps(result), re.I), result
    assert hashlib.sha256((project / 'book.pdf').read_bytes()).hexdigest() == previous
    for kind, body in [('vertical', '\n\n'.join('```NOTE\nDense note %d. %s\n```' % (i, 'Dense words. ' * 14) for i in range(18))),
                       ('horizontal', '```NOTE\n`' + 'Unbreakable' * 35 + '`\n```')]:
        (project / 'index.literate').write_text('# Overflow\n\n' + body)
        (project / 'chapter.literate').unlink(missing_ok=True)
        result = cli('pdf', kind + '-rejected', ['--paper', 'a4'], False)
        assert not result.get('outputs'), result
        build = Path(result['publication']['buildDirectory'])
        certs = list(build.rglob('book.litrail'))
        assert len(certs) == 1 and certs[0].read_text().startswith('error\n'), result
        assert re.search(r'overflow|width|horizontal', certs[0].read_text(), re.I), certs[0].read_text()
        shutil.copytree(certs[0].parent, root / (kind + '-failed-build'))
        assert hashlib.sha256((project / 'book.pdf').read_bytes()).hexdigest() == previous
        report[kind] = certs[0].read_text()
        print(f'PASS {kind}: failure preserved previous PDF', flush=True)
    report['default-a5'] = 'Rejected before compilation; previous PDF unchanged'
    report['environment'] = {'fontManifest': str(args.font_manifest.resolve()),
                             'ulem': str(args.ulem.resolve()) if args.ulem else 'system lookup',
                             'productionCompilerRepeatLimit': 5}
    (root / 'acceptance.json').write_text(json.dumps(report, indent=2) + '\n')
    print('PASS M6 annotation acceptance', flush=True)


if __name__ == '__main__':
    main()
