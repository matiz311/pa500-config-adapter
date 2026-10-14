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


IFACE_SRC = """<config version="11.1.0">
<shared><address><entry name="ethernet1/1"><ip-netmask>192.0.2.10/32</ip-netmask></entry></address>
<address-group><entry name="same-name-group"><static><member>ethernet1/1</member></static></entry></address-group></shared>
<devices><entry name="localhost.localdomain"><network>
<interface><ethernet>
<entry name="ethernet1/1"><comment>ethernet1/1</comment><layer3><ip><entry name="10.0.0.1/24"/></ip><units><entry name="ethernet1/1.10"><tag>10</tag></entry></units></layer3></entry>
<entry name="ethernet1/2"><layer3/></entry>
</ethernet></interface>
<dhcp><interface><entry name="ethernet1/1.10"><server/></entry></interface></dhcp>
<virtual-router><entry name="default"><interface><member>ethernet1/1</member><member>ethernet1/1.10</member></interface>
<routing-table><ip><static-route><entry name="r1"><destination>203.0.113.0/24</destination><interface>ethernet1/1</interface></entry></static-route></ip></routing-table>
<protocol><ospf><area><entry name="0.0.0.0"><interface><entry name="ethernet1/1"><enable>yes</enable></entry></interface></entry></area></ospf></protocol>
</entry></virtual-router>
<ike><gateway><entry name="gw1"><local-address><interface>ethernet1/1</interface></local-address></entry></gateway></ike>
</network>
<vsys><entry name="vsys1"><import><network><interface><member>ethernet1/1</member></interface></network></import>
<zone><entry name="trust"><network><layer3><member>ethernet1/1</member><member>ethernet1/1.10</member></layer3></network></entry></zone>
<rulebase><security><rules><entry name="same-name-rule"><description>ethernet1/1</description><from><member>trust</member></from><to><member>trust</member></to><source><member>any</member></source><destination><member>ethernet1/1</member></destination><application><member>any</member></application><service><member>application-default</member></service><action>allow</action></entry></rules></security></rulebase>
</entry></vsys></entry></devices></config>"""

JS = """
([src, are, iface]) => {
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

  // 5. riferimenti tipizzati: oggetti/testo omonimi devono restare intatti
  const ifRules = { are: false, dyn: false, ifaces: true, ha: false, poe: false, keepMgmt: false, keepHA: false, keepAdmins: false };
  const val = (doc, xp) => PA500.evalXPath(doc, xp).map(n => n.value !== undefined ? n.value : n.textContent.trim());
  const r6 = run(iface, { map: { 'ethernet1/1': 'ethernet1/3' }, rules: ifRules });
  const r7 = run(iface, { map: { 'ethernet1/1': '__drop__' }, rules: ifRules });
  out.typedRename = {
    iface: val(r6.doc, "//network/interface/ethernet/entry/@name"),
    unit: val(r6.doc, "//network/interface/ethernet/entry/layer3/units/entry/@name"),
    dhcp: val(r6.doc, "//dhcp/interface/entry/@name"),
    vr: val(r6.doc, "//virtual-router/entry/interface/member"),
    ospf: val(r6.doc, "//protocol/ospf/area/entry/interface/entry/@name"),
    route: val(r6.doc, "//static-route/entry/interface"),
    ike: val(r6.doc, "//ike/gateway/entry/local-address/interface"),
    zone: val(r6.doc, "//zone/entry/network/layer3/member"),
    imp: val(r6.doc, "//vsys/entry/import/network/interface/member"),
    object: PA500.evalXPath(r6.doc, "//shared/address/entry[@name='ethernet1/1']").length,
    group: val(r6.doc, "//shared/address-group/entry/static/member"),
    policy: val(r6.doc, "//rulebase/security/rules/entry/destination/member"),
    description: val(r6.doc, "//rulebase/security/rules/entry/description"),
    comment: val(r6.doc, "//network/interface/ethernet/entry[@name='ethernet1/3']/comment"),
    checks: r6.report.filter(i => i.area === 'Interfacce' && i.level === 'check').length
  };
  out.typedDrop = {
    iface: val(r7.doc, "//network/interface/ethernet/entry/@name"),
    dhcp: val(r7.doc, "//dhcp/interface/entry/@name"),
    vr: val(r7.doc, "//virtual-router/entry/interface/member"),
    ospf: val(r7.doc, "//protocol/ospf/area/entry/interface/entry/@name"),
    route: val(r7.doc, "//static-route/entry/interface"),
    ike: val(r7.doc, "//ike/gateway/entry/local-address/interface"),
    zone: val(r7.doc, "//zone/entry/network/layer3/member"),
    imp: val(r7.doc, "//vsys/entry/import/network/interface/member"),
    object: PA500.evalXPath(r7.doc, "//shared/address/entry[@name='ethernet1/1']").length,
    group: val(r7.doc, "//shared/address-group/entry/static/member"),
    policy: val(r7.doc, "//rulebase/security/rules/entry/destination/member"),
    description: val(r7.doc, "//rulebase/security/rules/entry/description"),
    errors: r7.report.filter(i => i.area === 'Interfacce' && i.level === 'error').map(i => i.msg),
    checks: r7.report.filter(i => i.area === 'Interfacce' && i.level === 'check').length
  };
  return out;
}
"""

def check(cond, msg):
    if not cond:
        FAILS.append(msg)
        print('FAIL', msg)


FAILS = []
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page()
    page.set_content('<html><body></body></html>')
    page.add_script_tag(content=ENGINE)
    r = page.evaluate(JS, [SRC, ARE_SRC, IFACE_SRC])
    b.close()

# 1. regole personalizzate
c = r['custom']
check(c['hits'] == {'a': 1, 'b': 1, 'c': 1, 'd': 1, 'e': -1, 'f': 1, 'g': 0}, 'conteggio nodi delle regole: %s' % c['hits'])
check(c['tz'] == 'UTC', 'set: timezone = %r' % c['tz'])
check(c['ip'] == '172.16.10.10/32', 'replace: ip-netmask = %r' % c['ip'])
check(c['renamed'] == 1, 'rename: dns-setting-x non trovato')
check(c['nat'] == 0, 'remove: rulebase/nat ancora presente')
check(c['hostname'] == 1, 'la regola disattivata ha rimosso l\'hostname')
check(any(m.startswith('error') and 'XPath non valido' in m for m in c['msgs']), 'XPath non valido non segnalato')
check(any(m.startswith('check') and 'lan-out' in m for m in c['msgs']), 'regola report senza segnalazione')

# 2. errori di commit
e = r['errors']
check([x['parsed'] for x in e] == [False, True, True, True, True, True, False], 'righe riconosciute: %s' % [x['parsed'] for x in e])
check([x['n'] for x in e] == [0, 1, 1, 1, 1, 0, 0], 'nodi trovati per riga: %s' % [x['n'] for x in e])
ref = e[1]['actions']
check(ref and ref[0][0] == "Rimuovi il riferimento 'old-zone'" and ref[0][1].endswith("/from/member[.='old-zone']"), 'azione sul riferimento: %s' % ref[:1])
check(ref and ref[0][2] == "/config/devices/entry/vsys/entry/rulebase/security/rules/entry/from/member[.='old-zone']", 'XPath generico: %s' % ref[:1])
check([a[0] for a in e[3]['actions']] == ['Segnala soltanto'], 'constraints failed deve proporre solo la segnalazione: %s' % e[3]['actions'])
check('advance-routing' in (e[3]['hint'] or ''), 'manca il suggerimento su advance-routing')
check([a[0] for a in e[4]['actions']] == ['Segnala soltanto'], 'is missing deve proporre solo la segnalazione')
check(e[5]['actions'] == [], 'percorso inesistente con azioni proposte')

# 3. sorgente già con Advanced Routing, multi-vsys, Panorama
are = '\n'.join(r['are'])
check('virtual router residui' in are, 'virtual router residui non rimossi')
check('2 virtual system' in are, 'multi-vsys non segnalato')
check('Panorama' in are, 'gestione da Panorama non segnalata')
check('<virtual-router' not in r['areXml'] and 'ethernet1/3' in r['areXml'], 'XML convertito inatteso')

# 4. collisione e scambio di porte
check(any('Più interfacce finiscono su `ethernet1/1`' in m for m in r['collision']), 'collisione non segnalata: %s' % r['collision'])
sw = r['swap']
check(sw['errors'] == [], 'scambio di porte con errori: %s' % sw['errors'])
check(sw['zoneUntrust'] == 'ethernet1/2', 'zona untrust: %r' % sw['zoneUntrust'])
check(sw['unit'] == ['ethernet1/1.10', 'ethernet1/1.20'], 'sub-interfacce dopo lo scambio: %s' % sw['unit'])
check(sw['dhcp'] == ['ethernet1/1.10', 'ethernet1/9'], 'DHCP dopo lo scambio: %s' % sw['dhcp'])

# 5. rinomina/esclusione: solo riferimenti tipizzati, nessuna corruzione di oggetti omonimi
rn = r['typedRename']
check('ethernet1/3' in rn['iface'] and 'ethernet1/1' not in rn['iface'], 'rinomina definizione fisica: %s' % rn['iface'])
check(rn['unit'] == ['ethernet1/3.10'], 'rinomina subinterfaccia: %s' % rn['unit'])
check(rn['dhcp'] == ['ethernet1/3.10'], 'rinomina DHCP: %s' % rn['dhcp'])
check(rn['vr'] == ['ethernet1/3', 'ethernet1/3.10'], 'rinomina router: %s' % rn['vr'])
check(rn['ospf'] == ['ethernet1/3'], 'rinomina OSPF: %s' % rn['ospf'])
check(rn['route'] == ['ethernet1/3'], 'rinomina static route: %s' % rn['route'])
check(rn['ike'] == ['ethernet1/3'], 'rinomina IKE local-address: %s' % rn['ike'])
check(rn['zone'] == ['ethernet1/3', 'ethernet1/3.10'], 'rinomina zona: %s' % rn['zone'])
check(rn['imp'] == ['ethernet1/3'], 'rinomina import vsys: %s' % rn['imp'])
check(rn['object'] == 1, 'address object omonimo rinominato')
check(rn['group'] == ['ethernet1/1'], 'address-group omonimo modificato: %s' % rn['group'])
check(rn['policy'] == ['ethernet1/1'], 'membro policy omonimo modificato: %s' % rn['policy'])
check(rn['description'] == ['ethernet1/1'], 'descrizione omonima modificata: %s' % rn['description'])
check(rn['comment'] == ['ethernet1/1'], 'commento interfaccia modificato: %s' % rn['comment'])
check(rn['checks'] >= 4, 'match omonimi non segnalati in rinomina: %s' % rn['checks'])

dp = r['typedDrop']
check(dp['iface'] == ['ethernet1/2'], 'esclusione definizione fisica: %s' % dp['iface'])
check(dp['dhcp'] == [], 'riferimento DHCP alla porta esclusa rimasto: %s' % dp['dhcp'])
check(dp['vr'] == [], 'riferimenti router alla porta esclusa rimasti: %s' % dp['vr'])
check(dp['ospf'] == [], 'riferimento OSPF alla porta esclusa rimasto: %s' % dp['ospf'])
check(dp['route'] == [], 'riferimento static route alla porta esclusa rimasto: %s' % dp['route'])
check(dp['ike'] == [], 'riferimento IKE alla porta esclusa rimasto: %s' % dp['ike'])
check(dp['zone'] == [], 'riferimenti zona alla porta esclusa rimasti: %s' % dp['zone'])
check(dp['imp'] == [], 'riferimento import vsys alla porta esclusa rimasto: %s' % dp['imp'])
check(dp['object'] == 1, 'address object omonimo eliminato')
check(dp['group'] == ['ethernet1/1'], 'address-group omonimo alterato: %s' % dp['group'])
check(dp['policy'] == ['ethernet1/1'], 'membro policy omonimo alterato: %s' % dp['policy'])
check(dp['description'] == ['ethernet1/1'], 'descrizione omonima alterata: %s' % dp['description'])
check(dp['errors'] == [], 'errori residui su riferimenti tipizzati: %s' % dp['errors'])
check(dp['checks'] >= 3, 'match omonimi non segnalati in esclusione: %s' % dp['checks'])

print('test_engine2: %d verifiche fallite' % len(FAILS) if FAILS else 'test_engine2: tutte le verifiche passate')
sys.exit(1 if FAILS else 0)
