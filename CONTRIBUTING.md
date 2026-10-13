# Manutenzione

## Build e verifiche

Modificare i sorgenti in `src/`, poi rigenerare il file distribuito:

```sh
python build.py
python test/test_build.py -v
python build.py --check
```

La build usa UTF-8 e LF su tutti i sistemi. `--check` non scrive file e restituisce
0 quando `dist/pa500-adattatore.html` coincide con i sorgenti, 1 se manca o è
obsoleto, 2 per errori di lettura o template non valido. La normale build crea
`dist/` quando manca. I segnaposto CSS/ENGINE/UI devono comparire una sola volta
nel template; non vengono interpretati dentro i contenuti inseriti.

Il workflow **Build integrity** esegue i test della build e il confronto del file
distribuito su Linux e Windows con Python 3.11 e 3.13. Non valida la semantica
PAN-OS e non esegue le suite Chromium: per modifiche al motore o alla pagina
eseguire anche i comandi Playwright elencati nel README.

## Modifiche al convertitore

- Ogni nuova conversione richiede un caso sintetico con verifica dell'XML atteso
  e delle sezioni che devono essere preservate. Stampare il risultato non basta.
- Indicare nella PR modello, release PAN-OS e fonte ufficiale dello schema o
  della limitazione applicata. Separare un limite del tool da un limite del firewall.
- Descrivere eventuali perdite di configurazione e la copertura dei test.
- Conservare i casi non convertibili nel report; non dichiarare compatibilità
  completa sulla sola base dei test XML.
- Inserire solo configurazioni sintetiche nel repository e nelle issue.
- Il risultato va ancora verificato sul target con la procedura di validazione
  documentata nel README prima del commit operativo.

## Prossimi interventi individuati

1. Aggiungere asserzioni a `test/test_engine2.py`: attualmente stampa i risultati
   ma non verifica i valori attesi per regole personalizzate, collisioni e scambi.
2. Portare le suite Chromium nella CI con dipendenze riproducibili, dopo aver
   verificato le fixture e trasformato gli scenari diagnostici in regressioni.
3. Documentare una matrice di prove sul firewall reale, indicando modello,
   release, funzionalità convertite ed esito di validate/commit. I test di build
   e di schema non costituiscono una prova sul dispositivo.
