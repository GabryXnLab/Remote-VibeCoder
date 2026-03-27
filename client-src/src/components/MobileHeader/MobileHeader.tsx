import { Button } from '@/components/ui/Button'
import { SettingsDropdown } from '@/components/ui/SettingsDropdown'
import type { SettingsSection } from '@/components/ui/SettingsDropdown'
import styles from './MobileHeader.module.css'

export interface MobileHeaderProps {
  sessionLabel:      string
  onBack:            () => void
  onOpenMenu:        () => void
  settingsSections:  SettingsSection[]
  settingsOpen:      boolean
  onSettingsToggle:  () => void
  onSettingsClose:   () => void
  onToggleSidebar:   () => void
}

export function MobileHeader({
  sessionLabel,
  onBack,
  onOpenMenu,
  settingsSections,
  settingsOpen,
  onSettingsToggle,
  onSettingsClose,
  onToggleSidebar,
}: MobileHeaderProps) {
  return (
    <header className={styles.header}>
      <Button variant="secondary" size="sm" className={styles.backBtn} onClick={onBack}>←</Button>

      <span className={styles.title}>{sessionLabel}</span>

      <Button variant="toolbar" className={styles.iconBtn} onClick={onOpenMenu} title="New terminal">+</Button>

      <SettingsDropdown
        open={settingsOpen}
        onToggle={onSettingsToggle}
        onClose={onSettingsClose}
        sections={settingsSections}
        buttonTitle="Impostazioni"
      />

      <Button variant="toolbar" className={styles.iconBtn} onClick={onToggleSidebar} title="Switch terminal">≡</Button>
    </header>
  )
}
