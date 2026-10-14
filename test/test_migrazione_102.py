"""Migrazione reale 10.2.16 (PA-460) -> 12.1 (PA-550), riprodotta con dati sintetici.

Il virtual router legacy ha la forma dell'export 10.2: admin distance scritte anche ai default,
protocolli spenti con le impostazioni di default, ECMP con il solo algoritmo, route con e senza
next hop, `route-table/unicast`, un nome con uno spazio, IKE gateway senza versione.
Il logical router atteso è quello che PAN-OS ha nel PA-550 dopo la migrazione.
"""
import pathlib
import sys
import xml.etree.ElementTree as ET

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
ENGINE = (HERE.parent / 'src' / 'engine.js').read_text()

SRC = """<config version="10.2.0" detail-version="10.2.16">
  <devices><entry name="localhost.localdomain">
    <deviceconfig><system><hostname>fw-102</hostname></system></deviceconfig>
    <network>
      <interface><ethernet>
        <entry name="ethernet1/1"><layer3><ip><entry name="203.0.113.2/29"/></ip></layer3></entry>
        <entry name="ethernet1/2"><layer3><ip><entry name="10.0.1.253/24"/></ip></layer3></entry>
      </ethernet></interface>
      <ike><gateway>
        <entry name="vpn-a"><protocol><ikev1><ike-crypto-profile>default</ike-crypto-profile></ikev1></protocol></entry>
        <entry name="vpn-b"><protocol><version>ikev2-preferred</version></protocol></entry>
      </gateway></ike>
      <virtual-router>
        <entry name="vr1">
          <interface><member>ethernet1/1</member><member>ethernet1/2</member></interface>
          <routing-table><ip><static-route>
            <entry name="default"><nexthop><ip-address>203.0.113.1</ip-address></nexthop><interface>ethernet1/1</interface><metric>1</metric><destination>0.0.0.0/0</destination><route-table><unicast/></route-table></entry>
            <entry name="lan"><nexthop><ip-address>10.0.1.254</ip-address></nexthop><interface>ethernet1/2</interface><metric>1</metric><destination>10.10.0.0/16</destination></entry>
            <entry name="solo interfaccia"><interface>ethernet1/2</interface><metric>1</metric><destination>10.20.0.0/24</destination><route-table><unicast/></route-table></entry>
            <entry name="solo_interfaccia"><interface>ethernet1/2</interface><metric>1</metric><destination>10.21.0.0/24</destination></entry>
            <entry name="net_198.51.100.8_29"><nexthop><ip-address>10.0.1.254</ip-address></nexthop><interface>ethernet1/2</interface><metric>1</metric><destination>198.51.100.8/29</destination></entry>
          </static-route></ip></routing-table>
          <protocol>
            <rip><enable>no</enable><reject-default-route>yes</reject-default-route><allow-redist-default-route>no</allow-redist-default-route>
              <timers><interval-seconds>1</interval-seconds><update-intervals>30</update-intervals><expire-intervals>180</expire-intervals><delete-intervals>120</delete-intervals></timers></rip>
            <ospf><enable>no</enable><reject-default-route>yes</reject-default-route><allow-redist-default-route>no</allow-redist-default-route><rfc1583>no</rfc1583></ospf>
            <bgp><enable>no</enable><reject-default-route>yes</reject-default-route>
              <routing-options><as-format>2-byte</as-format><med><deterministic-med-comparison>yes</deterministic-med-comparison><always-compare-med>no</always-compare-med></med>
                <graceful-restart><enable>yes</enable><stale-route-time>120</stale-route-time><local-restart-time>120</local-restart-time><max-peer-restart-time>120</max-peer-restart-time></graceful-restart></routing-options></bgp>
            <ospfv3><enable>no</enable></ospfv3>
          </protocol>
          <admin-dists><static>10</static><ospf-int>30</ospf-int><ospf-ext>110</ospf-ext><ibgp>200</ibgp><ebgp>20</ebgp><rip>120</rip></admin-dists>
          <ecmp><algorithm><ip-modulo/></algorithm></ecmp>
        </entry>
      </virtual-router>
    </network>
    <vsys><entry name="vsys1"><zone><entry name="lan"><network><layer3><member>ethernet1/2</member></layer3></network></entry></zone></entry></vsys>
  </entry></devices>
</config>"""

JS = """(src) => {
  const r = PA500.run(PA500.parse(src), { model: 'PA-550', map: {}, customRules: [],
    rules: { are: true, dyn: true, ifaces: true, ha: true, poe: true } }, null);
  return { xml: PA500.serialize(r.doc), stats: r.stats, report: r.report.map(i => i.level + ' [' + i.area + '] ' + i.msg) };
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
    r = page.evaluate(JS, SRC)
    b.close()

d = ET.fromstring(r['xml'].encode())
dev = d.find('devices/entry')
vrf = dev.find("network/logical-router/entry[@name='vr1']/vrf/entry[@name='default']")
check(vrf is not None, 'logical router vr1 non creato')
check(dev.find('network/virtual-router') is None, 'virtual-router residuo')
check(r['stats']['error'] == 0 and r['stats']['manual'] == 0, 'errori o attività manuali: %s' % [i for i in r['report'] if i.startswith(('error', 'manual'))])

# protocolli spenti con i soli default: non convertiti, come nel PA-550
for t in ('bgp', 'ospf', 'ospfv3', 'rip'):
    check(vrf.find(t) is None, 'protocollo spento convertito: ' + t)

# admin distance: OSPF interna 30 (default legacy, OSPF spento) non portata
ad = {c.tag: c.text for c in vrf.find('admin-dists')}
check('ospf-intra' not in ad and 'ospf-inter' not in ad, 'distanza OSPF interna 30 portata con OSPF spento: %s' % ad)
check(ad.get('static') == '10' and ad.get('bgp-internal') == '200' and ad.get('bgp-external') == '20', 'admin distance convertite male: %s' % ad)

# static route
routes = {e.get('name'): e for e in vrf.findall('routing-table/ip/static-route/entry')}
check(sorted(routes) == sorted(['default', 'lan', 'solo_interfaccia', 'solo_interfaccia_2', 'net_198.51.100.8_29']), 'nomi delle route: %s' % sorted(routes))
check(all(e.find('route-table') is None for e in routes.values()), 'route-table rimasto nelle route')
check(routes['solo_interfaccia_2'].find('nexthop') is None and routes['solo_interfaccia_2'].findtext('destination') == '10.20.0.0/24', 'route solo su interfaccia convertita male')
check(any('rinominata `solo_interfaccia_2`' in i for i in r['report']), 'rinomina della route non segnalata')

# IKE: versione esplicita solo dove mancava
check(dev.findtext("network/ike/gateway/entry[@name='vpn-a']/protocol/version") == 'ikev1', 'IKE vpn-a senza ikev1')
check(dev.findtext("network/ike/gateway/entry[@name='vpn-b']/protocol/version") == 'ikev2-preferred', 'IKE vpn-b modificato')

# la versione dichiarata resta quella della sorgente: PAN-OS applica le sue migrazioni al caricamento
check(d.get('version') == '10.2.0' and d.get('detail-version') == '10.2.16', 'versione della config modificata')

print('test_migrazione_102: %d verifiche fallite' % len(FAILS) if FAILS else 'test_migrazione_102: tutte le verifiche passate')
sys.exit(1 if FAILS else 0)
