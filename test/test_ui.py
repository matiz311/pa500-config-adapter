"""Test end-to-end della pagina in Chromium headless (file://, nessuna rete)."""
import io, json, pathlib, sys, tarfile
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
PAGE = (HERE.parent / 'dist' / 'pa500-adattatore.html').resolve().as_uri()
SHOTS = HERE / 'shots'
SHOTS.mkdir(exist_ok=True)

# device state di prova: tgz con running-config.xml e altri file
tgz = HERE / 'device-state-test.tgz'
with tarfile.open(tgz, 'w:gz') as t:
    for name, data in (('./running-config.xml', (HERE / 'src-pa3220.xml').read_bytes()), ('./config/.keys/dummy.key', b'x' * 700)):
        ti = tarfile.TarInfo(name)
        ti.size = len(data)
        t.addfile(ti, io.BytesIO(data))

ERRORS = """Validation Error:
 vsys -> vsys1 -> rulebase -> security -> rules -> dmz-in -> from 'old-zone' is not a valid reference
 devices -> localhost.localdomain -> deviceconfig -> system -> route -> service -> syslog -> source -> interface 'ethernet1/21' is not a valid reference
 network -> virtual-router is unexpected
Commit failed"""

problems = []
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
    page = ctx.new_page()
    page.on('console', lambda m: m.type in ('error', 'warning') and problems.append('console ' + m.type + ': ' + m.text))
    page.on('pageerror', lambda e: problems.append('pageerror: ' + str(e)))
    page.route('**/*', lambda r: r.abort() if not r.request.url.startswith('file:') and not r.request.url.startswith('data:') else r.continue_())
    page.goto(PAGE)
    page.screenshot(path=str(SHOTS / '00-vuota.png'), full_page=True)

    # 1) device state .tgz come sorgente
    page.set_input_files('input[data-file=src]', str(tgz))
    page.wait_for_timeout(500)
    print('slot src:', page.inner_text('#drop-src .slot-body').replace('\n', ' | '))
    page.screenshot(path=str(SHOTS / '01-sorgente.png'), full_page=True)
    print('summary:', page.inner_text('#map-summary'))
    print('verdict:', page.inner_text('.verdict'))

    # 2) assegna porte: ethernet1/20 -> ethernet1/15 via pannello, ethernet1/21 esclusa via select, ha1-a -> management, ha1-b -> 1/11
    page.click('tr[data-key="ethernet1/20"] .if-pick')
    page.click('.port[data-port="ethernet1/15"]')
    page.select_option('select[data-key="ethernet1/21"]', '__drop__')
    page.select_option('select[data-key="ha1-a"]', 'management')
    page.select_option('select[data-key="ha1-b"]', 'ethernet1/11')
    page.wait_for_timeout(400)
    print('summary:', page.inner_text('#map-summary'))
    print('verdict:', page.inner_text('.verdict'))
    page.screenshot(path=str(SHOTS / '02-porte.png'), full_page=True)

    # 3) config del PA-500
    page.set_input_files('input[data-file=tgt]', str(HERE / 'tgt-pa550.xml'))
    page.wait_for_timeout(500)
    print('slot tgt:', page.inner_text('#drop-tgt .slot-body').replace('\n', ' | '))
    print('summary:', page.inner_text('#map-summary'))
    print('verdict:', page.inner_text('.verdict'))
    print('levels:', page.inner_text('.levels').replace('\n', ' '))

    # 4) errori di commit -> regole
    page.fill('#errors', ERRORS)
    page.click('#btn-errors')
    page.wait_for_timeout(300)
    items = page.query_selector_all('.err-item')
    for it in items:
        print('ERR:', it.inner_text().replace('\n', ' | ')[:300])
    page.click('.err-item.found button:has-text("Rimuovi il riferimento")')
    page.wait_for_timeout(500)
    print('custom rules:', page.inner_text('#custom-list').replace('\n', ' | ')[:400])
    for it in page.query_selector_all('.err-item'):
        print('ERR2:', it.inner_text().replace('\n', ' | ')[:200])

    # 5) tab
    for tab in ('load', 'xpath', 'counts', 'report'):
        page.click(f'#tab-{tab}')
        page.wait_for_timeout(150)
        page.screenshot(path=str(SHOTS / f'03-tab-{tab}.png'))
        if tab == 'load' and 'delete network virtual-router' not in page.inner_text('.steps-load'):
            problems.append('scheda Caricamento: manca la pulizia del virtual router legacy')
    page.screenshot(path=str(SHOTS / '04-completa.png'), full_page=True)

    # 6) download
    with page.expect_download() as dl:
        page.click('#btn-dl-xml')
    path = dl.value.path()
    out = pathlib.Path(path).read_text()
    (HERE / 'out-ui.xml').write_text(out)
    print('download:', dl.value.suggested_filename, len(out), 'byte')
    with page.expect_download() as dl2:
        page.click('#btn-dl-report')
    rep = pathlib.Path(dl2.value.path()).read_text()
    (HERE / 'out-ui-report.md').write_text(rep)
    print('report:', dl2.value.suggested_filename, len(rep), 'byte')

    # 7) mobile
    m = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    mp = m.new_page()
    mp.on('pageerror', lambda e: problems.append('pageerror mobile: ' + str(e)))
    mp.goto(PAGE)
    mp.set_input_files('input[data-file=src]', str(HERE / 'src-pa3220.xml'))
    mp.wait_for_timeout(500)
    mp.screenshot(path=str(SHOTS / '05-mobile.png'), full_page=True)
    sw = mp.evaluate('document.documentElement.scrollWidth')
    print('mobile scrollWidth:', sw)
    if sw > 390:
        problems.append('scroll orizzontale su mobile: %d' % sw)

    # 8) tema scuro
    d = b.new_context(viewport={'width': 1440, 'height': 1000}, color_scheme='dark')
    dp = d.new_page()
    dp.goto(PAGE)
    dp.set_input_files('input[data-file=src]', str(HERE / 'src-pa3220.xml'))
    dp.wait_for_timeout(500)
    dp.screenshot(path=str(SHOTS / '06-scuro.png'), full_page=False)

    # 9) nessuna connessione in uscita: la CSP blocca fetch anche con la pagina pubblicata online
    csp = dp.get_attribute('meta[http-equiv="Content-Security-Policy"]', 'content') or ''
    if "connect-src 'none'" not in csp:
        problems.append('CSP senza connect-src none: %r' % csp)
    esito = dp.evaluate("""() => new Promise(res => {
      document.addEventListener('securitypolicyviolation', e => res(e.effectiveDirective), { once: true });
      fetch('https://example.com/x').catch(() => {});
      setTimeout(() => res('nessuna violazione'), 3000);
    })""")
    if esito != 'connect-src':
        problems.append('fetch verso l\'esterno non bloccato dalla CSP: %s' % esito)
    b.close()

print('problemi:', problems or 'nessuno')
sys.exit(1 if problems else 0)
