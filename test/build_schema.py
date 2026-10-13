"""Rigenera test/are_schema.json dagli schemi pubblicati da Palo Alto (pan-os-codegen, licenza MIT).

Il file elenca i percorsi XML ammessi sotto network/logical-router e network/routing-profile:
i test lo usano per verificare che il convertitore generi solo elementi esistenti.

Uso:
    git clone --depth 1 https://github.com/PaloAltoNetworks/pan-os-codegen.git /tmp/pan-os-codegen
    pip install pyyaml
    python3 test/build_schema.py /tmp/pan-os-codegen
"""
import glob
import json
import pathlib
import sys

import yaml


def children(p):
    s = p.get('spec')
    if not isinstance(s, dict):
        return None
    if 'items' in s and isinstance(s['items'], dict):
        s = s['items'].get('spec') or {}
    return s if isinstance(s, dict) else None


def walk(spec, path, out):
    if not spec:
        return
    for p in list(spec.get('params') or []) + list(spec.get('variants') or []):
        xp = []
        for prof in p.get('profiles') or []:
            xp = prof.get('xpath', [])
        full = path + xp
        out.add('/'.join(full))
        s = p.get('spec')
        # liste di stringhe: in XML diventano elementi <member>
        if (p.get('type') == 'list' and isinstance(s, dict) and isinstance(s.get('items'), dict)
                and s['items'].get('type') in ('string', None) and not s['items'].get('spec')):
            out.add('/'.join(full + ['member']))
        walk(children(p), full, out)


def main(codegen):
    specs = pathlib.Path(codegen) / 'specs' / 'network'
    res = {}
    d = yaml.safe_load((specs / 'logical-router.yaml').read_text())
    s = set()
    walk(d['spec'], [], s)
    res['logical-router'] = sorted(s)
    for f in sorted(glob.glob(str(specs / 'routing-profiles' / '*.yaml'))):
        d = yaml.safe_load(pathlib.Path(f).read_text())
        s = set()
        walk(d['spec'], [], s)
        res['/'.join(d['panos_xpath']['path'])] = sorted(s)
    out = pathlib.Path(__file__).parent / 'are_schema.json'
    out.write_text(json.dumps(res, indent=0))
    print(out, {k: len(v) for k, v in res.items()})


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
