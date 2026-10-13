"""Assembla la pagina unica: template + CSS + motore + interfaccia."""
import pathlib

root = pathlib.Path(__file__).parent
src = root / 'src'
html = (src / 'template.html').read_text()
for marker, name in (('/*CSS*/', 'style.css'), ('/*ENGINE*/', 'engine.js'), ('/*UI*/', 'ui.js')):
    part = (src / name).read_text()
    assert '</script' not in part.lower() and '</style' not in part.lower(), name
    html = html.replace(marker, part, 1)
out = root / 'dist' / 'pa500-adattatore.html'
out.write_text(html)
print(out, len(html), 'byte')
