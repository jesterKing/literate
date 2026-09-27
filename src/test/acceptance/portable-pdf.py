"""Opt-in real CLI PDF acceptance; no installs, downloads, or source generation.

Requires an explicit local font manifest (the layout inspector expects LilexNF).
Optional --browser enables the existing Mermaid vector/geometry proof. --ulem
supplies only an existing local ulem.sty through an absolute TEXINPUTS directory.
Inputs and reports live under out/. Browser builds retain stages in the system
temporary directory to avoid Chromium's Unix socket path-length limit.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import traceback
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True


def helper(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(f'portable-{name}.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


LAYOUT, ASSETS, MERMAID = (helper(name) for name in ['layout', 'assets', 'mermaid'])
REPO, run = LAYOUT.REPO, LAYOUT.run


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--font-manifest', type=Path, required=True)
    parser.add_argument('--browser', type=Path, help='Explicit installed browser; no download fallback')
    parser.add_argument('--ulem', type=Path, help='Existing local ulem.sty workaround')
    args = parser.parse_args()
    for name in ['font_manifest', 'browser', 'ulem']:
        value = getattr(args, name)
        if value is not None:
            if not value.is_file():
                parser.error(f'Not a file: {value}')
            setattr(args, name, value.resolve())
    tools = ['node', 'pandoc', 'latexmk', 'lualatex', 'kpsewhich', 'pdfinfo',
             'pdftohtml', 'pdftotext', 'pdffonts', 'pdftocairo']
    if args.browser:
        tools += ['pdfimages', 'pdftoppm']
    for tool in tools:
        if not shutil.which(tool):
            parser.error(f'Required opt-in tool not found: {tool}')
    root = Path(tempfile.mkdtemp(prefix='pdf-acceptance-', dir=REPO / 'out'))
    print(f'Evidence: {root}', flush=True)
    for name in ['tmp', 'home', 'cache', 'project']:
        (root / name).mkdir()
    env = dict(os.environ, TMPDIR=str(root / 'tmp'), HOME=str(root / 'home'),
               TEXMFVAR=str(root / 'cache'), TEXMFCACHE=str(root / 'cache'))
    if args.ulem:
        (root / 'texinputs').mkdir()
        shutil.copyfile(args.ulem, root / 'texinputs/ulem.sty')
        # The trailing empty search component preserves the system TeX lookup.
        env['TEXINPUTS'] = str(root / 'texinputs') + ':'
    reports = {'environment': {'fontManifest': str(args.font_manifest),
                               'browser': str(args.browser) if args.browser else None,
                               'ulem': str(args.ulem) if args.ulem else 'system lookup'},
               'passed': {}, 'failed': {}, 'skipped': []}
    marker = root / 'rc-executed'
    # Trusted test-only Perl: the sole side effect is writing this evidence marker.
    escaped = str(marker).replace('\\', '\\\\').replace("'", "\\'")
    rc = "open(my $fh, '>', '" + escaped + "') or die $!; print $fh 'read'; close($fh);\n"


    def case(name, check):
        print(f'Checking {name}', flush=True)
        try:
            reports['passed'][name] = check()
        except Exception as error:
            reports['failed'][name] = str(error)
            (root / f'{name}-failure.txt').write_text(traceback.format_exc())
            print(f'FAILED {name}: {error}', flush=True)
        (root / 'acceptance.json').write_text(json.dumps(reports, indent=2) + '\n')

    def invoke(project, output, name, keep=True, success=True, browser=False):
        paper = Path(output).parts[0]
        command = ['node', str(REPO / 'out/cli-entry.js'), 'pdf', str(project), '--output', output,
                   '--font-manifest', 'fonts.json', '--paper', paper, '--margin-left', '20mm',
                   '--margin-top', '20mm' if paper == 'a4' else '18mm',
                   '--margin-right', '20mm' if paper == 'a4' else '16mm',
                   '--margin-bottom', '22mm', '--json']
        if keep:
            command.append('--keep-build')
        if browser:
            command += ['--browser', str(args.browser)]
            # Mermaid's existing inspector uses 18/16/22/20 on both papers.
            command[command.index('--margin-top') + 1] = '18mm'
            command[command.index('--margin-right') + 1] = '16mm'
        before = LAYOUT.digest_tree(project)
        invocation_env = dict(env)
        if browser:
            invocation_env['TMPDIR'] = tempfile.gettempdir()
        temporary = Path(invocation_env['TMPDIR'])
        stages = set(temporary.glob('literate-pdf-*'))
        result = subprocess.run(command, cwd=project, env=invocation_env, capture_output=True, timeout=240)
        (root / f'{name}.json').write_bytes(result.stdout)
        (root / f'{name}.stderr.txt').write_bytes(result.stderr)
        response = json.loads(result.stdout)
        assert (result.returncode == 0) == success and response['ok'] == success, response
        assert not result.stderr, result.stderr.decode(errors='replace')
        after = LAYOUT.digest_tree(project)
        assert {k: v for k, v in after.items() if k != output} == {k: v for k, v in before.items() if k != output}
        publication = response.get('publication', {})
        if success:
            assert response['outputs'] == [{'path': output, 'status': 'written'}], response
            assert (project / output).read_bytes().startswith(b'%PDF-')
            assert publication['warnings'] == [], publication
        else:
            assert response['outputs'] == [] and after == before, response
            assert response['errors'], response
        new_stages = set(temporary.glob('literate-pdf-*')) - stages
        stage = None
        if keep:
            stage = Path(publication['buildDirectory'])
            assert new_stages == {stage} and stage.is_dir(), (publication, new_stages)
            assert stage.stat().st_mode & 0o777 == 0o700
            assert not stage.is_relative_to(project)
        else:
            assert not publication.get('buildDirectory') and not new_stages, (publication, new_stages)
        return response, stage / paper if stage else None

    def rc_control():
        (root / 'home/.latexmkrc').write_text(rc)
        (small / '.latexmkrc').write_text(rc)
        control = root / 'rc-control'
        control.mkdir()
        (control / 'book.tex').write_text('\\documentclass{article}\\begin{document}Control\\end{document}\n')
        try:
            run(['latexmk', '-commands', 'book.tex'], control, root / 'rc-control.txt', env)
            assert marker.is_file(), 'rc marker control was not executed'
        finally:
            marker.unlink(missing_ok=True)
        return {'markerControl': True}

    project = root / 'project'
    LAYOUT.fixture(project)
    LAYOUT.copy_manifest(args.font_manifest, project)

    (project / 'illustration.pdf').write_bytes(ASSETS.vector_pdf(1200, 120))
    run(['pdftocairo', '-png', '-singlefile', '-scale-to', '400', 'illustration.pdf', 'illustration'],
        project, root / 'create-png.txt')
    with (project / 'chapter.literate').open('a') as file:
        file.write('\n![PdfCaptionSentinel](illustration.pdf)\n\n![PngCaptionSentinel](illustration.png)\n')

    def layout(paper):
        response, folder = invoke(project, f'{paper}/book.pdf', paper)
        assert (folder / 'book.pdf').read_bytes() == (project / paper / 'book.pdf').read_bytes()
        for suffix in ['tex', 'log', 'aux', 'toc', 'fls', 'fdb_latexmk']:
            assert (folder / f'book.{suffix}').stat().st_size, suffix
        assert list(folder.glob('lit-fonts-*')) and list(folder.glob('lit-assets-*'))
        for command, output in [(['pdfinfo', '-dests', 'book.pdf'], 'destinations.txt'),
                                (['pdffonts', 'book.pdf'], 'fonts.txt'),
                                (['pdftohtml', '-xml', '-i', 'book.pdf', 'book.xml'], 'xml.txt'),
                                (['pdftotext', '-layout', 'book.pdf', 'book.txt'], 'text.txt')]:
            run(command, folder, folder / output)
        proof = LAYOUT.inspect(folder, paper)
        toc = (folder / 'book.toc').read_text()
        assert 'Portable layout' in toc and 'Additions' in toc, toc
        assert re.search(r'\\contentsline.*\{\d+\}', toc), toc
        scale = 108 / 25.4
        width, height = (210, 297) if paper == 'a4' else (148, 210)
        pages = ET.parse(folder / 'book.xml').findall('.//page')
        for caption in ['PdfCaptionSentinel', 'PngCaptionSentinel']:
            found = [item for page in pages for item in page.findall('text') if caption in ''.join(item.itertext())]
            assert len(found) == 1, (caption, len(found))
            item = found[0]
            x, y, w, h = [float(item.attrib[key]) for key in ['left', 'top', 'width', 'height']]
            assert x >= 20 * scale - 3 and x + w <= (width - (20 if paper == 'a4' else 16)) * scale + 3
            assert y >= (20 if paper == 'a4' else 18) * scale - 3 and y + h <= (height - 22) * scale + 3
        return dict(proof, publication=response['publication'], captions=True)

    for paper in ['a4', 'a5']:
        case(paper, lambda paper=paper: layout(paper))

    small = root / 'small-project'
    small.mkdir()
    LAYOUT.copy_manifest(args.font_manifest, small)
    (small / 'index.literate').write_text('# Cleanup proof\n\nTrusted small publication.\n')

    def cleanup():
        response, _ = invoke(small, 'a4/book.pdf', 'cleanup', keep=False)
        return response['publication']

    case('cleanup', cleanup)

    def failure(keep):
        (small / 'wide.pdf').write_bytes(ASSETS.vector_pdf(1200, 120))
        (small / 'index.literate').write_text('# Caption budget\n\n![' + 'M ' * 2047 + '](wide.pdf)\n')
        (small / 'a5').mkdir(exist_ok=True)
        # Preserve an actual previously published PDF, not a fabricated header.
        shutil.copyfile(small / 'a4/book.pdf', small / 'a5/book.pdf')
        name = 'failure-retained' if keep else 'failure-cleanup'
        response, folder = invoke(small, 'a5/book.pdf', name, keep=keep, success=False)
        assert 'Image caption leaves no space' in '\n'.join(response['errors']), response
        if keep:
            assert (folder / 'book.tex').is_file()
            assert 'Image caption leaves no space' in (folder / 'book.log').read_text()
        return {'oldPdfPreserved': True, 'publication': response.get('publication')}

    for keep in [True, False]:
        case('failure-retained' if keep else 'failure-cleanup', lambda keep=keep: failure(keep))

    if args.browser:
        diagrams = root / 'diagram-project'
        diagrams.mkdir()
        MERMAID.fixture(diagrams)
        LAYOUT.copy_manifest(args.font_manifest, diagrams)
        for paper, width, height in [('a4', 210, 297), ('a5', 148, 210)]:
            def diagram(paper=paper, width=width, height=height):
                response, folder = invoke(diagrams, f'{paper}/book.pdf', f'diagrams-{paper}', browser=True)
                assert (folder / 'book.pdf').read_bytes() == (diagrams / paper / 'book.pdf').read_bytes()
                return dict(MERMAID.inspect(folder, width, height), publication=response['publication'])
            case(f'diagrams-{paper}', diagram)
    else:
        reports['skipped'].append('Mermaid: pass --browser /absolute/path/to/installed/browser')
    # Keep this adversarial environment separate so an rc failure cannot mask
    # geometry, convergence, or cleanup results from independent cases.
    case('rc-control', rc_control)

    def rc_ignored():
        (small / 'index.literate').write_text('# RC isolation\n\nTrusted publication.\n')
        response, _ = invoke(small, 'a4/rc.pdf', 'rc-ignore', keep=False)
        assert not marker.exists(), 'latexmk executed an untrusted rc file (including preflight)'
        return response['publication']

    case('rc-ignore', rc_ignored)
    if all(paper in reports['passed'] for paper in ['a4', 'a5']):
        def pagination():
            a4, a5 = (reports['passed'][paper] for paper in ['a4', 'a5'])
            assert a4['pages'] != a5['pages'] and a4['additionPage'] != a5['additionPage']
            return {'paperChangesPageReferences': True}
        case('pagination', pagination)
    (root / 'acceptance.json').write_text(json.dumps(reports, indent=2) + '\n')
    print(f"Passed {len(reports['passed'])}; failed {len(reports['failed'])}; evidence: {root}", flush=True)
    if reports['failed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
