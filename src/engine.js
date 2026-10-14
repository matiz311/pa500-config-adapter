/*
 * Motore di conversione: config PAN-OS (XML) -> config accettata dai firewall PA-500 (PAN-OS 12.1).
 * Nessuna dipendenza: usa solo DOMParser, XPath e DOM standard del browser.
 *
 * Nomi degli elementi dell'Advanced Routing Engine verificati sugli schemi pubblicati da
 * Palo Alto (pan-os-codegen) e sull'SDK pan-os-python:
 *   deviceconfig/setting/advance-routing, network/logical-router/entry/vrf/entry/...,
 *   network/routing-profile/..., vsys/entry/import/network/logical-router.
 */
(function (root) {
  'use strict';

  const DROP = '__drop__';
  const MGMT = 'management';

  // ------------------------------------------------------------------ modelli PA-500
  // Porte dedotte dai pannelli frontali della PA-500 Hardware Reference; la porta N è ethernet1/N.
  const MODELS = [
    { id: 'PA-501', groups: [['RJ-45', 1000, 1, 7]] },
    { id: 'PA-505', groups: [['RJ-45', 1000, 1, 7]] },
    { id: 'PA-510', groups: [['RJ-45', 1000, 1, 8]] },
    { id: 'PA-520', groups: [['RJ-45', 1000, 1, 8]], ztp: 1 },
    { id: 'PA-520-5G', groups: [['RJ-45', 1000, 1, 8], ['SFP', 1000, 9, 10]], ztp: 1, failOpen: [3, 4], cellular: ['cellular1/1'] },
    { id: 'PA-540', groups: [['RJ-45', 1000, 1, 8], ['SFP', 1000, 9, 10]], ztp: 1 },
    { id: 'PA-545-POE', groups: [['RJ-45', 1000, 1, 8], ['mGig', 2500, 9, 12], ['SFP', 1000, 13, 16]], ztp: 1, failOpen: [3, 4], poe: [9, 10, 11, 12] },
    { id: 'PA-550', groups: [['RJ-45', 1000, 1, 12], ['SFP', 1000, 13, 14], ['SFP+', 10000, 15, 16]], ztp: 1, failOpen: [3, 4] },
    { id: 'PA-555-POE', groups: [['RJ-45', 1000, 1, 8], ['mGig', 2500, 9, 12], ['SFP', 1000, 13, 14], ['SFP+', 10000, 15, 16]], ztp: 1, failOpen: [3, 4], poe: [5, 6, 7, 8, 9, 10, 11, 12] },
    { id: 'PA-560', groups: [['RJ-45', 1000, 1, 16], ['SFP', 1000, 17, 20], ['SFP+', 10000, 21, 24]], ztp: 1, failOpen: [3, 4] }
  ];

  const PORT_TYPES = { 'rj45': ['RJ-45', 1000], 'rj-45': ['RJ-45', 1000], 'mgig': ['mGig', 2500], 'sfp': ['SFP', 1000], 'sfp+': ['SFP+', 10000] };

  /** Restituisce {id, ports:[{name,n,type,speed,poe,failOpen,ztp}], groups, cellular[]} */
  function getModel(id, customSpec) {
    let m = MODELS.find(x => x.id === id);
    let groups;
    if (!m) {
      groups = parseCustomPorts(customSpec || '');
      m = { id: 'Personalizzato', groups: [], cellular: [] };
    } else {
      groups = m.groups.map(g => ({ type: g[0], speed: g[1], from: g[2], to: g[3] }));
    }
    const ports = [];
    for (const g of groups) {
      for (let n = g.from; n <= g.to; n++) {
        ports.push({
          name: 'ethernet1/' + n, n, type: g.type, speed: g.speed,
          poe: !!(m.poe && m.poe.includes(n)), failOpen: !!(m.failOpen && m.failOpen.includes(n)), ztp: m.ztp === n
        });
      }
    }
    return { id: m.id, groups, ports, cellular: m.cellular || [], byName: new Map(ports.map(p => [p.name, p])) };
  }

  /** "1-12 rj45, 13-14 sfp, 15-16 sfp+" -> gruppi */
  function parseCustomPorts(spec) {
    const groups = [];
    for (const raw of spec.split(/[,;\n]+/)) {
      const t = raw.trim().toLowerCase();
      if (!t) continue;
      const m = /^(?:ethernet1\/)?(\d+)(?:\s*-\s*(?:ethernet1\/|1\/)?(\d+))?\s*([a-z0-9+\-]*)$/.exec(t);
      if (!m) continue;
      const from = +m[1], to = m[2] ? +m[2] : from;
      const pt = PORT_TYPES[m[3] || 'rj45'] || PORT_TYPES.rj45;
      if (to >= from && to - from < 64) groups.push({ type: pt[0], speed: pt[1], from, to });
    }
    return groups;
  }

  // ------------------------------------------------------------------ helper XML
  function kids(el, tag) {
    const out = [];
    if (!el) return out;
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (!tag || c.tagName === tag) out.push(c);
    return out;
  }
  function kid(el, tag) {
    if (!el) return null;
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (c.tagName === tag) return c;
    return null;
  }
  function at(el, path) {
    let cur = el;
    for (const t of path.split('/')) { cur = kid(cur, t); if (!cur) return null; }
    return cur;
  }
  function all(el, path) {
    let cur = el ? [el] : [];
    for (const t of path.split('/')) {
      const nxt = [];
      for (const c of cur) for (const k of kids(c, t)) nxt.push(k);
      cur = nxt;
    }
    return cur;
  }
  function txt(el, path) {
    const n = path ? at(el, path) : el;
    return n ? n.textContent.trim() : null;
  }
  function mk(doc, tag, text) {
    const e = doc.createElement(tag);
    if (text != null) e.textContent = String(text);
    return e;
  }
  function add(parent, tag, text) {
    const e = mk(parent.ownerDocument, tag, text);
    parent.appendChild(e);
    return e;
  }
  function ensure(el, path) {
    let cur = el;
    for (const t of path.split('/')) cur = kid(cur, t) || add(cur, t);
    return cur;
  }
  function ent(parent, name) {
    if (!parent) return null;
    for (let c = parent.firstElementChild; c; c = c.nextElementSibling) {
      if (c.tagName === 'entry' && c.getAttribute('name') === name) return c;
    }
    return null;
  }
  function ensureEnt(parent, name) {
    let e = ent(parent, name);
    if (!e) { e = add(parent, 'entry'); e.setAttribute('name', name); }
    return e;
  }
  function setText(el, path, value) {
    const n = ensure(el, path);
    while (n.firstChild) n.removeChild(n.firstChild);
    n.textContent = String(value);
    return n;
  }
  function cloneTo(parent, node) {
    const c = parent.ownerDocument.importNode(node, true);
    parent.appendChild(c);
    return c;
  }
  function copyLeaf(src, dst, tag, dstTag) {
    const v = txt(src, tag);
    if (v != null && v !== '') add(dst, dstTag || tag, v);
  }
  function detach(n) { if (n && n.parentNode) n.parentNode.removeChild(n); }
  function members(el) { return kids(el, 'member').map(m => m.textContent.trim()); }
  function nameOf(el) { return el ? el.getAttribute('name') : null; }
  function hasContent(el) { return !!el && (!!el.firstElementChild || el.textContent.trim() !== ''); }
  function firstChildTag(el) { return el && el.firstElementChild ? el.firstElementChild.tagName : null; }
  function isPrefix(s) { return /^[0-9a-f:.]+\/\d{1,3}$/i.test(s) && (s.includes('.') || s.includes(':')); }

  // ------------------------------------------------------------------ serializzazione
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;'); }

  function writeEl(el, depth, out) {
    const ind = '  '.repeat(depth);
    let open = ind + '<' + el.tagName;
    for (const a of Array.from(el.attributes)) open += ' ' + a.name + '="' + escAttr(a.value) + '"';
    if (!el.firstElementChild) {
      let t = '';
      for (let c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) t += esc(c.nodeValue);
        else if (c.nodeType === 4) t += '<![CDATA[' + c.nodeValue + ']]>';
      }
      out.push(t === '' ? open + '/>\n' : open + '>' + t + '</' + el.tagName + '>\n');
      return;
    }
    out.push(open + '>\n');
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1) writeEl(c, depth + 1, out);
      else if (c.nodeType === 3 && c.nodeValue.trim() !== '') out.push(ind + '  ' + esc(c.nodeValue.trim()) + '\n');
      else if (c.nodeType === 4) out.push(ind + '  <![CDATA[' + c.nodeValue + ']]>\n');
      else if (c.nodeType === 8) out.push(ind + '  <!--' + c.nodeValue + '-->\n');
    }
    out.push(ind + '</' + el.tagName + '>\n');
  }
  function serialize(doc) {
    const out = ['<?xml version="1.0"?>\n'];
    writeEl(doc.documentElement, 0, out);
    return out.join('');
  }
  function snippet(el, max) {
    const out = [];
    writeEl(el, 0, out);
    const s = out.join('').replace(/\n$/, '');
    const lim = max || 6000;
    return s.length > lim ? s.slice(0, lim) + '\n<!-- ... troncato ... -->' : s;
  }
  function signature(el) {
    const out = [];
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) writeEl(c, 0, out);
    return out.join('');
  }

  function parse(text) {
    const doc = new root.DOMParser().parseFromString(text, 'application/xml');
    const perr = doc.getElementsByTagName('parsererror')[0];
    if (perr) {
      const msg = (perr.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      throw new Error('Il file non è un XML valido. ' + msg);
    }
    return doc;
  }

  // ------------------------------------------------------------------ XPath e percorsi
  function xq(s) {
    if (!s.includes("'")) return "'" + s + "'";
    if (!s.includes('"')) return '"' + s + '"';
    return 'concat(' + s.split("'").map(p => "'" + p + "'").join(", \"'\", ") + ')';
  }
  function xpathOf(node, generic) {
    const parts = [];
    let n = node;
    if (n.nodeType === 2) { parts.unshift('@' + n.name); n = n.ownerElement; }
    else if (n.nodeType === 3) { parts.unshift('text()'); n = n.parentNode; }
    for (; n && n.nodeType === 1; n = n.parentNode) {
      let step = n.tagName;
      const nm = n.getAttribute('name');
      if (nm != null) { if (!generic) step += '[@name=' + xq(nm) + ']'; }
      else if (n.tagName === 'member') step += '[.=' + xq(n.textContent.trim()) + ']';
      else if (!generic && n.parentNode && n.parentNode.nodeType === 1) {
        const same = kids(n.parentNode, n.tagName);
        if (same.length > 1) step += '[' + (same.indexOf(n) + 1) + ']';
      }
      parts.unshift(step);
    }
    return '/' + parts.join('/');
  }
  /** Percorso leggibile: devices › localhost.localdomain › network › ... */
  function humanPath(node) {
    const parts = [];
    for (let n = node; n && n.nodeType === 1; n = n.parentNode) {
      const nm = n.getAttribute('name');
      parts.unshift(n.tagName === 'entry' && nm != null ? nm : n.tagName);
    }
    if (parts[0] === 'config') parts.shift();
    return parts.join(' › ');
  }
  function evalXPath(doc, expr) {
    const res = doc.evaluate(expr, doc, null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null);
    const out = [];
    for (let i = 0; i < res.snapshotLength; i++) out.push(res.snapshotItem(i));
    return out;
  }

  // ------------------------------------------------------------------ report
  function Report() { this.items = []; }
  Report.prototype.add = function (level, area, msg, extra) {
    this.items.push(Object.assign({ level, area, msg }, extra || {}));
  };

  // ------------------------------------------------------------------ inventario
  const MODE_TAGS = ['layer3', 'layer2', 'virtual-wire', 'tap', 'ha', 'aggregate-group', 'decrypt-mirror', 'log-card'];
  const DEDICATED_HA = /^(ha1-a|ha1-b|ha2-a|ha2-b|hsci|dedicated-ha1|dedicated-ha2|ha1|ha2)$/i;
  const HA_SECTIONS = ['ha1', 'ha1-backup', 'ha2', 'ha2-backup', 'ha3'];

  /** [sezione, porta, implicita]: senza <port> HA1/HA2 usano la porta dedicata di default della piattaforma. */
  function haSectionPorts(dev) {
    const ha = at(dev, 'deviceconfig/high-availability');
    const out = [];
    if (!ha) return out;
    const enabled = txt(ha, 'enabled') === 'yes';
    for (const s of HA_SECTIONS) {
      const sec = at(ha, 'interface/' + s);
      if (!sec) continue;
      const p = txt(sec, 'port');
      if (p) out.push([s, p, false]);
      else if ((s === 'ha1' || s === 'ha2') && (enabled || hasContent(sec))) out.push([s, 'dedicated-' + s, true]);
    }
    return out;
  }

  function ifMode(e) {
    for (const t of MODE_TAGS) if (kid(e, t)) return t;
    return '';
  }
  function unitNames(e) {
    const out = [];
    for (const mode of ['layer3', 'layer2']) for (const u of all(e, mode + '/units/entry')) out.push(nameOf(u));
    return out;
  }
  function baseName(n) { return n.replace(/\.\d+$/, ''); }

  function interfaceInventory(dev) {
    const zones = new Map(), routers = new Map();
    const push = (map, key, v) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(v); };
    for (const z of all(dev, 'vsys/entry/zone/entry')) {
      const net = kid(z, 'network');
      for (const t of kids(net)) for (const m of members(t)) push(zones, baseName(m), nameOf(z));
    }
    for (const vr of all(dev, 'network/virtual-router/entry')) for (const m of members(kid(vr, 'interface'))) push(routers, baseName(m), nameOf(vr));
    for (const lr of all(dev, 'network/logical-router/entry')) {
      for (const vrf of all(lr, 'vrf/entry')) for (const m of members(kid(vrf, 'interface'))) push(routers, baseName(m), nameOf(lr));
    }
    const ha = new Map();
    for (const [s, p] of haSectionPorts(dev)) push(ha, p, s);
    const inv = [];
    const aeMembers = new Map();
    for (const e of all(dev, 'network/interface/ethernet/entry')) {
      const g = txt(e, 'aggregate-group');
      if (g) push(aeMembers, g, nameOf(e));
    }
    const describe = (e, kind) => {
      const name = nameOf(e);
      const units = unitNames(e);
      const ips = all(e, 'layer3/ip/entry').map(nameOf);
      return {
        key: name, kind, mode: ifMode(e), units, ips,
        dhcp: !!at(e, 'layer3/dhcp-client'), pppoe: !!at(e, 'layer3/pppoe'),
        ae: txt(e, 'aggregate-group'), linkSpeed: txt(e, 'link-speed'), poe: !!kid(e, 'poe'),
        zones: [...(zones.get(name) || [])], routers: [...(routers.get(name) || [])],
        ha: [...(ha.get(name) || [])], members: [...(aeMembers.get(name) || [])],
        comment: txt(e, 'comment') || ''
      };
    };
    for (const e of all(dev, 'network/interface/ethernet/entry')) inv.push(describe(e, 'ethernet'));
    for (const e of all(dev, 'network/interface/aggregate-ethernet/entry')) inv.push(describe(e, 'ae'));
    for (const c of kids(at(dev, 'network/interface'))) {
      for (const e of kids(c, 'entry')) {
        if (/^cellular\d+\/\d+$/.test(nameOf(e) || '')) inv.push(describe(e, 'cellular'));
      }
    }
    for (const [port, secs] of ha) {
      if (DEDICATED_HA.test(port)) inv.push({ key: port, kind: 'ha-dedicated', mode: 'ha', units: [], ips: [], zones: [], routers: [], ha: [...secs], members: [], comment: '' });
    }
    for (const it of inv) {
      it.used = (!!it.mode && it.mode !== 'aggregate-group') || it.zones.length > 0 || it.routers.length > 0 || it.ha.length > 0 || it.units.length > 0;
    }
    for (const it of inv) {
      if (it.mode === 'aggregate-group' && it.ae) {
        const parent = inv.find(x => x.key === it.ae);
        it.used = parent ? parent.used : true;
      }
    }
    return inv;
  }

  function analyze(doc) {
    const r = doc.documentElement;
    const info = { version: r.getAttribute('version') || '', kind: 'firewall', devices: [], users: [], ok: true, problem: '' };
    if (r.tagName !== 'config') {
      info.ok = false;
      info.problem = 'Il file non è una configurazione PAN-OS: manca l\'elemento <config> iniziale.';
      return info;
    }
    if (all(r, 'devices/entry/device-group').length || all(r, 'devices/entry/template').length || all(r, 'devices/entry/template-stack').length) {
      info.kind = 'panorama';
      info.ok = false;
      info.problem = 'Sembra la configurazione di un Panorama. Carica l\'export del firewall (running-config.xml del dispositivo).';
    }
    for (const dev of all(r, 'devices/entry')) {
      info.devices.push({
        name: nameOf(dev),
        hostname: txt(dev, 'deviceconfig/system/hostname') || '',
        mgmtIp: txt(dev, 'deviceconfig/system/ip-address') || (at(dev, 'deviceconfig/system/type/dhcp-client') ? 'DHCP' : ''),
        are: txt(dev, 'deviceconfig/setting/advance-routing') || '',
        vsys: all(dev, 'vsys/entry').map(nameOf),
        vrs: all(dev, 'network/virtual-router/entry').map(nameOf),
        lrs: all(dev, 'network/logical-router/entry').map(nameOf),
        haEnabled: txt(dev, 'deviceconfig/high-availability/enabled') === 'yes',
        haPorts: haSectionPorts(dev).map(x => [x[0], x[1]]),
        interfaces: interfaceInventory(dev)
      });
    }
    if (!info.devices.length && info.ok) { info.ok = false; info.problem = 'Nella configurazione non c\'è nessun devices/entry.'; }
    info.users = all(r, 'mgt-config/users/entry').map(nameOf);
    return info;
  }

  /** Mappatura proposta: stesso nome se la porta esiste sul modello, altrimenti da scegliere. */
  function defaultMap(inv, model) {
    const map = {};
    for (const it of inv) {
      if (it.kind === 'ethernet') map[it.key] = model.byName.has(it.key) ? it.key : '';
      else if (it.kind === 'ae') map[it.key] = it.key;
      else if (it.kind === 'cellular') map[it.key] = model.cellular.includes(it.key) ? it.key : '';
      else if (it.kind === 'ha-dedicated') map[it.key] = '';
    }
    return map;
  }

  // ------------------------------------------------------------------ profili di routing (ARE)
  function profileStore(net) {
    return {
      /** Crea (o riusa se identico) un profilo; build(entry) lo riempie. */
      add(kindPath, baseName, build) {
        const tmp = mk(net.ownerDocument, 'entry');
        build(tmp);
        const sig = signature(tmp);
        const container = ensure(net, 'routing-profile/' + kindPath);
        for (const e of kids(container, 'entry')) if (signature(e) === sig) return nameOf(e);
        let name = baseName, i = 2;
        while (ent(container, name)) name = baseName + '-' + i++;
        tmp.setAttribute('name', name);
        container.appendChild(tmp);
        return name;
      },
      /** Copia un profilo legacy con lo stesso nome; in caso di conflitto lo rinomina. */
      copyNamed(kindPath, srcEntry) {
        const container = ensure(net, 'routing-profile/' + kindPath);
        const name = nameOf(srcEntry), sig = signature(srcEntry);
        const ex = ent(container, name);
        if (ex) {
          if (signature(ex) === sig) return name;
          let n2 = name, i = 2;
          while (ent(container, n2)) n2 = name + '-' + i++;
          cloneTo(container, srcEntry).setAttribute('name', n2);
          return n2;
        }
        cloneTo(container, srcEntry);
        return name;
      }
    };
  }

  // ------------------------------------------------------------------ regola: Advanced Routing
  const AD_MAP = {
    'static': ['static'], 'static-ipv6': ['static-ipv6'],
    'ospf-int': ['ospf-intra', 'ospf-inter'], 'ospf-ext': ['ospf-ext'],
    'ospfv3-int': ['ospfv3-intra', 'ospfv3-inter'], 'ospfv3-ext': ['ospfv3-ext'],
    'ibgp': ['bgp-internal'], 'ebgp': ['bgp-external'], 'rip': ['rip']
  };

  function ruleARE(ctx) {
    const { dev, R, opts } = ctx;
    const area = 'Routing';
    const net = ensure(dev, 'network');
    const vrRoot = kid(net, 'virtual-router');
    const vrs = kids(vrRoot, 'entry');
    const flag = txt(dev, 'deviceconfig/setting/advance-routing');
    const lrRoot = kid(net, 'logical-router');

    if (vrs.length && flag === 'yes' && kids(lrRoot, 'entry').length) {
      R.add('check', area, 'Advanced Routing era già attivo nella sorgente: rimossi i virtual router residui (' + vrs.map(nameOf).join(', ') + ') senza convertirli.', { xml: snippet(vrRoot, 3000) });
      detach(vrRoot);
    } else if (vrs.length) {
      const rp = profileStore(net);
      const lrs = ensure(net, 'logical-router');
      moveBfdProfiles(net, R, rp);
      for (const vr of vrs) {
        const name = nameOf(vr);
        if (ent(lrs, name)) {
          R.add('error', area, 'Esiste già un logical router `' + name + '`: il virtual router con lo stesso nome non è stato convertito.');
          continue;
        }
        lrs.appendChild(convertVR(ctx, vr, rp));
      }
      detach(vrRoot);
      R.add('done', area, 'Convertiti ' + vrs.length + ' virtual router in logical router (VRF `default`): ' + vrs.map(v => '`' + nameOf(v) + '`').join(', ') + '.');
    } else if (flag === 'yes') {
      R.add('info', area, 'Advanced Routing già attivo nella sorgente: nessuna conversione necessaria.');
    } else {
      R.add('info', area, 'Nessun virtual router nella sorgente.');
    }
    if (vrRoot && vrRoot.parentNode && !kids(vrRoot, 'entry').length) {
      detach(vrRoot);
      R.add('done', area, 'Rimosso `network/virtual-router`, vuoto: con l\'Advanced Routing non serve.');
    }
    haPathGroups(ctx);
    if (!all(dev, 'network/logical-router/entry').length) {
      const l3 = all(dev, 'network/interface/ethernet/entry').filter(e => kid(e, 'layer3')).length
        + all(dev, 'network/interface/aggregate-ethernet/entry').filter(e => kid(e, 'layer3')).length;
      const tun = all(dev, 'network/tunnel/ipsec/entry').length;
      if (l3) R.add('check', area, 'La config non ha nessun router: ' + l3 + (l3 === 1 ? ' interfaccia layer 3 non è associata' : ' interfacce layer 3 non sono associate') + ' a un logical router e non ci sono route' + (tun ? ', quindi anche i ' + tun + ' tunnel IPsec non possono instradare traffico' : '') + '. Va bene solo se il firewall non deve fare routing (per esempio in virtual wire); altrimenti il routing manca da questo export.');
    }

    const setting = ensure(dev, 'deviceconfig/setting');
    const legacyFlag = kid(setting, 'advanced-routing');
    if (legacyFlag) detach(legacyFlag);
    if (flag !== 'yes') {
      setText(setting, 'advance-routing', 'yes');
      R.add('done', area, 'Impostato `deviceconfig/setting/advance-routing` = yes (sui PA-500 non si può disattivare).');
    }

    const vsyses = all(dev, 'vsys/entry');
    for (const vsys of vsyses) {
      const imp = at(vsys, 'import/network/virtual-router');
      if (!imp) continue;
      const netImp = imp.parentNode;
      if (vsyses.length === 1) {
        detach(imp);
        R.add('done', area, 'vsys `' + nameOf(vsys) + '`: rimosso l\'import del virtual router; nelle configurazioni single-vsys il PA-500 usa il logical router senza importarlo nella vsys.');
        continue;
      }
      const lrImp = kid(netImp, 'logical-router') || add(netImp, 'logical-router');
      const have = new Set(members(lrImp));
      for (const m of members(imp)) if (!have.has(m)) add(lrImp, 'member', m);
      detach(imp);
      R.add('done', area, 'vsys `' + nameOf(vsys) + '`: import dei router aggiornato da `virtual-router` a `logical-router` (configurazione multi-vsys).');
    }
    void opts;
  }

  /** Path monitoring HA: con l'Advanced Routing il path group «virtual-router» diventa «logical-router». */
  function haPathGroups(ctx) {
    const { dev, R } = ctx;
    for (const pg of all(dev, 'deviceconfig/high-availability/group/monitoring/path-monitoring/path-group')) {
      const vr = kid(pg, 'virtual-router');
      if (!vr) continue;
      if (!kids(vr, 'entry').length) {
        detach(vr);
        R.add('done', 'HA', 'Rimosso il path group HA `virtual-router` vuoto (con l\'Advanced Routing i path group usano `logical-router`).');
        continue;
      }
      let lr = kid(pg, 'logical-router');
      if (!lr) { lr = mk(dev.ownerDocument, 'logical-router'); pg.insertBefore(lr, vr); }
      for (const e of kids(vr, 'entry')) {
        if (ent(lr, nameOf(e))) { R.add('error', 'HA', 'Path group HA: esiste già un logical router `' + nameOf(e) + '`, quello del virtual router non è stato spostato.'); continue; }
        lr.appendChild(e);
      }
      detach(vr);
      R.add('done', 'HA', 'Path monitoring HA: i path group `virtual-router` sono diventati `logical-router` (' + kids(lr, 'entry').map(e => '`' + nameOf(e) + '`').join(', ') + '), con la stessa struttura (`destination-ip-group`) che usa un PA-550 con Advanced Routing.', { xml: snippet(lr, 3000) });
    }
  }

  function moveBfdProfiles(net, R, rp) {
    const legacy = at(net, 'profiles/bfd-profile');
    const entries = kids(legacy, 'entry');
    if (!entries.length) return;
    const moved = [];
    for (const e of entries) {
      const n = rp.copyNamed('bfd', e);
      moved.push(n === nameOf(e) ? '`' + n + '`' : '`' + nameOf(e) + '` → `' + n + '`');
    }
    detach(legacy);
    R.add('done', 'Routing', 'Profili BFD spostati in `network/routing-profile/bfd`: ' + moved.join(', ') + '.');
  }

  function convertVR(ctx, vr, rp) {
    const { doc, R, opts } = ctx;
    const name = nameOf(vr);
    const area = 'Routing';
    const lr = mk(doc, 'entry');
    lr.setAttribute('name', name);
    const vrf = ensureEnt(ensure(lr, 'vrf'), 'default');

    const ifs = kid(vr, 'interface');
    if (ifs && ifs.firstElementChild) cloneTo(vrf, ifs);

    // admin distance
    const ad = kid(vr, 'admin-dists');
    const adSet = {};
    if (ad) {
      for (const c of kids(ad)) {
        const dst = AD_MAP[c.tagName];
        if (!dst) { R.add('check', area, '`' + name + '`: admin distance `' + c.tagName + '` senza equivalente, ignorata.'); continue; }
        for (const d of dst) adSet[d] = c.textContent.trim();
      }
    }
    const proto = kid(vr, 'protocol');
    const ospfOn = txt(proto, 'ospf/enable') === 'yes';
    const ospf3On = txt(proto, 'ospfv3/enable') === 'yes';
    // L'export legacy scrive le admin distance anche quando sono ai default. Per OSPF
    // il default interno passa da 30 (legacy) a 110 (ARE/PAN-OS 12.x): il 30 di default
    // non viene portato, anche con OSPF attivo. I valori espliciti non-default restano invariati.
    const idle = [];
    if (adSet['ospf-intra'] === '30') {
      delete adSet['ospf-intra']; delete adSet['ospf-inter'];
      if (ospfOn) R.add('check', 'OSPF', '`' + name + '`: admin distance OSPF interna 30 del motore legacy non portata; nell\'ARE/PAN-OS 12.x resta il default 110. Verifica la preferenza delle route dopo la migrazione.');
      else idle.push('OSPF');
    }
    if (!ospf3On && adSet['ospfv3-intra'] === '30') { delete adSet['ospfv3-intra']; delete adSet['ospfv3-inter']; idle.push('OSPFv3'); }
    if (idle.length) R.add('info', area, '`' + name + '`: ' + idle.join(' e ') + ' disattivato: la distanza interna resta al default ARE (110) invece del 30 legacy, come nei logical router creati da PAN-OS.');
    if (ospfOn && !(ad && kid(ad, 'ospf-int'))) {
      R.add('check', 'OSPF', '`' + name + '`: OSPF attivo senza admin distance interna esplicita: nell\'ARE/PAN-OS 12.x vale il default 110 (nel legacy era 30). Verifica la preferenza delle route dopo la migrazione.');
    }
    if (ospf3On && !(ad && kid(ad, 'ospfv3-int'))) {
      adSet['ospfv3-intra'] = '30'; adSet['ospfv3-inter'] = '30';
      R.add('check', 'OSPF', '`' + name + '`: impostata admin distance OSPFv3 interna a 30 come nel motore legacy (default ARE 110).');
    }
    if (Object.keys(adSet).length) {
      const oad = add(vrf, 'admin-dists');
      for (const k of Object.keys(adSet)) add(oad, k, adSet[k]);
      if (ad && ad.firstElementChild) R.add('done', area, '`' + name + '`: admin distance convertite (' + kids(ad).map(c => c.tagName + '=' + c.textContent.trim()).join(', ') + ').');
    }

    // static route
    let nStatic = 0;
    for (const fam of ['ip', 'ipv6']) {
      const routes = all(vr, 'routing-table/' + fam + '/static-route/entry');
      if (!routes.length) continue;
      let sr = null;
      const used = new Set(routes.map(nameOf).filter(n => !/\s/.test(n)));
      for (const r of routes) {
        const out = convertStaticRoute(ctx, r, name, fam);
        if (!out) continue;
        const orig = nameOf(r);
        if (/\s/.test(orig) || !/^[A-Za-z0-9_-]/.test(orig)) {
          const nn = routeName(orig, used);
          out.setAttribute('name', nn);
          R.add('done', area, '`' + name + '` / ' + (fam === 'ip' ? 'IPv4' : 'IPv6') + ' `' + orig + '` rinominata `' + nn + '`: nell\'Advanced Routing il nome di una static route non può contenere spazi.');
        }
        if (!sr) sr = ensure(vrf, 'routing-table/' + fam + '/static-route');
        sr.appendChild(out);
        nStatic++;
      }
    }
    if (nStatic) R.add('done', area, '`' + name + '`: ' + nStatic + ' static route convertite.');

    const ecmp = kid(vr, 'ecmp');
    if (ecmp && ecmp.firstElementChild) {
      cloneTo(vrf, ecmp);
      R.add('done', area, '`' + name + '`: ECMP copiato nella VRF (stessa struttura nell\'ARE).');
    }

    if (proto) {
      const off = [];
      for (const p of kids(proto)) {
        const enabled = txt(p, 'enable');
        const meaningful = p.firstElementChild && !(enabled === 'no' && kids(p).length === 1);
        if (!meaningful && p.tagName !== 'redist-profile') continue;
        // un protocollo spento con le sole impostazioni di default (l'export legacy le scrive comunque) non va convertito
        if (enabled !== 'yes' && !p.tagName.startsWith('redist-profile') && !protocolContent(p)) { off.push(p.tagName.toUpperCase()); continue; }
        if (p.tagName === 'bgp' && opts.rules.dyn) convertBGP(ctx, { vr, vrName: name, lb: p, vrf, rp });
        else if (p.tagName === 'ospf' && opts.rules.dyn) convertOSPF(ctx, { vr, vrName: name, lo: p, vrf, rp });
        else if (p.tagName === 'redist-profile' || p.tagName === 'redist-profile-ipv6') {
          if (!opts.rules.dyn && kids(p, 'entry').length) R.add('manual', area, '`' + name + '`: redistribution profile legacy da ricreare con i profili di redistribuzione e le route map dell\'ARE.', { xml: snippet(p) });
        } else {
          R.add('manual', p.tagName === 'bgp' ? 'BGP' : p.tagName.startsWith('ospf') ? 'OSPF' : area,
            '`' + name + '`: ' + p.tagName.toUpperCase() + (enabled === 'yes' ? ' (attivo)' : ' (disattivato, ma configurato)') + ' da ricostruire a mano nel logical router.', { xml: snippet(p) });
        }
      }
      if (off.length) R.add('info', area, '`' + name + '`: ' + off.join(', ') + ' disattivati e senza configurazione: non convertiti.');
    }

    if (proto && opts.rules.dyn) {
      const referenced = new Set(all(proto, 'bgp/redist-rules/entry').concat(all(proto, 'ospf/export-rules/entry')).map(nameOf));
      const unused = all(proto, 'redist-profile/entry').map(nameOf).filter(n => !referenced.has(n));
      if (unused.length) R.add('info', area, '`' + name + '`: redistribution profile non usati da BGP/OSPF, non convertiti: ' + unused.map(n => '`' + n + '`').join(', ') + '.');
    }

    const mc = kid(vr, 'multicast');
    if (mc && txt(mc, 'enable') === 'yes') R.add('manual', area, '`' + name + '`: multicast da ricostruire nel logical router (struttura diversa nell\'ARE).', { xml: snippet(mc) });

    const known = new Set(['interface', 'routing-table', 'ecmp', 'admin-dists', 'protocol', 'multicast']);
    for (const c of kids(vr)) {
      if (!known.has(c.tagName) && hasContent(c)) R.add('check', area, '`' + name + '`: elemento `' + c.tagName + '` non gestito, non copiato.', { xml: snippet(c, 2000) });
    }
    return lr;
  }

  /** Un protocollo legacy ha configurazione vera (aree, peer, interfacce, regole) oltre ai default? */
  function protocolContent(p) {
    const paths = {
      bgp: ['peer-group/entry', 'redist-rules/entry', 'policy/import/rules/entry', 'policy/export/rules/entry', 'policy/aggregation/address/entry', 'policy/conditional-advertisement/policy/entry', 'auth-profile/entry'],
      ospf: ['area/entry', 'export-rules/entry', 'auth-profile/entry'],
      ospfv3: ['area/entry', 'export-rules/entry', 'auth-profile/entry'],
      rip: ['interface/entry', 'export-rules/entry', 'auth-profile/entry']
    }[p.tagName];
    if (!paths) return true;
    return paths.some(x => all(p, x).length > 0) || !!txt(p, 'router-id') || !!txt(p, 'local-as');
  }

  /** Nome di static route valido nell'ARE: niente spazi (nel motore legacy erano ammessi). */
  function routeName(name, used) {
    let n = name.replace(/\s+/g, '_');
    if (!/^[A-Za-z0-9_-]/.test(n)) n = '_' + n;
    let out = n, i = 2;
    while (used.has(out)) out = n + '_' + i++;
    used.add(out);
    return out;
  }

  function convertStaticRoute(ctx, r, vrName, fam) {
    const { doc, R } = ctx;
    const area = 'Routing';
    const name = nameOf(r);
    const label = '`' + vrName + '` / ' + (fam === 'ip' ? 'IPv4' : 'IPv6') + ' `' + name + '`';
    const rt = firstChildTag(kid(r, 'route-table'));
    if (rt === 'no-install' || rt === 'multicast') {
      R.add('manual', area, label + ': route-table `' + rt + '` non esiste nell\'ARE, la route non è stata convertita.', { xml: snippet(r) });
      return null;
    }
    const nhKind = firstChildTag(kid(r, 'nexthop'));
    if (nhKind === 'receive') {
      R.add('manual', area, label + ': next hop `receive` non esiste nell\'ARE, la route non è stata convertita.', { xml: snippet(r) });
      return null;
    }
    const out = mk(doc, 'entry');
    out.setAttribute('name', name);
    copyLeaf(r, out, 'destination');
    copyLeaf(r, out, 'interface');
    copyLeaf(r, out, 'admin-dist');
    copyLeaf(r, out, 'metric');
    const nh = kid(r, 'nexthop');
    if (nhKind) {
      const k = nh.firstElementChild;
      const onh = add(out, 'nexthop');
      if (nhKind === 'next-vr') {
        add(onh, 'next-lr', k.textContent.trim());
        R.add('done', area, label + ': next hop `next-vr ' + k.textContent.trim() + '` diventato `next-lr`.');
      } else if (nhKind === 'discard') add(onh, 'discard');
      else add(onh, nhKind, k.textContent.trim());
    }
    const bfd = kid(r, 'bfd');
    if (bfd && hasContent(bfd)) cloneTo(out, bfd);
    const pm = kid(r, 'path-monitor');
    if (pm && hasContent(pm)) cloneTo(out, pm);
    if (rt === 'both') R.add('check', area, label + ': route-table `both`, convertita solo la parte unicast.');
    void ctx;
    return out;
  }

  // ------------------------------------------------------------------ BGP
  function convertBGP(ctx, c) {
    const { R } = ctx;
    const { vr, vrName, lb, vrf, rp } = c;
    const area = 'BGP';
    const L = '`' + vrName + '`';
    const ob = add(vrf, 'bgp');
    for (const t of ['enable', 'router-id', 'local-as', 'install-route', 'enforce-first-as', 'ecmp-multi-as']) copyLeaf(lb, ob, t);
    const gb = kid(lb, 'global-bfd');
    if (hasContent(gb)) cloneTo(ob, gb);

    const ro = kid(lb, 'routing-options');
    if (ro) {
      copyLeaf(ro, ob, 'default-local-preference');
      const gr = kid(ro, 'graceful-restart');
      if (hasContent(gr)) cloneTo(ob, gr);
      const med = kid(ro, 'med');
      if (hasContent(med)) cloneTo(ob, med);
      if (txt(ro, 'confederation-member-as')) R.add('manual', area, L + ': confederazione BGP (`confederation-member-as`) da riconfigurare a mano.');
      if (txt(ro, 'reflector-cluster-id')) R.add('manual', area, L + ': `reflector-cluster-id` da riconfigurare a mano.');
      if (txt(ro, 'aggregate/aggregate-med') === 'yes') R.add('check', area, L + ': `aggregate-med` globale: nell\'ARE si imposta per ogni aggregato (`same-med`).');
    }
    if (txt(lb, 'enable') === 'yes' && txt(lb, 'reject-default-route') !== 'no') {
      R.add('check', area, L + ': nel legacy Reject Default Route è attivo di default e scarta la default ricevuta dai peer. Nell\'ARE non c\'è questa opzione: se la default non deve entrare, filtrala con un filtering profile.');
    }
    if (txt(lb, 'allow-redist-default-route') === 'yes') R.add('check', area, L + ': `allow-redist-default-route` attivo: nell\'ARE la default si annuncia con una route map o `default-originate` nel profilo AF.');

    const authMap = {};
    for (const ap of all(lb, 'auth-profile/entry')) {
      authMap[nameOf(ap)] = rp.copyNamed('bgp/auth-profile', ap);
    }
    if (Object.keys(authMap).length) R.add('done', area, L + ': profili di autenticazione spostati in `routing-profile/bgp/auth-profile` (' + Object.keys(authMap).map(k => '`' + k + '`').join(', ') + ').');
    if (all(lb, 'dampening-profile/entry').length) R.add('manual', area, L + ': dampening profile con parametri diversi nell\'ARE (half-life, reuse, suppress): da ricreare.', { xml: snippet(kid(lb, 'dampening-profile')) });

    let nPeers = 0;
    for (const pg of all(lb, 'peer-group/entry')) {
      const pgName = nameOf(pg);
      const opg = ensureEnt(ensure(ob, 'peer-group'), pgName);
      copyLeaf(pg, opg, 'enable');
      const typeEl = kid(pg, 'type');
      const tk = firstChildTag(typeEl) || 'ebgp';
      const tsub = typeEl && typeEl.firstElementChild;
      if (tk === 'ebgp' || tk === 'ibgp') add(add(opg, 'type'), tk);
      else {
        add(add(opg, 'type'), tk === 'ebgp-confed' ? 'ebgp' : 'ibgp');
        R.add('manual', area, L + ' / peer group `' + pgName + '`: tipo `' + tk + '` (confederazione) impostato come ' + (tk === 'ebgp-confed' ? 'eBGP' : 'iBGP') + ', da rivedere.');
      }
      const af = { nhSelf: false, rmPriv: false, soft: txt(pg, 'soft-reset-with-stored-info') === 'yes' };
      if (tsub) {
        if (txt(tsub, 'export-nexthop') === 'use-self') af.nhSelf = true;
        if (txt(tsub, 'remove-private-as') === 'yes') af.rmPriv = true;
        if (txt(tsub, 'import-nexthop') === 'use-peer') R.add('check', area, L + ' / peer group `' + pgName + '`: `import-nexthop use-peer` non ha un equivalente diretto (serve una route map in ingresso).');
      }
      if (txt(pg, 'aggregated-confed-as-path') === 'yes') R.add('check', area, L + ' / peer group `' + pgName + '`: `aggregated-confed-as-path` non convertito.');

      const peers = all(pg, 'peer/entry');
      const v6 = peers.some(p => txt(p, 'address-family-identifier') === 'ipv6');
      const v4 = peers.length === 0 || peers.some(p => txt(p, 'address-family-identifier') !== 'ipv6');
      if (v4) {
        const afName = rp.add('bgp/address-family-profile', 'af-ipv4' + (af.nhSelf ? '-nhself' : '') + (af.rmPriv ? '-nopriv' : '') + (af.soft ? '-soft' : ''), e => {
          const u = ensure(e, 'ipv4/unicast');
          add(u, 'enable', 'yes');
          if (af.soft) add(u, 'soft-reconfig-with-stored-info', 'yes');
          if (af.nhSelf) add(add(u, 'next-hop'), 'self');
          if (af.rmPriv) add(add(u, 'remove-private-AS'), 'all');
        });
        setText(opg, 'address-family/ipv4', afName);
      }
      if (v6) R.add('manual', area, L + ' / peer group `' + pgName + '`: peer IPv6, serve un address family profile IPv6.');

      for (const p of peers) {
        nPeers++;
        const pn = nameOf(p);
        const PL = L + ' / peer `' + pn + '`';
        const op = ensureEnt(ensure(opg, 'peer'), pn);
        for (const t of ['enable', 'peer-as', 'enable-sender-side-loop-detection']) copyLeaf(p, op, t);
        add(add(op, 'inherit'), 'yes');
        const la = kid(p, 'local-address');
        if (hasContent(la)) cloneTo(op, la);
        const pa = kid(p, 'peer-address');
        if (hasContent(pa)) cloneTo(op, pa);
        const bfd = kid(p, 'bfd');
        if (hasContent(bfd)) cloneTo(op, bfd);
        const co = kid(p, 'connection-options');
        if (co) {
          const auth = txt(co, 'authentication');
          if (auth) setText(op, 'connection-options/authentication', authMap[auth] || auth);
          const mh = txt(co, 'multihop');
          if (mh && mh !== '0') setText(op, 'connection-options/multihop', mh);
          const tm = {
            ka: txt(co, 'keep-alive-interval') || '30', ht: txt(co, 'hold-time') || '90',
            mra: txt(co, 'min-route-adv-interval') || '30', odt: txt(co, 'open-delay-time') || '0',
            rri: txt(co, 'idle-hold-time') || '15'
          };
          if (tm.ka !== '30' || tm.ht !== '90' || tm.mra !== '30' || tm.odt !== '0' || tm.rri !== '15') {
            const tn = rp.add('bgp/timer-profile', 'bgp-timer-' + tm.ka + '-' + tm.ht, e => {
              add(e, 'keep-alive-interval', tm.ka); add(e, 'hold-time', tm.ht);
              add(e, 'min-route-adv-interval', tm.mra); add(e, 'open-delay-time', tm.odt);
              add(e, 'reconnect-retry-interval', tm.rri);
            });
            setText(op, 'connection-options/timers', tn);
            R.add('done', area, PL + ': timer convertiti nel timer profile `' + tn + '` (idle hold time → reconnect retry interval).');
          }
          const inc = kid(co, 'incoming-bgp-connection'), outc = kid(co, 'outgoing-bgp-connection');
          if ((inc && (txt(inc, 'allow') === 'no' || (txt(inc, 'remote-port') || '0') !== '0')) || (outc && (txt(outc, 'allow') === 'no' || (txt(outc, 'local-port') || '0') !== '0'))) {
            R.add('check', area, PL + ': restrizioni su connessioni BGP in ingresso/uscita (allow, porte) non convertite.');
          }
        }
        const rc = txt(p, 'reflector-client');
        if (rc && rc !== 'non-client') R.add('check', area, PL + ': route reflector client (`' + rc + '`): impostalo nel profilo AF del peer (`route-reflector-client`).');
        const mp = txt(p, 'max-prefixes');
        if (mp && mp !== '5000') R.add('check', area, PL + ': `max-prefixes ' + mp + '`: nell\'ARE si imposta come `maximum-prefix` nel profilo AF.');
        if (txt(p, 'enable-mp-bgp') === 'yes') R.add('check', area, PL + ': MP-BGP attivo, verificare i profili AF.');
        if (txt(p, 'subsequent-address-family-identifier/multicast') === 'yes') R.add('manual', area, PL + ': SAFI multicast da configurare con un profilo AF multicast.');
      }
    }
    if (nPeers) R.add('done', area, L + ': convertiti ' + all(lb, 'peer-group/entry').length + ' peer group e ' + nPeers + ' peer; ai peer group IPv4 è applicato un address family profile con IPv4 unicast attivo.');

    // policy
    const pol = kid(lb, 'policy');
    if (pol) {
      for (const sec of ['import', 'export', 'conditional-advertisement']) {
        const s = kid(pol, sec);
        if (s && s.getElementsByTagName('entry').length) {
          R.add('manual', area, L + ': policy BGP `' + sec + '` da ricreare con route map e filtering profile.', { xml: snippet(s) });
        }
      }
      for (const a of all(pol, 'aggregation/address/entry')) {
        const an = nameOf(a);
        const complex = hasContent(kid(a, 'aggregate-route-attributes')) || hasContent(kid(a, 'suppress-filters')) || hasContent(kid(a, 'advertise-filters'));
        if (complex) {
          R.add('manual', area, L + ': aggregato `' + an + '` con attributi o filtri: da ricreare con route map.', { xml: snippet(a) });
          continue;
        }
        const oa = ensureEnt(ensure(ob, 'aggregate-routes'), an);
        copyLeaf(a, oa, 'enable');
        if (txt(a, 'summary') === 'yes') add(oa, 'summary-only', 'yes');
        if (txt(a, 'as-set') === 'yes') add(oa, 'as-set', 'yes');
        const pfx = txt(a, 'prefix');
        if (pfx) setText(oa, (pfx.includes(':') ? 'type/ipv6' : 'type/ipv4') + '/summary-prefix', pfx);
        R.add('done', area, L + ': aggregato `' + an + '` convertito in aggregate route.');
      }
    }

    // redistribuzione
    const kinds = {};
    const redistNotes = [];
    for (const r of all(lb, 'redist-rules/entry')) {
      const rn = nameOf(r);
      if (txt(r, 'enable') === 'no') { R.add('info', area, L + ': redist rule `' + rn + '` disattivata, ignorata.'); continue; }
      const attrs = ['set-origin', 'set-local-preference', 'set-as-path-limit', 'set-community', 'set-extended-community']
        .filter(t => { const v = kid(r, t); return hasContent(v) && !(t === 'set-origin' && txt(v) === 'incomplete'); });
      if (isPrefix(rn)) {
        const fam = rn.includes(':') ? 'ipv6' : 'ipv4';
        const n = ensureEnt(ensure(ob, 'advertise-network/' + fam + '/network'), rn);
        add(n, 'unicast', 'yes');
        R.add('check', area, L + ': redistribuzione del prefisso `' + rn + '` convertita in Advertise Network. Nell\'ARE il prefisso è annunciato solo se nella RIB esiste la route identica.' + (attrs.length ? ' Attributi non convertiti: ' + attrs.join(', ') + '.' : ''));
        continue;
      }
      const prof = ent(at(vr, 'protocol/redist-profile'), rn);
      const res = simpleRedist(prof);
      if (!res.ok) {
        R.add('manual', area, L + ': redist rule `' + rn + '`: ' + res.reason + ' Va ricreata con un redistribution profile e una route map.', { xml: snippet(r) + (prof ? '\n' + snippet(prof) : '') });
        continue;
      }
      const metric = txt(r, 'set-med') || txt(r, 'metric');
      for (const k of res.types) {
        if (k === 'bgp') continue;
        if (kinds[k] && kinds[k].metric !== metric) redistNotes.push(k);
        kinds[k] = { metric };
      }
      if (attrs.length) R.add('check', area, L + ': redist rule `' + rn + '`: attributi ' + attrs.join(', ') + ' non convertiti (servono route map).');
    }
    if (Object.keys(kinds).length) {
      const pn = rp.add('bgp/redistribution-profile', vrName + '-bgp-redist', e => {
        const u = ensure(e, 'ipv4/unicast');
        for (const k of ['static', 'connected', 'ospf', 'rip']) {
          if (!kinds[k]) continue;
          const x = add(u, k);
          add(x, 'enable', 'yes');
          if (kinds[k].metric) add(x, 'metric', kinds[k].metric);
        }
      });
      setText(ob, 'redistribution-profile/ipv4/unicast', pn);
      R.add('done', area, L + ': redistribuzione in BGP convertita nel profilo `' + pn + '` (' + Object.keys(kinds).join(', ') + ').');
      if (redistNotes.length) R.add('check', area, L + ': più regole con metriche diverse per ' + redistNotes.join(', ') + ': tenuta l\'ultima.');
    }
  }

  const REDIST_TYPE = { connect: 'connected', 'static': 'static', ospf: 'ospf', rip: 'rip', bgp: 'bgp' };
  function simpleRedist(prof) {
    if (!prof) return { ok: false, reason: 'redistribution profile non trovato.' };
    if (!at(prof, 'action/redist')) return { ok: false, reason: 'il profilo ha azione `no-redist`.' };
    const f = kid(prof, 'filter');
    const types = members(kid(f, 'type'));
    for (const t of ['interface', 'destination', 'nexthop']) if (members(kid(f, t)).length) return { ok: false, reason: 'il profilo filtra per `' + t + '`.' };
    if (hasContent(kid(f, 'ospf')) || hasContent(kid(f, 'bgp'))) return { ok: false, reason: 'il profilo filtra per attributi OSPF/BGP.' };
    if (!types.length) return { ok: false, reason: 'il profilo non indica il tipo di route.' };
    return { ok: true, types: types.map(t => REDIST_TYPE[t] || t) };
  }

  // ------------------------------------------------------------------ OSPF
  function ospfTimers(rp, el) {
    const t = {
      h: txt(el, 'hello-interval') || '10', d: txt(el, 'dead-counts') || '4', r: txt(el, 'retransmit-interval') || '5',
      td: txt(el, 'transit-delay') || '1', gr: txt(el, 'gr-delay') || '10'
    };
    if (t.h === '10' && t.d === '4' && t.r === '5' && t.td === '1' && t.gr === '10') return null;
    return rp.add('ospf/if-timer-profile', 'ospf-timer-' + t.h + '-' + t.d, e => {
      add(e, 'hello-interval', t.h); add(e, 'dead-counts', t.d); add(e, 'retransmit-interval', t.r);
      add(e, 'transit-delay', t.td); add(e, 'gr-delay', t.gr);
    });
  }

  function convertOSPF(ctx, c) {
    const { R } = ctx;
    const { vr, vrName, lo, vrf, rp } = c;
    const area = 'OSPF';
    const L = '`' + vrName + '`';
    const oo = add(vrf, 'ospf');
    for (const t of ['enable', 'router-id', 'rfc1583']) copyLeaf(lo, oo, t);
    const gb = kid(lo, 'global-bfd');
    if (hasContent(gb)) cloneTo(oo, gb);
    const gr = kid(lo, 'graceful-restart');
    if (hasContent(gr)) cloneTo(oo, gr);
    const tmr = kid(lo, 'timers');
    if (tmr && ((txt(tmr, 'lsa-interval') || '5') !== '5' || (txt(tmr, 'spf-calculation-delay') || '5') !== '5')) {
      R.add('check', area, L + ': timer SPF/LSA personalizzati (' + kids(tmr).map(x => x.tagName + '=' + x.textContent.trim()).join(', ') + '): crea un SPF timer profile.');
    }
    if (txt(lo, 'enable') === 'yes' && txt(lo, 'reject-default-route') === 'yes') {
      R.add('check', area, L + ': nel legacy era attivo Reject Default Route (la default ricevuta via OSPF veniva scartata). Nell\'ARE non c\'è questa opzione: verifica il comportamento.');
    }
    if (txt(lo, 'allow-redist-default-route') === 'yes') R.add('check', area, L + ': `allow-redist-default-route`: nell\'ARE la default si annuncia dal redistribution profile (`default-route`).');

    const authMap = {};
    for (const ap of all(lo, 'auth-profile/entry')) authMap[nameOf(ap)] = rp.copyNamed('ospf/auth-profile', ap);
    if (Object.keys(authMap).length) R.add('done', area, L + ': profili di autenticazione spostati in `routing-profile/ospf/auth-profile`.');

    let nIf = 0;
    for (const a of all(lo, 'area/entry')) {
      const an = nameOf(a);
      const oa = ensureEnt(ensure(oo, 'area'), an);
      const tk = kid(a, 'type') && kid(a, 'type').firstElementChild;
      const ot = add(oa, 'type');
      if (!tk || tk.tagName === 'normal') add(ot, 'normal');
      else if (tk.tagName === 'stub') {
        const s = add(ot, 'stub');
        if (txt(tk, 'accept-summary') === 'no') add(s, 'no-summary', 'yes');
        const adv = at(tk, 'default-route/advertise');
        if (adv) add(s, 'default-route-metric', txt(adv, 'metric') || '10');
        else if (at(tk, 'default-route/disable')) R.add('check', area, L + ' / area `' + an + '`: stub senza default route: nell\'ARE l\'ABR la annuncia comunque.');
      } else if (tk.tagName === 'nssa') {
        const s = add(ot, 'nssa');
        if (txt(tk, 'accept-summary') === 'no') add(s, 'no-summary', 'yes');
        const adv = at(tk, 'default-route/advertise');
        if (adv) {
          const d = add(s, 'default-information-originate');
          add(d, 'metric', txt(adv, 'metric') || '10');
          add(d, 'metric-type', (txt(adv, 'type') || 'ext-2') === 'ext-1' ? 'type-1' : 'type-2');
        }
        for (const r of all(tk, 'nssa-ext-range/entry')) {
          add(ensureEnt(ensure(s, 'abr/nssa-ext-range'), nameOf(r)), 'advertise', kid(r, 'suppress') ? 'no' : 'yes');
        }
      }
      for (const r of all(a, 'range/entry')) add(ensureEnt(ensure(oa, 'range'), nameOf(r)), 'advertise', kid(r, 'suppress') ? 'no' : 'yes');
      for (const i of all(a, 'interface/entry')) {
        nIf++;
        const oi = ensureEnt(ensure(oa, 'interface'), nameOf(i));
        for (const t of ['enable', 'passive', 'metric', 'priority']) copyLeaf(i, oi, t);
        const ltk = firstChildTag(kid(i, 'link-type'));
        if (ltk) {
          const olt = add(add(oi, 'link-type'), ltk);
          if (ltk === 'p2mp') for (const nb of all(i, 'neighbor/entry')) ensureEnt(ensure(olt, 'neighbor'), nameOf(nb));
        }
        const au = txt(i, 'authentication');
        if (au) add(oi, 'authentication', authMap[au] || au);
        const bfd = kid(i, 'bfd');
        if (hasContent(bfd)) cloneTo(oi, bfd);
        const tn = ospfTimers(rp, i);
        if (tn) add(oi, 'timing', tn);
      }
      for (const v of all(a, 'virtual-link/entry')) {
        const ov = ensureEnt(ensure(oa, 'virtual-link'), nameOf(v));
        for (const t of ['neighbor-id', 'transit-area-id', 'enable']) copyLeaf(v, ov, t);
        const au = txt(v, 'authentication');
        if (au) add(ov, 'authentication', authMap[au] || au);
        const bfd = kid(v, 'bfd');
        if (hasContent(bfd)) cloneTo(ov, bfd);
        const tn = ospfTimers(rp, v);
        if (tn) add(ov, 'timing', tn);
      }
    }
    R.add('done', area, L + ': OSPF convertito (' + all(lo, 'area/entry').length + ' aree, ' + nIf + ' interfacce); i timer personalizzati sono diventati interface timer profile.');

    // export rules -> redistribution profile
    const kinds = {};
    for (const r of all(lo, 'export-rules/entry')) {
      const rn = nameOf(r);
      const metric = txt(r, 'metric');
      const mtype = (txt(r, 'new-path-type') || 'ext-2') === 'ext-1' ? 'type-1' : 'type-2';
      if (txt(r, 'new-tag')) R.add('check', area, L + ': export rule `' + rn + '`: tag non convertito (serve una route map).');
      if (rn === '0.0.0.0/0') { kinds['default-route'] = { metric, mtype }; continue; }
      if (isPrefix(rn)) { R.add('manual', area, L + ': export rule per il prefisso `' + rn + '`: nell\'ARE serve un redistribution profile con route map.', { xml: snippet(r) }); continue; }
      const prof = ent(at(vr, 'protocol/redist-profile'), rn);
      const res = simpleRedist(prof);
      if (!res.ok) {
        R.add('manual', area, L + ': export rule `' + rn + '`: ' + res.reason + ' Va ricreata con un redistribution profile e una route map.', { xml: snippet(r) + (prof ? '\n' + snippet(prof) : '') });
        continue;
      }
      for (const k of res.types) if (k !== 'ospf') kinds[k] = { metric, mtype };
    }
    if (Object.keys(kinds).length) {
      const pn = rp.add('ospf/redistribution-profile', vrName + '-ospf-redist', e => {
        for (const k of ['static', 'connected', 'bgp', 'rip', 'default-route']) {
          if (!kinds[k]) continue;
          const x = add(e, k);
          add(x, 'enable', 'yes');
          if (kinds[k].metric) add(x, 'metric', kinds[k].metric);
          add(x, 'metric-type', kinds[k].mtype);
        }
      });
      add(oo, 'redistribution-profile', pn);
      R.add('done', area, L + ': export rule convertite nel redistribution profile `' + pn + '` (' + Object.keys(kinds).join(', ') + ').');
    }
  }

  // ------------------------------------------------------------------ regola: interfacce
  function nameRegex(keys) {
    const escd = keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length);
    return new RegExp('^(' + escd.join('|') + ')((?:\\.\\d+)?)$');
  }
  function underInterfaceTree(el) {
    for (let n = el.parentNode; n && n.nodeType === 1; n = n.parentNode) {
      if (n.tagName === 'interface' && n.parentNode && n.parentNode.tagName === 'network') return true;
    }
    return false;
  }
  function underNetwork(el) {
    for (let n = el.parentNode; n && n.nodeType === 1; n = n.parentNode) if (n.tagName === 'network' && n.parentNode && n.parentNode.tagName === 'entry') return true;
    return false;
  }
  function tagPath(el) {
    const tags = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentNode) tags.push(n.tagName);
    return tags.reverse().join('/');
  }
  function isInterfaceNameRef(el) {
    if (!el || el.tagName !== 'entry') return false;
    const p = tagPath(el);
    if (/\/network\/interface\/(?:ethernet|aggregate-ethernet)\/entry$/.test(p)) return true;
    if (/\/network\/interface\/(?:ethernet|aggregate-ethernet)\/entry\/(?:layer2|layer3)\/units\/entry$/.test(p)) return true;
    if (/\/network\/interface\/(?:loopback|tunnel|vlan)\/units\/entry$/.test(p)) return true;
    const par = el.parentNode;
    return !!(par && par.tagName === 'interface' && underNetwork(el));
  }
  function isInterfaceTextRef(el) {
    if (!el || el.firstElementChild) return false;
    const p = tagPath(el);
    const tag = el.tagName;
    if (tag === 'member') {
      const par = el.parentNode;
      if (par && par.tagName === 'interface') {
        if (underNetwork(el) || /\/deviceconfig\/high-availability\//.test(p)) return true;
        if (/\/vsys\/entry\/import\/network\/interface\/member$/.test(p)) return true;
        if (/\/vsys\/entry\/rulebase\/pbf\/rules\/entry\/from\/interface\/member$/.test(p)) return true;
      }
      if (/\/vsys\/entry\/zone\/entry\/network\/(?:layer3|layer2|tap|virtual-wire)\/member$/.test(p)) return true;
      return false;
    }
    if (tag === 'aggregate-group' && underInterfaceTree(el)) return true;
    if (isHaPort(el)) return true;
    if (['interface', 'tunnel-interface', 'remote-user-tunnel', 'to-interface', 'egress-interface', 'interface1', 'interface2'].includes(tag)) {
      if (underNetwork(el)) return true;
      if (/\/deviceconfig\/system\/route\/service\//.test(p)) return true;
      if (/\/vsys\/entry\/(?:global-protect|rulebase\/(?:nat|pbf))\//.test(p)) return true;
    }
    return false;
  }

  function ruleInterfaces(ctx) {
    const { dev, doc, R, opts, model } = ctx;
    const area = 'Interfacce';
    const inv = interfaceInventory(dev);
    const map = opts.map || {};
    const keepHA = ctx.keepHA;
    // con l'HA del PA-500 le porte HA della sorgente vengono eliminate dalla regola HA: qui si ignorano
    const skip = it => it.kind === 'ha-dedicated' ? !!keepHA : (keepHA && it.mode === 'ha');
    const rename = {}, drop = [];
    for (const it of inv) {
      if (skip(it)) continue;
      const t = map[it.key];
      if (t === DROP) drop.push(it.key);
      else if (t && t !== it.key) rename[it.key] = t;
    }
    // conflitti: due interfacce sulla stessa porta
    const finalOf = new Map();
    for (const it of inv) {
      if (it.kind === 'ha-dedicated' || skip(it)) continue;
      if (drop.includes(it.key)) continue;
      const f = rename[it.key] || it.key;
      if (!finalOf.has(f)) finalOf.set(f, []);
      finalOf.get(f).push(it.key);
    }
    ctx.collisions = [];
    for (const [f, srcs] of finalOf) {
      if (srcs.length > 1) {
        ctx.collisions.push(f);
        R.add('error', area, 'Più interfacce finiscono su `' + f + '`: ' + srcs.map(s => '`' + s + '`').join(', ') + '. Assegna porte diverse.');
      }
    }

    if (drop.length) dropInterfaces(ctx, drop);

    const keys = Object.keys(rename);
    if (keys.length) {
      const re = nameRegex(keys);
      let count = 0;
      const unknown = [];
      const els = Array.from(doc.documentElement.getElementsByTagName('*'));
      for (const el of els) {
        const nm = el.getAttribute('name');
        if (nm != null) {
          const m = re.exec(nm);
          if (m) {
            if (isInterfaceNameRef(el)) {
              el.setAttribute('name', rename[m[1]] + m[2]);
              count++;
            } else {
              unknown.push({ el, value: nm, kind: 'nome' });
            }
          }
        }
        if (!el.firstElementChild) {
          const t = el.textContent.trim();
          if (t) {
            const m = re.exec(t);
            if (m) {
              if (isInterfaceTextRef(el)) {
                el.textContent = rename[m[1]] + m[2];
                count++;
              } else {
                unknown.push({ el, value: t, kind: 'valore' });
              }
            }
          }
        }
      }
      R.add('done', area, 'Rinominate le interfacce (' + keys.map(k => '`' + k + '` → `' + rename[k] + '`').join(', ') + '): ' + count + ' riferimenti tipizzati aggiornati, sub-interfacce comprese.');
      const seen = new Set();
      for (const it of unknown) {
        const p = humanPath(it.el);
        const sig = it.kind + '|' + p + '|' + it.value;
        if (seen.has(sig)) continue;
        seen.add(sig);
        R.add('check', area, 'Preservato ' + it.kind + ' omonimo a un\'interfaccia in ' + p + ' (`' + it.value + '`): il percorso non è riconosciuto come riferimento di interfaccia; verifica solo se quel valore deve seguire la rinomina.');
      }
    }
    ctx.rename = rename;
    ctx.drop = drop;
    void model;
  }

  function dropInterfaces(ctx, keys) {
    const { doc, R } = ctx;
    const area = 'Interfacce';
    const re = nameRegex(keys);
    const removed = [];
    const unknown = [];

    // Elimina solo entry il cui attributo name è un riferimento/definizione di interfaccia noto.
    const entries = Array.from(doc.documentElement.getElementsByTagName('entry'));
    for (const e of entries) {
      const nm = e.getAttribute('name');
      if (nm == null || !re.test(nm) || !e.parentNode) continue;
      if (!isInterfaceNameRef(e)) {
        unknown.push({ el: e, value: nm, kind: 'nome' });
        continue;
      }
      let inside = false;
      for (let p = e.parentNode; p && p.nodeType === 1; p = p.parentNode) {
        if (p.tagName === 'entry' && re.test(p.getAttribute('name') || '') && isInterfaceNameRef(p)) {
          inside = true;
          break;
        }
      }
      if (!inside) removed.push(humanPath(e));
      detach(e);
    }

    // Elimina i soli riferimenti foglia tipizzati. Testo libero e oggetti omonimi restano intatti.
    let nRefs = 0;
    const leaves = Array.from(doc.documentElement.getElementsByTagName('*'));
    for (const el of leaves) {
      if (!el.parentNode || el.firstElementChild) continue;
      const t = el.textContent.trim();
      if (!t || !re.test(t)) continue;
      if (isHaPort(el)) continue; // viene gestita dalla regola HA, che conosce il contesto della porta
      if (!isInterfaceTextRef(el)) {
        unknown.push({ el, value: t, kind: 'valore' });
        continue;
      }
      if (el.tagName === 'aggregate-group') {
        const eth = el.parentNode;
        detach(el);
        nRefs++;
        R.add('check', area, (nameOf(eth) || 'Interfaccia') + ' era membro di un aggregato escluso: ora non ha aggregate-group configurato.');
      } else {
        detach(el);
        nRefs++;
      }
    }

    R.add('done', area, 'Escluse ' + keys.join(', ') + ': rimosse solo definizioni e riferimenti tipizzati (' + nRefs + ' riferimenti foglia).');
    for (const p of removed) R.add('check', area, 'Rimossa la voce di interfaccia ' + p + '.');

    const seen = new Set();
    for (const it of unknown) {
      const p = humanPath(it.el);
      const sig = it.kind + '|' + p + '|' + it.value;
      if (seen.has(sig)) continue;
      seen.add(sig);
      R.add('check', area, 'Preservato ' + it.kind + ' omonimo a una porta esclusa in ' + p + ' (' + it.value + '): il percorso non è riconosciuto come riferimento di interfaccia.');
    }

    // Qualunque riferimento tipizzato rimasto dopo la pulizia è un errore reale.
    const left = [];
    for (const el of Array.from(doc.documentElement.getElementsByTagName('*'))) {
      if (!el.firstElementChild && re.test(el.textContent.trim()) && !isHaPort(el) && isInterfaceTextRef(el)) left.push(el);
    }
    for (const el of left) R.add('error', area, 'Riferimento tipizzato a un interfaccia esclusa rimasto in ' + humanPath(el) + ' (' + el.textContent.trim() + ').', { xpath: xpathOf(el) });
    for (const e of Array.from(doc.documentElement.getElementsByTagName('entry'))) {
      const nm = e.getAttribute('name');
      if (nm && re.test(nm) && isInterfaceNameRef(e)) R.add('error', area, 'Definizione o riferimento di interfaccia esclusa rimasto in ' + humanPath(e) + ' (' + nm + ').', { xpath: xpathOf(e) });
    }
  }

  // ------------------------------------------------------------------ regola: HA
  function ruleHA(ctx) {
    const { dev, R, opts } = ctx;
    const area = 'HA';
    const haEl = at(dev, 'deviceconfig/high-availability');
    const keepHA = ctx.keepHA;
    if (keepHA) {
      const tha = at(ctx.tdev, 'deviceconfig/high-availability');
      if (haEl) detach(haEl);
      if (tha) {
        cloneTo(ensure(dev, 'deviceconfig'), tha);
        R.add('done', area, 'Configurazione HA presa dal PA-500 (' + (txt(tha, 'enabled') === 'yes' ? 'HA attivo' : 'HA non attivo') + ').');
      } else {
        R.add('info', area, 'Il PA-500 non ha configurazione HA: rimossa quella della sorgente.');
      }
    } else if (haEl && txt(haEl, 'enabled') === 'yes') {
      R.add('check', area, 'HA attivo nella sorgente: peer, priority e IP HA sono quelli del nodo esportato. Carica la config sul nodo corrispondente e verifica gli indirizzi.');
    }
    const ha = at(dev, 'deviceconfig/high-availability');
    if (!ha) return;
    const used = new Set();
    const dropped = new Set(ctx.drop || []);
    for (const s of HA_SECTIONS) {
      const portEl = at(ha, 'interface/' + s + '/port');
      if (!portEl) continue;
      const p = portEl.textContent.trim();
      if (!p) continue;
      if (dropped.has(p)) {
        if (s === 'ha1-backup' || s === 'ha2-backup') {
          detach(at(ha, 'interface/' + s));
          R.add('done', area, 'Tolto `' + s + '`: la sua porta `' + p + '` è stata esclusa nella tabella delle porte.');
        } else {
          R.add('error', area, '`' + s + '` usa la porta `' + p + '`, che hai escluso: assegnale una porta del PA-500.');
        }
        continue;
      }
      if (p === MGMT) {
        if (s === 'ha1' || s === 'ha1-backup') {
          mgmtHaSection(ctx, ha, s);
          continue;
        }
        R.add('error', area, '`' + s + '` non può usare la porta di management.');
        continue;
      }
      if (DEDICATED_HA.test(p)) {
        R.add('error', area, '`' + s + '` usa la porta HA dedicata `' + p + '`, che sui PA-500 non esiste: assegnale una porta dati o la management nella tabella delle porte.');
        continue;
      }
      used.add(p);
      ensureHaInterface(ctx, p, s);
    }
    // interfacce in modalità HA non più usate
    const idle = all(dev, 'network/interface/ethernet/entry').filter(e => kid(e, 'ha') && !used.has(nameOf(e)));
    if (keepHA) {
      for (const e of idle) {
        detach(e);
        R.add('done', area, '`' + nameOf(e) + '` era in modalità HA ma non è usata dalla configurazione HA del PA-500: rimossa.');
      }
    } else if (idle.length) {
      R.add('info', area, 'Porte in modalità HA non usate da nessun link HA: ' + idle.map(e => '`' + nameOf(e) + '`').join(', ') + '. Restano configurate; escludile dalla tabella se non servono.');
    }
  }

  /** HA1 o HA1 backup sulla management: niente IP propri, peer e Permitted IP da controllare. */
  function mgmtHaSection(ctx, ha, s) {
    const { dev, R } = ctx;
    const sec = at(ha, 'interface/' + s);
    const removed = [];
    for (const t of ['ip-address', 'netmask', 'gateway', 'link-speed', 'link-duplex']) {
      const e = kid(sec, t);
      if (e) { removed.push(t + (e.textContent.trim() ? ' ' + e.textContent.trim() : '')); detach(e); }
    }
    if (!removed.length) return;
    R.add('done', 'HA', '`' + s + '` usa la porta di management: tolti ' + removed.join(', ') + '. Sulla management PAN-OS usa l\'indirizzo dell\'interfaccia di management e rifiuta il commit se la sezione HA ne ha uno proprio.');
    const peerTag = s === 'ha1' ? 'peer-ip' : 'peer-ip-backup';
    const peer = at(ha, 'group/' + peerTag);
    if (peer && peer.textContent.trim()) {
      R.add('check', 'HA', '`' + s + '` è passato su management: in `group/' + peerTag + '` va l\'IP di management del peer, ora c\'è `' + peer.textContent.trim() + '` (l\'indirizzo del vecchio link dedicato).', { xpath: xpathOf(peer) });
    }
    if (all(dev, 'deviceconfig/system/permitted-ip/entry').length) {
      R.add('check', 'HA', 'La management ha una lista di Permitted IP: aggiungi l\'IP del peer usato da `' + s + '`, altrimenti il link HA non si stabilisce.');
    }
  }

  function isHaPort(el) {
    const sec = el.parentNode, itf = sec && sec.parentNode, ha = itf && itf.parentNode;
    return el.tagName === 'port' && !!ha && itf.tagName === 'interface' && ha.tagName === 'high-availability';
  }

  function ipv4(s) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec((s || '').trim());
    if (!m || m.slice(1).some(o => +o > 255)) return null;
    return ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + (+m[4]);
  }
  function maskLen(mask, ipField) {
    const cidr = /\/(\d{1,2})$/.exec(ipField || '');
    if (cidr) return +cidr[1];
    const n = ipv4(mask);
    if (n == null) return null;
    let len = 0;
    for (let b = 31; b >= 0 && ((n >>> b) & 1); b--) len++;
    return len;
  }
  function sameNet(a, b) {
    const len = Math.min(a.len, b.len);
    if (len === 0) return true;
    const m = len === 32 ? 0xFFFFFFFF : ((0xFFFFFFFF << (32 - len)) >>> 0);
    return ((a.ip & m) >>> 0) === ((b.ip & m) >>> 0);
  }

  /** Controlli sulla configurazione HA finale: porte e subnet dei link non devono sovrapporsi. */
  function haChecks(ctx) {
    const { dev, R } = ctx;
    const ha = at(dev, 'deviceconfig/high-availability');
    if (!ha) return;
    const links = [];
    for (const s of HA_SECTIONS) {
      const sec = at(ha, 'interface/' + s);
      const port = txt(sec, 'port');
      if (!sec || !port) continue;
      let ipField = txt(sec, 'ip-address'), mask = txt(sec, 'netmask'), ipEl = kid(sec, 'ip-address');
      if (port === MGMT) {
        ipField = txt(dev, 'deviceconfig/system/ip-address');
        mask = txt(dev, 'deviceconfig/system/netmask');
        ipEl = at(dev, 'deviceconfig/system/ip-address');
      }
      const ip = ipv4((ipField || '').replace(/\/\d+$/, ''));
      const len = maskLen(mask, ipField);
      links.push({ s, port, sec, ipEl, net: ip != null && len != null ? { ip, len, text: (ipField || '').replace(/\/\d+$/, '') + '/' + len } : null });
    }
    for (let i = 0; i < links.length; i++) {
      for (let j = i + 1; j < links.length; j++) {
        const a = links[i], b = links[j];
        if (a.port === b.port) {
          R.add('error', 'HA', '`' + a.s + '` e `' + b.s + '` usano la stessa porta `' + a.port + '`: ogni link HA, backup compresi, deve stare su una porta fisica diversa. Assegna un\'altra porta a `' + b.s + '` oppure toglilo (opzione «Nessuna» nella tabella delle porte). Al commit PAN-OS risponde «ports overlap».', { xpath: xpathOf(kid(b.sec, 'port')) });
        } else if (a.net && b.net && b.s === a.s + '-backup' && sameNet(a.net, b.net)) {
          R.add('error', 'HA', 'Gli indirizzi di `' + a.s + '` (' + a.net.text + (a.port === MGMT ? ', IP di management' : '') + ') e di `' + b.s + '` (' + b.net.text + (b.port === MGMT ? ', IP di management' : '') + ') sono nella stessa subnet: i link primari e di backup devono stare su subnet diverse. Cambia l\'IP di `' + (b.port === MGMT ? a.s : b.s) + '`.', { xpath: xpathOf(b.port === MGMT ? a.ipEl || a.sec : b.ipEl || b.sec) });
        }
      }
    }
  }

  function ensureHaInterface(ctx, port, section) {
    const { dev, R } = ctx;
    const isAe = /^ae\d+$/.test(port);
    const container = ensure(dev, 'network/interface/' + (isAe ? 'aggregate-ethernet' : 'ethernet'));
    let e = ent(container, port);
    const tEnt = ctx.tdev && ent(at(ctx.tdev, 'network/interface/' + (isAe ? 'aggregate-ethernet' : 'ethernet')), port);
    if (e) {
      const mode = ifMode(e);
      if (mode === 'ha') return;
      if (mode) {
        R.add('error', 'HA', 'La porta `' + port + '` serve a `' + section + '` ma nella config è già in modalità `' + mode + '`: scegli un\'altra porta per l\'una o per l\'altra.');
        return;
      }
      add(e, 'ha');
    } else if (tEnt && kid(tEnt, 'ha')) {
      cloneTo(container, tEnt);
    } else {
      e = add(container, 'entry');
      e.setAttribute('name', port);
      add(e, 'ha');
    }
    R.add('done', 'HA', '`' + port + '` impostata in modalità HA per `' + section + '`.');
  }

  // ------------------------------------------------------------------ regole: management, admin
  const MGMT_TAGS = ['hostname', 'ip-address', 'netmask', 'default-gateway', 'ipv6-address', 'ipv6-default-gateway', 'type', 'speed-duplex', 'mtu'];
  function ruleKeepMgmt(ctx) {
    const { dev, R } = ctx;
    const tsys = at(ctx.tdev, 'deviceconfig/system');
    if (!tsys) { R.add('check', 'Management', 'La config del PA-500 non ha `deviceconfig/system`: management lasciato come nella sorgente.'); return; }
    const sys = ensure(dev, 'deviceconfig/system');
    for (const t of MGMT_TAGS) {
      const cur = kid(sys, t);
      if (cur) detach(cur);
      const tv = kid(tsys, t);
      if (tv) cloneTo(sys, tv);
    }
    R.add('done', 'Management', 'Hostname e IP di management presi dal PA-500: `' + (txt(tsys, 'hostname') || '?') + '`, `' + (txt(tsys, 'ip-address') || (kid(at(tsys, 'type'), 'dhcp-client') ? 'DHCP' : '?')) + '`.');
  }
  function ruleKeepAdmins(ctx) {
    const { doc, R } = ctx;
    const tm = at(ctx.tdoc.documentElement, 'mgt-config');
    const cur = at(doc.documentElement, 'mgt-config');
    if (!tm) { R.add('check', 'Management', 'La config del PA-500 non ha `mgt-config`: amministratori lasciati come nella sorgente.'); return; }
    const imported = doc.importNode(tm, true);
    if (cur) doc.documentElement.replaceChild(imported, cur);
    else doc.documentElement.appendChild(imported);
    R.add('done', 'Management', 'Amministratori e password presi dal PA-500 (' + all(tm, 'users/entry').map(nameOf).join(', ') + ').');
  }

  // ------------------------------------------------------------------ regola: PoE e verifiche di piattaforma
  function rulePoE(ctx) {
    const { dev, R, model } = ctx;
    for (const e of all(dev, 'network/interface/ethernet/entry')) {
      const poe = kid(e, 'poe');
      if (!poe) continue;
      const p = model.byName.get(nameOf(e));
      if (!p || !p.poe) {
        detach(poe);
        R.add('done', 'Interfacce', '`' + nameOf(e) + '`: rimosse le impostazioni PoE (porta senza PoE sul ' + model.id + ').');
      }
    }
  }

  function platformChecks(ctx) {
    const { dev, doc, R, model } = ctx;
    const area = 'Piattaforma';
    const ver = (doc.documentElement.getAttribute('version') || '').split('.').map(Number);
    if (ver.length >= 2 && (ver[0] < 10 || (ver[0] === 10 && ver[1] < 2))) {
      R.add('check', area, 'La sorgente è PAN-OS ' + doc.documentElement.getAttribute('version') + ', precedente all\'Advanced Routing (10.2). Al caricamento PAN-OS migra lo schema: se validate segnala errori sulla parte di routing, usa il caricamento parziale oppure porta prima la config su una release 10.2 o successiva.');
    }
    const vs = all(dev, 'vsys/entry');
    if (vs.length > 1) R.add('check', area, 'La config ha ' + vs.length + ' virtual system (' + vs.map(nameOf).join(', ') + '): verifica che il ' + model.id + ' supporti il multi-vsys e abbia la licenza.');
    if (at(dev, 'deviceconfig/system/panorama') || at(dev, 'deviceconfig/system/panorama-server')) {
      R.add('check', area, 'Il firewall era gestito da Panorama: l\'export contiene solo la config locale. Se usava template o device group, parti dalla config merged (`show config merged`) oppure adegua anche template e device group.');
    }

    const ports = new Set();
    for (const e of all(dev, 'network/interface/ethernet/entry')) {
      const n = nameOf(e);
      ports.add(n);
      const p = model.byName.get(n);
      if (!p) {
        R.add('error', 'Interfacce', 'La porta `' + n + '` non esiste sul ' + model.id + ': assegnala a una porta del pannello o escludila.');
        continue;
      }
      const ls = txt(e, 'link-speed');
      if (ls && /^\d+$/.test(ls) && +ls > p.speed) R.add('error', 'Interfacce', '`' + n + '` ha velocità ' + ls + ' Mbps ma la porta è ' + p.type + ' (max ' + p.speed + '): imposta `auto` o un valore supportato.');
      if (kid(e, 'log-card')) R.add('error', 'Interfacce', '`' + n + '` è in modalità log-card, che esiste solo sui PA-7000.');
      if (txt(e, 'layer3/cluster-interconnect') === 'yes' || txt(e, 'layer3/traffic-interconnect') === 'yes') R.add('check', 'Interfacce', '`' + n + '` ha impostazioni di cluster (PA-7500), da togliere.');
      if (at(e, 'layer3/sdwan-link-settings/enable') && txt(e, 'layer3/sdwan-link-settings/enable') === 'yes') R.add('info', 'Interfacce', '`' + n + '`: SD-WAN attivo, richiede plugin e licenza sul PA-500.');
    }
    // aggregate con porte di tipo diverso
    const aeTypes = new Map();
    for (const e of all(dev, 'network/interface/ethernet/entry')) {
      const g = txt(e, 'aggregate-group');
      const p = model.byName.get(nameOf(e));
      if (!g || !p) continue;
      if (!aeTypes.has(g)) aeTypes.set(g, new Set());
      aeTypes.get(g).add(p.type + ' ' + p.speed);
    }
    for (const [g, types] of aeTypes) if (types.size > 1) R.add('check', 'Interfacce', 'I membri di `' + g + '` sono su porte di tipo diverso (' + [...types].join(', ') + '): l\'aggregata richiede porte uguali.');
    // cellulare
    for (const c of kids(at(dev, 'network/interface'))) {
      for (const e of kids(c, 'entry')) {
        const n = nameOf(e) || '';
        if (/^cellular\d+\/\d+$/.test(n) && !model.cellular.includes(n)) R.add('error', 'Interfacce', 'L\'interfaccia `' + n + '` esiste solo sui modelli 5G: escludila.');
      }
    }
    ctx.finalPorts = ports;
  }

  /** Valori cifrati con la master key del firewall sorgente: si decifrano solo con la stessa master key. */
  function secretsCheck(doc, R) {
    const tags = new Map();
    let n = 0;
    const els = doc.documentElement.getElementsByTagName('*');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el.firstElementChild) continue;
      if (el.textContent.trim().startsWith('-AQ==')) { n++; tags.set(el.tagName, (tags.get(el.tagName) || 0) + 1); }
    }
    if (!n) return;
    const list = [...tags.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => '`' + t + '` ' + c).join(', ');
    R.add('check', 'Piattaforma', 'La config contiene ' + n + ' valori cifrati con la master key del firewall sorgente (' + list + '). Se la sorgente usa una master key personalizzata, impostala uguale sul PA-500 (Device > Master Key and Diagnostics) prima del caricamento, altrimenti chiavi private, PSK e password non si decifrano e il commit fallisce.');
  }

  // ------------------------------------------------------------------ regola: adeguamento alla 12.1
  /** Versione della sorgente da detail-version (o version) come [maggiore, minore, patch]. */
  function sourceVersion(doc) {
    const r = doc.documentElement;
    const v = r.getAttribute('detail-version') || r.getAttribute('version') || '';
    const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(v);
    return m ? { t: [+m[1], +m[2], +(m[3] || 0)], text: v } : null;
  }
  function olderThan(v, a, b, c) {
    if (!v) return false;
    const x = v.t, y = [a, b, c || 0];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
    return false;
  }
  function sslTlsProfiles(doc) {
    return Array.from(doc.documentElement.getElementsByTagName('ssl-tls-service-profile'))
      .filter(c => c.parentNode && (c.parentNode.tagName === 'shared' || (c.parentNode.tagName === 'entry' && c.parentNode.parentNode && c.parentNode.parentNode.tagName === 'vsys')))
      .flatMap(c => kids(c, 'entry'));
  }
  function decryptionProfiles(doc) {
    return Array.from(doc.documentElement.getElementsByTagName('decryption'))
      .filter(c => c.parentNode && c.parentNode.tagName === 'profiles')
      .flatMap(c => kids(c, 'entry'));
  }

  /**
   * Cambi di comportamento e di schema tra le release precedenti e la 12.1 che una config
   * caricata da file non riceve automaticamente (fonti in docs/differenze-12x.md).
   */
  function ruleVersion(ctx) {
    const { doc, dev, R } = ctx;
    const area = 'Versione';
    const v = sourceVersion(doc);
    const label = v ? 'PAN-OS ' + v.text : 'una versione non indicata';

    // IKE: dalla 11.2 un gateway senza versione esplicita usa IKEv2 invece di IKEv1
    const noVer = all(dev, 'network/ike/gateway/entry').filter(g => !txt(g, 'protocol/version'));
    if (noVer.length) {
      const names = noVer.map(g => '`' + nameOf(g) + '`').join(', ');
      if (olderThan(v, 11, 2, 0)) {
        for (const g of noVer) setText(ensure(g, 'protocol'), 'version', 'ikev1');
        R.add('done', area, 'IKE gateway senza versione esplicita (' + names + '): impostata `ikev1`, il default fino alla 11.1, come fa PAN-OS caricando una config 10.2. Dalla 11.2 il default è IKEv2 e la VPN non si stabilirebbe con un peer IKEv1.');
      } else if (!v) {
        R.add('check', area, 'IKE gateway senza versione esplicita (' + names + ') e versione della sorgente non indicata: fino alla 11.1 il default era IKEv1, dalla 11.2 è IKEv2. Imposta la versione che usa il peer.');
      }
    }

    // SSL/TLS service profile
    const tls = sslTlsProfiles(doc);
    if (olderThan(v, 11, 1, 0)) {
      const changed = [];
      for (const e of tls) {
        const mx = txt(e, 'protocol-settings/max-version');
        if (!mx || mx === 'max') { setText(ensure(e, 'protocol-settings'), 'max-version', 'tls1-2'); changed.push('`' + nameOf(e) + '`'); }
      }
      if (changed.length) R.add('done', area, 'SSL/TLS service profile con versione massima «Max» (' + changed.join(', ') + '): impostata `tls1-2`, come fa l\'upgrade ufficiale alla 11.1. Con «Max» la 12.1 abiliterebbe TLS 1.3 (anche per GlobalProtect e per la management); alzala a `tls1-3` solo dopo aver verificato i client.');
    }
    const renamed = [];
    for (const e of tls) {
      const old = at(e, 'protocol-settings/enc-algo-chacha20-poly1305');
      if (!old) continue;
      const ps = old.parentNode;
      const repl = mk(doc, 'enc-algo-aes-chacha20-poly1305', old.textContent.trim());
      if (!kid(ps, 'enc-algo-aes-chacha20-poly1305')) ps.replaceChild(repl, old); else detach(old);
      renamed.push('`' + nameOf(e) + '`');
    }
    if (renamed.length) R.add('check', area, 'SSL/TLS service profile ' + renamed.join(', ') + ': `enc-algo-chacha20-poly1305` rinominato in `enc-algo-aes-chacha20-poly1305`, il nome usato dalla 11.1 in poi. Il vecchio nome fa fallire il commit («unexpected here»); se validate rifiuta anche il nuovo, toglilo come indica Palo Alto.');

    // Decryption: dalla 12.1 TLS 1.3 in forward proxy solo con i gruppi di scambio chiavi RFC
    if (olderThan(v, 12, 1, 0)) {
      const fwd = decryptionProfiles(doc).filter(e => kid(e, 'ssl-forward-proxy') && ['', 'max', 'tls1-3'].includes(txt(e, 'ssl-protocol-settings/max-version') || ''));
      if (fwd.length) R.add('check', area, 'Decryption profile con SSL Forward Proxy e TLS 1.3 (' + fwd.map(e => '`' + nameOf(e) + '`').join(', ') + '): dalla 12.1 TLS 1.3 si decifra solo con X25519, X448, secp256r1, secp384r1 e secp521r1. Le sessioni verso server che negoziano solo altre curve non si completano; per quei server limita il profilo a TLS 1.2.');
    }

    // Authentication sequence: comportamento cambiato nella 11.1.1
    if (olderThan(v, 11, 1, 1)) {
      const seq = Array.from(doc.documentElement.getElementsByTagName('authentication-sequence')).flatMap(c => kids(c, 'entry'));
      if (seq.length) R.add('check', area, 'Authentication sequence (' + seq.map(e => '`' + nameOf(e) + '`').join(', ') + '): dalla 11.1.1 «Exit the sequence on failed authentication» non dipende più da «Use domain to determine authentication profile». Verifica che la sequenza si comporti come prima.');
    }
    if (!v) R.add('check', area, 'La config non indica la versione di PAN-OS: gli adeguamenti alla 12.1 legati alla versione non sono stati applicati.');
    else if (!olderThan(v, 12, 1, 0)) R.add('info', area, 'La sorgente è già ' + label + ': nessun adeguamento di versione necessario.');
  }

  function finalScan(ctx) {
    const { doc, R } = ctx;
    const els = doc.documentElement.getElementsByTagName('*');
    const seen = new Set();
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el.tagName !== 'virtual-router' && el.tagName !== 'next-vr') continue;
      const p = humanPath(el);
      if (seen.has(p)) continue;
      seen.add(p);
      R.add('check', 'Routing', 'Riferimento residuo a `' + el.tagName + '` in ' + p + '.', { xpath: xpathOf(el), xml: snippet(el, 1500) });
    }
  }

  // ------------------------------------------------------------------ conteggi
  const COUNTERS = [
    ['Zone', 'devices/entry/vsys/entry/zone/entry'],
    ['Regole di sicurezza', 'devices/entry/vsys/entry/rulebase/security/rules/entry'],
    ['Regole NAT', 'devices/entry/vsys/entry/rulebase/nat/rules/entry'],
    ['Regole di decryption', 'devices/entry/vsys/entry/rulebase/decryption/rules/entry'],
    ['Regole PBF', 'devices/entry/vsys/entry/rulebase/pbf/rules/entry'],
    ['Oggetti indirizzo', 'devices/entry/vsys/entry/address/entry', 'shared/address/entry'],
    ['Gruppi di indirizzi', 'devices/entry/vsys/entry/address-group/entry', 'shared/address-group/entry'],
    ['Servizi', 'devices/entry/vsys/entry/service/entry', 'shared/service/entry'],
    ['Gruppi di servizi', 'devices/entry/vsys/entry/service-group/entry', 'shared/service-group/entry'],
    ['Logical router', 'devices/entry/network/logical-router/entry'],
    ['Static route', 'devices/entry/network/logical-router/entry/vrf/entry/routing-table/ip/static-route/entry', 'devices/entry/network/logical-router/entry/vrf/entry/routing-table/ipv6/static-route/entry'],
    ['Porte fisiche configurate', 'devices/entry/network/interface/ethernet/entry'],
    ['Sub-interfacce', 'devices/entry/network/interface/ethernet/entry/layer3/units/entry', 'devices/entry/network/interface/ethernet/entry/layer2/units/entry', 'devices/entry/network/interface/aggregate-ethernet/entry/layer3/units/entry', 'devices/entry/network/interface/aggregate-ethernet/entry/layer2/units/entry'],
    ['Interfacce aggregate', 'devices/entry/network/interface/aggregate-ethernet/entry'],
    ['Interfacce VLAN', 'devices/entry/network/interface/vlan/units/entry'],
    ['Interfacce tunnel', 'devices/entry/network/interface/tunnel/units/entry'],
    ['Loopback', 'devices/entry/network/interface/loopback/units/entry'],
    ['IKE gateway', 'devices/entry/network/ike/gateway/entry'],
    ['Tunnel IPsec', 'devices/entry/network/tunnel/ipsec/entry'],
    ['GlobalProtect gateway', 'devices/entry/vsys/entry/global-protect/global-protect-gateway/entry'],
    ['GlobalProtect portal', 'devices/entry/vsys/entry/global-protect/global-protect-portal/entry']
  ];
  function counts(doc) {
    const r = doc.documentElement;
    return COUNTERS.map(([label, ...paths]) => ({ label, value: paths.reduce((s, p) => s + all(r, p).length, 0) }));
  }

  // ------------------------------------------------------------------ regole personalizzate
  function applyCustomRules(doc, rules, R) {
    const hits = {};
    for (const rule of rules || []) {
      if (!rule || rule.enabled === false || !rule.xpath) continue;
      const label = '«' + (rule.desc || rule.xpath) + '»';
      let nodes;
      try { nodes = evalXPath(doc, rule.xpath); }
      catch (e) {
        hits[rule.id] = -1;
        R.add('error', 'Regole personalizzate', 'Regola ' + label + ': XPath non valido (' + (e.message || e) + ').');
        continue;
      }
      hits[rule.id] = nodes.length;
      if (!nodes.length) continue;
      let n = 0;
      for (const node of nodes) {
        try {
          if (rule.action === 'remove') {
            if (node.nodeType === 2) node.ownerElement.removeAttributeNode(node);
            else detach(node);
            n++;
          } else if (rule.action === 'set') {
            if (node.nodeType === 1) { while (node.firstChild) node.removeChild(node.firstChild); node.textContent = rule.value || ''; n++; }
            else { node.nodeValue = rule.value || ''; n++; }
          } else if (rule.action === 'rename') {
            if (node.nodeType !== 1 || !/^[A-Za-z_][\w.\-]*$/.test(rule.value || '')) continue;
            const nn = doc.createElement(rule.value);
            for (const a of Array.from(node.attributes)) nn.setAttribute(a.name, a.value);
            while (node.firstChild) nn.appendChild(node.firstChild);
            node.parentNode.replaceChild(nn, node);
            n++;
          } else if (rule.action === 'replace') {
            const re = new RegExp(rule.pattern || '', 'g');
            const target = node.nodeType === 1 ? (node.firstElementChild ? null : node) : node;
            if (!target) continue;
            const before = target.textContent;
            const after = before.replace(re, rule.value || '');
            if (after !== before) { target.textContent = after; n++; }
          } else if (rule.action === 'report') {
            R.add('check', 'Regole personalizzate', 'Regola ' + label + ': trovato ' + humanPath(node.nodeType === 1 ? node : node.parentNode || node.ownerElement) + '.', { xpath: xpathOf(node) });
            n++;
          }
        } catch (e) {
          R.add('error', 'Regole personalizzate', 'Regola ' + label + ': ' + (e.message || e));
        }
      }
      const verb = { remove: n === 1 ? 'rimosso' : 'rimossi', set: n === 1 ? 'impostato' : 'impostati', rename: n === 1 ? 'rinominato' : 'rinominati', replace: n === 1 ? 'modificato' : 'modificati' }[rule.action];
      if (verb) R.add('done', 'Regole personalizzate', 'Regola ' + label + ': ' + n + (n === 1 ? ' nodo ' : ' nodi ') + verb + '.');
    }
    return hits;
  }

  // ------------------------------------------------------------------ errori di commit
  function parseCommitErrors(text) {
    const out = [];
    for (const raw0 of String(text || '').split(/\r?\n/)) {
      const raw = raw0.trim();
      if (!raw) continue;
      let l = raw.replace(/\s*(?:→|›|=>)\s*/g, ' -> ')
        .replace(/^[-•*]\s*/, '')
        .replace(/^(validation error|error|errore|warning|details?)\s*:\s*/i, '').trim();
      if (!/\s->\s|->/.test(l)) { out.push({ raw, parsed: false }); continue; }
      const segs = l.split(/\s*->\s*/).map(s => s.trim()).filter(s => s !== '');
      const last = segs.pop() || '';
      out.push({ raw, parsed: true, segs, last });
    }
    return out;
  }

  function walkTokens(doc, toks) {
    const r = doc.documentElement;
    let starts;
    if (toks[0] === 'config') starts = [r];
    else {
      starts = Array.from(r.getElementsByTagName(toks[0]));
      if (r.tagName === toks[0]) starts.unshift(r);
      if (!starts.length) starts = Array.from(r.getElementsByTagName('entry')).filter(e => e.getAttribute('name') === toks[0]);
    }
    const res = [];
    for (const s of starts) {
      let cur = [s];
      for (let i = 1; i < toks.length && cur.length; i++) {
        const t = toks[i], nxt = [];
        for (const c of cur) {
          const byTag = kids(c, t);
          if (byTag.length) nxt.push(...byTag);
          else { const e = ent(c, t); if (e) nxt.push(e); }
        }
        cur = nxt;
      }
      for (const c of cur) if (!res.includes(c)) res.push(c);
    }
    return res;
  }

  /** Trova i nodi a cui si riferisce un errore di commit e propone le correzioni. */
  function resolveError(doc, e) {
    if (!e.parsed) return Object.assign({ nodes: [], msg: e.raw, actions: [] }, e);
    const words = e.last.split(/\s+/);
    let found = null;
    for (let k = 1; k <= Math.min(words.length, 8) && !found; k++) {
      const toks = e.segs.concat([words.slice(0, k).join(' ')]);
      const nodes = walkTokens(doc, toks);
      if (nodes.length) found = { nodes, msg: words.slice(k).join(' '), toks };
    }
    if (!found) return Object.assign({ nodes: [], msg: e.last, actions: [] }, e);
    const ref = /'([^']+)'\s+is not (?:a valid reference|an allowed keyword|a valid value|valid)/i.exec(found.msg);
    const actions = [];
    const union = nodes => nodes.map(n => xpathOf(n)).join(' | ');
    const unionG = nodes => [...new Set(nodes.map(n => xpathOf(n, true)))].join(' | ');
    if (ref) {
      const refNodes = [];
      for (const n of found.nodes) {
        const ms = kids(n, 'member').filter(m => m.textContent.trim() === ref[1]);
        if (ms.length) refNodes.push(...ms);
        else if (!n.firstElementChild && n.textContent.trim() === ref[1]) refNodes.push(n);
      }
      // l'elemento c'è ma il valore segnalato no: l'errore è già stato risolto
      if (!refNodes.length) return Object.assign({}, e, { nodes: [], msg: found.msg, actions: [], ref: ref[1], refGone: true });
      actions.push({ label: 'Rimuovi il riferimento \'' + ref[1] + '\'', action: 'remove', xpath: union(refNodes), generic: unionG(refNodes), nodes: refNodes });
    }
    const tag = found.nodes[0].tagName;
    const low = (found.msg || '').toLowerCase();
    // per vincoli e elementi mancanti togliere il nodo peggiorerebbe le cose: si propone solo la segnalazione
    if (!low.includes('constraints failed') && !low.includes('is missing')) {
      actions.push({ label: 'Rimuovi <' + tag + (found.nodes[0].getAttribute('name') ? ' ' + found.nodes[0].getAttribute('name') : '') + '>' + (found.nodes.length > 1 ? ' (' + found.nodes.length + ' nodi)' : ''), action: 'remove', xpath: union(found.nodes), generic: unionG(found.nodes), nodes: found.nodes });
    }
    actions.push({ label: 'Segnala soltanto', action: 'report', xpath: union(found.nodes), generic: unionG(found.nodes), nodes: found.nodes });
    return Object.assign({}, e, found, { ref: ref ? ref[1] : null, actions, hint: errorHint(found.msg, tag) });
  }

  function errorHint(msg, tag) {
    const m = (msg || '').toLowerCase();
    if (m.includes('advanced routing')) return 'Il PA-500 non accetta advance-routing = no: carica la config convertita da questa pagina, dove la regola Advanced Routing lo imposta a yes.';
    if (m.includes('is unexpected')) return 'Elemento che questa versione o questa piattaforma non accetta: di solito si rimuove.';
    if (m.includes('not a valid reference')) return 'Riferimento a un oggetto che non esiste nella config: rimuovi il riferimento oppure crea l\'oggetto.';
    if (m.includes('not an allowed keyword') || m.includes('is invalid')) return 'Valore non accettato: correggilo con una regola «imposta valore» o rimuovi l\'elemento.';
    if (m.includes('constraints failed')) return 'Vincolo della piattaforma: leggi il messaggio, spesso indica l\'impostazione da cambiare.';
    if (m.includes('is missing')) return 'Manca un elemento obbligatorio: va aggiunto a mano.';
    if (tag === 'virtual-router') return 'Configurazione del motore legacy: con la regola Advanced Routing attiva viene convertita.';
    return '';
  }

  // ------------------------------------------------------------------ esecuzione
  function run(srcDoc, opts, tgtDoc) {
    const t0 = Date.now();
    const R = new Report();
    const doc = srcDoc.cloneNode(true);
    const model = getModel(opts.model, opts.customPorts);
    const devs = all(doc.documentElement, 'devices/entry');
    const tdevs = tgtDoc ? all(tgtDoc.documentElement, 'devices/entry') : [];
    const ctxs = [];
    for (const dev of devs) {
      const tdev = tdevs.find(t => nameOf(t) === nameOf(dev)) || tdevs[0] || null;
      // l'HA del PA-500 si usa solo se il PA-500 ne ha davvero una
      const tha = tdev && at(tdev, 'deviceconfig/high-availability');
      const tgtHasHA = !!tha && (txt(tha, 'enabled') === 'yes' || HA_SECTIONS.some(s => !!txt(tha, 'interface/' + s + '/port')));
      const keepHA = !!(opts.rules.ha && opts.rules.keepHA && tgtHasHA);
      const ctx = { doc, dev, R, opts, model, tdev, tdoc: tgtDoc, keepHA };
      ctxs.push(ctx);
      if (keepHA) detach(at(dev, 'deviceconfig/high-availability'));
      else if (opts.rules.ha) {
        for (const [sec, port, implicit] of haSectionPorts(dev)) {
          if (!implicit) continue;
          setText(at(dev, 'deviceconfig/high-availability/interface/' + sec), 'port', port);
          R.add('check', 'HA', '`' + sec + '` non indica la porta: nella sorgente usava la porta HA dedicata di default, qui chiamata `' + port + '`. Scegli la porta del PA-500 nella tabella.');
        }
      }
      else if (opts.rules.ha && opts.rules.keepHA && tdev) R.add('info', 'HA', 'Il PA-500 caricato non ha configurazione HA: uso quella della sorgente con le porte della tabella.');
      if (opts.rules.are) ruleARE(ctx);
      if (opts.rules.ifaces) ruleInterfaces(ctx);
      if (opts.rules.ha) ruleHA(ctx);
      if (opts.rules.poe) rulePoE(ctx);
      if (opts.rules.ver !== false) ruleVersion(ctx);
      if (tdev && opts.rules.keepMgmt) ruleKeepMgmt(ctx);
      platformChecks(ctx);
      if (tdev && all(tdev, 'network/logical-router/entry').length) {
        R.add('check', 'Routing', 'Il PA-500 ha già ' + all(tdev, 'network/logical-router/entry').length + ' logical router: con il caricamento completo vengono sostituiti da quelli convertiti.');
      }
    }
    if (tgtDoc && opts.rules.keepAdmins && ctxs.length) ruleKeepAdmins(ctxs[0]);
    const ruleHits = applyCustomRules(doc, opts.customRules, R);
    for (const ctx of ctxs) if (opts.rules.ha) haChecks(ctx);
    secretsCheck(doc, R);
    if (ctxs.length) finalScan(ctxs[0]);

    // stato delle porte per il pannello
    const ports = {};
    const rename = ctxs[0] ? ctxs[0].rename || {} : {};
    const back = {};
    for (const [k, v] of Object.entries(rename)) back[v] = k;
    const dev0 = devs[0];
    if (dev0) {
      const haPorts = new Map();
      for (const s of HA_SECTIONS) {
        const p = txt(dev0, 'deviceconfig/high-availability/interface/' + s + '/port');
        if (p) { if (!haPorts.has(p)) haPorts.set(p, []); haPorts.get(p).push(s); }
      }
      for (const e of all(dev0, 'network/interface/ethernet/entry')) {
        const n = nameOf(e);
        ports[n] = {
          source: back[n] || n, mode: ifMode(e), ha: haPorts.get(n) || null,
          ae: txt(e, 'aggregate-group'), units: unitNames(e).length,
          exists: model.byName.has(n), collision: !!(ctxs[0].collisions && ctxs[0].collisions.includes(n))
        };
      }
    }
    const mgmtHa = dev0 ? HA_SECTIONS.filter(s => txt(dev0, 'deviceconfig/high-availability/interface/' + s + '/port') === MGMT) : [];
    const stats = { error: 0, manual: 0, check: 0, done: 0, info: 0 };
    for (const it of R.items) stats[it.level]++;
    return { doc, report: R.items, stats, counts: counts(doc), ruleHits, ports, mgmtHa, model, ms: Date.now() - t0 };
  }

  /** Comandi CLI per caricare il file sul PA-500. */
  function loadCommands(fileName, devName) {
    const d = devName || 'localhost.localdomain';
    const f = fileName || 'config-pa500.xml';
    const base = "devices/entry[@name='" + d + "']";
    return {
      full: ['configure', 'load config from ' + f, 'validate full'].join('\n'),
      partial: [
        'configure',
        'load config partial mode replace from-xpath shared to-xpath /config/shared from ' + f,
        'load config partial mode replace from-xpath ' + base + '/network to-xpath /config/' + base + '/network from ' + f,
        'load config partial mode replace from-xpath ' + base + '/vsys to-xpath /config/' + base + '/vsys from ' + f,
        'set deviceconfig setting advance-routing yes',
        'validate full'
      ].join('\n')
    };
  }

  // ------------------------------------------------------------------ device state (.tgz)
  async function extractRunningConfig(buffer) {
    let bytes = new Uint8Array(buffer);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof root.DecompressionStream === 'undefined') throw new Error('Questo browser non sa decomprimere il .tgz: estrai running-config.xml dall\'archivio e caricalo.');
      const ds = new root.DecompressionStream('gzip');
      const stream = new root.Blob([bytes]).stream().pipeThrough(ds);
      bytes = new Uint8Array(await new root.Response(stream).arrayBuffer());
    }
    const dec = new root.TextDecoder('utf-8');
    const names = [];
    let off = 0;
    let longName = null;
    while (off + 512 <= bytes.length) {
      const h = bytes.subarray(off, off + 512);
      if (h.every(b => b === 0)) break;
      const str = (a, b) => dec.decode(h.subarray(a, b)).replace(/\0.*$/s, '');
      let name = str(0, 100);
      const prefix = str(345, 500);
      if (prefix && str(257, 263).startsWith('ustar')) name = prefix + '/' + name;
      const size = parseInt(str(124, 136).trim() || '0', 8) || 0;
      const type = String.fromCharCode(h[156] || 48);
      const dataStart = off + 512;
      if (type === 'L') {
        longName = dec.decode(bytes.subarray(dataStart, dataStart + size)).replace(/\0.*$/s, '');
      } else {
        if (longName) { name = longName; longName = null; }
        if (type === '0' || type === '\0') {
          names.push(name);
          if (/(^|\/)running-config\.xml$/.test(name)) return { name, text: dec.decode(bytes.subarray(dataStart, dataStart + size)) };
        }
      }
      off = dataStart + Math.ceil(size / 512) * 512;
    }
    throw new Error('Nell\'archivio non c\'è running-config.xml' + (names.length ? ' (contiene: ' + names.slice(0, 8).join(', ') + (names.length > 8 ? ', ...' : '') + ').' : '.'));
  }

  root.PA500 = {
    DROP, MGMT, MODELS, getModel, parseCustomPorts, parse, analyze, defaultMap, run, serialize, snippet,
    parseCommitErrors, resolveError, evalXPath, xpathOf, humanPath, loadCommands, extractRunningConfig, interfaceInventory
  };
})(typeof window !== 'undefined' ? window : globalThis);
