"""Casi aggiuntivi: regole personalizzate, errori di commit, sorgente già ARE, multi-vsys, collisioni."""
import json, pathlib, sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
ENGINE = (HERE.parent / 'src' / 'engine.js').read_text()
SRC = (HERE / 'src-pa3220.xml').read_text()

ARE_SRC = """<config version="11.1.0"><devices><entry name="localhost.localdomain">
<deviceconfig><setting><advance-routing>yes</advance-routing></setting><system><hostname>x</hostname><panorama><local-panorama><panorama-server>10.9.9.9</panorama-server></local-panorama></panorama></system></deviceconfig>
<network><interface><ethernet><entry name="ethernet1/1"><layer3/></entry><entry name="ethernet1/2"><layer3/></entry></ethernet></interface>
<logical-router><entry name="lr1"><vrf><entry name="default"><interface><member>ethernet1/1</member></interface></entry></vrf></entry></logical-router>
<virtual-router><entry name="default"><interface><member>ethernet1/2</member></interface></entry></virtual-router></network>
<vsys><entry name="vsys1"><zone><entry name="ae1"><network><layer3><member>ethernet1/1</member></layer3></network></entry></zone></entry><entry name="vsys2"/></vsys>
</entry></devices></config>"""

JS = """
([src, are]) => {
  const out = {};
  const run = (xml, opts) => PA500.run(PA500.parse(xml), Object.assign({ model: 'PA-550', map: {}, customRules: [],
      rules: { are: true, dyn: true, ifaces: true, ha: true, poe: true, keepMgmt: false, keepHA: false, keepAdmins: false } }, opts), null);

  // 1. regole personalizzate
  const rules = [
    { id: 'a', xpath: "/config/devices/entry/deviceconfig/system/timezone", action: 'set', value: 'UTC' },
    { id: 'b', xpath: "/config/shared/address/entry[@name='srv-web']/ip-netmask", action: 'replace', pattern: '^10\\\\.10', value: '172.16' },
    { id: 'c', xpath: "//dns-setting", action: 'rename', value: 'dns-setting-x' },
    { id: 'd', xpath: "//entry[@name='lan-out']", action: 'report' },
    { id: 'e', xpath: "//entry[", action: 'remove' },
    { id: 'f', xpath: "/config/devices/entry/vsys/entry/rulebase/nat", action: 'remove' },
    { id: 'g', xpath: "/config/nothing", action: 'remove', enabled: true },
    { id: 'h', xpath: "/config/devices/entry/deviceconfig/system/hostname", action: 'remove', enabled: false }
  ];
  const r1 = run(src, { customRules: rules });
  const d = r1.doc;
  out.custom = {
    hits: r1.ruleHits,
    tz: PA500.evalXPath(d, '/config/devices/entry/deviceconfig/system/timezone')[0].textContent,
    ip: PA500.evalXPath(d, "/config/shared/address/entry[@name='srv-web']/ip-netmask")[0].textContent,
    renamed: PA500.evalXPath(d, '//dns-setting-x').length,
    nat: PA500.evalXPath(d, '//rulebase/nat').length,
    hostname: PA500.evalXPath(d, '/config/devices/entry/deviceconfig/system/hostname').length,
    msgs: r1.report.filter(i => i.area === 'Regole personalizzate').map(i => i.level + ': ' + i.msg)
  };

  // 2. errori di commit
  const errs = PA500.parseCommitErrors([
    "Validation Error:",
    " vsys -> vsys1 -> rulebase -> security -> rules -> dmz-in -> from 'old-zone' is not a valid reference",
    " rulebase -> security -> rules -> lan-out -> application is invalid",
    " devices -> localhost.localdomain -> deviceconfig -> setting constraints failed : Disabling advanced routing is not allowed on this platform",
    " vsys1 -> zone -> guest -> network is missing 'layer3'",
    " foo -> bar is unexpected",
    "Commit failed"].join('\\n'));
  out.errors = errs.map(e => {
    const r = PA500.resolveError(r1.doc, e);
    return { raw: e.raw, parsed: e.parsed, n: (r.nodes || []).length, paths: (r.nodes || []).map(PA500.humanPath), msg: r.msg, actions: (r.actions || []).map(a => [a.label, a.xpath, a.generic]), hint: r.hint };
  });

  // 3. sorgente già ARE con VR residui, zona con nome di interfaccia, multi-vsys, panorama
  const r3 = run(are, { map: { 'ethernet1/1': 'ethernet1/3' } });
  out.are = r3.report.map(i => i.level + ' [' + i.area + '] ' + i.msg);
  out.areXml = PA500.serialize(r3.doc);

  // 4. collisione: due interfacce sulla stessa porta + porta scambiata
  const r4 = run(src, { map: { 'ethernet1/20': 'ethernet1/1', 'ethernet1/21': 'ethernet1/9' } });
  out.collision = r4.report.filter(i => i.level === 'error').map(i => i.msg);
  const r5 = run(src, { map: { 'ethernet1/1': 'ethernet1/2', 'ethernet1/2': 'ethernet1/1', 'ethernet1/20': 'ethernet1/15', 'ethernet1/21': 'ethernet1/9', 'ha1-a': 'management', 'ha1-b': 'ethernet1/10' } });
  out.swap = { errors: r5.report.filter(i => i.level === 'error').map(i => i.msg),
    zoneUntrust: PA500.evalXPath(r5.doc, "//zone/entry[@name='untrust']/network/layer3/member")[0].textContent,
    unit: PA500.evalXPath(r5.doc, "//ethernet/entry[@name='ethernet1/1']/layer3/units/entry/@name").map(a => a.value),
    dhcp: PA500.evalXPath(r5.doc, "//dhcp/interface/entry/@name").map(a => a.value) };
  return out;
}
"""

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page()
    page.set_content('<html><body></body></html>')
    page.add_script_tag(content=ENGINE)
    r = page.evaluate(JS, [SRC, ARE_SRC])
    print(json.dumps(r['custom'], indent=1, ensure_ascii=False))
    for e in r['errors']:
        print(json.dumps(e, ensure_ascii=False))
    print('\n'.join(r['are']))
    print(r['areXml'])
    print('collisione:', r['collision'])
    print('scambio:', json.dumps(r['swap'], ensure_ascii=False))
    b.close()
