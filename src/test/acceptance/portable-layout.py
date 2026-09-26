"""Opt-in production CLI/PDF acceptance; Python standard library + external tools.

No fonts are discovered, downloaded, or installed. See CONTRIBUTING.md.
Every invocation uses a new ignored evidence directory, preserving failed runs.
"""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zlib

REPO = Path(__file__).resolve().parents[3]
LONG_NAME = 'Long reference ' + 'wrapped semantic name ' * 12 + 'ENDNAME'


def run(args, cwd, output, env=None):
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            timeout=180)
    output.write_bytes(result.stdout)
    if result.returncode:
        raise RuntimeError(f'{args[0]} exited {result.returncode}; see {output}')
    return result.stdout.decode('utf-8')


def fence(name, body, append=False):
    return f'```js : <<{name}>>' + ('=+' if append else '=') + f'\n{body}\n```\n'


def fixture(project):
    # Repeated short fragments sample many boundary positions on both papers.
    pressure = []
    for index in range(36):
        pressure.append(f'Pressure paragraph {index:02}: the following fragment heading must '
                        'stay with its first code line, not the preceding paragraph.\n\n')
        pressure.append(fence(f'Boundary{index:02}', f'const Start{index:02} = {index};\n'
                              f'const Finish{index:02} = {index};') + '\n')
    long_lines = '\n'.join(f'const LongLine{index:03} = {index};' for index in range(140))
    nested = fence('NestedBase', '// NestedCommentSentinel\nconst NestedStart = 1;\n<<Shared>>')
    quote = fence('QuotedBase', 'const QuotedStart = 2;\n<<Shared>>')
    index = '''# Portable layout

```SETTINGS
theme=rosepine-dawn
font-code-ligatures=on
```

[Second chapter](chapter.literate) and [CrossHeading](chapter.html#additions).
Native regular: `RegularCode`.

Native bold: **`BoldCode`**.

Native italic: *`ItalicCode`*.

Native bold italic: ***`BoldItalicCode`***.

Unicode café and literal TeX prose: \\input{NOT-A-FILE} & % $ # _ { }.

## Containers

- Outer bullet

  1. Inner numbered item

     > Quoted prose inside a nested list.
     >
'''
    index += '\n'.join('     > ' + line if line else '     >' for line in nested.splitlines())
    index += '\n\n  2. Second numbered item after the contribution.\n\n'
    index += '> Outer quote\n>\n> - Bullet inside quote\n>\n'
    index += '\n'.join('>   ' + line for line in quote.splitlines()) + '\n\n'
    index += fence('Shared', 'const SharedBase = 1;\n// CommentSlantSentinel') + '\n'
    index += fence('Caller', 'const BeforeRef = 1; <<Shared>> const AfterRef = 2;\n'
                   '<<Shared>>\n<<' + LONG_NAME + '>>\nconst AfterLong = 3;') + '\n'
    index += fence('LiteralSafety', r'''// NativeItalicSentinel
const BlankBefore = 1;


    const BlankAfter = 2;
const AdjacentAfter = 3;
const unicode = "café λ →";
const danger = "\\end{Verbatim} \\input{NOT-A-FILE} % & $ # _ { }";
const escaped = "\<<Shared>>";
const token = "''' + 'LongToken' * 32 + '''ENDTOKEN";''') + '\n'
    index += '## Boundary pressure\n\n' + ''.join(pressure)
    index += '## Long contribution\n\n' + fence('LongBlock', long_lines)
    chapter = '# Additions\n\n[BackHeading](index.literate#containers).\n\n'
    chapter += fence('Shared', 'const SharedAdditionOne = 2;', True) + '\n'
    chapter += fence(LONG_NAME, 'const LongNameStart = 1;') + '\n'
    chapter += fence('Shared', 'const SharedAdditionTwo = 3;', True) + '\n'
    chapter += fence('CrossCaller', '<<Shared>>\n<<LongBlock>>')
    (project / 'index.literate').write_text(index)
    (project / 'chapter.literate').write_text(chapter)


def copy_manifest(source, project):
    manifest = json.loads(source.read_text())
    # Re-home only explicitly supplied manifest inputs; never scan a font tree.
    def copy(value):
        path = source.parent / value
        destination = 'inputs/' + hashlib.sha256(value.encode()).hexdigest() + path.suffix
        shutil.copyfile(path, project / destination)
        return destination
    (project / 'inputs').mkdir()
    for entry in manifest['families'].values():
        for face in ['regular', 'bold', 'italic', 'boldItalic']:
            choice = entry[face]
            if isinstance(choice, str):
                entry[face] = copy(choice)
            else:
                choice['file'] = copy(choice['file'])
        entry['licenses'] = [copy(value) for value in entry['licenses']]
    (project / 'fonts.json').write_text(json.dumps(manifest, indent=2) + '\n')


def digest_tree(folder):
    return {str(path.relative_to(folder)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in folder.rglob('*') if path.is_file()}


def inspect(folder, paper):
    log = (folder / 'book.log').read_text()
    issues = [line for line in log.splitlines() if any(term in line for term in
              ['Warning', 'Missing character', 'Overfull', 'Underfull', 'undefined'])]
    assert not issues, issues
    xml = ET.parse(folder / 'book.xml')
    pages = xml.findall('.//page')
    items = [(int(page.attrib['number']), item) for page in pages for item in page.findall('text')]
    text = lambda item: ''.join(item.itertext())
    def matches(marker):
        return [(page, item) for page, item in items if marker in text(item)]
    def unique(marker):
        found = matches(marker)
        assert len(found) == 1, (marker, len(found))
        return found[0]
    # Poppler XML uses 1.5 coordinates per PDF point by default.
    scale = 72 / 25.4 * 1.5
    width, height = (210, 297) if paper == 'a4' else (148, 210)
    for page in pages:
        assert abs(float(page.attrib['width']) - width * scale) < 2
        assert abs(float(page.attrib['height']) - height * scale) < 2
    # Body width: A4 20mm all sides; A5 top18/right16/bottom22/left20.
    right = 20 if paper == 'a4' else 16
    for page, item in items:
        x, w = float(item.attrib['left']), float(item.attrib['width'])
        # Allow 4pt for microtype punctuation protrusion and Poppler rounding.
        assert x >= 20 * scale - 6 and x + w <= (width - right) * scale + 6, (page, text(item), x, w)
    boundary_pages = []
    for index in range(36):
        heading_page, heading = unique(f'Boundary{index:02}')
        start_page, start = unique(f'Start{index:02}')
        assert heading_page == start_page, ('orphan', index, heading_page, start_page)
        assert float(start.attrib['top']) > float(heading.attrib['top'])
        boundary_pages.append(heading_page)
    assert len(set(boundary_pages)) >= 3
    line_pages = [unique(f'LongLine{index:03}')[0] for index in range(140)]
    assert line_pages == sorted(line_pages) and len(set(line_pages)) >= 3
    positions = [(unique(f'LongLine{index:03}')[0],
                  float(unique(f'LongLine{index:03}')[1].attrib['top'])) for index in range(140)]
    assert positions == sorted(set(positions))
    for heading, marker in [('NestedBase', 'NestedStart'), ('QuotedBase', 'QuotedStart'),
                            ('LiteralSafety', 'NativeItalicSentinel'), ('LongBlock', 'LongLine000')]:
        headings = [(page, item) for page, item in matches(heading) if '<<' not in text(item)]
        assert len(headings) == 1 and headings[0][0] == unique(marker)[0], heading
    blank_page, blank = unique('BlankBefore')
    after_page, after = unique('BlankAfter')
    adjacent_page, adjacent = unique('AdjacentAfter')
    assert blank_page == after_page == adjacent_page
    gap = float(after.attrib['top']) - float(blank.attrib['top'])
    step = float(adjacent.attrib['top']) - float(after.attrib['top'])
    assert abs(gap / step - 3) < 0.2, ('blank lines', gap, step)
    assert float(after.attrib['left']) > float(blank.attrib['left']) + 10
    for marker in ['NestedStart', 'QuotedStart', 'BeforeRef', 'AfterRef', 'AfterLong',
                   'SharedBase', 'SharedAdditionOne', 'SharedAdditionTwo', 'LongNameStart']:
        unique(marker)
    plain = (folder / 'book.txt').read_text()
    for marker in ['ENDTOKEN', 'ENDNAME', 'café', 'λ', '→', 'NOT-A-FILE', '\\end{Verbatim}', '<<Shared>>']:
        assert marker in plain, marker
    compact = re.sub(r'\s+', '', plain)
    assert 'LongToken' * 32 + 'ENDTOKEN' in compact
    assert re.sub(r'\s+', '', LONG_NAME) in compact
    fonts = (folder / 'fonts.txt').read_text()
    for face in ['Regular', 'Bold', 'Italic', 'BoldItalic']:
        assert 'LilexNF-' + face in fonts
    for row in fonts.splitlines()[2:]:
        assert re.search(r'\byes\s+yes\b', row), row
    font_names = {item.attrib['id']: item.attrib['family'] for item in xml.findall('.//fontspec')}
    for page, item in items:
        if 'LilexNF' in font_names[item.attrib['font']]:
            top, bottom = (20, 20) if paper == 'a4' else (18, 22)
            y, h = float(item.attrib['top']), float(item.attrib['height'])
            assert y >= top * scale - 6 and y + h <= (height - bottom) * scale + 6, (page, text(item))
    for marker in ['CommentSlantSentinel', 'NativeItalicSentinel', 'NestedCommentSentinel']:
        _, item = unique(marker)
        assert 'LilexNF' in font_names[item.attrib['font']] and item.find('.//i') is not None
    for marker, bold, italic in [('RegularCode', False, False), ('BoldCode', True, False),
                                 ('ItalicCode', False, True), ('BoldItalicCode', True, True)]:
        found = [item for _, item in items if text(item) == marker]
        assert len(found) == 1, marker
        item = found[0]
        assert 'LilexNF' in font_names[item.attrib['font']]
        assert (item.find('.//b') is not None) == bold
        assert (item.find('.//i') is not None) == italic
    # Fixture-specific LuaTeX PDF action inspection, not a general PDF parser.
    pdf = (folder / 'book.pdf').read_bytes()
    streams = [pdf]
    for stream in re.findall(rb'stream\r?\n(.*?)\r?\nendstream', pdf, re.S):
        try:
            streams.append(zlib.decompress(stream))
        except zlib.error:
            pass
    actions = re.findall(rb'/Subtype /Link[^\n]*?/S /GoTo /D \(([^)]+)\)', b'\n'.join(streams))
    assert actions
    destinations = {}
    for line in (folder / 'destinations.txt').read_text().splitlines():
        match = re.match(r'\s*(\d+) \[.*"([^"]+)"$', line)
        if match:
            destinations[match[2]] = int(match[1])
    assert all(action.decode() in destinations for action in actions)
    aux = (folder / 'book.aux').read_text()
    labels = re.findall(r'\\newlabel\{([^}]+)\}\{\{[^}]*\}\{(\d+)\}\{[^}]*\}\{([^}]+)\}', aux)
    semantic = {label: (int(page), dest) for label, page, dest in labels if label.startswith(('lit-', 'h-'))}
    assert semantic
    for label, (page, dest) in semantic.items():
        assert destinations[dest] == page, (label, page, dest)
    shared = 'lit-' + ('f-' + 'Shared'.encode('utf-16-be').hex()).encode('utf-16-be').hex()
    shared_page, shared_dest = semantic[shared]
    assert shared_page == unique('SharedBase')[0]
    assert Counter(action.decode() for action in actions)[shared_dest] >= 5
    # Visible semantic superscripts and navigation pages are actual PDF links.
    linked_pages = []
    for page, item in items:
        if page == 1:  # Contents numbers are chapter numbers, not reference superscripts.
            continue
        for link in item.findall('.//a'):
            caption = ''.join(link.itertext()).strip()
            destination_page = int(link.attrib['href'].rsplit('#', 1)[1])
            if caption.isdigit():
                assert int(caption) == destination_page, caption
                linked_pages.append(destination_page)
    assert len(linked_pages) >= 8, linked_pages
    for caption, marker in [('Second chapter', 'SharedAdditionOne'), ('CrossHeading', 'SharedAdditionOne'),
                            ('BackHeading', 'NestedStart')]:
        links = [link for link in xml.findall('.//a') if caption in ''.join(link.itertext())]
        assert len(links) == 1, caption
        assert int(links[0].attrib['href'].rsplit('#', 1)[1]) == unique(marker)[0], caption
    return {'pages': len(pages), 'boundaryPages': sorted(set(boundary_pages)),
            'longBlockPages': sorted(set(line_pages)), 'blankLineRatio': gap / step,
            'semanticLabels': len(semantic), 'pdfGoToLinks': len(actions),
            'checkedVisiblePageLinks': len(linked_pages), 'sharedPage': shared_page,
            'additionPage': unique('SharedAdditionOne')[0], 'logIssues': issues}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--font-manifest', type=Path, required=True)
    parser.add_argument('--ulem', type=Path, help='Optional existing local ulem.sty; never downloaded')
    args = parser.parse_args()
    for tool in ['node', 'pandoc', 'latexmk', 'lualatex', 'pdfinfo', 'pdftohtml', 'pdftotext', 'pdffonts']:
        if not shutil.which(tool):
            parser.error(f'Required opt-in tool not found: {tool}')
    root = Path(tempfile.mkdtemp(prefix='layout-acceptance-', dir=REPO / 'out'))
    print(f'Evidence: {root}', flush=True)
    project = root / 'project'
    project.mkdir()
    fixture(project)
    copy_manifest(args.font_manifest.resolve(), project)
    env = dict(os.environ, TEXMFVAR=str(root / 'cache'), TEXMFCACHE=str(root / 'cache'))
    (root / 'cache').mkdir()
    reports = {}
    for paper in ['a4', 'a5']:
        command = ['node', REPO / 'out/cli.js', 'latex', project, '--output', f'{paper}/book.tex',
                   '--font-manifest', 'fonts.json', '--paper', paper, '--margin', '20mm', '--json']
        if paper == 'a5':
            command += ['--margin-top', '18mm', '--margin-right', '16mm', '--margin-bottom', '22mm']
        exported = json.loads(run(command, REPO, root / f'export-{paper}.json'))
        assert exported['ok'] and all(item['status'] == 'written' for item in exported['outputs'])
        repeated = json.loads(run(command, REPO, root / f'repeat-{paper}.json'))
        assert repeated['ok'] and all(item['status'] == 'current' for item in repeated['outputs'])
        source = project / paper
        before = digest_tree(source)
        # Match every companion to an explicitly supplied input, not merely its relocated copy.
        sha = lambda value: hashlib.sha256(value.encode()).hexdigest()
        companion_dir = source / ('lit-fonts-' + sha('book.tex'))
        manifest = json.loads((project / 'fonts.json').read_text())
        expected = {}
        for family, entry in manifest['families'].items():
            for face in ['regular', 'bold', 'italic', 'boldItalic']:
                choice = entry[face]
                path = project / (choice if isinstance(choice, str) else choice['file'])
                expected[sha(family + ':' + face) + path.suffix.lower()] = hashlib.sha256(path.read_bytes()).hexdigest()
            for index, value in enumerate(entry['licenses']):
                expected[sha(family + ':license-' + str(index)) + '.license.txt'] = hashlib.sha256((project / value).read_bytes()).hexdigest()
        assert digest_tree(companion_dir) == expected
        folder = root / f'relocated-{paper}'
        shutil.copytree(source, folder)
        assert digest_tree(folder) == before
        tex = (folder / 'book.tex').read_text()
        assert str(project) not in tex and 'FakeSlant' not in next(line for line in tex.splitlines() if line.startswith('\\setmonofont'))
        if args.ulem:
            shutil.copyfile(args.ulem, folder / 'ulem.sty')
        run(['latexmk', '-lualatex', '-interaction=nonstopmode', '-halt-on-error',
             '-file-line-error', '-no-shell-escape', 'book.tex'], folder, folder / 'build.txt', env)
        for command, output in [(['pdfinfo', '-dests', 'book.pdf'], 'destinations.txt'),
                                (['pdffonts', 'book.pdf'], 'fonts.txt'),
                                (['pdftohtml', '-xml', '-i', 'book.pdf', 'book.xml'], 'xml.txt'),
                                (['pdftotext', '-layout', 'book.pdf', 'book.txt'], 'text.txt')]:
            run(command, folder, folder / output)
        assert all(digest_tree(folder)[name] == digest for name, digest in before.items())
        reports[paper] = inspect(folder, paper)
        reports[paper]['exportHashes'] = before
    assert reports['a4']['pages'] != reports['a5']['pages']
    assert reports['a4']['additionPage'] != reports['a5']['additionPage']
    reports['environment'] = {'ulem': str(args.ulem.resolve()) if args.ulem else 'system lookup',
                              'fontManifest': str(args.font_manifest.resolve())}
    (root / 'acceptance.json').write_text(json.dumps(reports, indent=2) + '\n')
    print(json.dumps({paper: {key: value for key, value in report.items() if key != 'exportHashes'}
                      for paper, report in reports.items()}, indent=2))


if __name__ == '__main__':
    main()
