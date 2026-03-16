# Comando: /commit

Crea un commit git ben strutturato:

1. Esegui `git diff --staged` per vedere cosa è in staging
2. Se non c'è nulla in staging, esegui `git status` e mostra cosa è modificato
3. Scrivi un messaggio di commit seguendo il formato:
   `tipo(scope): descrizione breve in italiano o inglese`
   Tipi validi: feat, fix, docs, refactor, test, chore
4. Esegui `git add` solo sui file relativi al task corrente
5. Crea il commit con `git commit -m "messaggio"`
6. NON fare push automaticamente — mostra il risultato e attendi
