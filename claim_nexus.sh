#!/bin/bash

# ==============================================================================
# SCRIPT DI ACQUISIZIONE AUTOMATICA NEXUS-CORE (MODALITÀ MARATONA)
# ==============================================================================

# CONFIGURAZIONE
STACK_ID="ocid1.ormstack.oc1.eu-milan-1.amaaaaaaevo6g2qaudjsjq2timxiaab7cr2duuryfpvjcirxmllguppbpaza"
PLAN_JOB_ID="ocid1.ormjob.oc1.eu-milan-1.amaaaaaaevo6g2qaj4qn32sklggvtdsrzvreqk2rvhrxikme24zvn7jiohqa"

# Percorso della CLI
OCI_BIN="$HOME/bin/oci"
export SUPPRESS_LABEL_WARNING=True

echo "----------------------------------------------------------------"
echo "🚀 NEXUS-CORE ACQUISITION BOT AVVIATO"
echo "----------------------------------------------------------------"
echo "Intervallo: 10 minuti (per rispettare i limiti delle API Oracle)"
echo "Log:        $(pwd)/acquisition_bot.log"
echo "----------------------------------------------------------------"

while true; do
  TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")
  echo "[$TIMESTAMP] Tentativo di invio job APPLY..."

  # Invia il job senza attendere l'esecuzione (fire and forget)
  # Questo evita i timeout della connessione locale
  OUTPUT=$($OCI_BIN resource-manager job create --stack-id "$STACK_ID" --operation APPLY --apply-job-plan-resolution "{\"planJobId\": \"$PLAN_JOB_ID\"}" 2>&1)

  if [[ $OUTPUT == *"ocid1.ormjob"* ]]; then
    JOB_ID=$(echo "$OUTPUT" | grep -o "ocid1.ormjob\.[^\" ']*" | head -n 1)
    echo "✅ [$TIMESTAMP] Job inviato con successo! ID: $JOB_ID"
    echo "[$TIMESTAMP] Controlla lo stato su Oracle Cloud. Se fallisce per capacità, riproverò tra 10 min."
  elif [[ $OUTPUT == *"TooManyRequests"* ]]; then
    echo "❌ [$TIMESTAMP] Errore 429 (Too Many Requests). Oracle ci sta limitando. Attendo..."
  else
    echo "⚠️ [$TIMESTAMP] Errore durante l'invio. Vedere log."
    echo "ERRORE ($TIMESTAMP): $OUTPUT" >> acquisition_bot.log
  fi

  echo "----------------------------------------------------------------"
  sleep 600
done
