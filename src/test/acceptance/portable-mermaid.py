"""Explicit system-browser Mermaid/portable LaTeX proof. No downloads or installs."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('layout', Path(__file__).with_name('portable-layout.py'))
LAYOUT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAYOUT)
REPO, run = LAYOUT.REPO, LAYOUT.run


def fixture(project):
    (project / 'chapters').mkdir()
    wide = 'flowchart LR\n' + '\n'.join(f'W{i}[WideNode{i:02}] --> W{i + 1}[WideNode{i + 1:02}]' for i in range(18))
    tall = 'flowchart TD\n' + '\n'.join(f'T{i}[TallNode{i:02}] --> T{i + 1}[TallNode{i + 1:02}]' for i in range(28))
    diagrams = [('wide', wide), ('tall', tall), ('nested-wide', wide), ('nested-tall', tall),
                ('sequence', 'sequenceDiagram\nSequenceSender->>SequenceReceiver: MessageSent\nSequenceReceiver-->>SequenceSender: ResponseSent'),
                ('er', 'erDiagram\nWRITER ||--o{ VOLUME : creates')]
    (project / 'index.literate').write_text('# Vector diagrams\n\n' + '\n\n'.join(
        f'[{name}](chapters/{name}.literate)' for name, _ in diagrams))
    for name, source in diagrams:
        content = '```mermaid\n' + source + '\n```\n'
        if name.startswith('nested'):
            content = '- Outer list\n\n' + '\n'.join('  > ' + line for line in content.splitlines()) + '\n'
        (project / f'chapters/{name}.literate').write_text(f'# {name.title()}\n\n{content}')


def compile_book(folder, args, env):
    if args.ulem:
        shutil.copyfile(args.ulem, folder / 'ulem.sty')
    run(['latexmk', '-lualatex', '-interaction=nonstopmode', '-halt-on-error',
         '-file-line-error', '-no-shell-escape', 'book.tex'], folder, folder / 'build.txt', env)
    log = (folder / 'book.log').read_text()
    return [line for line in log.splitlines() if any(word in line for word in
            ['Warning', 'Missing character', 'Overfull', 'Underfull', 'undefined'])]


def inspect(folder, width, height):
    run(['pdftohtml', '-xml', '-i', 'book.pdf', 'book.xml'], folder, folder / 'xml.txt')
    pages = ET.parse(folder / 'book.xml').findall('.//page')
    scale = 108 / 25.4
    markers = ['WideNode00', 'WideNode18', 'TallNode00', 'TallNode28',
               'SequenceSender', 'SequenceReceiver', 'MessageSent', 'ResponseSent', 'WRITER', 'VOLUME']
    found = {marker: [] for marker in markers}
    vector_pages = set()
    for page in pages:
        assert abs(float(page.attrib['width']) - width * scale) < 2
        assert abs(float(page.attrib['height']) - height * scale) < 2
        for item in page.findall('text'):
            text = ''.join(item.itertext()).strip()
            if any(marker in text for marker in markers):
                x, y, w, h = [float(item.attrib[key]) for key in ['left', 'top', 'width', 'height']]
                assert x >= 20 * scale - 3 and x + w <= (width - 16) * scale + 3, (text, x, w)
                assert y >= 18 * scale - 3 and y + h <= (height - 22) * scale + 3, (text, y, h)
                for marker in markers:
                    if marker in text:
                        found[marker].append(int(page.attrib['number']))
                vector_pages.add(page.attrib['number'])
    for marker in markers:
        assert len(found[marker]) >= (2 if marker.startswith(('WideNode', 'TallNode')) else 1), (marker, found)
    sizes = [(float(w), float(h)) for w, h in re.findall(r'Requested size:\s*([\d.]+)pt x ([\d.]+)pt', (folder / 'book.log').read_text())]
    assert len(sizes) == 6, sizes
    for w, h in sizes:
        assert w <= (width - 36) * 72.27 / 25.4 + 0.02
        assert h < (height - 40) * 72.27 / 25.4
    assert sizes[2][0] < sizes[0][0] - 20, sizes
    assert sizes[0][0] / sizes[0][1] > 10 and sizes[1][1] / sizes[1][0] > 10, sizes
    images = run(['pdfimages', '-list', 'book.pdf'], folder, folder / 'images.txt')
    assert not re.search(r'^\s*\d+\s+\d+\s+(?:image|mask|smask)\b', images, re.M), images
    for number in sorted(vector_pages, key=int):
        run(['pdftoppm', '-f', number, '-l', number, '-scale-to', '1200', '-png', '-singlefile',
             'book.pdf', f'page-{number}'], folder, folder / f'page-{number}-raster.txt')
    return {'pages': len(pages), 'bodyMm': [width - 36, height - 40], 'requestedGraphicSizesPt': sizes,
            'diagramTextPages': found, 'vectorPages': sorted(map(int, vector_pages))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', type=Path, required=True)
    parser.add_argument('--font-manifest', type=Path, required=True)
    parser.add_argument('--ulem', type=Path)
    parser.add_argument('--full-repo', action='store_true')
    args = parser.parse_args()
    assert args.browser.is_absolute() and args.browser.is_file(), 'Explicit installed browser required'
    for tool in ['node', 'pandoc', 'latexmk', 'lualatex', 'pdftohtml', 'pdftoppm', 'pdfinfo', 'pdfimages']:
        if not shutil.which(tool):
            parser.error(f'Missing tool: {tool}')
    root = Path(tempfile.mkdtemp(prefix='mermaid-acceptance-', dir=REPO / 'out'))
    print(f'Evidence: {root}', flush=True)
    project = root / 'project'
    project.mkdir()
    fixture(project)
    LAYOUT.copy_manifest(args.font_manifest.resolve(), project)
    (root / 'cache').mkdir()
    env = dict(os.environ, TEXMFVAR=str(root / 'cache'), TEXMFCACHE=str(root / 'cache'))
    reports = {'environment': {'browser': str(args.browser), 'fontManifest': str(args.font_manifest.resolve()),
                               'ulem': str(args.ulem.resolve()) if args.ulem else 'system lookup'}}
    for paper, width, height in [('a4', 210, 297), ('a5', 148, 210)]:
        command = ['node', REPO / 'out/cli-entry.js', 'latex', project, '--output', f'{paper}/book.tex',
                   '--font-manifest', 'fonts.json', '--browser', args.browser, '--paper', paper,
                   '--margin-top', '18mm', '--margin-right', '16mm', '--margin-bottom', '22mm', '--margin-left', '20mm', '--json']
        exported = json.loads(run(command, REPO, root / f'export-{paper}.json'))
        assert exported['ok']
        repeat = json.loads(run(command, REPO, root / f'repeat-{paper}.json'))
        assert repeat['ok'] and all(item['status'] == 'current' for item in repeat['outputs'])
        assets = [item['path'] for item in exported['outputs'] if '/lit-assets-' in item['path']]
        assert len(assets) == 8, assets
        for name in assets:
            if name.endswith('.svg'):
                svg = ET.parse(project / name)
                assert not svg.findall('.//{http://www.w3.org/2000/svg}image')
            if name.endswith('.pdf'):
                info = run(['pdfinfo', project / name], REPO, root / (Path(name).stem + '.info'))
                assert re.search(r'Pages:\s+1\b', info), info
        before = LAYOUT.digest_tree(project / paper)
        folder = root / f'relocated-{paper}'
        shutil.move(project / paper, folder)
        assert LAYOUT.digest_tree(folder) == before
        shutil.move(project / 'inputs', root / 'hidden-font-inputs')
        try:
            issues = compile_book(folder, args, env)
        finally:
            shutil.move(root / 'hidden-font-inputs', project / 'inputs')
        assert not issues, issues
        reports[paper] = inspect(folder, width, height)
        reports[paper]['exportHashes'] = before
        assert all(LAYOUT.digest_tree(folder)[name] == value for name, value in before.items())
    (root / 'acceptance.json').write_text(json.dumps(reports, indent=2) + '\n')
    print('Passed graph/sequence/ER rendering, deterministic export, relocation and A4/A5 vector fitting.', flush=True)
    if args.full_repo:
        manifest = json.loads((project / 'fonts.json').read_text())
        prefix = project.relative_to(REPO).as_posix() + '/'
        for entry in manifest['families'].values():
            for face in ['regular', 'bold', 'italic', 'boldItalic']:
                if isinstance(entry[face], str):
                    entry[face] = prefix + entry[face]
                else:
                    entry[face]['file'] = prefix + entry[face]['file']
            entry['licenses'] = [prefix + value for value in entry['licenses']]
        manifest_path = root / 'full-fonts.json'
        manifest_path.write_text(json.dumps(manifest))
        destination = root / 'full-export/book.tex'
        command = ['node', REPO / 'out/cli-entry.js', 'latex', REPO, '--output', destination.relative_to(REPO),
                   '--font-manifest', manifest_path.relative_to(REPO), '--browser', args.browser, '--json']
        result = json.loads(run(command, REPO, root / 'full-export.json'))
        assert result['ok']
        assert len([item for item in result['outputs'] if item['path'].endswith('.svg')]) == 8
        folder = root / 'full-relocated'
        before = LAYOUT.digest_tree(destination.parent)
        shutil.move(destination.parent, folder)
        issues = compile_book(folder, args, env)
        assert all(LAYOUT.digest_tree(folder)[name] == value for name, value in before.items())
        run(['pdfinfo', 'book.pdf'], folder, folder / 'pdfinfo.txt')
        reports['fullRepo'] = {'diagrams': 8, 'compiled': True, 'logIssues': issues, 'exportHashes': before}
        (root / 'acceptance.json').write_text(json.dumps(reports, indent=2) + '\n')
        print(f'Full repository compiled after relocation; final-log issues: {len(issues)}')


if __name__ == '__main__':
    main()
