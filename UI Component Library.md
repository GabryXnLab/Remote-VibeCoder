# UI Component Library — Migrazione da HTML/CSS a React + TypeScript

## Contesto e Obiettivo

La codebase attuale è costruita con HTML e CSS vanilla (o con templating
tradizionale). L'obiettivo è migrare l'intero frontend a React + TypeScript,
costruendo da zero una libreria di componenti centralizzata, modulare e
riutilizzabile in `/components`, che replichi fedelmente l'interfaccia
esistente e ne diventi la base permanente.

---

## Fase 1 — Analisi dell'Interfaccia Esistente

Prima di scrivere qualsiasi codice React:

1. Scansiona tutti i file HTML, CSS (e JS vanilla se presente)
2. Identifica ogni pattern UI ricorrente: strutture HTML ripetute, classi
   CSS condivise, stili inline duplicati, elementi identici in pagine diverse
3. Mappa ogni elemento visivo in un componente React candidato
4. Produci un inventario strutturato prima di procedere:

   ```
   INVENTARIO COMPONENTI
   ─────────────────────
   [NomeComponente] — trovato in: [file1.html, file2.html, ...]
     Varianti visive rilevate: [variante1, variante2]
     Attributi/classi CSS chiave: [classe1, classe2]
     Props candidate: [prop1, prop2]
     Priorità migrazione: [Alta/Media/Bassa]
   ```

5. Identifica anche:
   - Le variabili CSS custom (`:root { --color-... }`) da convertire in
     un theme token file TypeScript
   - Le classi CSS utility riutilizzabili da preservare o integrare
   - Eventuali animazioni/transizioni CSS da replicare

---

## Fase 2 — Setup Architettura React + TypeScript

Prima di costruire i componenti, verifica o configura:

- **tsconfig.json** con `strict: true`, `jsx: "react-jsx"`, path alias
  `@/` puntato a `src/`
- Struttura cartelle consigliata:

```
/src
  /components
    /ui                      ← Elementi atomici puri
      Button.tsx
      Input.tsx
      Switch.tsx
      Textarea.tsx
      Badge.tsx
      Spinner.tsx
      Icon.tsx
      Divider.tsx
      Avatar.tsx
    /layout                  ← Contenitori strutturali
      Card.tsx
      Modal.tsx
      Panel.tsx
      Section.tsx
      PageWrapper.tsx
    /forms                   ← Elementi legati ai form
      FormField.tsx
      Select.tsx
      Checkbox.tsx
      RadioGroup.tsx
      FileUpload.tsx
    /feedback                ← Comunicazione con l'utente
      Alert.tsx
      Toast.tsx
      Tooltip.tsx
      ProgressBar.tsx
      Skeleton.tsx
    index.ts                 ← Barrel export
  /styles
    tokens.ts                ← Design tokens (colori, spacing, typography)
    globals.css              ← CSS base globale (reset, font, variabili)
  /types
    common.ts                ← Tipi condivisi tra componenti
```

---

## Fase 3 — Design Token File

Converti le variabili CSS e i valori ricorrenti trovati nel CSS esistente
in un file TypeScript strutturato `/styles/tokens.ts`:

```ts
// styles/tokens.ts

export const colors = {
  primary: {
    50:  '#...',
    500: '#...',   // valore dal CSS esistente
    900: '#...',
  },
  neutral: { ... },
  danger:  { ... },
  success: { ... },
} as const

export const spacing = {
  xs: '4px',
  sm: '8px',
  md: '16px',
  lg: '24px',
  xl: '32px',
} as const

export const radius = {
  sm: '4px',
  md: '8px',
  full: '9999px',
} as const

export const typography = {
  fontFamily: { sans: '...', mono: '...' },
  fontSize:   { sm: '0.875rem', md: '1rem', lg: '1.125rem' },
  fontWeight: { normal: 400, medium: 500, bold: 700 },
} as const

// Tipi derivati automaticamente dai valori
export type ColorScale  = typeof colors
export type SpacingKey  = keyof typeof spacing
```

---

## Fase 4 — Criteri di Progettazione dei Componenti React/TS

Ogni componente deve rispettare questi principi:

### Struttura Standard di ogni Componente

```tsx
// components/ui/Button.tsx

import type { ButtonHTMLAttributes, ReactNode } from 'react'
import styles from './Button.module.css'   // o className string se no CSS Modules

// 1. Tipi delle varianti come union literals
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link'
export type ButtonSize    = 'sm' | 'md' | 'lg'

// 2. Props: estendi sempre gli attributi HTML nativi del tag sottostante
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:   ButtonVariant
  size?:      ButtonSize
  loading?:   boolean
  leftIcon?:  ReactNode
  rightIcon?: ReactNode
  fullWidth?: boolean
  // NON ridefinire: onClick, disabled, className, children — vengono da HTMLButtonAttributes
}

// 3. Componente con default espliciti
export const Button = ({
  variant   = 'primary',
  size      = 'md',
  loading   = false,
  fullWidth = false,
  leftIcon,
  rightIcon,
  children,
  className,
  disabled,
  ...rest           // passa tutto il resto al <button> nativo
}: ButtonProps) => {

  const classes = [
    styles.base,
    styles[variant],
    styles[size],
    fullWidth  && styles.fullWidth,
    loading    && styles.loading,
    className,                         // override dall'esterno sempre supportato
  ].filter(Boolean).join(' ')

  return (
    <button
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading}
      {...rest}
    >
      {leftIcon  && <span className={styles.iconLeft}>{leftIcon}</span>}
      {loading   ? <Spinner size="sm" /> : children}
      {rightIcon && <span className={styles.iconRight}>{rightIcon}</span>}
    </button>
  )
}
```

### Regole Generali per Tutti i Componenti

- **Estendi sempre l'attributo HTML nativo** corrispondente al tag root
  (`HTMLButtonAttributes`, `HTMLInputAttributes`, `HTMLDivElement`, ecc.)
  così ogni prop nativa (aria-*, data-*, event handler) funziona senza
  doverla ridichiarare
- **Spread `...rest`** sul tag root per massima compatibilità
- **`className` sempre supportato** per override dall'esterno
- **Nessun hardcoding** di testi, colori o dimensioni nel JSX
- **Nessuna logica di business** — solo presentazione e stato UI locale
- **Accessibilità minima**: ruoli ARIA corretti, `aria-label` dove manca
  testo visibile, focus management nei componenti interattivi (Modal, Dropdown)

---

## Fase 5 — Strategia di Migrazione degli Stili CSS → React

Per ogni componente, scegli la strategia coerente con il resto del progetto
(verifica quale è già in uso o più adatta):

| Strategia | Quando usarla |
|---|---|
| **CSS Modules** (`.module.css`) | Approccio consigliato default — scoping locale, zero runtime |
| **Tailwind CSS** | Se già presente o se si vuole utility-first |
| **Styled Components / Emotion** | Se si preferisce CSS-in-JS con theming dinamico |
| **Classe CSS globale + BEM** | Solo se si vuole preservare il CSS esistente quasi intatto |

Durante la migrazione:

1. Copia le regole CSS dell'elemento originale nel file `.module.css`
   del componente corrispondente
2. Sostituisci classi dinamiche inline con logica JSX (`variant`, `size`)
3. Rimuovi dal CSS globale tutto ciò che è stato incapsulato
4. Conserva in `globals.css` solo reset, font-face e variabili CSS root

---

## Fase 6 — Costruzione dei Componenti (ordine consigliato)

Procedi in questo ordine di priorità (dal più atomico al più composito):

**Tier 1 — Fondamenta (costruisci prima)**

- `Button` — varianti, size, loading, icone
- `Input` — type, label, error, helper text, prefix/suffix
- `Textarea` — righe, resize, caratteri rimanenti
- `Select` — opzioni come array di `{ label, value }`, placeholder
- `Checkbox` / `Switch` — stato controllato e non controllato
- `Badge` / `Tag` — varianti colore, dismissibile

**Tier 2 — Struttura**

- `FormField` — wrapper con `label`, `error`, `hint`, slot per qualsiasi input
- `Card` — header/body/footer slot, varianti ombra/bordo
- `Modal` — overlay, focus trap, `onClose`, `size`
- `Tooltip` — posizione, trigger, delay

**Tier 3 — Feedback e Navigazione**

- `Alert` — tipo (info/success/warning/error), dismissibile
- `Spinner` / `Skeleton` — loading states
- `Toast` — sistema notifiche con queue
- `Tabs` — controlled/uncontrolled, orientamento

---

## Fase 7 — Barrel Export e Typing Globale

### `components/index.ts`

```ts
// Barrel export — importa tutto da un solo punto
export * from './ui/Button'
export * from './ui/Input'
export * from './ui/Switch'
export * from './layout/Modal'
export * from './layout/Card'
export * from './forms/FormField'
export * from './feedback/Alert'
// ...
```

### `types/common.ts`

```ts
// Tipi condivisi tra più componenti
export type Size    = 'sm' | 'md' | 'lg'
export type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type Status  = 'idle' | 'loading' | 'success' | 'error'

// Utility type per componenti con "as" prop (polimorfismo)
export type AsProp<T extends React.ElementType> = {
  as?: T
} & React.ComponentPropsWithoutRef<T>
```

---

## Fase 8 — Refactoring delle Pagine Esistenti

Dopo aver costruito i componenti:

1. Per ogni pagina HTML esistente, crea il corrispondente file `.tsx`
   in `/pages` (o `/views`)
2. Converti la struttura HTML in JSX rispettando queste regole:
   - `class` → `className`
   - `for` → `htmlFor`
   - Stili inline `style="..."` → oggetto `style={{ ... }}` o rimuovi
     se già gestiti dal componente
   - Tag HTML nudi (es. `<button class="btn btn-primary">`) → componente
     centralizzato (`<Button variant="primary">`)
3. Ogni evento `onclick="..."` inline diventa una funzione tipizzata:

   ```tsx
   // Prima (HTML)
   <button onclick="handleSubmit()">
   
   // Dopo (React/TS)
   const handleSubmit = (e: React.MouseEvent<HTMLButtonElement>) => { ... }
   <Button onClick={handleSubmit}>
   ```

4. Aggiungi tutti gli import dal barrel:
   `import { Button, Input, Modal } from '@/components'`

---

## Vincoli e Regole

- ❌ Non usare `any` come tipo TypeScript — usa `unknown` se necessario
- ❌ Non usare `React.FC` — preferisci la tipizzazione diretta delle props
- ❌ Non creare componenti specifici per un singolo caso d'uso
- ❌ Non inserire logica di business (fetch, stato globale) nei componenti UI
- ✅ `strict: true` nel tsconfig deve rimanere soddisfatto
- ✅ Ogni componente deve essere usabile in almeno 2 contesti diversi
- ✅ Procedi per fasi e aspetta conferma tra Fase 1, Fase 2-4 e Fase 5-8

---

## Output Atteso a Fine Migrazione

Fornisci un riepilogo con:

- Lista completa dei componenti creati, con le props esposte e i tipi
- Lista dei file HTML migrati in `.tsx`
- CSS globale rimasto vs CSS incapsulato nei componenti
- Eventuali componenti non centralizzati con motivazione
- Eventuali pattern HTML non migrabili automaticamente che richiedono
  una decisione manuale
