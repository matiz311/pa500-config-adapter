"""tools/anonimizza.py: nomi, indirizzi e testi sostituiti in modo coerente, struttura intatta."""
import pathlib
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

HERE = pathlib.Path(__file__).parent
TOOL = HERE.parent / 'tools' / 'anonimizza.py'
SRC = HERE / 'src-pa3220.xml'
REF = HERE / 'pa550-are-funzionante.xml'
FAILS = []


def check(cond, msg):
    if not cond:
        FAILS.append(msg)
        print('FAIL', msg)


with tempfile.TemporaryDirectory() as tmp:
    r = subprocess.run([sys.executable, str(TOOL), str(SRC), str(REF), '--out', tmp, '--nomi', 'a.xml', 'b.xml'], capture_output=True, text=True)
    check(r.returncode == 0, 'anonimizzazione fallita: ' + r.stdout + r.stderr)
    a = (pathlib.Path(tmp) / 'a.xml').read_text() if r.returncode == 0 else ''
    b = (pathlib.Path(tmp) / 'b.xml').read_text() if r.returncode == 0 else ''

if a and b:
    for parola in ('lan-out', 'srv-web', 'isp-md5', 'agg-lan', 'fw-old-a', 'pa550-are', 'coppia test', 'uplink A', 'gw.example.net'):
        check(parola not in a and parola not in b, 'valore originale rimasto: ' + parola)
    for ip in ('203.0.113.2', '198.51.100.10', '10.0.10.1'):
        check(ip not in a and ip not in b, 'indirizzo originale rimasto: ' + ip)
    ra, rb = ET.fromstring(a.encode()), ET.fromstring(b.encode())
    check(ra.find('mgt-config') is None and rb.find('mgt-config') is None, 'sezione mgt-config non eliminata')
    check(ra.find('devices/entry/deviceconfig/system') is None, 'deviceconfig/system non eliminato')
    check(ra.find("devices/entry/network/interface/ethernet/entry[@name='ethernet1/2']/layer3/units/entry[@name='ethernet1/2.10']") is not None, 'nomi delle interfacce cambiati')
    check(ra.find('devices/entry/network/virtual-router/entry/routing-table/ip/static-route/entry/route-table/unicast') is not None, 'struttura del virtual router cambiata')
    check(rb.findtext('devices/entry/deviceconfig/setting/advance-routing') == 'yes', 'valori degli enum cambiati')
    za = {e.get('name') for e in ra.findall('devices/entry/vsys/entry/zone/entry')}
    zb = {e.get('name') for e in rb.findall('devices/entry/vsys/entry/zone/entry')}
    check(len(za & zb) >= 2, 'stessi nomi originali non mappati sugli stessi nomi anonimi nei due file')
    m = ra.findtext("devices/entry/vsys/entry/zone/entry/network/layer3/member")
    check(m is not None and m.startswith(('ethernet', 'ae')), 'riferimenti alle interfacce cambiati')

print('test_anonimizza: %d verifiche fallite' % len(FAILS) if FAILS else 'test_anonimizza: tutte le verifiche passate')
sys.exit(1 if FAILS else 0)
