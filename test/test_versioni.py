"""Adeguamento alla 12.1: cambi tra le release della sorgente e la 12.1 (docs/differenze-12x.md)."""
import pathlib
import sys
import xml.etree.ElementTree as ET

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
ENGINE = (HERE.parent / 'src' / 'engine.js').read_text()


def config(version):
    return f"""<config version="{version}" detail-version="{version}">
  <shared>
    <ssl-tls-service-profile>
      <entry name="tls-max"><protocol-settings><min-version>tls1-1</min-version><max-version>max</max-version><enc-algo-chacha20-poly1305>yes</enc-algo-chacha20-poly1305></protocol-settings></entry>
      <entry name="tls-12"><protocol-settings><min-version>tls1-2</min-version><max-version>tls1-2</max-version></protocol-settings></entry>
    </ssl-tls-service-profile>
    <authentication-sequence><entry name="seq"><authentication-profiles><member>ldap</member></authentication-profiles></entry></authentication-sequence>
  </shared>
  <devices><entry name="localhost.localdomain">
    <deviceconfig><system><hostname>fw</hostname></system><setting><advance-routing>yes</advance-routing></setting></deviceconfig>
    <network>
      <ike><gateway>
        <entry name="gw-default"><protocol><ikev1><ike-crypto-profile>default</ike-crypto-profile></ikev1></protocol></entry>
        <entry name="gw-v2"><protocol><version>ikev2</version><ikev2><ike-crypto-profile>default</ike-crypto-profile></ikev2></protocol></entry>
        <entry name="gw-vuoto"/>
      </gateway></ike>
      <logical-router><entry name="lr"><vrf><entry name="default"/></vrf></entry></logical-router>
    </network>
    <vsys><entry name="vsys1">
      <profiles><decryption>
        <entry name="dec-fwd"><ssl-forward-proxy><block-expired-certificate>yes</block-expired-certificate></ssl-forward-proxy><ssl-protocol-settings><max-version>max</max-version><enc-algo-chacha20-poly1305>yes</enc-algo-chacha20-poly1305></ssl-protocol-settings></entry>
        <entry name="dec-12"><ssl-forward-proxy/><ssl-protocol-settings><max-version>tls1-2</max-version></ssl-protocol-settings></entry>
      </decryption></profiles>
    </entry></vsys>
  </entry></devices>
</config>"""


JS = """(src) => {
  const r = PA500.run(PA500.parse(src), { model: 'PA-550', map: {}, customRules: [],
    rules: { are: true, dyn: true, ifaces: true, ha: true, poe: true } }, null);
  return { xml: PA500.serialize(r.doc), items: r.report.filter(i => i.area === 'Versione').map(i => i.level + ': ' + i.msg) };
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
    res = {v: page.evaluate(JS, config(v)) for v in ('10.2.9', '11.1.4', '11.2.5', '12.1.7')}
    unknown = page.evaluate(JS, config('10.2.9').replace(' version="10.2.9" detail-version="10.2.9"', ''))
    b.close()


def doc(v):
    return ET.fromstring(res[v]['xml'].encode())


def ike(d, name):
    return d.findtext(f".//ike/gateway/entry[@name='{name}']/protocol/version")


def tls(d, name, tag):
    return d.find(f".//ssl-tls-service-profile/entry[@name='{name}']/protocol-settings/{tag}")


# 10.2: tutti gli adeguamenti
d = doc('10.2.9')
check(ike(d, 'gw-default') == 'ikev1' and ike(d, 'gw-vuoto') == 'ikev1', '10.2: versione IKE esplicita non impostata')
check(ike(d, 'gw-v2') == 'ikev2', '10.2: versione IKE esplicita modificata')
check(tls(d, 'tls-max', 'max-version').text == 'tls1-2', '10.2: max-version Max non portato a tls1-2')
check(tls(d, 'tls-12', 'max-version').text == 'tls1-2', '10.2: profilo tls1-2 modificato')
check(tls(d, 'tls-max', 'enc-algo-chacha20-poly1305') is None and tls(d, 'tls-max', 'enc-algo-aes-chacha20-poly1305') is not None, '10.2: chacha20 non rinominato nel profilo SSL/TLS')
check(d.find(".//decryption/entry[@name='dec-fwd']/ssl-protocol-settings/enc-algo-chacha20-poly1305") is not None, 'il chacha20 dei decryption profile non va toccato')
items = '\n'.join(res['10.2.9']['items'])
check('`dec-fwd`' in items and '`dec-12`' not in items, '10.2: avviso TLS 1.3 sui decryption profile sbagliato')
check('Authentication sequence' in items, '10.2: avviso sulle authentication sequence mancante')

# 11.1: TLS già migrato, IKE ancora da rendere esplicito
d = doc('11.1.4')
check(ike(d, 'gw-default') == 'ikev1', '11.1: versione IKE esplicita non impostata')
check(tls(d, 'tls-max', 'max-version').text == 'max', '11.1: max-version modificato')
check('Authentication sequence' not in '\n'.join(res['11.1.4']['items']), '11.1: avviso authentication sequence fuori luogo')

# 11.2: il default IKE è già IKEv2, non si tocca
d = doc('11.2.5')
check(ike(d, 'gw-default') is None, '11.2: versione IKE aggiunta a torto')
check(any('TLS 1.3' in i for i in res['11.2.5']['items']), '11.2: avviso TLS 1.3 mancante')

# 12.1: nessun cambio di versione, solo la rinomina di un nome non valido
d = doc('12.1.7')
check(ike(d, 'gw-default') is None and tls(d, 'tls-max', 'max-version').text == 'max', '12.1: config modificata')
check(any(i.startswith('info') and 'già PAN-OS 12.1.7' in i for i in res['12.1.7']['items']), '12.1: nota di versione mancante')

# versione assente: nessuna modifica legata alla versione, solo avvisi
u = ET.fromstring(unknown['xml'].encode())
check(ike(u, 'gw-default') is None, 'versione assente: IKE modificato')
check(any('non indica la versione' in i for i in unknown['items']), 'versione assente: avviso mancante')

print('test_versioni: %d verifiche fallite' % len(FAILS) if FAILS else 'test_versioni: tutte le verifiche passate')
sys.exit(1 if FAILS else 0)
