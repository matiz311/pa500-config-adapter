"""Migrazione reale 10.1 -> 12.1 su PA-540, riprodotta con dati sintetici.

Dal confronto tra l'uscita dello strumento e la config estratta dal PA-540 dopo il commit:
- i profili URL Filtering della 10.1 hanno `mlav-engine-urlbased-enabled` (Inline ML), che dalla
  10.2 non esiste: PAN-OS lo sostituisce con `local-inline-cat`/`cloud-inline-cat`;
- due regole deny usavano le EDL predefinite `panw-*`, che su un PA-500 appena inizializzato non
  esistono finché non si installano i contenuti: il commit fallisce e le regole erano state tolte.

Dal confronto tra la config del secondo nodo HA preparata a mano e quella generata dallo strumento:
- la config generata, caricata e salvata come candidate, porta i marcatori delle modifiche non
  committate (`admin`, `dirtyId`, `time`, nodi `deleted`);
- il caricamento completo sostituisce `mgt-config` e toglie l'account di sistema `__telemetryuser`
  e la complessità minima delle password che il PA-540 aveva.
"""
import pathlib
import sys
import xml.etree.ElementTree as ET

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
ENGINE = (HERE.parent / 'src' / 'engine.js').read_text()

SRC = """<config version="10.1.0" urldb="paloaltonetworks" detail-version="10.1.14">
  <mgt-config><users><entry name="admin"><phash>$5$sintetico$hash</phash><permissions><role-based><superuser>yes</superuser></role-based></permissions></entry></users></mgt-config>
  <devices><entry name="localhost.localdomain">
    <deviceconfig><system><hostname>fw-101</hostname>
      <dns-setting><dns-proxy-object admin="admin" dirtyId="7" time="2026/01/01 10:00:00">mgmt</dns-proxy-object><deleted admin="admin" dirtyId="7" time="2026/01/01 10:00:00"/><deleted admin="admin" dirtyId="7" time="2026/01/01 10:00:00"/></dns-setting>
    </system></deviceconfig>
    <network>
      <interface><ethernet>
        <entry name="ethernet1/1"><layer3><ip><entry name="203.0.113.2/29"/></ip></layer3></entry>
        <entry name="ethernet1/2"><layer3><ip><entry name="10.0.1.254/24"/></ip></layer3></entry>
      </ethernet></interface>
      <virtual-router>
        <entry name="default">
          <interface><member>ethernet1/1</member><member>ethernet1/2</member></interface>
          <routing-table><ip><static-route>
            <entry name="default"><nexthop><ip-address>203.0.113.1</ip-address></nexthop><interface>ethernet1/1</interface><metric>10</metric><destination>0.0.0.0/0</destination></entry>
          </static-route></ip></routing-table>
          <protocol><bgp><enable>no</enable></bgp><ospf><enable>no</enable></ospf></protocol>
          <admin-dists><static>10</static><ospf-int>30</ospf-int><ospf-ext>110</ospf-ext><ibgp>200</ibgp><ebgp>20</ebgp><rip>120</rip></admin-dists>
          <ecmp><algorithm><ip-modulo/></algorithm></ecmp>
        </entry>
      </virtual-router>
    </network>
    <vsys><entry name="vsys1">
      <zone>
        <entry name="untrust"><network><layer3><member>ethernet1/1</member></layer3></network></entry>
        <entry name="trust"><network><layer3><member>ethernet1/2</member></layer3></network></entry>
      </zone>
      <external-list>
        <entry name="edl-custom"><type><ip><url>https://edl.example.com/ip.txt</url><recurring><hourly/></recurring></ip></type></entry>
      </external-list>
      <profiles><url-filtering>
        <entry name="uf-allow">
          <mlav-engine-urlbased-enabled>
            <entry name="Javascript Exploit Detection"><mlav-policy-action>allow</mlav-policy-action></entry>
            <entry name="Phishing Detection"><mlav-policy-action>allow</mlav-policy-action></entry>
          </mlav-engine-urlbased-enabled>
          <block><member>malware</member></block>
        </entry>
        <entry name="uf-alert">
          <mlav-engine-urlbased-enabled>
            <entry name="Phishing Detection"><mlav-policy-action>alert</mlav-policy-action></entry>
          </mlav-engine-urlbased-enabled>
          <mlav-category-exception><member>example.org</member></mlav-category-exception>
        </entry>
        <entry name="uf-plain"><block><member>malware</member></block></entry>
      </url-filtering></profiles>
      <rulebase><security><rules>
        <entry name="deny-in"><from><member>untrust</member></from><to><member>any</member></to>
          <source><member>edl-custom</member><member>panw-highrisk-ip-list</member><member>panw-torexit-ip-list</member></source>
          <destination><member>any</member></destination><application><member>any</member></application><service><member>any</member></service><action>deny</action></entry>
        <entry name="deny-out"><from><member>trust</member></from><to><member>untrust</member></to>
          <source><member>any</member></source>
          <destination><member>edl-custom</member><member>panw-known-ip-list</member></destination><application><member>any</member></application><service><member>any</member></service><action>deny</action></entry>
        <entry name="web"><from><member>trust</member></from><to><member>untrust</member></to>
          <source><member>any</member></source><destination><member>any</member></destination><application><member>web-browsing</member></application><service><member>application-default</member></service>
          <profile-setting><profiles><url-filtering><member>uf-alert</member></url-filtering></profiles></profile-setting><action>allow</action></entry>
      </rules></security></rulebase>
    </entry></vsys>
  </entry></devices>
</config>"""

# config del PA-540 appena inizializzato: account di sistema e complessità delle password
TARGET = """<config version="12.1.0" detail-version="12.1.5">
  <mgt-config>
    <users>
      <entry name="admin"><phash>$5$sintetico$pa540</phash><permissions><role-based><superuser>yes</superuser></role-based></permissions></entry>
      <entry name="__telemetryuser"><phash>$5$sintetico$tel</phash><permissions><role-based><deviceadmin><member>localhost.localdomain</member></deviceadmin></role-based></permissions></entry>
    </users>
    <password-complexity><enabled>yes</enabled><minimum-length>8</minimum-length></password-complexity>
  </mgt-config>
  <devices><entry name="localhost.localdomain"><deviceconfig><system><hostname>pa540</hostname><ip-address>10.0.254.10</ip-address></system></deviceconfig></entry></devices>
</config>"""

COMMIT_ERROR = 'vsys -> vsys1 -> rulebase -> security -> rules -> deny-in -> source \'panw-highrisk-ip-list\' is not a valid reference'

JS = """([src, err, tgt, admins]) => {
  const r = PA500.run(PA500.parse(src), { model: 'PA-540', map: {}, customRules: [],
    rules: { are: true, dyn: true, ifaces: true, ha: true, poe: true, keepAdmins: !!admins } }, tgt ? PA500.parse(tgt) : null);
  const res = PA500.resolveError(PA500.parse(src), PA500.parseCommitErrors(err)[0]);
  return { xml: PA500.serialize(r.doc), stats: r.stats, hint: res.hint || '', actions: res.actions.map(a => a.label),
    report: r.report.map(i => i.level + ' [' + i.area + '] ' + i.msg), xpaths: r.report.filter(i => i.msg.includes('EDL predefinite')).map(i => i.xpath || '') };
}"""

FAILS = []


def check(cond, msg):
    if not cond:
        FAILS.append(msg)
        print('FAIL', msg)


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page()
    page.set_content('<html></html>')
    page.add_script_tag(content=ENGINE)
    r = page.evaluate(JS, [SRC, COMMIT_ERROR, None, False])
    rt = page.evaluate(JS, [SRC, COMMIT_ERROR, TARGET, False])
    ra = page.evaluate(JS, [SRC, COMMIT_ERROR, TARGET, True])
    b.close()

d = ET.fromstring(r['xml'].encode())
vsys = d.find('devices/entry/vsys/entry')
check(r['stats']['error'] == 0 and r['stats']['manual'] == 0, 'errori o attività manuali: %s' % [i for i in r['report'] if i.startswith(('error', 'manual'))])
check(d.find('devices/entry/network/logical-router/entry/vrf/entry') is not None, 'logical router non creato')

# URL Filtering: Inline ML della 10.1 tolto da tutti i profili, il resto invariato
uf = {e.get('name'): e for e in vsys.findall('profiles/url-filtering/entry')}
check(all(e.find('mlav-engine-urlbased-enabled') is None for e in uf.values()), 'mlav-engine-urlbased-enabled rimasto')
check(uf['uf-alert'].find('mlav-category-exception/member') is not None, 'mlav-category-exception tolto: esiste anche nella 12.1')
check(uf['uf-allow'].findtext('block/member') == 'malware', 'profilo URL modificato oltre l\'Inline ML')
check(all(e.find('local-inline-cat') is None and e.find('cloud-inline-cat') is None for e in uf.values()), 'Inline Categorization aggiunta: i default li mette PAN-OS')
done = [i for i in r['report'] if i.startswith('done [Versione]') and 'mlav-engine-urlbased-enabled' in i]
check(len(done) == 1 and '`uf-allow`' in done[0] and '`uf-alert`' in done[0] and '`uf-plain`' not in done[0], 'rimozione Inline ML non segnalata o profili sbagliati: %s' % done)
active = [i for i in r['report'] if i.startswith('check [Versione]') and 'Inline ML era attiva' in i]
check(len(active) == 1 and '`uf-alert`' in active[0] and '`uf-allow`' not in active[0], 'avviso Inline ML attiva sbagliato: %s' % active)

# EDL predefinite: regole intatte e segnalate
rules = {e.get('name'): e for e in vsys.findall('rulebase/security/rules/entry')}
check(sorted(rules) == ['deny-in', 'deny-out', 'web'], 'regole modificate: %s' % sorted(rules))
check([m.text for m in rules['deny-in'].findall('source/member')] == ['edl-custom', 'panw-highrisk-ip-list', 'panw-torexit-ip-list'], 'riferimenti EDL tolti dalla regola')
edl = [i for i in r['report'] if 'EDL predefinite' in i]
check(len(edl) == 1 and edl[0].startswith('check [Piattaforma]'), 'avviso EDL predefinite mancante: %s' % edl)
if edl:
    check(all(s in edl[0] for s in ('`panw-highrisk-ip-list`', '`panw-known-ip-list`', '`panw-torexit-ip-list`', 'security `deny-in`', 'security `deny-out`')), 'avviso EDL incompleto: %s' % edl[0])
    check('`edl-custom`' not in edl[0] and '`web`' not in edl[0], 'avviso EDL su oggetti non predefiniti: %s' % edl[0])
    check("deny-in" in r['xpaths'][0] and "deny-out" in r['xpaths'][0], 'XPath delle regole mancante: %s' % r['xpaths'])

# errore di commit su una EDL predefinita: suggerimento sui contenuti
check('Threat Prevention' in r['hint'] and 'Antivirus' in r['hint'], 'suggerimento per l\'errore di commit mancante: %r' % r['hint'])
check(any('panw-highrisk-ip-list' in a for a in r['actions']), 'azione di rimozione del solo riferimento mancante: %s' % r['actions'])

# candidate con modifiche non committate: marcatori tolti, contenuto invariato
check('dirtyId' not in r['xml'] and '<deleted' not in r['xml'], 'marcatori della candidate rimasti')
check(d.findtext('devices/entry/deviceconfig/system/dns-setting/dns-proxy-object') == 'mgmt', 'contenuto della candidate modificato')
mk = [i for i in r['report'] if 'candidate con modifiche' in i]
check(len(mk) == 1 and '3 nodi marcati' in mk[0] and '2 nodi `deleted`' in mk[0] and '`admin`' in mk[0], 'avviso sui marcatori della candidate sbagliato: %s' % mk)


# account di sistema e complessità delle password
def users(res):
    return [e.get('name') for e in ET.fromstring(res['xml'].encode()).findall('mgt-config/users/entry')]


check(users(r) == ['admin'] and any(i.startswith('check [Management]') and '__telemetryuser' in i for i in r['report']), 'senza config del PA-500: avviso su __telemetryuser mancante')
t = ET.fromstring(rt['xml'].encode())
check(users(rt) == ['admin', '__telemetryuser'], 'account di sistema non mantenuto: %s' % users(rt))
check(t.findtext("mgt-config/users/entry[@name='admin']/phash") == '$5$sintetico$hash', 'amministratori della sorgente sostituiti')
check(t.findtext('mgt-config/password-complexity/minimum-length') == '8', 'complessità delle password del PA-540 persa')
check(not any('__telemetryuser' in i and i.startswith('check') for i in rt['report']), 'avviso su __telemetryuser con la config del PA-500 caricata')
ta = ET.fromstring(ra['xml'].encode())
check(users(ra) == ['admin', '__telemetryuser'] and ta.findtext("mgt-config/users/entry[@name='admin']/phash") == '$5$sintetico$pa540', 'con «Mantieni gli amministratori» mgt-config non è quello del PA-540: %s' % users(ra))

print('test_migrazione_101: %d verifiche fallite' % len(FAILS) if FAILS else 'test_migrazione_101: tutte le verifiche passate')
sys.exit(1 if FAILS else 0)
