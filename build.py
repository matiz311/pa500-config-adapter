"""Assembla e verifica la pagina unica, senza dipendenze esterne."""
import argparse
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent
PARTS = {'/*CSS*/': 'style.css', '/*ENGINE*/': 'engine.js', '/*UI*/': 'ui.js'}
MARKERS = re.compile('|'.join(re.escape(marker) for marker in PARTS))


def render(root=ROOT):
    """Restituisce byte UTF-8 con terminatori LF, senza scrivere su disco."""
    src = root / 'src'
    template = (src / 'template.html').read_text(encoding='utf-8')
    parts = {}
    for marker, name in PARTS.items():
        count = template.count(marker)
        if count != 1:
            raise ValueError(f'template.html: atteso un solo {marker}, trovati {count}')
        part = (src / name).read_text(encoding='utf-8')
        if '</script' in part.lower() or '</style' in part.lower():
            raise ValueError(f'{name}: chiusura script/style non consentita nel contenuto inline')
        parts[marker] = part
    # Una sola sostituzione: un marker presente nel JS/CSS rimane testo letterale.
    return MARKERS.sub(lambda match: parts[match.group()], template).encode('utf-8')


def main(argv=None, root=ROOT):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true',
                        help='verifica dist senza modificarlo; esce con 1 se manca o non è aggiornato')
    args = parser.parse_args(argv)
    out = root / 'dist' / 'pa500-adattatore.html'
    try:
        data = render(root)
        if args.check:
            if not out.is_file() or out.read_bytes() != data:
                print('Build non aggiornata o assente: eseguire python build.py', file=sys.stderr)
                return 1
            print('Build aggiornata:', len(data), 'byte')
        else:
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(data)
            print(out, len(data), 'byte')
    except (OSError, UnicodeError, ValueError) as exc:
        print(f'Errore build: {exc}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
