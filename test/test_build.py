"""Regressioni della build; solo libreria standard, nessun browser richiesto."""
import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

BUILD_PATH = Path(__file__).resolve().parents[1] / 'build.py'
spec = importlib.util.spec_from_file_location('adapter_build', BUILD_PATH)
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'src').mkdir()
        self.template = '<style>/*CSS*/</style><script>/*ENGINE*/</script><script>/*UI*/</script>\n'
        self.write('template.html', self.template)
        self.write('style.css', '/* città */\n')
        self.write('engine.js', 'const messaggio = "È pronto →";\n')
        self.write('ui.js', 'console.log(messaggio);\n')
        self.out = self.root / 'dist' / 'pa500-adattatore.html'

    def write(self, name, text):
        (self.root / 'src' / name).write_bytes(text.encode('utf-8'))

    def run_build(self, *args):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return build.main(list(args), root=self.root)

    def test_fresh_build_creates_dist_and_preserves_unicode(self):
        self.assertEqual(self.run_build(), 0)
        expected = self.template.replace('/*CSS*/', '/* città */\n').replace(
            '/*ENGINE*/', 'const messaggio = "È pronto →";\n').replace(
            '/*UI*/', 'console.log(messaggio);\n')
        self.assertEqual(self.out.read_bytes(), expected.encode('utf-8'))

    def test_crlf_sources_produce_identical_lf_output(self):
        expected = build.render(self.root)
        for path in (self.root / 'src').iterdir():
            path.write_bytes(path.read_bytes().replace(b'\n', b'\r\n'))
        self.assertEqual(build.render(self.root), expected)

    def test_check_missing_output_does_not_create_it(self):
        self.assertEqual(self.run_build('--check'), 1)
        self.assertFalse(self.out.parent.exists())

    def test_check_current_output_does_not_rewrite_it(self):
        self.run_build()
        before = self.out.stat().st_mtime_ns
        self.assertEqual(self.run_build('--check'), 0)
        self.assertEqual(self.out.stat().st_mtime_ns, before)

    def test_check_stale_output_preserves_existing_file(self):
        self.run_build()
        before = self.out.read_bytes()
        self.write('ui.js', '// modifica\n')
        self.assertEqual(self.run_build('--check'), 1)
        self.assertEqual(self.out.read_bytes(), before)

    def test_missing_or_duplicate_markers_fail_before_writing(self):
        self.run_build()
        before = self.out.read_bytes()
        for marker in build.PARTS:
            for replacement in ('', marker + marker):
                with self.subTest(marker=marker, replacement=replacement):
                    self.write('template.html', self.template.replace(marker, replacement))
                    self.assertEqual(self.run_build(), 2)
                    self.assertEqual(self.out.read_bytes(), before)

    def test_inline_closing_tags_fail_case_insensitively(self):
        for tag in ('</ScRiPt>', '</STYLE>'):
            with self.subTest(tag=tag):
                self.write('engine.js', 'const bad = "' + tag + '";')
                self.assertEqual(self.run_build(), 2)
                self.assertFalse(self.out.exists())

    def test_markers_in_inserted_content_remain_literal(self):
        self.write('style.css', '/*ENGINE*/\n')
        self.write('engine.js', 'const marker = "/*UI*/";')
        html = build.render(self.root).decode('utf-8')
        self.assertIn('<style>/*ENGINE*/\n</style>', html)
        self.assertIn('<script>const marker = "/*UI*/";</script>', html)
        self.assertIn('<script>console.log(messaggio);\n</script>', html)

    def test_invalid_utf8_or_missing_source_does_not_write(self):
        path = self.root / 'src' / 'engine.js'
        path.write_bytes(b'\xff')
        self.assertEqual(self.run_build(), 2)
        path.unlink()
        self.assertEqual(self.run_build(), 2)
        self.assertFalse(self.out.exists())

    def test_optimized_python_still_enforces_validation(self):
        (self.root / 'build.py').write_bytes(BUILD_PATH.read_bytes())
        self.write('engine.js', '</script>')
        result = subprocess.run([sys.executable, '-O', str(self.root / 'build.py')],
                                cwd=self.root.parent, capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.out.exists())


if __name__ == '__main__':
    unittest.main()
