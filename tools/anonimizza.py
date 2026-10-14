#!/usr/bin/env python3
"""Anonimizza una o più config PAN-OS per usarle come schema di migrazione nei test.

Tiene la struttura (elementi, interfacce, numeri, valori degli enum) e sostituisce tutto ciò
che identifica il cliente, in modo coerente tra i file: lo stesso oggetto, la stessa rete o lo
stesso testo diventano lo stesso valore anonimo in tutte le config passate insieme.

- Sezioni: si tengono solo quelle utili alla migrazione (SEZIONI); il resto si elimina.
- Nomi delle entry: sostituiti con un nome per tipo (zona_03, ind_0123, rotta_07); uno spazio
  nel nome originale resta uno spazio, così si vede la stessa rinomina della config reale.
- Indirizzi IPv4: il primo e il secondo ottetto sono rimappati, il terzo e il quarto restano,
  così subnet, maschere e relazioni tra reti non cambiano. Privati restano privati (10/8,
  172.16/12, 192.168/16); gli altri finiscono in 100.64.0.0/10 (RFC 6598). IPv6 in 2001:db8::/32.
- Segreti, testi liberi, FQDN, URL, MAC: sostituiti con segnaposto.
- Controllo finale: nessuna parola di almeno 4 caratteri dei file originali (esclusi vocabolario,
  nomi degli elementi XML e interfacce) e nessun indirizzo pubblico originale compare nell'output.
  Se il controllo fallisce, i file non vengono scritti.

Uso:
    python3 tools/anonimizza.py prima.xml dopo.xml --out test/schema --nomi prima-10.2.xml dopo-12.1.xml
"""
import argparse
import ipaddress
import pathlib
import re
import sys
import xml.etree.ElementTree as ET

HERE = pathlib.Path(__file__).parent

SEZIONI = [
    'devices/entry/network/interface',
    'devices/entry/network/virtual-router',
    'devices/entry/network/logical-router',
    'devices/entry/network/routing-profile',
    'devices/entry/network/profiles/interface-management-profile',
    'devices/entry/network/profiles/bfd-profile',
    'devices/entry/network/ike',
    'devices/entry/network/tunnel/ipsec',
    'devices/entry/network/dhcp',
    'devices/entry/network/dns-proxy',
    'devices/entry/network/virtual-wire',
    'devices/entry/network/qos',
    'devices/entry/network/lldp',
    'devices/entry/deviceconfig/setting/advance-routing',
    'devices/entry/deviceconfig/setting/config',
    'devices/entry/deviceconfig/setting/session',
    'devices/entry/deviceconfig/high-availability',
    'devices/entry/vsys/entry/zone',
    'devices/entry/vsys/entry/import',
    'devices/entry/vsys/entry/rulebase',
    'devices/entry/vsys/entry/address',
    'devices/entry/vsys/entry/address-group',
    'devices/entry/vsys/entry/service',
    'devices/entry/vsys/entry/service-group',
    'devices/entry/vsys/entry/tag',
    'devices/entry/vsys/entry/profiles/decryption',
    'devices/entry/vsys/entry/profile-group',
    'devices/entry/vsys/entry/global-protect',
    'shared/ssl-tls-service-profile',
    'shared/profiles/decryption',
    'shared/authentication-sequence',
    'shared/address',
    'shared/service',
]

NOMI_FISSI = {'default', 'vsys1', 'shared', 'localhost.localdomain', 'vr1', 'any', 'None'}
INTERFACCIA = re.compile(r'^(ethernet\d+/\d+|ae\d+|loopback|tunnel|vlan)(\.\d+)?$|^(ha[1-4]-[ab]|management|hsci)$')
NUMERO = re.compile(r'^-?\d+(\.\d+)?$')
IPV4 = re.compile(r'(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])')
IPV6 = re.compile(r'(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f:]*(?:/\d{1,3})?')
MAC = re.compile(r'\b[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}\b')
SEGRETO = re.compile(r'^(-AQ==|\$[156]\$)')
MASCHERA = {0, 128, 192, 224, 240, 248, 252, 254, 255}
RESOLVER = {'8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1'}
TESTO_LIBERO = {'description', 'comment', 'display-name', 'disable-override', 'message', 'content'}
PREFISSI = {
    'address': 'ind', 'address-group': 'gruppo', 'service': 'serv', 'service-group': 'gruppo-serv', 'zone': 'zona',
    'rules': 'regola', 'static-route': 'rotta', 'gateway': 'gw', 'ipsec': 'tun', 'tag': 'etichetta',
    'ssl-tls-service-profile': 'tls', 'decryption': 'dec', 'profile-group': 'profili', 'authentication-sequence': 'seq',
    'logical-router': 'lr', 'virtual-router': 'vr', 'link-group': 'link', 'destination-ip-group': 'dest',
    'proxy-id': 'proxy', 'crypto-profiles': 'crypto', 'ike-crypto-profiles': 'ike', 'ipsec-crypto-profiles': 'ipsec',
    'global-protect-portal': 'portale', 'global-protect-gateway': 'gpgw', 'interface-management-profile': 'mgmt',
}


def vocabolario():
    v = set()
    for line in (HERE / 'vocabolario.txt').read_text().splitlines():
        if line and not line.startswith('#'):
            v.add(line.strip())
    return v


class Anonimizzatore:
    def __init__(self):
        self.vocab = vocabolario()
        self.nomi = {}          # chiave normalizzata -> nome anonimo
        self.contatori = {}
        self.blocchi = {}       # (a, b) -> (A, B)
        self.testi = {}
        self.v6 = {}
        self.mac = {}
        self.tag_xml = set()

    # ---------- indirizzi
    def blocco(self, a, b):
        if (a, b) in self.blocchi:
            return self.blocchi[(a, b)]
        ip = ipaddress.ip_address(f'{a}.{b}.0.1')
        usati = set(self.blocchi.values())
        if a == 10:
            cand = [(10, x) for x in range(1, 256)]
        elif a == 172 and 16 <= b <= 31:
            cand = [(172, x) for x in range(16, 32)]
        elif a == 192 and b == 168:
            cand = [(192, 168)]
        elif ip.is_private:
            cand = [(10, x) for x in range(200, 256)]
        else:
            cand = [(100, x) for x in range(64, 128)]
        for c in cand:
            if c not in usati or c == (192, 168):
                self.blocchi[(a, b)] = c
                return c
        raise SystemExit(f'Spazio di indirizzi esaurito per {a}.{b}.0.0/16')

    def ip4(self, m):
        o = [int(x) for x in m.groups()]
        if any(x > 255 for x in o):
            return m.group(0)
        s = m.group(0)
        if s in RESOLVER or s == '0.0.0.0' or o[0] in (0, 127, 255) or (o[0] == 255 or all(x in MASCHERA for x in o) and o[0] == 255):
            return s
        if o[0] >= 224:
            return s
        A, B = self.blocco(o[0], o[1])
        return f'{A}.{B}.{o[2]}.{o[3]}'

    def ip6(self, m):
        s = m.group(0)
        pre = ''
        if '/' in s:
            s, pre = s.split('/', 1)
            pre = '/' + pre
        try:
            ipaddress.ip_address(s)
        except ValueError:
            return m.group(0)
        if s not in self.v6:
            self.v6[s] = f'2001:db8::{len(self.v6) + 1:x}'
        return self.v6[s] + pre

    def indirizzi(self, s):
        s = IPV4.sub(self.ip4, s)
        s = IPV6.sub(self.ip6, s)
        def mac(m):
            k = m.group(0).lower()
            if k not in self.mac:
                n = len(self.mac) + 1
                self.mac[k] = f'00:00:5e:00:53:{n:02x}'
            return self.mac[k]
        return MAC.sub(mac, s)

    # ---------- nomi
    @staticmethod
    def chiave(nome):
        return re.sub(r'[ _]+', '_', nome)

    def nome_con_ip(self, nome):
        m = re.fullmatch(r'(?i)((?:net|host|h|n|ip|rete|subnet|range)[_\- ]?)?(\d{1,3}(?:\.\d{1,3}){3})([_\-/]\d{1,2})?', nome)
        if not m:
            return None
        return (m.group(1) or '') + self.indirizzi(m.group(2)) + (m.group(3) or '')

    def registra(self, nome, contenitore):
        if nome in NOMI_FISSI or INTERFACCIA.match(nome) or self.nome_con_ip(nome) is not None:
            return
        k = self.chiave(nome)
        if k in self.nomi:
            return
        pref = PREFISSI.get(contenitore, 'nome')
        n = self.contatori.get(pref, 0) + 1
        self.contatori[pref] = n
        self.nomi[k] = f'{pref}_{n:02d}'

    def nome(self, nome):
        if nome in NOMI_FISSI or INTERFACCIA.match(nome):
            return nome
        ip = self.nome_con_ip(nome)
        if ip is not None:
            return ip
        k = self.chiave(nome)
        if k in self.nomi:
            nuovo = self.nomi[k]
            return nuovo.replace('_', ' ') if ' ' in nome else nuovo
        return None

    # ---------- testi
    def testo(self, s, tag):
        v = s.strip()
        if not v:
            return s
        if tag in TESTO_LIBERO:
            return 'testo anonimizzato'
        if SEGRETO.match(v):
            return v[:5] + 'ANONIMIZZATO'
        n = self.nome(v)
        if n is not None:
            return n
        if v in self.vocab or NUMERO.match(v):
            return v
        conv = self.indirizzi(v)
        if conv != v or IPV4.fullmatch(v):
            # testo fatto di soli indirizzi, maschere, intervalli e separatori
            if re.fullmatch(r'[\d.:/\-a-fA-F, ]+', conv):
                return conv
        if v not in self.testi:
            n = len(self.testi) + 1
            if re.fullmatch(r'(?i)https?://\S+', v):
                self.testi[v] = f'https://example.net/elenco-{n}'
            elif re.fullmatch(r'[^@\s]+@[^@\s]+\.[a-z]{2,}', v, re.I):
                self.testi[v] = f'utente-{n}@example.net'
            elif re.fullmatch(r'(?i)(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+', v) and re.search(r'[a-z]', v, re.I):
                self.testi[v] = f'host-{n}.example.net'
            else:
                self.testi[v] = f'{tag}-{n}'
        return self.testi[v]

    # ---------- documento
    def riduci(self, root):
        nuovo = ET.Element(root.tag, {k: v for k, v in root.attrib.items() if k in ('version', 'detail-version', 'urldb')})
        for sez in SEZIONI:
            src = root.find(sez)
            if src is None:
                continue
            parti = sez.split('/')
            cur_src, cur_dst = root, nuovo
            for p in parti[:-1]:
                cur_src = cur_src.find(p)
                trovato = None
                for c in cur_dst:
                    if c.tag == p and c.get('name') == cur_src.get('name'):
                        trovato = c
                        break
                if trovato is None:
                    trovato = ET.SubElement(cur_dst, p, {'name': cur_src.get('name')} if cur_src.get('name') else {})
                cur_dst = trovato
            cur_dst.append(src)
        return nuovo

    def raccogli(self, root):
        for parent in root.iter():
            for c in parent:
                self.tag_xml.add(c.tag)
                if c.get('name') is not None:
                    self.registra(c.get('name'), parent.tag)

    def applica(self, root):
        for el in root.iter():
            if el.get('name') is not None:
                el.set('name', self.nome(el.get('name')) or self.testo(el.get('name'), 'nome'))
            for k in list(el.attrib):
                if k not in ('name', 'version', 'detail-version', 'urldb'):
                    el.set(k, self.testo(el.get(k), k))
            if len(el) == 0 and el.text and el.text.strip():
                el.text = self.testo(el.text, el.tag)
            elif len(el) and el.text and el.text.strip():
                el.text = None
        # nomi resi uguali dalla normalizzazione nello stesso contenitore
        for parent in root.iter():
            visti = {}
            for c in parent:
                n = c.get('name')
                if n is None:
                    continue
                if n in visti:
                    i = 2
                    while f'{n}-{i}' in visti:
                        i += 1
                    c.set('name', f'{n}-{i}')
                visti[c.get('name')] = True


def parole(root):
    out = set()
    for el in root.iter():
        for v in [el.text or ''] + list(el.attrib.values()):
            out.update(w.lower() for w in re.findall(r'[A-Za-z0-9][A-Za-z0-9_\-]{3,}', v))
    return out


def controllo(originali, prodotti, an):
    """Restituisce le stringhe del cliente rimaste nei file prodotti."""
    generiche = {w.lower() for w in an.vocab} | {t.lower() for t in an.tag_xml}
    generiche |= {'anonimizzato', 'testo', 'example', 'elenco', 'utente', 'host', 'localhost', 'localdomain', 'paloaltonetworks'}
    generiche |= set(PREFISSI.values())
    sospette = set()
    for r in originali:
        for w in parole(r):
            if w in generiche or re.fullmatch(r'[0-9_\-]+', w) or INTERFACCIA.match(w) or re.fullmatch(r'ethernet\d+', w):
                continue
            # frammenti di nomi di elementi XML o di valori degli schemi (use-default-browser, agent-user-override-key)
            if any(w in g for g in generiche if len(g) > len(w)):
                continue
            sospette.add(w)
    testo_out = '\n'.join(ET.tostring(r, encoding='unicode').lower() for r in prodotti)
    rimaste = sorted(w for w in sospette if re.search(r'(?<![a-z0-9])' + re.escape(w) + r'(?![a-z0-9])', testo_out))
    pubblici = set()
    for r in originali:
        for el in r.iter():
            for v in [el.text or ''] + list(el.attrib.values()):
                for m in IPV4.finditer(v):
                    s = m.group(0)
                    try:
                        a = ipaddress.ip_address(s)
                    except ValueError:
                        continue
                    if a.is_global and s not in RESOLVER:
                        pubblici.add(s)
    ip_rimasti = sorted(s for s in pubblici if re.search(r'(?<![\d.])' + re.escape(s) + r'(?![\d.])', testo_out))
    return rimaste, ip_rimasti


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('config', nargs='+', help='config PAN-OS da anonimizzare insieme')
    ap.add_argument('--out', required=True, help='cartella di destinazione')
    ap.add_argument('--nomi', nargs='+', help='nomi dei file prodotti, nello stesso ordine')
    a = ap.parse_args()
    nomi = a.nomi or [f'anonima-{i + 1}.xml' for i in range(len(a.config))]
    if len(nomi) != len(a.config):
        sys.exit('--nomi deve avere un nome per ogni config')

    an = Anonimizzatore()
    originali = [ET.parse(f).getroot() for f in a.config]
    ridotte = [an.riduci(ET.parse(f).getroot()) for f in a.config]
    for r in ridotte:
        an.raccogli(r)
    for r in ridotte:
        an.applica(r)
    rimaste, ip_rimasti = controllo(ridotte and [an.riduci(o) for o in originali], ridotte, an)
    if rimaste or ip_rimasti:
        print('Controllo non superato: nessun file scritto.')
        if rimaste:
            print('Parole dei file originali ancora presenti:', ', '.join(rimaste[:80]))
        if ip_rimasti:
            print('Indirizzi pubblici originali ancora presenti:', ', '.join(ip_rimasti[:40]))
        sys.exit(1)
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for r, n in zip(ridotte, nomi):
        ET.indent(r, space='  ')
        (out / n).write_text('<?xml version="1.0"?>\n' + ET.tostring(r, encoding='unicode') + '\n')
        print('scritto', out / n)
    print(f'nomi sostituiti: {len(an.nomi)}, blocchi di indirizzi: {len(an.blocchi)}, testi: {len(an.testi)}')


if __name__ == '__main__':
    main()
