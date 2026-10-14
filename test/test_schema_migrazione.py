"""Schema di migrazione reale, anonimizzato: firewall 10.2.16 (prima) -> PA-550 12.1.7 (dopo).

I due file in test/schema/ vengono da una migrazione in produzione, resi anonimi con
tools/anonimizza.py: struttura, interfacce e numeri sono quelli reali, nomi, indirizzi e testi no.
Fra i due ci sono anche cambi infrastrutturali (porte, aggregate, HA) e modifiche fatte a mano
dopo la migrazione (regole riordinate, una route in più): il test verifica solo ciò che dipende
dalla migrazione di versione e dal routing.
"""
import pathlib
import re
import sys
import xml.etree.ElementTree as ET

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
ENGINE = (HERE.parent / 'src' / 'engine.js').read_text()
PRIMA = (HERE / 'schema' / 'prima-10.2.xml').read_text()
DOPO = (HERE / 'schema' / 'dopo-12.1.xml').read_text()
AGGIUNTE_A_MANO = {'rotta_18'}   # route presenti solo dopo, create sul PA-550 dopo la migrazione

JS = """(src) => {
  const t0 = performance.now();
  const r = PA500.run(PA500.parse(src), { model: 'PA-550', map: {}, customRules: [],
    rules: { are: true, dyn: true, ifaces: true, ha: true, poe: true } }, null);
  return { xml: PA500.serialize(r.doc), stats: r.stats, ms: performance.now() - t0,
           report: r.report.map(i => i.level + ' [' + i.area + '] ' + i.msg) };
}"""

FAILS = []


def check(cond, msg):
    if not cond:
        FAILS.append(msg)
        print('FAIL', msg)


def canon(el):
    return re.sub(r'>\s+<', '><', ET.tostring(el, encoding='unicode')).strip() if el is not None else None


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page()
    page.set_content('<html></html>')
    page.add_script_tag(content=ENGINE)
    conv = page.evaluate(JS, PRIMA)
    same = page.evaluate(JS, DOPO)
    b.close()

prima = ET.fromstring(PRIMA.encode()).find('devices/entry')
dopo = ET.fromstring(DOPO.encode()).find('devices/entry')
out = ET.fromstring(conv['xml'].encode()).find('devices/entry')

# lo schema è quello atteso
check(prima.find('network/virtual-router/entry') is not None and prima.findtext('deviceconfig/setting/advance-routing') is None, 'schema prima: atteso un virtual router legacy')
check(dopo.find('network/logical-router/entry') is not None and dopo.findtext('deviceconfig/setting/advance-routing') == 'yes', 'schema dopo: atteso un logical router')

# conversione del prima
check(conv['stats']['error'] == 0 and conv['stats']['manual'] == 0, 'errori o attività manuali: %s' % [i for i in conv['report'] if i.startswith(('error', 'manual'))])
check(out.find('network/virtual-router') is None and out.findtext('deviceconfig/setting/advance-routing') == 'yes', 'routing non convertito')
check(conv['ms'] < 5000, 'conversione troppo lenta: %.0f ms' % conv['ms'])

vo = out.find('network/logical-router/entry/vrf/entry')
vd = dopo.find('network/logical-router/entry/vrf/entry')
check(out.find('network/logical-router/entry').get('name') == dopo.find('network/logical-router/entry').get('name'), 'nome del logical router diverso')
ro = {e.get('name'): e for e in vo.findall('routing-table/ip/static-route/entry')}
rd = {e.get('name'): e for e in vd.findall('routing-table/ip/static-route/entry')}
check(set(ro) == set(rd) - AGGIUNTE_A_MANO, 'route diverse: solo convertite %s, solo dopo %s' % (sorted(set(ro) - set(rd)), sorted(set(rd) - set(ro) - AGGIUNTE_A_MANO)))
for k in set(ro) & set(rd):
    a, b2 = ro[k], rd[k]
    for t in ('destination', 'metric', 'nexthop/ip-address'):
        check(a.findtext(t) == b2.findtext(t), f'route {k}: {t} {a.findtext(t)!r} invece di {b2.findtext(t)!r}')
    check((a.find('nexthop') is None) == (b2.find('nexthop') is None), f'route {k}: presenza del next hop diversa')
    check((a.find('interface') is None) == (b2.find('interface') is None), f'route {k}: presenza dell\'interfaccia diversa')
    check(a.find('route-table') is None, f'route {k}: route-table rimasto')
check(any(' ' in e.get('name') for e in prima.findall('network/virtual-router/entry/routing-table/ip/static-route/entry')), 'schema prima: manca la route con lo spazio nel nome')
check(all(' ' not in n for n in ro), 'route con spazi nel nome dopo la conversione')
ad = {c.tag: c.text for c in vo.find('admin-dists')}
check('ospf-intra' not in ad, 'distanza OSPF 30 portata con OSPF spento: %s' % ad)

# IKE: la versione esplicita che PAN-OS ha scritto al caricamento
for g in prima.findall('network/ike/gateway/entry'):
    n = g.get('name')
    got = out.findtext(f"network/ike/gateway/entry[@name='{n}']/protocol/version")
    if g.findtext('protocol/version'):
        check(got == g.findtext('protocol/version'), f'IKE {n}: versione esplicita modificata')
    else:
        check(got == 'ikev1', f'IKE {n}: attesa ikev1, trovata {got!r}')
ikev1_dopo = sum(1 for g in prima.findall('network/ike/gateway/entry') if not g.findtext('protocol/version')
                 and dopo.findtext(f"network/ike/gateway/entry[@name='{g.get('name')}']/protocol/version") == 'ikev1')
check(ikev1_dopo >= 3, 'schema dopo: attesi almeno 3 gateway con ikev1 esplicito')

# la config 12.1 passa invariata
d2 = ET.fromstring(same['xml'].encode()).find('devices/entry')
check(same['stats']['error'] == 0 and same['stats']['manual'] == 0, 'errori sulla config 12.1: %s' % [i for i in same['report'] if i.startswith(('error', 'manual'))])
for path in ('network/logical-router', 'network/ike', 'network/interface', 'deviceconfig/high-availability', 'vsys'):
    check(canon(dopo.find(path)) == canon(d2.find(path)), 'config 12.1 modificata in ' + path)

print('test_schema_migrazione: %d verifiche fallite' % len(FAILS) if FAILS else 'test_schema_migrazione: tutte le verifiche passate')
sys.exit(1 if FAILS else 0)
