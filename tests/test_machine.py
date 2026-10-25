import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('machine', Path(__file__).resolve().parents[1] / 'machine.py')
machine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(machine)


class CreationTests(unittest.TestCase):
    def test_word_preserving_split(self):
        text = ' '.join('word' + str(i) for i in range(160)) + '\n\nlast paragraph.'
        self.assertEqual(' '.join(machine.chunks(text)).split(), text.split())
        self.assertTrue(all(len(s.split()) <= 45 for s in machine.chunks(text)))

    def test_literal_source_survives_markdown(self):
        original = '1. Keep *this* and <script>alert(1)</script> and [word](https://example.com) and "quotes" and &copy; and ^word^ and $5 unchanged.'
        escaped = machine.plain_markdown(original)
        self.assertEqual(machine.run('pandoc', '-f', 'markdown-smart', '-t', 'plain', '--wrap=none', input=escaped).strip(), original)
        rendered, _, _, _ = machine.render('---\ntitle: "test123"\nseconds: auto\n---\n' + escaped)
        self.assertIn('"quotes"', rendered)

    def test_html_is_inert_and_has_no_runtime_resources(self):
        text = '---\ntitle: "test123"\nseconds: 1\n---\n' + machine.plain_markdown('<script>window.injected=true</script>')
        rendered, _, _, _ = machine.render(text)
        self.assertNotIn('<script>window.injected=true</script>', rendered)
        self.assertNotRegex(rendered, r'<(?:script|link|img)[^>]*(?:src|href)=')
        self.assertNotIn('<h2>1. Section</h2>', rendered)

    def test_timing_and_empty_slide_validation(self):
        base = '---\ntitle: "test123"\nseconds: auto\n---\n'
        _, slides = machine.parse_deck(base + '<!-- seconds: 3 -->\nhello\n\n---\n\nworld')
        self.assertEqual([s['seconds'] for s in slides], [3, 8])
        with self.assertRaises(ValueError):
            machine.parse_deck(base + 'hello\n---\n')
        with self.assertRaises(ValueError):
            machine.parse_deck(base.replace('auto', '-1') + 'hello')

    def test_input_extractors(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp)
            source = p / 'test123.txt'
            source.write_text('hello world')
            self.assertEqual(machine.source_text(source), 'hello world')
            docx = p / 'test123.docx'
            machine.run('pandoc', '-f', 'markdown', '-t', 'docx', '-o', str(docx), input='hello world')
            self.assertEqual(machine.source_text(docx).strip(), 'hello world')
            source = p / 'test123.pdf'
            stream = b'BT /F1 12 Tf 40 700 Td (hello world) Tj ET'
            objects = [
                b'<< /Type /Catalog /Pages 2 0 R >>',
                b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
                b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
                b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
                b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream',
            ]
            pdf = b'%PDF-1.4\n'
            offsets = [0]
            for i, obj in enumerate(objects, 1):
                offsets.append(len(pdf))
                pdf += f'{i} 0 obj\n'.encode() + obj + b'\nendobj\n'
            xref = len(pdf)
            pdf += b'xref\n0 6\n0000000000 65535 f \n'
            pdf += b''.join(f'{n:010} 00000 n \n'.encode() for n in offsets[1:])
            pdf += f'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF'.encode()
            source.write_bytes(pdf)
            self.assertEqual(machine.source_text(source).strip(), 'hello world')
            source.write_bytes(b'%PDF-1.4\ninvalid')
            with self.assertRaises(subprocess.CalledProcessError):
                machine.source_text(source)

    def test_build_checkpoint_and_resumed_revision(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp)
            with patch.multiple(machine, LOCAL=p, DRAFTS=p/'drafts', PREVIEWS=p/'previews'):
                machine.ensure_drafts()
                source = p / 'drafts/test123.md'
                source.write_text('---\ntitle: "test123"\nseconds: auto\n---\nhello')
                (p / 'drafts/test123.source.txt').write_text('hello')
                first = machine.build('test123').read_text()
                source.write_text(source.read_text().replace('hello', 'world'))
                second = machine.build('test123').read_text()
                self.assertNotEqual(first, second)
                self.assertEqual(len(machine.run('git', '-C', str(p/'drafts'), 'log', '--oneline').splitlines()), 2)
                self.assertFalse((machine.ROOT / 'decks/test123.html').exists())

    def test_publish_requires_explicit_public_confirmation(self):
        with patch.object(machine, 'gh') as network:
            with self.assertRaises(ValueError):
                machine.publish('test123', False)
            network.assert_not_called()

    def test_publication_is_one_commit_of_generated_assets_only(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'test123.html'
            target.write_text('<title>test123</title>')
            calls = []
            def fake(endpoint, method='GET', payload=None):
                calls.append((endpoint, method, payload))
                if endpoint.endswith('/pages'):
                    return {'build_type':'legacy', 'source':{'branch':'main','path':'/'}, 'html_url':'https://example.com/'}
                if endpoint.endswith('/git/ref/heads/main'): return {'object':{'sha':'base'}}
                if endpoint.endswith('/git/commits/base'): return {'tree':{'sha':'tree'}}
                if endpoint.endswith('/git/trees/tree'): return {'tree':[]}
                if endpoint.endswith('/git/trees'): return {'sha':'tree2'}
                if endpoint.endswith('/git/commits'): return {'sha':'next'}
                return {}
            with patch.object(machine, 'gh', side_effect=fake), patch.object(machine, 'build', return_value=target):
                machine.publish('test123', True)
            payload = next(p for e, m, p in calls if e.endswith('/git/trees') and m == 'POST')
            self.assertEqual({x['path'] for x in payload['tree']}, {'decks/test123.html','library.html','catalog.json'})
            self.assertEqual(calls[-1][2], {'sha':'next', 'force':False})


if __name__ == '__main__':
    unittest.main()
