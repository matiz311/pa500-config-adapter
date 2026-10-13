"""Misura i tempi su una config sintetica grande (40.000 oggetti, 10.000 regole)."""
import pathlib
import tempfile
import time

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
PAGE = (HERE.parent / 'dist' / 'pa500-adattatore.html').resolve().as_uri()


def big_config(path):
    src = (HERE / 'src-pa3220.xml').read_text()
    addrs = ''.join(f'<entry name="h{i}"><ip-netmask>10.{i // 65536 % 256}.{i // 256 % 256}.{i % 256}/32</ip-netmask></entry>\n' for i in range(40000))
    rules = ''.join(
        f'<entry name="r{i}"><from><member>trust</member></from><to><member>untrust</member></to>'
        f'<source><member>h{i}</member></source><destination><member>any</member></destination>'
        f'<application><member>any</member></application><service><member>application-default</member></service>'
        f'<action>allow</action></entry>\n' for i in range(10000))
    anchor = '<entry name="srv-web"><ip-netmask>10.10.10.10/32</ip-netmask></entry>'
    big = src.replace(anchor, anchor + addrs).replace('<entry name="lan-out">', rules + '<entry name="lan-out">')
    path.write_text(big)
    return len(big) / 1e6


with tempfile.TemporaryDirectory() as tmp:
    cfg = pathlib.Path(tmp) / 'big.xml'
    print('config sintetica: %.1f MB' % big_config(cfg))
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page()
        page.goto(PAGE)
        t = time.time()
        page.set_input_files('input[data-file=src]', str(cfg))
        page.wait_for_selector('.verdict', timeout=60000)
        print('caricamento e prima conversione: %.2f s' % (time.time() - t))
        print(page.inner_text('#r-meta'))
        t = time.time()
        with page.expect_download() as dl:
            page.click('#btn-dl-xml')
        size = pathlib.Path(dl.value.path()).stat().st_size / 1e6
        print('serializzazione e download: %.2f s, %.1f MB' % (time.time() - t, size))
        b.close()
