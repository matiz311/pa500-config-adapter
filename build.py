"""Assembla la pagina unica: template + CSS + motore + interfaccia."""
import base64
import pathlib
import re

root = pathlib.Path(__file__).parent
src = root / 'src'
html = (src / 'template.html').read_text()
for marker, name in (('/*CSS*/', 'style.css'), ('/*ENGINE*/', 'engine.js'), ('/*UI*/', 'ui.js')):
    part = (src / name).read_text()
    if name == 'style.css':
        # font incorporati: la pagina resta un file unico e la CSP non ammette risorse esterne
        part = re.sub(r'url\("fonts/([^"]+)"\)', lambda m: 'url("data:font/woff2;base64,%s")' % base64.b64encode((src / 'fonts' / m.group(1)).read_bytes()).decode(), part)
    assert '</script' not in part.lower() and '</style' not in part.lower(), name
    html = html.replace(marker, part, 1)
out = root / 'dist' / 'pa500-adattatore.html'
out.write_text(html)
print(out, len(html), 'byte')
