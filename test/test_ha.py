"""Casi HA: porte condivise, link su management, backup tolti, subnet sovrapposte."""
import pathlib
import sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
ENGINE = (HERE.parent / 'src' / 'engine.js').read_text()
SRC = (HERE / 'src-pa3220.xml').read_text()
TGT = (HERE / 'tgt-pa550.xml').read_text()
# variante: ha1-backup nella stessa subnet della management del PA-500 (10.0.0.0/24)
SRC_OVERLAP = SRC.replace('<ip-address>10.255.254.1</ip-address><netmask>255.255.255.252</netmask>',
                          '<ip-address>10.0.0.60</ip-address><netmask>255.255.255.0</netmask>')

JS = """
([src, tgt, map, rules]) => {
  const r = PA500.run(PA500.parse(src), { model: 'PA-550', map, customRules: [],
    rules: Object.assign({ are: true, dyn: true, ifaces: true, ha: true, poe: true, keepMgmt: false, keepHA: false, keepAdmins: false }, rules) },
    tgt ? PA500.parse(tgt) : null);
  const ha = PA500.evalXPath(r.doc, '/config/devices/entry/deviceconfig/high-availability/interface')[0];
  return { items: r.report.filter(i => i.area === 'HA').map(i => i.level + ': ' + i.msg),
           xml: ha ? PA500.snippet(ha) : '(nessuna sezione HA)', mgmtHa: r.mgmtHa };
}
"""

CASES = [
    ('entrambe su management', SRC, None, {'ha1-a': 'management', 'ha1-b': 'management', 'ethernet1/20': 'ethernet1/15', 'ethernet1/21': 'ethernet1/9'}, {},
     lambda r: any('stessa porta' in i for i in r['items']) and r['mgmtHa'] == ['ha1', 'ha1-backup']),
    ('ha1 su management, backup tolto', SRC, None, {'ha1-a': 'management', 'ha1-b': '__drop__', 'ethernet1/20': 'ethernet1/15', 'ethernet1/21': 'ethernet1/9'}, {},
     lambda r: not any(i.startswith('error') for i in r['items']) and 'ha1-backup' not in r['xml'] and '<ip-address>' not in r['xml'].split('<ha2>')[0]),
    ('backup nella subnet della management', SRC_OVERLAP, TGT, {'ha1-a': 'management', 'ha1-b': 'ethernet1/11', 'ethernet1/20': 'ethernet1/15', 'ethernet1/21': 'ethernet1/9'}, {'keepMgmt': True},
     lambda r: any('stessa subnet' in i for i in r['items'])),
    ('porta di ha2 esclusa', SRC, None, {'ha1-a': 'management', 'ha1-b': 'ethernet1/11', 'ethernet1/8': '__drop__', 'ethernet1/20': 'ethernet1/15', 'ethernet1/21': 'ethernet1/9'}, {},
     lambda r: any('hai escluso' in i for i in r['items'])),
    ('configurazione valida', SRC, None, {'ha1-a': 'management', 'ha1-b': 'ethernet1/11', 'ethernet1/20': 'ethernet1/15', 'ethernet1/21': 'ethernet1/9'}, {},
     lambda r: not any(i.startswith('error') for i in r['items'])),
]

fail = 0
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page()
    page.set_content('<html></html>')
    page.add_script_tag(content=ENGINE)
    for name, src, tgt, mp, rules, ok in CASES:
        r = page.evaluate(JS, [src, tgt, mp, rules])
        good = ok(r)
        fail += not good
        print(('OK   ' if good else 'FAIL ') + name)
        for i in r['items']:
            print('     ' + i)
        if name in ('ha1 su management, backup tolto',):
            print(r['xml'])
    b.close()
sys.exit(1 if fail else 0)
