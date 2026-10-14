# Regole per chi lavora sul repository

Su questo progetto lavorano il proprietario e due agenti AI: **Claude** (Anthropic) e **ChatGPT** (OpenAI). Ogni azione deve dire chi l'ha fatta: commit, branch, issue, commenti e pull request.

## Attribuzione

### Commit

Ogni commit scritto da un agente termina con il trailer `Agente:`, seguito dalle righe di co-autore dell'agente.

```
Agente: Claude
Co-Authored-By: Claude <noreply@anthropic.com>
```

```
Agente: ChatGPT
```

I commit del proprietario possono usare `Agente: matiz311` oppure nessun trailer. I primi commit del progetto, precedenti a queste regole, sono di Claude e si riconoscono dalla riga `Co-Authored-By: Claude`.

Per vedere chi ha fatto cosa:

```sh
git log --format='%h %ad %<(9)%(trailers:key=Agente,valueonly,separator=%x2C) %s' --date=short
```

### Branch e pull request

- Ogni agente lavora su un branch suo: `claude/<argomento>` per Claude, `chatgpt/<argomento>` oppure `codex/<argomento>` per ChatGPT (Codex usa `codex/` di default).
- Le modifiche arrivano su `main` con una pull request che porta l'etichetta `agent:claude` o `agent:chatgpt` e compila il campo «Agente» del modello.
- Il merge lo fa il proprietario, oppure l'agente autore se il proprietario l'ha chiesto e i test passano.

### Issue e commenti

- Chi apre una issue mette l'etichetta del proprio agente (`agent:claude`, `agent:chatgpt`) e chiude il testo con la firma: `— Segnalata da Claude` oppure `— Segnalata da ChatGPT`.
- Ogni commento si apre con il nome di chi scrive: `**Claude:**` oppure `**ChatGPT:**`.
- Prima di lavorare su una issue, l'agente lo scrive in un commento («Me ne occupo io»), così l'altro non la prende in parallelo.
- Una issue si chiude con il riferimento al commit o alla pull request che la risolve (`Fixes #N`).
- Il lavoro trovato e non fatto diventa una issue: niente TODO sparsi nel codice.

## Dati sensibili

- Mai committare config reali di firewall: contengono chiavi private, hash delle password, PSK e indirizzi dei clienti. Nel repository vanno solo config sintetiche (`test/*.xml`), con indirizzi di documentazione (RFC 5737) o privati.
- Una config reale si può usare come schema solo dopo averla passata in `tools/anonimizza.py`. Lo strumento tiene le sole sezioni utili alla migrazione, sostituisce nomi, indirizzi (pubblici in RFC 6598, privati rimappati) e testi, e rifiuta di scrivere se nei file prodotti resta una parola o un indirizzo pubblico degli originali. Rileggi comunque l'output prima del commit. Gli schemi stanno in `test/schema/`.
- Nelle issue e nei commenti niente nomi di clienti, hostname, IP pubblici o estratti di config reali: descrivi la struttura, non i dati.

## Prima di ogni push

1. `python3 build.py` rigenera `dist/pa500-adattatore.html`; va committato insieme alle modifiche in `src/`.
2. Tutti i test devono passare:

```sh
python3 test/test_engine.py
python3 test/test_engine2.py
python3 test/test_ha.py
python3 test/test_riferimento_are.py
python3 test/test_versioni.py
python3 test/test_migrazione_102.py
python3 test/test_schema_migrazione.py
python3 test/test_anonimizza.py
python3 test/test_ui.py
```

3. Ogni elemento XML nuovo sotto `network/logical-router` o `network/routing-profile` deve esistere in `test/are_schema.json` (lo controlla `test_engine.py`). Per elementi fuori da quegli alberi, cita nel commit la fonte che ne conferma il nome.

## Dove guardare

- `README.md`: cosa fa lo strumento, limiti noti, struttura dei file.
- `src/engine.js`: regole di conversione e controlli, senza interfaccia.
- `src/ui.js`, `src/style.css`, `src/template.html`: la pagina.
