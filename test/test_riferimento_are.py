"""Riferimento: config con la struttura di un PA-550 in produzione con Advanced Routing.

1. Convertita per PA-550 deve passare senza errori né attività manuali e restare identica
   nelle sezioni di rete, routing, HA e vsys: lo strumento non deve toccare una config valida.
2. Ogni elemento del logical router deve esistere nello schema ARE (test/are_schema.json).
3. Usata come config del PA-500 mentre si converte una sorgente legacy, deve fornire HA e
   management, mentre il routing viene dalla sorgente convertita.
"""
import json
import pathlib
import re
import sys
import xml.etree.ElementTree as ET

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
ENGINE = (HERE.parent / 'src' / 'engine.js').read_text()
REF = (HERE / 'pa550-are-funzionante.xml').read_text()
LEGACY = (HERE / 'src-pa3220.xml').read_text()
SCHEMA = json.loads((HERE / 'are_schema.json').read_text())

JS = """([src, tgt, map, rules]) => {
  const s = PA500.parse(src);
  const info = PA500.analyze(s);
  const m = PA500.getModel('PA-550');
  const full = Object.assign(PA500.defaultMap(info.devices[0].interfaces, m), map);
  const r = PA500.run(s, { model: 'PA-550', map: full, customRules: [],
    rules: Object.assign({ are: true, dyn: true, ifaces: true, ha: true, poe: true, keepMgmt: false, keepHA: false, keepAdmins: false }, rules) },
    tgt ? PA500.parse(tgt) : null);
  return { xml: PA500.serialize(r.doc), stats: r.stats, report: r.report.map(i => i.level + ' [' + i.area + '] ' + i.msg) };
}"""

FAILS = []


def check(cond, msg):
    if not cond:
        FAILS.append(msg)
        print('FAIL', msg)


def canon(el):
    return re.sub(r'>\s+<', '><', ET.tostring(el, encoding='unicode')).strip() if el is not None else None


def prefixes(paths):
    out = set()
    for p in paths:
        parts = p.split('/')
        for i in range(1, len(parts) + 1):
            out.add('/'.join(parts[:i]))
    return out


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page()
    page.set_content('<html></html>')
    page.add_script_tag(content=ENGINE)
    same = page.evaluate(JS, [REF, None, {}, {}])
    as_target = page.evaluate(JS, [LEGACY, REF,
                                   {'ethernet1/3': 'ethernet1/9', 'ethernet1/4': 'ethernet1/10', 'ethernet1/20': 'ethernet1/16', 'ethernet1/21': 'ethernet1/13'},
                                   {'keepHA': True, 'keepMgmt': True}])
    b.close()

# 1. config già valida: nessun errore e nessuna modifica
check(same['stats']['error'] == 0, 'errori su una config valida: %s' % [i for i in same['report'] if i.startswith('error')])
check(same['stats']['manual'] == 0, 'attività manuali su una config valida: %s' % [i for i in same['report'] if i.startswith('manual')])
src, out = ET.fromstring(REF.encode()), ET.fromstring(same['xml'].encode())
for path in ('devices/entry/network/logical-router', 'devices/entry/network/interface', 'devices/entry/network/dhcp',
             'devices/entry/network/virtual-wire', 'devices/entry/deviceconfig/high-availability',
             'devices/entry/deviceconfig/setting', 'devices/entry/vsys'):
    check(canon(src.find(path)) == canon(out.find(path)), 'sezione modificata: ' + path)

# 2. il riferimento rispetta lo schema ARE
ok = prefixes(SCHEMA['logical-router'])
for lr in src.findall('devices/entry/network/logical-router/entry'):
    def walk(e, p):
        for c in e:
            q = (p + '/' if p else '') + c.tag
            check(q in ok, 'elemento del riferimento assente dallo schema: ' + q)
            walk(c, q)
    walk(lr, '')

# 3. riferimento come config del PA-500
t = ET.fromstring(as_target['xml'].encode())
check(as_target['stats']['error'] == 0, 'errori convertendo con il riferimento come destinazione: %s' % [i for i in as_target['report'] if i.startswith('error')])
check(canon(t.find('devices/entry/deviceconfig/high-availability')) == canon(src.find('devices/entry/deviceconfig/high-availability')), 'HA non presa dal PA-500')
check(t.findtext('devices/entry/deviceconfig/system/hostname') == 'pa550-are', 'hostname non preso dal PA-500')
check([e.get('name') for e in t.findall('devices/entry/network/logical-router/entry')] == ['default', 'vr2'], 'logical router non convertiti dalla sorgente')
check(t.find('devices/entry/network/virtual-router') is None, 'virtual-router residuo')
for port in ('ethernet1/11', 'ethernet1/12', 'ethernet1/14'):
    check(t.find("devices/entry/network/interface/ethernet/entry[@name='%s']/ha" % port) is not None, port + ' non è in modalità HA')

print('test_riferimento_are: %d verifiche fallite' % len(FAILS) if FAILS else 'test_riferimento_are: tutte le verifiche passate')
sys.exit(1 if FAILS else 0)
