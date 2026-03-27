# VM e2-micro — Manutenzione e Vulnerabilità

Documento di traccia degli interventi di ottimizzazione e delle vulnerabilità rilevate sul server GCP e2-micro che ospita Remote VibeCoder.

---

## 2026-03-27 — Intervento di ottimizzazione prestazioni

### Contesto

Il sito rispondeva in modo intermittente e andava a scatti. Diagnostica eseguita direttamente dalla VM tramite Claude Code CLI in sessione tmux.

### Problema critico — Filesystem root montato in sola lettura (RO)

**Gravità: CRITICA**

Al momento della diagnostica, il filesystem root (`/dev/sda1`) risultava montato con flag `ro` (read-only):

```
/dev/sda1 on / type ext4 (ro,relatime,discard,errors=remount-ro)
```

Il filesystem è montato con `errors=remount-ro`: se ext4 rileva un errore I/O, rimonta automaticamente in sola lettura per prevenire corruzione. Non sono stati trovati errori hardware o di filesystem (stato `clean` confermato da `tune2fs`), ma il remount era già avvenuto in un momento precedente non tracciato nei log.

**Effetti concreti dell'FS in RO:**
- L'app non riusciva a scrivere i file di sessione (`~/.claude-mobile/sessions/`)
- `journald` non poteva scrivere log → fallback su `/run` (tmpfs, volatile)
- Qualsiasi operazione di scrittura su disco (git clone/pull, session files, temp credentials) falliva silenziosamente o con errore
- Le API di commit/push potevano fallire anche con credenziali corrette

**Risoluzione applicata:**
```bash
sudo mount -o remount,rw /
```

**Prevenzione:**
- Creato `/usr/local/bin/check-fs-rw.sh` — controlla ogni 5 minuti se il FS è `ro`; se lo è e il FS è `clean`, rimonta automaticamente e logga l'evento via `logger`
- Aggiunto al crontab di root: `*/5 * * * * /usr/local/bin/check-fs-rw.sh`

**Causa probabile (non confermata):** un burst di I/O durante un'operazione git o una scrittura delle sessioni sotto pressione di memoria ha triggerato un errore I/O transitorio, che ha attivato `errors=remount-ro`. La 2GB swap su disco e il piccolo heap Node.js aumentano la frequenza di accesso al disco, rendendo questo scenario ripetibile.

---

### Processi inutili rimossi

#### 1. LXD snap (container manager)

```
lxd daemon: ~63 MB RAM
lxcfs:      ~3 MB RAM
```

LXD era installato come snap con 0 container attivi. Il suo daemon girava comunque in background consumando ~63MB di RAM — il 6% del totale disponibile su un sistema da 1GB. Rimosso con:

```bash
sudo snap remove lxd --purge
```

#### 2. multipathd (device mapper multipath)

```
multipathd: ~27 MB RAM
```

Servizio per gestire dischi multipli ridondanti. Inutile su una VM GCP con un singolo disco. Fermato, disabilitato e mascherato:

```bash
sudo systemctl stop multipathd
sudo systemctl disable multipathd
sudo systemctl mask multipathd
sudo systemctl mask multipathd.socket
```

#### 3. unattended-upgrades (watchdog di shutdown)

Il servizio `unattended-upgrades.service` era attivo in fase di shutdown per attendere aggiornamenti automatici in corso. Non necessario in produzione su questa VM (gli aggiornamenti si gestiscono manualmente). Disabilitato:

```bash
sudo systemctl stop unattended-upgrades
sudo systemctl disable unattended-upgrades
```

---

### Journal di sistema ridotto

Il journal `systemd-journald` aveva accumulato 256MB su disco. Ridotto a ~104MB con vacuum e configurato permanentemente:

**`/etc/systemd/journald.conf.d/size-limit.conf`:**
```ini
[Journal]
SystemMaxUse=50M
RuntimeMaxUse=20M
MaxRetentionSec=7day
```

---

### Riepilogo RAM liberata

| Intervento | RAM liberata |
|---|---|
| Rimozione LXD daemon | ~63 MB |
| Stop multipathd | ~27 MB |
| Drop cache dentries/inodes | ~80 MB (temporaneo) |
| **Totale permanente** | **~90 MB** |

---

## Vulnerabilità rilevate sul sistema

### 1. Filesystem che si rimonta in RO senza alerting

**Gravità: ALTA**

Il filesystem può passare da `rw` a `ro` in modo silenzioso a causa di `errors=remount-ro`. L'app continua ad "andare" (il processo Node.js non crasha), ma tutte le scritture falliscono. Non c'è nessun sistema di alerting che notifichi questo stato.

**Mitigazione applicata:** cron ogni 5 minuti con auto-remount.

**Mitigazione raccomandata aggiuntiva:** aggiungere un health check endpoint nell'app che tenti una scrittura di prova su disco e restituisca 503 se fallisce, in modo che nginx/Cloudflare possano rilevare il problema.

---

### 2. Swap su disco — vettore di amplificazione dei problemi I/O

**Gravità: MEDIA**

La 2GB swap è sul disco principale (`/swapfile` su `/dev/sda1`). Con Node.js, tmux, e Claude Code attivi, il sistema usa costantemente 250–300MB di swap. Questo significa accessi continui al disco che:
- Aumentano la probabilità di I/O error → remount RO
- Rallentano l'app quando la swap viene letta/scritta intensamente
- Competono con le operazioni git (clone, pull, push) che già stressano il disco

**Mitigazione:** non eliminabile senza upgrade VM; `vm.swappiness=30` in `setup.sh` già riduce l'uso di swap. Monitorare il `SwapCached` con `free -h` periodicamente.

---

### 3. snapd attivo con google-cloud-cli — overhead fisso ~30MB

**Gravità: BASSA**

`snapd` consuma ~30MB di RAM fissi per gestire esclusivamente `google-cloud-cli`. Se `gcloud` non viene usato dall'app in produzione, si può sostituire con l'installazione apt nativa (`google-cloud-cli` via apt) e rimuovere snapd interamente, liberando ~30MB permanenti.

**Verifica prima di agire:**
```bash
grep -r "gcloud" ~/claude-mobile/server/ ~/claude-mobile/*.sh
```

---

### 4. Nessun limite di dimensione su `/var/log/syslog`

**Gravità: BASSA**

`rsyslog` scrive su `/var/log/syslog` senza rotazione aggressiva. Al momento: 21MB per syslog + 7MB per syslog.1. Su un disco da 30GB non è critico, ma su un sistema con I/O continuo (swap + git) i log crescono velocemente. `logrotate` è configurato di default ma con rotazione settimanale.

**Raccomandazione:** verificare `/etc/logrotate.d/rsyslog` e impostare `rotate 3` con compressione.

---

### 5. Possibile leak di sessioni tmux orfane

**Gravità: BASSA**

Se il server Node.js viene riavviato bruscamente (OOM kill, restart systemd), le sessioni tmux `claude-{repo}` sopravvivono ma il loro metadata in memoria viene perso. Le sessioni si riaccumulano nel tempo senza essere pulite, consumando RAM (ogni sessione tmux con Claude Code attivo pesa 200–300MB).

**Mitigazione esistente:** `sessions.js` ha cleanup periodico dei metadata stale. Ma non termina le sessioni tmux orfane su riavvio del servizio.

**Raccomandazione:** aggiungere in `server/index.js` un hook di startup che esegua `tmux ls` e termini le sessioni `claude-*` senza corrispondenza nell'app state, oppure documentare che l'utente deve eseguire `tmux kill-server` prima di un riavvio pulito.

---

### 6. Nessun alerting su pressione di memoria critica

**Gravità: MEDIA**

Il `resource-governor.js` rileva la pressione di memoria e rifiuta nuove connessioni PTY (codice WS 1013), ma non c'è nessuna notifica esterna (email, webhook, log strutturato) quando il sistema entra in stato `critical`. Il comportamento per l'utente è: la connessione viene chiusa silenziosamente, senza un messaggio chiaro sul perché.

**Raccomandazione:** il frontend dovrebbe mostrare un messaggio specifico per il codice WS 1013 ("Server sotto pressione di memoria, riprova tra qualche minuto") invece del generico messaggio di disconnessione.

---

*Ultimo aggiornamento: 2026-03-27*
*Intervento eseguito da: Claude Code CLI (sessione diretta sulla VM)*
