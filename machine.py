#!/usr/bin/env python3
"""Agent-operated slideshow authoring. Drafts stay local; exports are HTML."""
import argparse
import hashlib
import html
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOCAL = ROOT / '.local'
DRAFTS = LOCAL / 'drafts'
PREVIEWS = LOCAL / 'previews'
SLUG = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout


def valid_slug(value):
    if not SLUG.fullmatch(value):
        raise ValueError('Use lowercase letters, numbers, and single hyphens for the deck name.')
    return value


def source_text(path):
    path = Path(path).expanduser().resolve()
    suffix = path.suffix.lower()
    if suffix in ('.txt', '.md', '.markdown'):
        text = path.read_text(encoding='utf-8-sig')
        if suffix != '.txt':
            text = run('pandoc', '-f', 'markdown-smart', '-t', 'plain', '--wrap=none', str(path))
    elif suffix == '.docx':
        text = run('pandoc', '-f', 'docx', '-t', 'plain', '--wrap=none', str(path))
    elif suffix == '.pdf':
        text = run('pdftotext', '-enc', 'UTF-8', str(path), '-')
    else:
        raise ValueError('Supported input files: .txt, .md, .markdown, .docx, .pdf.')
    if not text.strip():
        raise ValueError('No readable text found. Scanned PDFs need OCR and a review first.')
    if suffix in ('.pdf', '.docx'):
        print('Review extracted reading order, tables, and any omitted image text before publishing.', file=sys.stderr)
    return text


def chunks(text, limit=45):
    """Mechanical, word-preserving split. Agents refine structure afterward."""
    output = []
    for paragraph in re.split(r'\n\s*\n', text.strip()):
        words = paragraph.split()
        while words:
            take = min(limit, len(words))
            if len(words) > limit:
                ends = [i for i in range(15, take + 1) if re.search(r'[.!?][\x22\x27”’)]?$', words[i-1])]
                if ends:
                    take = ends[-1]
            output.append(' '.join(words[:take]))
            words = words[take:]
    return output


def plain_markdown(text):
    # Literal source is data. Escape Markdown so source punctuation cannot alter it.
    return re.sub(r'([\\`*_{}\[\]()#+.!<>|~&^$\-])', r'\\\1', text)


def parse_deck(text):
    match = re.match(r'\A---\r?\n(.*?)\r?\n---\r?\n(.*)\Z', text, re.S)
    if not match:
        raise ValueError('Deck must start with title/theme/seconds front matter between --- lines.')
    meta = {}
    for line in match[1].splitlines():
        if not line.strip():
            continue
        key, sep, value = line.partition(':')
        if not sep or key not in ('title', 'theme', 'seconds') or key in meta:
            raise ValueError(f'Unknown or duplicate deck setting: {key}')
        try:
            meta[key] = json.loads(value.strip())
        except json.JSONDecodeError:
            meta[key] = value.strip()
    if not isinstance(meta.get('title'), str) or not meta['title'].strip():
        raise ValueError('A nonempty title is required.')
    if meta.get('theme', 'dark') not in ('dark', 'light'):
        raise ValueError('Theme must be dark or light.')
    duration(meta.get('seconds', 'auto'))
    slides = []
    for part in re.split(r'^---\s*$', match[2], flags=re.M):
        part = part.strip()
        if not part:
            raise ValueError('Empty slide. Remove the extra --- separator.')
        timing = re.search(r'^<!--\s*seconds:\s*([\d.]+)\s*-->\s*$', part, re.M)
        seconds = duration(float(timing[1]) if timing else meta.get('seconds', 'auto'))
        part = re.sub(r'^<!--\s*seconds:\s*[\d.]+\s*-->\s*$', '', part, flags=re.M).strip()
        # No raw HTML, images, active links, remote resources, or attributes in v1.
        ast = json.loads(run('pandoc', '-f', 'markdown-raw_html-raw_tex-yaml_metadata_block-smart', '-t', 'json', input=part))
        def sanitize(value):
            if isinstance(value, list):
                return [sanitize(v) for v in value]
            if isinstance(value, dict):
                if value.get('t') in ('Image', 'RawInline', 'RawBlock'):
                    raise ValueError('Images and raw markup are not supported in text slides.')
                if value.get('t') == 'Link':
                    return {'t': 'Span', 'c': [['', [], []], sanitize(value['c'][1])]}
                return {k: sanitize(v) for k, v in value.items()}
            return value
        ast = sanitize(ast)
        safe = run('pandoc', '-f', 'json', '-t', 'html5', '--wrap=none', input=json.dumps(ast))
        words = len(run('pandoc', '-f', 'json', '-t', 'plain', input=json.dumps(ast)).split())
        if not words:
            raise ValueError('Each slide needs readable text.')
        if words > 70:
            print(f'Slide {len(slides)+1}: {words} words; consider splitting for iPad readability.', file=sys.stderr)
        slides.append({'html': safe, 'seconds': seconds or max(8, round(words / 2.5 + 2)), 'words': words})
    return meta, slides


def duration(value):
    if value == 'auto':
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 1 <= value <= 600:
        raise ValueError('Seconds must be auto or a number from 1 to 600.')
    return value


def shell(template, title, content):
    text = (ROOT / 'templates' / template).read_text()
    text = re.sub(r'<title>.*?</title>', lambda _: '<title>' + html.escape(title) + '</title>', text, flags=re.S)
    return re.sub(r'(<main>).*?(</main>)', lambda m: m[1] + '\n' + content + '\n' + m[2], text, count=1, flags=re.S)


def render(text):
    meta, slides = parse_deck(text)
    revision = hashlib.sha256(text.encode()).hexdigest()[:10]
    content = '<header><p class="eyebrow">Slideshow Machine</p><h1>' + html.escape(meta['title']) + '</h1></header>'
    content += '<nav class="playback" aria-label="Playback"><button id="previous" aria-label="Previous slide">←</button><button id="play">Play</button><button id="next" aria-label="Next slide">→</button><label>Reading time <select id="speed"><option value="0.5">Slower</option><option value="1" selected>Normal</option><option value="1.5">Faster</option><option value="2">Fastest</option></select></label><button id="fullscreen">Full screen</button><button id="mute">Mute this slide</button><select id="muted-slides" aria-label="Muted slides" hidden></select><button id="restore-slide" hidden>Restore selected slide</button><button id="restore-all" hidden>Restore all</button><span id="counter" aria-live="polite"></span></nav>'
    content += '<div class="stage" tabindex="0" aria-label="Slideshow; use left and right arrows">'
    for direction, points in [('previous', '15 5 8 12 15 19'), ('next', '9 5 16 12 9 19')]:
        content += f'<button type="button" id="edge-{direction}" class="edge-navigation edge-{direction}" aria-label="{direction.capitalize()} slide"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><polyline points="{points}" /></svg></button>'
    occurrences = {}
    for i, slide in enumerate(slides):
        digest = hashlib.sha256(slide["html"].encode()).hexdigest()
        occurrences[digest] = occurrences.get(digest, 0) + 1
        slide_id = f"{digest}-{occurrences[digest]}"
        content += f'<article class="slide" data-id="{slide_id}" data-seconds="{slide["seconds"]}" {"hidden" if i else ""}>{slide["html"]}</article>'
    content += '<p id="empty-slides" hidden>All slides muted. Restore a slide above to watch again.</p></div><footer><span id="status" role="status">Ready · loops continuously when playing</span><span class="revision">Revision ' + revision + '</span></footer>'
    out = shell('deck.html', meta['title'], content)
    css = (ROOT / 'player.css').read_text()
    js = (ROOT / 'player.js').read_text()
    out = out.replace('</head>', '<style>\n' + css + '\n</style>\n</head>')
    out = out.replace('</body>', '<script>\n' + js + '\n</script>\n</body>')
    out = out.replace("setTheme('dark'); setSize('small');", f"setTheme('{meta.get('theme', 'dark')}'); setSize('small');")
    return out, meta, slides, revision


def ensure_drafts():
    DRAFTS.mkdir(parents=True, exist_ok=True)
    PREVIEWS.mkdir(parents=True, exist_ok=True)
    if not (DRAFTS / '.git').exists():
        run('git', 'init', '-q', '-b', 'main', str(DRAFTS))


def checkpoint(slug):
    run('git', '-C', str(DRAFTS), 'add', '--', slug + '.md', slug + '.source.txt')
    if run('git', '-C', str(DRAFTS), 'diff', '--cached', '--name-only').strip():
        run('git', '-C', str(DRAFTS), '-c', 'user.name=Slideshow Machine', '-c', 'user.email=slideshow@localhost', 'commit', '-q', '-m', 'Revise ' + slug)


def build(slug):
    valid_slug(slug)
    ensure_drafts()
    text = (DRAFTS / (slug + '.md')).read_text()
    out, meta, slides, revision = render(text)
    target = PREVIEWS / (slug + '.html')
    target.write_text(out)
    checkpoint(slug)
    print(json.dumps({'preview': str(target), 'editable_source': str(DRAFTS / (slug + '.md')), 'slides': len(slides), 'revision': revision}, indent=2))
    return target


def library():
    decks = []
    for f in sorted(PREVIEWS.glob('*.html')):
        title = re.search(r'<title>(.*?)</title>', f.read_text(), re.S)[1]
        decks.append(f'<li><a href="{f.name}">{title}</a></li>')
    content = '<header><p class="eyebrow">Local previews · unpublished</p><h1>Slideshow Machine</h1><p class="lede">Choose a slideshow. Open it, press Play, and let it loop.</p></header><section><h2>Your slideshows</h2><ul>' + ''.join(decks) + '</ul></section>'
    target = LOCAL / 'index.html'
    # Preview links are relative to this index.
    content = content.replace('href="', 'href="previews/')
    target.write_text(shell('library.html', 'Slideshow Machine · Local drafts', content))
    return target


def gh(endpoint, method='GET', payload=None):
    args = ['gh', 'api', endpoint, '--method', method]
    if payload is not None:
        args += ['--input', '-']
    return json.loads(run(*args, input=json.dumps(payload) if payload is not None else None))


def publish(slug, confirmed):
    if not confirmed:
        raise ValueError('Publishing makes this deck public. Use --confirm-public only after Pete requests publication of this deck.')
    # Only generated HTML is sent. Never push the working repository or draft sources.
    repo = 'repos/petebrag/slideshows-1'
    info = gh(repo + '/pages')
    if info.get('build_type') != 'legacy' or info.get('source') != {'branch': 'main', 'path': '/'}:
        raise ValueError('GitHub Pages configuration changed. Review publishing settings before continuing.')
    target = build(slug)
    ref = gh(repo + '/git/ref/heads/main')['object']['sha']
    commit = gh(repo + '/git/commits/' + ref)
    tree = gh(repo + '/git/trees/' + commit['tree']['sha'])
    title = re.search(r'<title>(.*?)</title>', target.read_text(), re.S)[1]
    # Keep a dedicated published-deck catalog; preserve the old home page and files.
    catalog = {}
    entry = next((e for e in tree['tree'] if e['path'] == 'catalog.json'), None)
    if entry:
        import base64
        blob = gh(repo + '/git/blobs/' + entry['sha'])
        catalog = json.loads(base64.b64decode(blob['content']))
        if not isinstance(catalog, dict) or not all(SLUG.fullmatch(k) and isinstance(v, str) for k, v in catalog.items()):
            raise ValueError('Published catalog has an unexpected format.')
    catalog[slug] = html.unescape(title)
    items = ''.join('<li><a href="decks/' + k + '.html">' + html.escape(v) + '</a></li>' for k, v in sorted(catalog.items()))
    home = shell('library.html', 'Slideshow Machine', '<header><p class="eyebrow">Slideshow Machine</p><h1>Your slideshows</h1><p class="lede">Choose a slideshow, press Play, and let it loop.</p></header><section><h2>Library</h2><ul>' + items + '</ul></section>')
    changes = {'decks/' + slug + '.html': target.read_text(), 'library.html': home, 'catalog.json': json.dumps(catalog, indent=2)}
    newtree = gh(repo + '/git/trees', 'POST', {'base_tree': commit['tree']['sha'], 'tree': [{'path': p, 'mode': '100644', 'type': 'blob', 'content': c} for p, c in changes.items()]})
    newcommit = gh(repo + '/git/commits', 'POST', {'message': 'Publish slideshow: ' + catalog[slug], 'tree': newtree['sha'], 'parents': [ref]})
    gh(repo + '/git/refs/heads/main', 'PATCH', {'sha': newcommit['sha'], 'force': False})
    print(json.dumps({'commit': newcommit['sha'], 'deck_url': info['html_url'] + 'decks/' + slug + '.html', 'library_url': info['html_url'] + 'library.html', 'status': 'Submitted. Verify the GitHub Pages build and live content before reporting publication complete.'}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    create = commands.add_parser('create', help='Create a local draft from a file or standard input')
    create.add_argument('slug', type=valid_slug)
    create.add_argument('--title', required=True)
    create.add_argument('--file', type=Path)
    create.add_argument('--seconds', default='auto')
    for name in ('build', 'open', 'history'):
        commands.add_parser(name).add_argument('slug', type=valid_slug)
    commands.add_parser('library')
    pub = commands.add_parser('publish')
    pub.add_argument('slug', type=valid_slug)
    pub.add_argument('--confirm-public', action='store_true')
    args = parser.parse_args()
    if args.command == 'create':
        ensure_drafts()
        dest = DRAFTS / (args.slug + '.md')
        if dest.exists():
            raise ValueError('That deck already exists. Edit its Markdown source and run build; do not recreate it.')
        text = source_text(args.file) if args.file else sys.stdin.read()
        if not text.strip():
            raise ValueError('Provide a readable file or paste text on standard input.')
        seconds = args.seconds if args.seconds == 'auto' else float(args.seconds)
        duration(seconds)
        source = DRAFTS / (args.slug + '.source.txt')
        # No source filename or local path is embedded in the exported HTML.
        source.write_text(text)
        deck = '---\ntitle: ' + json.dumps(args.title, ensure_ascii=False) + '\ntheme: dark\nseconds: ' + str(seconds) + '\n---\n\n'
        deck += '\n\n---\n\n'.join(plain_markdown(part) for part in chunks(text)) + '\n'
        dest.write_text(deck)
        build(args.slug)
        library()
    elif args.command in ('build', 'open'):
        target = build(args.slug)
        library()
        if args.command == 'open':
            run('open', str(target))
    elif args.command == 'library':
        ensure_drafts()
        print(library())
    elif args.command == 'history':
        print(run('git', '-C', str(DRAFTS), 'log', '--oneline', '--', args.slug + '.md'))
    elif args.command == 'publish':
        publish(args.slug, args.confirm_public)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        detail = exc.stderr.strip() if isinstance(exc, subprocess.CalledProcessError) and exc.stderr else str(exc)
        sys.exit('Slideshow Machine: ' + detail)
