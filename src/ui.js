(function () {
  'use strict';
  const E = window.PA500;
  const KEY = 'pa500-adapter.v1';
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }
  function rich(msg) {
    const frag = document.createDocumentFragment();
    String(msg).split(/`([^`]*)`/).forEach((p, i) => frag.appendChild(i % 2 ? h('code', null, p) : document.createTextNode(p)));
    return frag;
  }
  function uid() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function speedLabel(mbps) { return mbps >= 1000 ? (mbps / 1000).toString().replace('.', ',') + 'G' : mbps + 'M'; }
  let toastTimer = null;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ------------------------------------------------------------------ stato
  function loadSaved() { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } }
  const saved = loadSaved();
  const S = {
    src: null, tgt: null,
    model: saved.model || 'PA-550',
    customPorts: saved.customPorts || '1-8 rj45',
    map: {}, sel: null,
    rules: Object.assign({ are: true, dyn: true, ifaces: true, ha: true, keepHA: true, poe: true, keepMgmt: true, keepAdmins: false }, saved.rules || {}),
    custom: Array.isArray(saved.custom) ? saved.custom.filter(r => r && r.xpath !== undefined) : [],
    limits: saved.limits || {},
    result: null, filter: null, tab: 'report', xpq: '/config/devices/entry/network/logical-router',
    outName: '', outNameEdited: false, errs: []
  };
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ model: S.model, customPorts: S.customPorts, rules: S.rules, custom: S.custom, limits: S.limits }));
    } catch (e) { /* archiviazione del browser non disponibile: le preferenze valgono solo per questa sessione */ }
  }
  const model = () => E.getModel(S.model, S.customPorts);
  const srcInv = () => (S.src && S.src.doc && S.src.info.devices[0]) ? S.src.info.devices[0].interfaces : [];
  const hasTgt = () => !!(S.tgt && S.tgt.doc);
  const tgtHasHA = () => hasTgt() && (S.tgt.info.devices[0].haEnabled || S.tgt.info.devices[0].haPorts.length > 0);
  const keepHA = () => S.rules.ha && S.rules.keepHA && tgtHasHA();
  const replacedByTarget = it => keepHA() && (it.kind === 'ha-dedicated' || it.mode === 'ha');
  function targetHaPorts() {
    if (!keepHA()) return new Map();
    const m = new Map();
    for (const [sec, port] of S.tgt.info.devices[0].haPorts) if (port !== E.MGMT) m.set(port, sec);
    return m;
  }
  function suggestName() {
    const base = S.src ? S.src.fileName.replace(/\.(xml|tgz|tar\.gz|tar|gz)$/i, '') : 'config';
    return base + '-' + model().id.toLowerCase() + '.xml';
  }

  // ------------------------------------------------------------------ file
  async function readConfigFile(file) {
    const buf = await file.arrayBuffer();
    const b = new Uint8Array(buf.slice(0, 512));
    const isGz = b[0] === 0x1f && b[1] === 0x8b;
    const isTar = b.length > 262 && new TextDecoder().decode(b.slice(257, 262)) === 'ustar';
    if (isGz || isTar) {
      const r = await E.extractRunningConfig(buf);
      return { text: r.text, note: 'estratto ' + r.name + ' dal device state' };
    }
    return { text: new TextDecoder('utf-8').decode(buf) };
  }
  async function loadSlot(slot, file) {
    const st = { fileName: file.name, error: null, doc: null };
    try {
      const r = await readConfigFile(file);
      st.note = r.note;
      st.doc = E.parse(r.text);
      st.info = E.analyze(st.doc);
      if (!st.info.ok) throw new Error(st.info.problem);
    } catch (e) {
      st.error = e.message || String(e);
      st.doc = null;
    }
    S[slot] = st;
    if (slot === 'src') {
      S.map = st.doc ? E.defaultMap(srcInv(), model()) : {};
      S.sel = null;
      if (!S.outNameEdited) S.outName = suggestName();
    }
    renderSlots(); renderRules(); renderMap(); schedule(renderErrors);
  }
  function clearSlot(slot) {
    S[slot] = null;
    if (slot === 'src') { S.map = {}; S.result = null; S.sel = null; }
    renderSlots(); renderRules(); renderMap(); schedule(renderErrors);
  }

  function renderSlots() {
    for (const slot of ['src', 'tgt']) {
      const box = $('#drop-' + slot);
      const body = $('.slot-body', box);
      const st = S[slot];
      box.classList.toggle('is-loaded', !!(st && st.doc));
      box.classList.toggle('is-error', !!(st && st.error));
      $('.actions label', box).lastChild.textContent = st && st.doc ? 'Sostituisci' : 'Scegli file';
      const actions = $('.actions', box);
      const rm = $('.rm', actions);
      if (st && !rm) actions.insertBefore(h('button', { type: 'button', class: 'btn quiet rm', onclick: () => clearSlot(slot) }, 'Rimuovi'), $('.or', actions));
      else if (!st && rm) rm.remove();
      $('.or', actions).hidden = !!(st && st.doc);
      body.replaceChildren();
      if (!st) continue;
      if (st.error) {
        body.append(h('p', { class: 'file-name' }, st.fileName), h('p', { class: 'err' }, st.error));
        continue;
      }
      const d = st.info.devices[0];
      const routing = d.are === 'yes'
        ? 'Advanced Routing' + (d.lrs.length ? ', ' + d.lrs.length + ' logical router' : '')
        : 'legacy' + (d.vrs.length ? ', ' + d.vrs.length + ' virtual router' : '');
      body.append(
        h('p', { class: 'file-name' }, st.fileName + (st.note ? ' (' + st.note + ')' : '')),
        h('dl', { class: 'facts' },
          h('dt', null, 'Hostname'), h('dd', null, d.hostname || 'non indicato'),
          h('dt', null, 'PAN-OS'), h('dd', null, st.info.version || 'non indicato'),
          h('dt', null, 'Routing'), h('dd', null, routing),
          slot === 'src'
            ? [h('dt', null, 'Interfacce'), h('dd', null, d.interfaces.filter(i => i.kind !== 'ha-dedicated').length + ' tra fisiche e aggregate'),
               h('dt', null, 'Virtual system'), h('dd', null, String(d.vsys.length))]
            : [h('dt', null, 'Management'), h('dd', null, d.mgmtIp || 'non indicato')],
          h('dt', null, 'HA'), h('dd', null, d.haEnabled ? 'attivo, ' + d.haPorts.map(p => p[0] + ' su ' + p[1]).join(', ') : (d.haPorts.length ? 'configurato, non attivo' : 'non configurato'))
        ),
      );
    }
    $('#s1').classList.toggle('is-done', !!(S.src && S.src.doc));
  }

  // ------------------------------------------------------------------ modello e pannello
  function renderModelSelect() {
    const sel = $('#model');
    sel.replaceChildren(...E.MODELS.map(m => h('option', { value: m.id }, m.id)), h('option', { value: 'custom' }, 'Personalizzato'));
    sel.value = E.MODELS.some(m => m.id === S.model) ? S.model : 'custom';
    if (sel.value === 'custom') S.model = 'custom';
    $('#custom-ports-field').hidden = sel.value !== 'custom';
    $('#custom-ports').value = S.customPorts;
  }
  function remapForModel() {
    const m = model();
    const def = E.defaultMap(srcInv(), m);
    for (const it of srcInv()) {
      const cur = S.map[it.key];
      if (cur === E.DROP || it.kind === 'ae') continue;
      if (it.kind === 'ha-dedicated' && cur === E.MGMT) continue;
      if (cur && (m.byName.has(cur) || m.cellular.includes(cur))) continue;
      S.map[it.key] = def[it.key];
    }
    if (!S.outNameEdited) S.outName = suggestName();
  }

  function portUse() {
    const use = new Map();
    const ports = (S.result && S.result.ports) || {};
    for (const [name, p] of Object.entries(ports)) {
      use.set(name, { source: p.source, ha: p.ha, mode: p.mode, ae: p.ae, units: p.units, err: !p.exists || p.collision });
    }
    return use;
  }
  function describeUse(u) {
    if (u.ha) return 'HA (' + u.ha.join(', ') + ')';
    let s = u.source && u.source !== '' ? 'da ' + u.source : '';
    if (u.ae) s += (s ? ', ' : '') + 'membro di ' + u.ae;
    else if (u.mode) s += (s ? ', ' : '') + u.mode;
    if (u.units) s += ', ' + u.units + ' sub-interfacce';
    return s;
  }
  function renderFaceplate() {
    const m = model();
    const fp = $('#faceplate');
    fp.replaceChildren();
    const mgmtHa = (S.result && S.result.mgmtHa) || [];
    const mgmtLabel = 'Porta di management' + (mgmtHa.length ? ', usata anche da ' + mgmtHa.join(' e ') : '') + (mgmtHa.length > 1 ? ': un solo link HA può usarla' : '');
    fp.append(h('div', { class: 'fp-brand' },
      h('span', { class: 'fp-model' }, m.id),
      h('span', { class: 'fp-mgmt' }, h('span', { class: 'sock-mini' + (mgmtHa.length > 1 ? ' is-err' : mgmtHa.length ? ' is-ha' : ''), title: mgmtLabel, role: 'img', 'aria-label': mgmtLabel }), 'MGT')));
    const use = portUse();
    const selPort = S.sel ? S.map[S.sel] : null;
    for (const g of m.groups) {
      const grid = h('div', { class: 'fp-ports' });
      const sfp = g.type === 'SFP' || g.type === 'SFP+';
      for (let n = g.from; n <= g.to; n++) {
        const name = 'ethernet1/' + n;
        const p = m.byName.get(name);
        const u = use.get(name);
        const bottom = (n - g.from) % 2 === 1;
        const cls = ['port', sfp ? 'sfp' : (bottom ? 'flip' : ''),
          u ? (u.err ? 'is-err' : u.ha ? 'is-ha' : 'is-used') : '',
          selPort === name ? 'is-sel' : ''].filter(Boolean).join(' ');
        const extra = [p.poe ? 'PoE' : '', p.failOpen ? 'fail-open' : '', p.ztp ? 'ZTP' : ''].filter(Boolean).join(', ');
        const label = name + ' (' + g.type + ' ' + speedLabel(g.speed) + (extra ? ', ' + extra : '') + '): ' + (u ? describeUse(u) : 'libera');
        grid.append(h('button', { type: 'button', class: cls, title: label, 'aria-label': label, dataset: { port: name } },
          h('span', { class: 'sock' }), p.poe ? h('span', { class: 'poe' }) : null,
          h('span', { class: 'num' }, String(n)), h('span', { class: 'led' })));
      }
      fp.append(h('div', { class: 'fp-group' }, grid, h('span', { class: 'fp-cap' }, g.type + ' ' + speedLabel(g.speed))));
    }
    if (!m.groups.length) fp.append(h('span', { class: 'fp-cap' }, 'Indica le porte del modello nel campo qui sopra.'));
    const strays = [...use.entries()].filter(([name, u]) => !m.byName.has(name) && u);
    const st = $('#fp-strays');
    st.hidden = !strays.length;
    st.textContent = strays.length ? 'Porte che non esistono sul ' + m.id + ': ' + strays.map(([n, u]) => n + (u.source && u.source !== n ? ' (da ' + u.source + ')' : '')).join(', ') + '.' : '';
  }

  // ------------------------------------------------------------------ tabella porte
  const KIND = { ethernet: 'Ethernet', ae: 'Aggregata', 'ha-dedicated': 'Porta HA dedicata', cellular: 'Cellulare' };
  const MODE_LABEL = { layer3: 'layer 3', layer2: 'layer 2', 'virtual-wire': 'virtual wire', tap: 'tap', ha: 'HA', 'decrypt-mirror': 'decrypt mirror', 'log-card': 'log card' };

  function chipsFor(it) {
    const c = [];
    if (it.mode === 'aggregate-group') c.push(h('span', { class: 'chip' }, 'membro di ' + it.ae));
    else if (it.mode) c.push(h('span', { class: 'chip' }, MODE_LABEL[it.mode] || it.mode));
    if (it.ha && it.ha.length) c.push(h('span', { class: 'chip' }, it.ha.join(', ')));
    if (it.units.length) c.push(h('span', { class: 'chip' }, it.units.length + (it.units.length === 1 ? ' sub-interfaccia' : ' sub-interfacce')));
    if (it.zones.length) c.push(h('span', { class: 'chip' }, (it.zones.length === 1 ? 'zona ' : 'zone ') + it.zones.join(', ')));
    if (it.ips.length) c.push(h('span', { class: 'chip mono' }, it.ips[0] + (it.ips.length > 1 ? ' +' + (it.ips.length - 1) : '')));
    if (it.dhcp) c.push(h('span', { class: 'chip' }, 'DHCP client'));
    if (it.pppoe) c.push(h('span', { class: 'chip' }, 'PPPoE'));
    if (it.members && it.members.length) c.push(h('span', { class: 'chip mono' }, it.members.join(', ')));
    if (it.linkSpeed && it.linkSpeed !== 'auto') c.push(h('span', { class: 'chip' }, it.linkSpeed + ' Mbps'));
    if (it.poe) c.push(h('span', { class: 'chip' }, 'PoE'));
    if (!it.used) c.push(h('span', { class: 'chip' }, 'non usata'));
    return h('div', { class: 'chips' }, c);
  }
  function holderOf(port, exceptKey) {
    for (const it of srcInv()) {
      if (it.key === exceptKey || replacedByTarget(it)) continue;
      if (S.map[it.key] === port) return it.key;
    }
    const tha = targetHaPorts();
    if (tha.has(port)) return 'HA ' + tha.get(port);
    return null;
  }
  function portSelect(it, v, m) {
    const sel = h('select', { 'aria-label': 'Porta per ' + it.key, dataset: { key: it.key } });
    if (it.kind === 'ae') {
      for (let i = 1; i <= 16; i++) sel.append(h('option', { value: 'ae' + i }, 'ae' + i));
    } else {
      sel.append(h('option', { value: '' }, 'scegli una porta'));
      if (it.kind === 'ha-dedicated' && it.ha.some(s => s === 'ha1' || s === 'ha1-backup')) sel.append(h('option', { value: E.MGMT }, 'management'));
      if (it.kind === 'cellular') for (const c of m.cellular) sel.append(h('option', { value: c }, c));
      for (const g of m.groups) {
        const og = h('optgroup', { label: g.type + ' ' + speedLabel(g.speed) });
        for (let n = g.from; n <= g.to; n++) {
          const name = 'ethernet1/' + n;
          const holder = holderOf(name, it.key);
          og.append(h('option', { value: name }, name + (holder ? '  (' + holder + ')' : '')));
        }
        sel.append(og);
      }
    }
    if (it.kind !== 'ha-dedicated') sel.append(h('option', { value: E.DROP }, 'Escludi'));
    else if (onlyBackups(it)) sel.append(h('option', { value: E.DROP }, 'Nessuna (togli il backup)'));
    const val = v || (it.kind === 'ae' ? it.key : '');
    if (val && ![...sel.options].some(o => o.value === val)) sel.insertBefore(h('option', { value: val }, val + ' (non esiste)'), sel.options[it.kind === 'ae' ? 0 : 1]);
    sel.value = val;
    return sel;
  }
  const onlyBackups = it => it.ha.length > 0 && it.ha.every(s => s === 'ha1-backup' || s === 'ha2-backup');
  /** Porta finale di ogni link HA della sorgente secondo la mappatura corrente. */
  function haLinks() {
    if (!S.src || !S.src.doc || keepHA() || !S.rules.ha) return [];
    const out = [];
    for (const [sec, port] of S.src.info.devices[0].haPorts) {
      let f = port;
      if (port !== E.MGMT) {
        const v = S.map[port];
        if (v === E.DROP) continue;
        if (v) f = v;
        else if (srcInv().some(i => i.key === port && i.kind === 'ha-dedicated')) f = '';
      }
      out.push({ sec, port: f });
    }
    return out;
  }
  function rowStatus(it, v, m) {
    if (replacedByTarget(it)) return { cls: 'off', text: 'Sostituita' };
    if (v === E.DROP) {
      if (it.ha.length && !onlyBackups(it)) return { cls: 'err', text: 'Serve a ' + it.ha.join(', ') };
      return { cls: 'off', text: it.ha.length ? 'Backup tolto' : 'Esclusa' };
    }
    if (it.ha.length) {
      const mine = it.kind === 'ha-dedicated' ? v : (v || it.key);
      const clash = haLinks().filter(l => !it.ha.includes(l.sec) && l.port && l.port === mine);
      if (mine && clash.length) return { cls: 'err', text: 'Stessa porta di ' + clash.map(c => c.sec).join(', ') };
    }
    if (it.kind === 'ha-dedicated') {
      if (!v) return { cls: 'err', text: 'Da assegnare' };
      if (v === E.MGMT) return { cls: 'ok', text: 'Management' };
    }
    const target = v || (it.kind === 'ae' ? it.key : '');
    if (!target) return { cls: 'err', text: 'Da assegnare' };
    const others = srcInv().filter(o => o.key !== it.key && !replacedByTarget(o) && (S.map[o.key] || (o.kind === 'ae' ? o.key : '')) === target);
    if (others.length) return { cls: 'err', text: 'Anche ' + others.map(o => o.key).join(', ') };
    const tha = targetHaPorts();
    if (tha.has(target)) return { cls: 'err', text: 'Usata da ' + tha.get(target) };
    if (it.kind === 'ae') return { cls: 'ok', text: 'OK' };
    if (!m.byName.has(target) && !m.cellular.includes(target)) return { cls: 'err', text: 'Porta inesistente' };
    const p = m.byName.get(target);
    if (p && it.linkSpeed && /^\d+$/.test(it.linkSpeed) && +it.linkSpeed > p.speed) return { cls: 'warn', text: 'Velocità ' + it.linkSpeed };
    if (p && it.poe && !p.poe && S.rules.poe) return { cls: 'warn', text: 'PoE rimosso' };
    return { cls: 'ok', text: p ? p.type + ' ' + speedLabel(p.speed) : 'OK' };
  }
  function renderMap() {
    const wrap = $('#map-wrap');
    const inv = srcInv();
    const m = model();
    if (!inv.length) {
      wrap.replaceChildren(h('p', { class: 'empty-note' }, S.src && S.src.doc ? 'La config sorgente non ha interfacce fisiche configurate.' : 'Carica la config sorgente per vedere le sue interfacce.'));
      $('#map-summary').textContent = '';
      $('#s2').classList.remove('is-done');
      renderFaceplate();
      return;
    }
    const tbody = h('tbody');
    let nOk = 0, nErr = 0, nDrop = 0;
    for (const it of inv) {
      const v = S.map[it.key] || '';
      const st = rowStatus(it, v, m);
      if (st.cls === 'err') nErr++; else if (st.cls === 'off') nDrop++; else nOk++;
      tbody.append(h('tr', { class: [S.sel === it.key ? 'is-sel' : '', it.used ? '' : 'is-unused'].join(' ').trim(), dataset: { key: it.key } },
        h('td', null,
          h('button', { type: 'button', class: 'if-pick if-name', 'aria-pressed': S.sel === it.key ? 'true' : 'false', title: 'Seleziona, poi clicca una porta del pannello' }, it.key),
          h('span', { class: 'if-kind' }, KIND[it.kind] || it.kind)),
        h('td', null, chipsFor(it)),
        h('td', null, replacedByTarget(it)
          ? h('div', null, h('span', { class: 'small' }, 'Sostituita dall\'HA del PA-500. '),
              h('button', { type: 'button', class: 'btn quiet', style: 'padding:0;font-size:13px', dataset: { act: 'source-ha' } }, 'Migra l\'HA della sorgente'))
          : portSelect(it, v, m)),
        h('td', null, h('span', { class: 'st ' + st.cls }, st.text))));
    }
    wrap.replaceChildren(h('table', { class: 'map' },
      h('thead', null, h('tr', null, h('th', null, 'Interfaccia'), h('th', null, 'Configurazione'), h('th', null, 'Porta sul ' + m.id), h('th', null, 'Stato'))),
      tbody));
    $('#map-summary').textContent = inv.length + ' interfacce: ' + nOk + ' assegnate, ' + nDrop + ' escluse o sostituite' + (nErr ? ', ' + nErr + ' da sistemare' : '');
    $('#s2').classList.toggle('is-done', nErr === 0);
    renderFaceplate();
  }
  function assign(key, port) {
    const it = srcInv().find(i => i.key === key);
    if (!it || replacedByTarget(it)) return;
    if (it.kind === 'ae') { toast('Le aggregate si assegnano dalla tabella.'); return; }
    const prevHolder = srcInv().find(o => o.key !== key && !replacedByTarget(o) && S.map[o.key] === port);
    const old = S.map[key];
    S.map[key] = port;
    if (prevHolder) {
      S.map[prevHolder.key] = old && old !== E.DROP && old !== E.MGMT ? old : '';
      toast(prevHolder.key + (S.map[prevHolder.key] ? ' spostata su ' + S.map[prevHolder.key] : ' ora è senza porta'));
    }
    S.sel = null;
    renderMap();
    schedule();
  }

  // ------------------------------------------------------------------ regole standard
  const RULES = [
    { id: 'are', title: 'Advanced Routing', desc: 'Converte i virtual router in logical router con VRF default: static route, ECMP, admin distance e next hop verso altri router. Attiva advance-routing e aggiorna l\'import delle vsys.' },
    { id: 'dyn', parent: 'are', title: 'Converti anche BGP e OSPF', desc: 'Peer group, peer, aree, interfacce, timer e autenticazione diventano configurazione e profili ARE. Policy, route map e filtri complessi finiscono nel report, da rifare a mano.' },
    { id: 'ifaces', title: 'Porte e interfacce', desc: 'Applica la tabella delle porte a tutta la config, sub-interfacce comprese, ed elimina le interfacce escluse con i loro riferimenti.' },
    { id: 'ha', title: 'Alta affidabilità', desc: 'Sposta HA1 e HA2 dalle porte dedicate, che sui PA-500 non ci sono, alle porte dati scelte o alla management, impostandole in modalità HA.' },
    { id: 'keepHA', parent: 'ha', needsTgt: true, title: 'Usa l\'HA già configurato sul PA-500', desc: 'Sostituisce la sezione HA della sorgente con quella del nuovo firewall e ne conserva le porte. Disattivala per portare l\'HA della sorgente sulle porte dati che scegli nella tabella.' },
    { id: 'poe', title: 'PoE', desc: 'Toglie le impostazioni PoE dalle porte che sul modello scelto non lo supportano.' },
    { id: 'keepMgmt', needsTgt: true, title: 'Mantieni management e hostname del PA-500', desc: 'IP, maschera, gateway e hostname restano quelli del nuovo firewall, così il caricamento completo non ti chiude fuori.' },
    { id: 'keepAdmins', needsTgt: true, title: 'Mantieni gli amministratori del PA-500', desc: 'Sostituisce utenti e password della sorgente con quelli del nuovo firewall.' }
  ];
  function renderRules() {
    const ul = $('#rules');
    ul.replaceChildren();
    for (const r of RULES) {
      const parentOff = r.parent && !S.rules[r.parent];
      const noHA = r.id === 'keepHA' && hasTgt() && !tgtHasHA();
      const disabled = (r.needsTgt && !hasTgt()) || parentOff || noHA;
      const id = 'rule-' + r.id;
      ul.append(h('li', { class: 'rule' + (r.parent ? ' sub' : '') + (disabled ? ' is-disabled' : '') },
        h('input', { type: 'checkbox', id, checked: !!S.rules[r.id] && !disabled, disabled: !!disabled, dataset: { rule: r.id } }),
        h('label', { for: id }, r.title),
        h('p', { class: 'desc' }, r.desc + (r.needsTgt && !hasTgt() ? ' Serve la config del PA-500 al passo 1.' : noHA ? ' Il PA-500 caricato non ha HA configurato.' : ''))));
    }
    ul.append(h('li', { class: 'rule' },
      h('input', { type: 'checkbox', id: 'rule-platform', checked: true, disabled: true }),
      h('label', { for: 'rule-platform' }, 'Controlli di piattaforma'),
      h('p', { class: 'desc' }, 'Sempre attivi: porte inesistenti sul modello, velocità non supportate, aggregate su porte diverse, multi-vsys, interfacce cellulari, residui del motore legacy e versione della sorgente.')));
  }

  // ------------------------------------------------------------------ regole personalizzate
  const ACTIONS = [['remove', 'Rimuovi'], ['set', 'Imposta valore'], ['rename', 'Rinomina elemento'], ['replace', 'Sostituisci testo'], ['report', 'Segnala soltanto']];
  const needsValue = a => a === 'set' || a === 'rename' || a === 'replace';
  function hitsText(n) {
    if (n === undefined) return { t: '', c: '' };
    if (n < 0) return { t: 'XPath non valido', c: 'bad' };
    if (n === 0) return { t: 'nessun nodo', c: 'zero' };
    return { t: n + (n === 1 ? ' nodo' : ' nodi'), c: '' };
  }
  function renderCustom() {
    const list = $('#custom-list');
    list.replaceChildren();
    if (!S.custom.length) {
      list.append(h('p', { class: 'empty-note' }, 'Nessuna regola personalizzata. Aggiungine una oppure creala dagli errori di commit al passo 4.'));
      return;
    }
    S.custom.forEach((r, i) => {
      const hits = hitsText(S.result && S.result.ruleHits ? S.result.ruleHits[r.id] : undefined);
      list.append(h('div', { class: 'crule' + (r.enabled === false ? ' is-off' : ''), dataset: { id: r.id } },
        h('input', { type: 'checkbox', checked: r.enabled !== false, 'aria-label': 'Regola attiva', dataset: { f: 'enabled' } }),
        h('input', { type: 'text', value: r.desc || '', placeholder: 'Descrizione', 'aria-label': 'Descrizione', dataset: { f: 'desc' } }),
        h('select', { 'aria-label': 'Azione', dataset: { f: 'action' } }, ACTIONS.map(([v, t]) => h('option', { value: v, selected: r.action === v }, t))),
        h('span', null,
          h('span', { class: 'hits ' + hits.c, dataset: { hits: r.id } }, hits.t),
          i > 0 ? h('button', { type: 'button', class: 'btn quiet', dataset: { act: 'up' }, title: 'Sposta prima', 'aria-label': 'Sposta prima' }, '↑') : null,
          h('button', { type: 'button', class: 'btn quiet', dataset: { act: 'del' } }, 'Elimina')),
        h('input', { type: 'text', class: 'mono xp', value: r.xpath || '', placeholder: '/config/devices/entry/deviceconfig/system/update-schedule', 'aria-label': 'XPath', dataset: { f: 'xpath' } }),
        needsValue(r.action) ? h('div', { class: 'val' },
          r.action === 'replace' ? h('input', { type: 'text', class: 'mono', value: r.pattern || '', placeholder: 'Espressione regolare', 'aria-label': 'Espressione regolare', dataset: { f: 'pattern' } }) : null,
          h('input', { type: 'text', class: 'mono', value: r.value || '', placeholder: r.action === 'rename' ? 'Nuovo nome dell\'elemento' : r.action === 'replace' ? 'Testo sostitutivo' : 'Valore', 'aria-label': 'Valore', dataset: { f: 'value' } })) : null));
    });
  }
  function renderCustomHits() {
    for (const el of $$('[data-hits]')) {
      const ht = hitsText(S.result && S.result.ruleHits ? S.result.ruleHits[el.dataset.hits] : undefined);
      el.textContent = ht.t;
      el.className = 'hits ' + ht.c;
    }
  }
  function customRuleOf(el) {
    const row = el.closest('.crule');
    return row ? S.custom.find(r => r.id === row.dataset.id) : null;
  }

  // ------------------------------------------------------------------ errori di commit
  function renderErrors() {
    const list = $('#err-list');
    list.replaceChildren();
    if (!S.errs.length) return;
    const doc = S.result && S.result.doc;
    if (!doc) { list.append(h('p', { class: 'empty-note' }, 'Carica prima la config sorgente: gli errori si cercano nella config convertita.')); return; }
    const parsed = S.errs.filter(e => e.parsed);
    const other = S.errs.filter(e => !e.parsed);
    if (!parsed.length) list.append(h('p', { class: 'empty-note' }, 'Nessuna riga con un percorso del tipo "vsys -> vsys1 -> ...": incolla l\'output di validate o del commit.'));
    for (const e of parsed) {
      const r = E.resolveError(doc, e);
      const found = r.nodes && r.nodes.length;
      const fixedBy = S.custom.find(c => c.fromError === e.raw && c.enabled !== false);
      const cls = found ? 'found' : (fixedBy || r.refGone ? 'fixed' : 'miss');
      const where = found
        ? 'Trovato in ' + r.nodes.slice(0, 2).map(n => E.humanPath(n)).join('; ') + (r.nodes.length > 2 ? ' e altri ' + (r.nodes.length - 2) : '') + '.'
        : fixedBy ? 'Corretto dalla regola «' + (fixedBy.desc || fixedBy.xpath) + '».'
        : r.refGone ? 'Il valore \'' + r.ref + '\' non c\'è più nella config convertita: l\'errore è già risolto.'
        : 'Non c\'è nella config convertita: è già corretto dalle regole, oppure riguarda un elemento che manca.';
      list.append(h('div', { class: 'err-item ' + cls },
        h('div', { class: 'err-raw' }, e.raw),
        h('div', { class: 'err-where' }, where),
        found && r.hint ? h('div', { class: 'err-hint' }, r.hint) : null,
        found ? h('div', { class: 'err-actions' }, r.actions.map(a => h('button', { type: 'button', class: 'btn', onclick: () => addRuleFromError(e, a) }, a.label))) : null,
        found ? h('details', { class: 'xml' }, h('summary', null, 'Mostra XML'), h('pre', { class: 'code' }, r.nodes.slice(0, 3).map(n => E.snippet(n, 3000)).join('\n\n'))) : null));
    }
    if (other.length) {
      list.append(h('details', { class: 'xml' },
        h('summary', null, other.length + (other.length === 1 ? ' riga senza percorso, non analizzata' : ' righe senza percorso, non analizzate')),
        h('pre', { class: 'code' }, other.map(o => o.raw).join('\n'))));
    }
  }
  function addRuleFromError(e, a) {
    const generic = $('#err-generic').checked;
    const verb = a.action === 'remove' ? 'Rimuovi' : 'Segnala';
    S.custom.push({ id: uid(), enabled: true, desc: verb + ' per errore: ' + e.raw.slice(0, 120), xpath: generic ? a.generic : a.xpath, action: a.action, value: '', fromError: e.raw });
    save();
    renderCustom();
    schedule(renderErrors);
    toast('Regola aggiunta alle regole personalizzate');
  }

  // ------------------------------------------------------------------ esecuzione
  let timer = null;
  let pending = [];
  function schedule(cb) {
    if (cb) pending.push(cb);
    clearTimeout(timer);
    timer = setTimeout(runNow, 120);
  }
  function runNow() {
    if (!S.src || !S.src.doc) {
      S.result = null;
    } else {
      try {
        S.result = E.run(S.src.doc, { model: S.model, customPorts: S.customPorts, map: S.map, rules: S.rules, customRules: S.custom }, hasTgt() ? S.tgt.doc : null);
      } catch (err) {
        S.result = { fatal: err.message || String(err) };
        if (window.console) console.error(err);
      }
    }
    renderResult();
    renderFaceplate();
    renderCustomHits();
    const cbs = pending;
    pending = [];
    cbs.forEach(f => f());
  }

  // ------------------------------------------------------------------ risultato
  const LEVELS = [['error', 'Errori'], ['manual', 'Da fare a mano'], ['check', 'Da verificare'], ['done', 'Applicate']];
  const LEVEL_ORDER = { error: 0, manual: 1, check: 2, done: 3, info: 4 };
  const LEVEL_NAME = { error: 'Errore', manual: 'Da fare a mano', check: 'Da verificare', done: 'Applicata', info: 'Nota' };
  const TABS = [['report', 'Report'], ['load', 'Caricamento'], ['xpath', 'XPath'], ['counts', 'Conteggi']];

  function renderResult() {
    const body = $('#r-body');
    const meta = $('#r-meta');
    const R = S.result;
    if (!R) {
      meta.textContent = '';
      body.replaceChildren(h('p', { class: 'empty' }, 'Carica la config sorgente: qui compaiono il report della conversione e il file da scaricare.'));
      return;
    }
    if (R.fatal) {
      meta.textContent = '';
      body.replaceChildren(h('p', { class: 'verdict bad' }, 'La conversione si è interrotta: ' + R.fatal));
      return;
    }
    meta.textContent = 'Config per ' + R.model.id + ', elaborata in ' + R.ms + ' ms.';
    const st = R.stats;
    const verdict = st.error
      ? h('p', { class: 'verdict bad' }, st.error === 1 ? 'Un errore da correggere prima del caricamento.' : st.error + ' errori da correggere prima del caricamento.')
      : h('p', { class: 'verdict good' }, 'Nessun errore noto: puoi caricare il file sul PA-500 e lanciare validate.');
    const levels = h('div', { class: 'levels', role: 'group', 'aria-label': 'Filtra il report per esito' },
      LEVELS.map(([lv, label]) => h('button', { type: 'button', class: 'lvl' + (st[lv] ? '' : ' zero'), dataset: { level: lv }, 'aria-pressed': S.filter === lv ? 'true' : 'false' },
        h('span', null, label), h('b', null, String(st[lv])))));
    const dl = h('div', { class: 'dl' },
      h('div', { class: 'field' }, h('label', { for: 'out-name' }, 'Nome del file'), h('input', { type: 'text', id: 'out-name', value: S.outName, spellcheck: 'false' })),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', id: 'btn-dl-xml' }, 'Scarica config'),
        h('button', { type: 'button', class: 'btn', id: 'btn-dl-report' }, 'Scarica report')));
    const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Dettagli' },
      TABS.map(([id, label]) => h('button', { type: 'button', class: 'tab', role: 'tab', id: 'tab-' + id, tabindex: S.tab === id ? '0' : '-1', 'aria-selected': S.tab === id ? 'true' : 'false', 'aria-controls': 'r-panel', dataset: { tab: id } }, label)));
    const panel = h('div', { class: 'panel', id: 'r-panel', role: 'tabpanel', 'aria-labelledby': 'tab-' + S.tab });
    if (S.tab === 'report') reportPanel(panel);
    else if (S.tab === 'load') loadPanel(panel);
    else if (S.tab === 'xpath') xpathPanel(panel);
    else countsPanel(panel);
    body.replaceChildren(verdict, levels, dl, tabs, panel);
  }

  function reportPanel(panel) {
    const items = S.result.report
      .map((it, i) => Object.assign({ i }, it))
      .filter(it => (S.filter ? it.level === S.filter : true))
      .sort((a, b) => (LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]) || (a.i - b.i));
    if (S.filter) panel.append(h('button', { type: 'button', class: 'btn quiet', onclick: () => { S.filter = null; renderResult(); } }, 'Mostra tutte le voci'));
    if (!items.length) { panel.append(h('p', { class: 'empty' }, 'Nessuna voce in questa categoria.')); return; }
    const ul = h('ul', { class: 'ritems' });
    for (const it of items) {
      ul.append(h('li', { class: 'ritem', dataset: { level: it.level } },
        h('span', { class: 'dot', title: LEVEL_NAME[it.level] }),
        h('div', null, h('div', { class: 'area' }, it.area + ', ' + LEVEL_NAME[it.level].toLowerCase()), h('div', { class: 'msg' }, rich(it.msg))),
        it.xpath ? h('div', { class: 'xpath' }, it.xpath, ' ',
          h('button', { type: 'button', class: 'btn quiet', style: 'font-family:var(--font);font-size:12.5px;padding:0 4px', onclick: () => {
            S.custom.push({ id: uid(), enabled: true, desc: it.msg.replace(/`/g, '').slice(0, 120), xpath: it.xpath, action: 'report', value: '' });
            save(); renderCustom(); schedule(renderErrors);
            toast('Regola aggiunta: scegli l\'azione nelle regole personalizzate');
          } }, 'Crea una regola')) : null,
        it.xml ? h('details', { class: 'xml' }, h('summary', null, 'XML originale'), h('pre', { class: 'code' }, it.xml)) : null));
    }
    panel.append(ul);
  }

  function codeBlock(text) {
    return h('div', { class: 'cmd' }, h('button', { type: 'button', class: 'btn', onclick: () => copy(text) }, 'Copia'), h('pre', { class: 'code' }, text));
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copiato negli appunti');
    } catch (e) {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      ta.remove();
      toast(ok ? 'Copiato negli appunti' : 'Copia non riuscita: seleziona il testo a mano');
    }
  }
  function loadPanel(panel) {
    const f = S.outName || 'config-pa500.xml';
    const devName = (S.src.info.devices[0] || {}).name;
    const cmds = E.loadCommands(f, devName);
    const keepsMgmt = hasTgt() && S.rules.keepMgmt;
    panel.append(h('ol', { class: 'steps-load' },
      h('li', null,
        h('p', null, 'Importa il file sul PA-500 da Device > Setup > Operations > Import named configuration snapshot, oppure dalla CLI:'),
        codeBlock('scp import configuration from utente@host:/percorso/' + f)),
      h('li', null,
        h('p', null, keepsMgmt
          ? 'Caricamento completo (Load named configuration snapshot o CLI). Management e hostname restano quelli del PA-500.'
          : 'Caricamento completo (Load named configuration snapshot o CLI). Sostituisce tutta la candidate, management compreso: carica la config del PA-500 al passo 1 per conservarne l\'accesso.'),
        codeBlock(cmds.full)),
      h('li', null,
        h('p', null, 'Oppure caricamento parziale: sostituisce solo oggetti condivisi, rete e vsys, e lascia intatti management, HA e amministratori del PA-500.'),
        codeBlock(cmds.partial)),
      h('li', null, h('p', null, 'Se validate restituisce errori, incollali al passo 4. Quando è pulito, esegui il commit.'))));
  }
  function xpathPanel(panel) {
    const inp = h('input', { type: 'text', value: S.xpq, spellcheck: 'false', 'aria-label': 'XPath da cercare nella config convertita' });
    const out = h('div');
    const go = () => {
      S.xpq = inp.value.trim();
      out.replaceChildren();
      if (!S.xpq) return;
      let nodes;
      try { nodes = E.evalXPath(S.result.doc, S.xpq); }
      catch (e) { out.append(h('p', { class: 'verdict bad' }, 'XPath non valido: ' + (e.message || e))); return; }
      out.append(h('p', { class: 'small' }, nodes.length + (nodes.length === 1 ? ' nodo trovato' : ' nodi trovati') + (nodes.length > 20 ? ', mostrati i primi 20' : '') + '.'));
      for (const n of nodes.slice(0, 20)) out.append(h('pre', { class: 'code' }, n.nodeType === 1 ? E.snippet(n, 20000) : String(n.nodeValue != null ? n.nodeValue : n.textContent)));
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    panel.append(
      h('p', { class: 'small' }, 'Cerca nella config convertita: serve a controllare il risultato e a scrivere le regole personalizzate.'),
      h('div', { class: 'xp-row' }, inp, h('button', { type: 'button', class: 'btn', onclick: go }, 'Cerca')),
      h('button', { type: 'button', class: 'btn quiet', onclick: () => {
        S.custom.push({ id: uid(), enabled: true, desc: '', xpath: inp.value.trim(), action: 'report', value: '' });
        save(); renderCustom(); schedule(); toast('Regola aggiunta alle regole personalizzate');
      } }, 'Crea una regola con questo XPath'),
      out);
    go();
  }
  function countsPanel(panel) {
    const mid = S.result.model.id;
    const lim = S.limits[mid] || {};
    const tb = h('tbody');
    for (const c of S.result.counts) {
      const l = lim[c.label];
      const over = l && /^\d+$/.test(l) && c.value > +l;
      tb.append(h('tr', { class: over ? 'over' : '' },
        h('td', null, c.label),
        h('td', { class: 'n' }, String(c.value)),
        h('td', { class: 'lim' }, h('input', { type: 'text', inputmode: 'numeric', value: l || '', placeholder: 'limite', 'aria-label': 'Limite del ' + mid + ' per ' + c.label, dataset: { label: c.label } }))));
    }
    tb.addEventListener('change', e => {
      const inp = e.target.closest('input');
      if (!inp) return;
      (S.limits[mid] = S.limits[mid] || {})[inp.dataset.label] = inp.value.trim();
      save();
      renderResult();
    });
    panel.append(
      h('p', { class: 'small' }, 'Oggetti nella config convertita. Inserisci i limiti del ' + mid + ' presi dalla scheda tecnica per evidenziare quelli superati: restano salvati in questo browser.'),
      h('table', { class: 'counts' }, tb));
  }

  // ------------------------------------------------------------------ download
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }
  function targetLabel(it) {
    const v = S.map[it.key];
    if (replacedByTarget(it)) return 'sostituita dall\'HA del PA-500';
    if (v === E.DROP) return 'esclusa';
    if (!v) return it.kind === 'ae' ? it.key : 'non assegnata';
    return v;
  }
  function reportMarkdown() {
    const R = S.result;
    const L = [];
    const d = S.src.info.devices[0];
    L.push('# Conversione per ' + R.model.id, '');
    L.push('- Sorgente: ' + S.src.fileName + ' (PAN-OS ' + (S.src.info.version || '?') + ', hostname ' + (d.hostname || '?') + ')');
    if (hasTgt()) L.push('- Config del PA-500: ' + S.tgt.fileName + ' (hostname ' + (S.tgt.info.devices[0].hostname || '?') + ')');
    L.push('- File generato: ' + (S.outName || 'config-pa500.xml'));
    L.push('- Data: ' + new Date().toLocaleString('it-IT'), '');
    L.push('| Errori | Da fare a mano | Da verificare | Applicate |', '|---:|---:|---:|---:|', '| ' + R.stats.error + ' | ' + R.stats.manual + ' | ' + R.stats.check + ' | ' + R.stats.done + ' |', '');
    if (srcInv().length) {
      L.push('## Porte', '', '| Sorgente | Tipo | ' + R.model.id + ' |', '|---|---|---|');
      for (const it of srcInv()) L.push('| ' + it.key + ' | ' + (KIND[it.kind] || it.kind) + ' | ' + targetLabel(it) + ' |');
      L.push('');
    }
    const on = RULES.filter(r => S.rules[r.id] && (!r.needsTgt || hasTgt()) && (!r.parent || S.rules[r.parent])).map(r => r.title);
    L.push('## Regole applicate', '', ...on.map(t => '- ' + t), '- Controlli di piattaforma', '');
    for (const [lv, title] of [['error', 'Errori'], ['manual', 'Da fare a mano'], ['check', 'Da verificare'], ['done', 'Applicate'], ['info', 'Note']]) {
      const items = R.report.filter(i => i.level === lv);
      if (!items.length) continue;
      L.push('## ' + title, '');
      for (const it of items) {
        L.push('- **' + it.area + '**: ' + it.msg);
        if (it.xpath) L.push('  - XPath: `' + it.xpath + '`');
        if (it.xml) L.push('', '  ```xml', ...it.xml.split('\n').map(l => '  ' + l), '  ```', '');
      }
      L.push('');
    }
    const cr = S.custom.filter(r => r.enabled !== false && r.xpath);
    if (cr.length) {
      L.push('## Regole personalizzate', '');
      for (const r of cr) L.push('- ' + (r.desc ? r.desc + ': ' : '') + '`' + r.action + '` su `' + r.xpath + '`' + (r.value ? ' (valore `' + r.value + '`)' : ''));
      L.push('');
    }
    L.push('## Conteggi', '', '| Oggetto | Numero |', '|---|---:|', ...R.counts.map(c => '| ' + c.label + ' | ' + c.value + ' |'), '');
    return L.join('\n');
  }

  // ------------------------------------------------------------------ eventi
  function wire() {
    for (const box of $$('.drop')) {
      const slot = box.dataset.slot;
      box.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('is-over'); });
      box.addEventListener('dragleave', e => { if (!box.contains(e.relatedTarget)) box.classList.remove('is-over'); });
      box.addEventListener('drop', e => {
        e.preventDefault();
        box.classList.remove('is-over');
        const f = e.dataTransfer && e.dataTransfer.files[0];
        if (f) loadSlot(slot, f);
      });
    }
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => e.preventDefault());
    for (const inp of $$('input[data-file]')) {
      inp.addEventListener('change', () => {
        const f = inp.files[0];
        if (f) loadSlot(inp.dataset.file, f);
        inp.value = '';
      });
    }

    $('#model').addEventListener('change', e => {
      S.model = e.target.value;
      $('#custom-ports-field').hidden = S.model !== 'custom';
      remapForModel(); save(); renderMap(); schedule();
    });
    $('#custom-ports').addEventListener('input', e => {
      S.customPorts = e.target.value;
      save(); remapForModel(); renderMap(); schedule();
    });

    $('#faceplate').addEventListener('click', e => {
      const b = e.target.closest('.port');
      if (!b) return;
      const port = b.dataset.port;
      if (S.sel) { assign(S.sel, port); return; }
      const holder = srcInv().find(it => !replacedByTarget(it) && S.map[it.key] === port);
      if (holder) {
        S.sel = holder.key;
        renderMap();
        const row = $('tr[data-key="' + CSS.escape(holder.key) + '"]');
        if (row) row.scrollIntoView({ block: 'nearest' });
      } else if (srcInv().length) {
        toast('Porta libera: seleziona prima un\'interfaccia nella tabella.');
      }
    });
    $('#map-wrap').addEventListener('click', e => {
      if (e.target.closest('[data-act="source-ha"]')) {
        S.rules.keepHA = false;
        save(); renderRules(); renderMap(); schedule();
        toast('Ora scegli le porte del PA-500 per i link HA della sorgente');
        return;
      }
      const b = e.target.closest('.if-pick');
      if (!b) return;
      const key = b.closest('tr').dataset.key;
      S.sel = S.sel === key ? null : key;
      renderMap();
      if (S.sel) toast('Ora clicca una porta del pannello per ' + key);
    });
    $('#map-wrap').addEventListener('change', e => {
      const sel = e.target.closest('select[data-key]');
      if (!sel) return;
      S.map[sel.dataset.key] = sel.value;
      renderMap();
      schedule();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && S.sel) { S.sel = null; renderMap(); }
    });
    $('#btn-drop-unused').addEventListener('click', () => {
      let n = 0;
      for (const it of srcInv()) {
        if (!it.used && (it.kind === 'ethernet' || it.kind === 'ae') && S.map[it.key] !== E.DROP) { S.map[it.key] = E.DROP; n++; }
      }
      renderMap(); schedule();
      toast(n ? (n === 1 ? 'Esclusa 1 interfaccia non usata' : 'Escluse ' + n + ' interfacce non usate') : 'Nessuna interfaccia inutilizzata');
    });
    $('#btn-ha-ports').addEventListener('click', () => {
      const m = model();
      const taken = new Set(Object.values(S.map));
      for (const p of targetHaPorts().keys()) taken.add(p);
      const rank = { 'SFP+': 0, 'SFP': 1, 'mGig': 2, 'RJ-45': 3 };
      const free = m.ports.filter(p => !taken.has(p.name));
      let n = 0;
      for (const it of srcInv()) {
        if (!it.ha.length || replacedByTarget(it)) continue;
        const v = S.map[it.key];
        const ok = it.kind === 'ha-dedicated' ? (v === E.MGMT || v === E.DROP || m.byName.has(v)) : (v === E.DROP || m.byName.has(v || it.key));
        if (ok) continue;
        const ha2 = it.ha.some(sec => sec.startsWith('ha2') || sec === 'ha3');
        // HA2 trasporta la sincronizzazione delle sessioni: meglio la porta più veloce; HA1 sta su una RJ-45
        const pool = free.slice().sort((a, b) => ha2 ? (rank[a.type] - rank[b.type]) || (b.n - a.n) : (rank[b.type] - rank[a.type]) || (b.n - a.n));
        const pick = pool[0];
        if (!pick) break;
        S.map[it.key] = pick.name;
        free.splice(free.indexOf(pick), 1);
        n++;
      }
      renderMap(); schedule();
      toast(n ? (n === 1 ? 'Assegnata 1 porta a un link HA' : 'Assegnate ' + n + ' porte ai link HA') + ': controlla la scelta in tabella' : 'Tutti i link HA hanno già una porta valida');
    });
    $('#btn-reset-map').addEventListener('click', () => {
      S.map = E.defaultMap(srcInv(), model());
      S.sel = null;
      renderMap(); schedule();
    });

    $('#rules').addEventListener('change', e => {
      const cb = e.target.closest('input[data-rule]');
      if (!cb) return;
      S.rules[cb.dataset.rule] = cb.checked;
      save(); renderRules(); renderMap(); schedule();
    });

    $('#btn-add-rule').addEventListener('click', () => {
      S.custom.push({ id: uid(), enabled: true, desc: '', xpath: '', action: 'remove', value: '' });
      save(); renderCustom();
      const rows = $$('.crule');
      const last = rows[rows.length - 1];
      if (last) $('.xp', last).focus();
    });
    const list = $('#custom-list');
    list.addEventListener('input', e => {
      const f = e.target.dataset.f;
      const r = customRuleOf(e.target);
      if (!r || !f || e.target.type === 'checkbox' || e.target.tagName === 'SELECT') return;
      r[f] = e.target.value;
      save();
      schedule(renderErrors);
    });
    list.addEventListener('change', e => {
      const f = e.target.dataset.f;
      const r = customRuleOf(e.target);
      if (!r || !f) return;
      if (e.target.type === 'checkbox') r.enabled = e.target.checked;
      else if (e.target.tagName === 'SELECT') r.action = e.target.value;
      else return;
      save(); renderCustom(); schedule(renderErrors);
    });
    list.addEventListener('click', e => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const r = customRuleOf(b);
      const i = S.custom.indexOf(r);
      if (i < 0) return;
      if (b.dataset.act === 'del') S.custom.splice(i, 1);
      else if (b.dataset.act === 'up' && i > 0) S.custom.splice(i - 1, 0, S.custom.splice(i, 1)[0]);
      save(); renderCustom(); schedule(renderErrors);
    });
    $('#btn-export-rules').addEventListener('click', () => {
      if (!S.custom.length) { toast('Non ci sono regole personalizzate da esportare'); return; }
      download('regole-pa500.json', JSON.stringify({ format: 'pa500-adapter-rules', version: 1, rules: S.custom.map(({ id, enabled, desc, xpath, action, value, pattern }) => ({ id, enabled, desc, xpath, action, value, pattern })) }, null, 2), 'application/json');
    });
    $('#file-rules').addEventListener('change', async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const rules = Array.isArray(data) ? data : data.rules;
        if (!Array.isArray(rules)) throw new Error('il file non contiene un elenco di regole');
        let n = 0;
        for (const r of rules) {
          if (!r || typeof r.xpath !== 'string' || !ACTIONS.some(a => a[0] === r.action)) continue;
          if (S.custom.some(c => c.xpath === r.xpath && c.action === r.action && (c.value || '') === (r.value || ''))) continue;
          S.custom.push({ id: uid(), enabled: r.enabled !== false, desc: String(r.desc || ''), xpath: r.xpath, action: r.action, value: String(r.value || ''), pattern: r.pattern ? String(r.pattern) : '' });
          n++;
        }
        save(); renderCustom(); schedule(renderErrors);
        toast(n ? (n === 1 ? 'Importata 1 regola' : 'Importate ' + n + ' regole') : 'Nessuna regola nuova nel file');
      } catch (err) {
        toast('Importazione non riuscita: ' + (err.message || err));
      }
    });

    $('#btn-errors').addEventListener('click', () => {
      S.errs = E.parseCommitErrors($('#errors').value);
      if (!S.errs.length) toast('Incolla prima l\'output di validate o del commit');
      renderErrors();
    });

    const rb = $('#r-body');
    rb.addEventListener('click', e => {
      const lv = e.target.closest('.lvl');
      if (lv) {
        S.filter = S.filter === lv.dataset.level ? null : lv.dataset.level;
        S.tab = 'report';
        renderResult();
        return;
      }
      const tb = e.target.closest('.tab');
      if (tb) { S.tab = tb.dataset.tab; renderResult(); $('#tab-' + S.tab).focus(); return; }
      if (e.target.closest('#btn-dl-xml')) {
        if (!S.result || !S.result.doc) return;
        download(S.outName.trim() || 'config-pa500.xml', E.serialize(S.result.doc), 'application/xml');
      }
      if (e.target.closest('#btn-dl-report')) {
        if (!S.result || !S.result.doc) return;
        const base = (S.outName.trim() || 'config-pa500.xml').replace(/\.xml$/i, '');
        download(base + '-report.md', reportMarkdown(), 'text/markdown');
      }
    });
    rb.addEventListener('keydown', e => {
      const tb = e.target.closest('.tab');
      if (!tb || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
      const ids = TABS.map(t => t[0]);
      const i = ids.indexOf(tb.dataset.tab);
      S.tab = ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
      renderResult();
      $('#tab-' + S.tab).focus();
    });
    rb.addEventListener('input', e => {
      if (e.target.id === 'out-name') { S.outName = e.target.value; S.outNameEdited = true; }
    });
  }

  renderModelSelect();
  renderSlots();
  renderRules();
  renderCustom();
  renderMap();
  renderResult();
  wire();
})();
