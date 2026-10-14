"""Test del motore in Chromium headless: conversione, report e validazione schema ARE."""
import json, sys, pathlib
import xml.etree.ElementTree as ET
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
ENGINE = (HERE.parent / 'src' / 'engine.js').read_text()
SCHEMA = json.loads((HERE / 'are_schema.json').read_text())
SRC = (HERE / 'src-pa3220.xml').read_text()
TGT = (HERE / 'tgt-pa550.xml').read_text()


def element_paths(el, prefix=''):
    for c in el:
        p = (prefix + '/' if prefix else '') + c.tag
        yield p, c
        yield from element_paths(c, p)


def schema_errors(xml_text):
    """Ogni elemento generato sotto logical-router e routing-profile deve esistere negli schemi Palo Alto."""
    root = ET.fromstring(xml_text)
    errs = []

    def with_prefixes(paths):
        out = set()
        for p in paths:
            parts = p.split('/')
            for i in range(1, len(parts) + 1):
                out.add('/'.join(parts[:i]))
        return out
    lr_ok = with_prefixes(SCHEMA['logical-router'])
    for dev in root.findall('./devices/entry'):
        for lr in dev.findall('./network/logical-router/entry'):
            for p, _ in element_paths(lr):
                if p not in lr_ok:
                    errs.append('logical-router: ' + p)
        rp = dev.find('./network/routing-profile')
        if rp is not None:
            for kind_key, allowed in SCHEMA.items():
                if not kind_key.startswith('network/routing-profile/'):
                    continue
                rel = kind_key[len('network/routing-profile/'):]
                container = rp.find('./' + rel)
                if container is None:
                    continue
                ok = with_prefixes(allowed)
                for e in container.findall('./entry'):
                    for p, _ in element_paths(e):
                        if p not in ok:
                            errs.append(kind_key + ': ' + p)
            known = {k[len('network/routing-profile/'):] for k in SCHEMA if k.startswith('network/routing-profile/')}
            for kindgrp in rp:
                for kind in kindgrp:
                    rel = kindgrp.tag + '/' + kind.tag
                    if kindgrp.tag == 'bfd':
                        rel = 'bfd'
                    if rel not in known and kindgrp.tag != 'bfd':
                        errs.append('routing-profile sconosciuto: ' + rel)
    return errs


SCENARIOS = {
    'senza_target': dict(model='PA-550', target=False, map={
        'ethernet1/20': 'ethernet1/15', 'ethernet1/21': '__drop__', 'ha1-a': 'management', 'ha1-b': 'ethernet1/11'},
        rules=dict(are=True, dyn=True, ifaces=True, ha=True, poe=True, keepMgmt=False, keepHA=False, keepAdmins=False)),
    'con_target': dict(model='PA-550', target=True, map={
        'ethernet1/20': 'ethernet1/15', 'ethernet1/21': 'ethernet1/10', 'ethernet1/8': '__drop__'},
        rules=dict(are=True, dyn=True, ifaces=True, ha=True, poe=True, keepMgmt=True, keepHA=True, keepAdmins=True)),
    'solo_are_senza_dyn': dict(model='PA-560', target=False, map={},
        rules=dict(are=True, dyn=False, ifaces=False, ha=False, poe=False, keepMgmt=False, keepHA=False, keepAdmins=False)),
}

JS_RUN = """
([src, tgt, opts]) => {
  const s = PA500.parse(src);
  const t = tgt ? PA500.parse(tgt) : null;
  const info = PA500.analyze(s);
  const model = PA500.getModel(opts.model);
  const map = Object.assign(PA500.defaultMap(info.devices[0].interfaces, model), opts.map);
  const res = PA500.run(s, Object.assign({}, opts, {map}), t);
  return { xml: PA500.serialize(res.doc), report: res.report, stats: res.stats, counts: res.counts, ports: res.ports,
           inv: info.devices[0].interfaces.map(i => [i.key, i.kind, i.mode, i.used, i.zones.join(',')]), map };
}
"""

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page()
    page.set_content('<html><body></body></html>')
    page.add_script_tag(content=ENGINE)
    failures = 0
    for name, sc in SCENARIOS.items():
        opts = dict(model=sc['model'], map=sc['map'], rules=sc['rules'], customRules=[])
        r = page.evaluate(JS_RUN, [SRC, TGT if sc['target'] else None, opts])
        out = HERE / f'out-{name}.xml'
        out.write_text(r['xml'])
        print('=' * 100)
        print(name, r['stats'])
        if name == 'senza_target':
            print('inventario:', r['inv'])
        for it in r['report']:
            print(f"  [{it['level']:6}] {it['area']:12} {it['msg']}")
        errs = schema_errors(r['xml'])
        if errs:
            failures += 1
            print('!! ERRORI SCHEMA:', *errs, sep='\n   ')
        root = ET.fromstring(r['xml'])
        assert root.find('.//virtual-router') is None or name == 'solo_are_senza_dyn' and False, 'virtual-router residuo'
        assert root.findtext('./devices/entry/deviceconfig/setting/advance-routing') == 'yes'
        if sc['rules']['dyn']:
            ospf_ad = root.find("./devices/entry/network/logical-router/entry[@name='default']/vrf/entry[@name='default']/admin-dists")
            assert ospf_ad is not None, 'admin-dists del logical router default mancanti'
            assert ospf_ad.find('ospf-intra') is None and ospf_ad.find('ospf-inter') is None, 'il default legacy OSPF 30 non deve essere portato nell ARE'
            assert any(it['level'] == 'check' and it['area'] == 'OSPF' and 'default 110' in it['msg'] for it in r['report']), 'manca avviso sul cambio del default OSPF 30 -> 110'
        print('porte:', json.dumps(r['ports']))
    b.close()
    print('schema failures:', failures)
    sys.exit(1 if failures else 0)
