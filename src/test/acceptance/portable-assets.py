"""Opt-in portable PNG/JPEG/PDF proof; no browser, downloads or host installation.

Uses the explicit local manifest/ulem contract of portable-layout.py. Evidence
and private TeX caches stay in a fresh ignored out/assets-acceptance-* directory.
"""
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
REPO = LAYOUT.REPO
run = LAYOUT.run


def vector_pdf(width, height):
    # Trusted fixture: magenta filled rectangle, with an inset white rectangle.
    # The outer silhouette is exactly the MediaBox, making clipping measurable.
    content = (f'1 0 1 rg 0 0 {width} {height} re f\n'
               f'1 1 1 rg 3 3 {width - 6} {height - 6} re f\n').encode()
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
               b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
               f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Resources << >> /Contents 4 0 R >>'.encode(),
               f'<< /Length {len(content)} >>\nstream\n'.encode() + content + b'endstream']
    result = b'%PDF-1.4\n'
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(result))
        result += f'{index} 0 obj\n'.encode() + obj + b'\nendobj\n'
    start = len(result)
    result += f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()
    result += b''.join(f'{offset:010} 00000 n \n'.encode() for offset in offsets[1:])
    return result + f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n'.encode()


def magenta_bounds(file):
    data = file.read_bytes()
    header = re.match(rb'P6\s+(\d+)\s+(\d+)\s+255\s', data)
    assert header, file
    width, height = map(int, header.groups())
    pixels = data[header.end():]
    assert len(pixels) == width * height * 3
    points = [match.start() // 3 for match in re.finditer(b'\xff\x00\xff', pixels) if match.start() % 3 == 0]
    assert points, file
    xs, ys = [p % width for p in points], [p // width for p in points]
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--font-manifest', type=Path, required=True)
    parser.add_argument('--ulem', type=Path)
    args = parser.parse_args()
    for tool in ['node', 'pandoc', 'latexmk', 'lualatex', 'pdftocairo', 'pdftoppm', 'pdftohtml']:
        if not shutil.which(tool):
            parser.error(f'Required opt-in tool not found: {tool}')
    root = Path(tempfile.mkdtemp(prefix='assets-acceptance-', dir=REPO / 'out'))
    print(f'Evidence: {root}', flush=True)
    project = root / 'project'
    project.mkdir()
    (project / 'images').mkdir()
    (project / 'chapters').mkdir()
    (project / 'images/wide.pdf').write_bytes(vector_pdf(1200, 120))
    (project / 'images/tall.pdf').write_bytes(vector_pdf(120, 1800))
    # Real PNG and JPEG decoder inputs, created only by the opt-in harness.
    for fmt in ['png', 'jpeg']:
        run(['pdftocairo', '-' + fmt, '-singlefile', '-scale-to', '400', 'wide.pdf', fmt],
            project / 'images', root / f'create-{fmt}.txt')
    (project / 'index.literate').write_text('# Portable illustrations\n\n'
        '[Wide](chapters/wide.literate)\n\n[Tall](chapters/tall.literate)\n\n'
        '[Nested wide](chapters/nested-wide.literate)\n\n[Nested tall](chapters/nested-tall.literate)\n\n'
        '[Raster](chapters/raster.literate)\n')
    for name, file, marker in [('wide', 'wide.pdf', 'WideCaption'), ('tall', 'tall.pdf', 'TallCaption'),
                               ('nested-wide', 'wide.pdf', 'NestedWideCaption'),
                               ('nested-tall', 'tall.pdf', 'NestedTallCaption')]:
        image = f'![{marker} with enough words to exercise measured caption wrapping in the narrow container.](../images/{file})'
        text = f'# {name.title()}\n\n'
        if name.startswith('nested'):
            text += '- Outer list\n\n  > ' + image + '\n'
        else:
            text += image + '\n'
        (project / f'chapters/{name}.literate').write_text(text)
    (project / 'chapters/raster.literate').write_text('# Raster images\n\n'
        '![PngCaption](../images/png.png)\n\n![JpegCaption](../images/jpeg.jpg)\n')
    LAYOUT.copy_manifest(args.font_manifest.resolve(), project)
    env = dict(os.environ, TEXMFVAR=str(root / 'cache'), TEXMFCACHE=str(root / 'cache'))
    (root / 'cache').mkdir()
    reports = {}
    for paper, width, height in [('a4', 210, 297), ('a5', 148, 210)]:
        command = ['node', REPO / 'out/cli-entry.js', 'latex', project, '--output', f'{paper}/book.tex',
                   '--font-manifest', 'fonts.json', '--paper', paper, '--margin-top', '18mm',
                   '--margin-right', '16mm', '--margin-bottom', '22mm', '--margin-left', '20mm', '--json']
        exported = json.loads(run(command, REPO, root / f'export-{paper}.json'))
        assert exported['ok']
        repeated = json.loads(run(command, REPO, root / f'repeat-{paper}.json'))
        assert repeated['ok'] and all(item['status'] == 'current' for item in repeated['outputs'])
        assets = [item['path'] for item in exported['outputs'] if '/lit-assets-' in item['path']]
        assert len(assets) == 4, assets
        before = LAYOUT.digest_tree(project / paper)
        folder = root / f'relocated-{paper}'
        shutil.move(project / paper, folder)
        assert LAYOUT.digest_tree(folder) == before
        if args.ulem:
            shutil.copyfile(args.ulem, folder / 'ulem.sty')
        # Source images disappear before compilation, not just before inspection.
        shutil.move(project / 'images', root / 'hidden-images')
        try:
            run(['latexmk', '-lualatex', '-interaction=nonstopmode', '-halt-on-error',
                 '-file-line-error', '-no-shell-escape', 'book.tex'], folder, folder / 'build.txt', env)
        finally:
            shutil.move(root / 'hidden-images', project / 'images')
        issues = [line for line in (folder / 'book.log').read_text().splitlines()
                  if any(word in line for word in ['Warning', 'Missing character', 'Overfull', 'Underfull', 'undefined'])]
        assert not issues, issues
        run(['pdftohtml', '-xml', '-i', 'book.pdf', 'book.xml'], folder, folder / 'xml.txt')
        pages = ET.parse(folder / 'book.xml').findall('.//page')
        for page in pages:
            assert abs(float(page.attrib['width']) - width * 108 / 25.4) < 2
            assert abs(float(page.attrib['height']) - height * 108 / 25.4) < 2
        proof = {}
        for marker, ratio, nested in [('WideCaption', 10, False), ('TallCaption', 1 / 15, False),
                                       ('NestedWideCaption', 10, True), ('NestedTallCaption', 1 / 15, True)]:
            found = [(page, item) for page in pages for item in page.findall('text')
                     if ''.join(item.itertext()).startswith(marker)]
            assert len(found) == 1, (marker, found)
            page, caption = found[0]
            number = page.attrib['number']
            run(['pdftoppm', '-r', '144', '-f', number, '-l', number, '-singlefile', 'book.pdf', marker],
                folder, folder / f'{marker}-raster.txt')
            left, top, right, bottom = magenta_bounds(folder / f'{marker}.ppm')
            mm = 144 / 25.4
            assert left >= 20 * mm - 2 and right <= (width - 16) * mm + 2
            assert top >= 18 * mm - 2 and bottom <= (height - 22) * mm + 2
            # Relative error allows pixel rounding on the thin dimension.
            actual_ratio = (right - left) / (bottom - top)
            assert abs(actual_ratio / ratio - 1) < 0.04, (marker, actual_ratio)
            caption_top = float(caption.attrib['top']) * 144 / 108
            assert caption_top >= bottom - 3, (marker, caption_top, bottom)
            for item in page.findall('text'):
                text = ''.join(item.itertext())
                # Caption continuations share the same small font and follow its first line.
                if item.attrib['font'] == caption.attrib['font'] and float(item.attrib['top']) >= float(caption.attrib['top']):
                    x, y = float(item.attrib['left']), float(item.attrib['top'])
                    w, h = float(item.attrib['width']), float(item.attrib['height'])
                    scale = 108 / 25.4
                    assert x >= 20 * scale - 3 and x + w <= (width - 16) * scale + 3, text
                    assert y + h <= (height - 22) * scale + 3, text
            if ratio == 10:
                expected_width = (width - 36) * mm
                assert right - left < expected_width - 20 if nested else abs(right - left - expected_width) < 3
            else:
                assert bottom - top > (height - 40) * mm * 0.75
            run(['pdftocairo', '-svg', '-f', number, '-l', number, 'book.pdf', f'{marker}.svg'],
                folder, folder / f'{marker}-vector.txt')
            svg = ET.parse(folder / f'{marker}.svg')
            assert not svg.findall('.//{http://www.w3.org/2000/svg}image'), 'PDF vector was rasterized'
            proof[marker] = {'page': int(number), 'pixelBounds144dpi': [left, top, right, bottom],
                             'aspectRatio': actual_ratio, 'vectorPreserved': True}
        plain = ''.join(''.join(item.itertext()) for page in pages for item in page.findall('text'))
        assert 'PngCaption' in plain and 'JpegCaption' in plain
        assert all(LAYOUT.digest_tree(folder)[name] == digest for name, digest in before.items())
        reports[paper] = {'bodyMm': [width - 36, height - 40], 'figures': proof,
                          'exportHashes': before, 'logIssues': issues}
    rejected = root / 'caption-project'
    rejected.mkdir()
    (rejected / 'wide.pdf').write_bytes(vector_pdf(1200, 120))
    (rejected / 'index.literate').write_text('# Caption budget\n\n![' + 'M ' * 2047 + '](wide.pdf)\n')
    LAYOUT.copy_manifest(args.font_manifest.resolve(), rejected)
    run(['node', REPO / 'out/cli-entry.js', 'latex', rejected, '--output', 'book.tex',
         '--font-manifest', 'fonts.json', '--paper', 'a5', '--json'], REPO, root / 'caption-export.json')
    if args.ulem:
        shutil.copyfile(args.ulem, rejected / 'ulem.sty')
    try:
        run(['lualatex', '-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape', 'book.tex'],
            rejected, rejected / 'build.txt', env)
    except RuntimeError:
        assert 'Image caption leaves no space' in (rejected / 'build.txt').read_text()
    else:
        raise AssertionError('Oversized caption unexpectedly compiled')
    reports['captionBudgetError'] = True
    reports['environment'] = {'fontManifest': str(args.font_manifest.resolve()),
                              'ulem': str(args.ulem.resolve()) if args.ulem else 'system lookup'}
    (root / 'acceptance.json').write_text(json.dumps(reports, indent=2) + '\n')
    print('Passed PNG/JPEG/PDF relocation, deduplication, vector retention, caption and geometry checks.')


if __name__ == '__main__':
    main()
