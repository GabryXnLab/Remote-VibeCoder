# Comando: /review

Esegui una code review del file o della directory specificata:

1. Leggi il codice target con @nomefile
2. Controlla: correttezza logica, edge cases, sicurezza, performance
3. Controlla: aderenza alle convenzioni in CLAUDE.md
4. Produci un report conciso in formato:
   - ✅ Cosa funziona bene
   - ⚠️ Miglioramenti suggeriti (non bloccanti)
   - ❌ Problemi critici da risolvere
5. Proponi le fix per i problemi ❌ e attendi conferma prima di applicarle
