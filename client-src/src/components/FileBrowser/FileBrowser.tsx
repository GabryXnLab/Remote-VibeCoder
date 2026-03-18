import { useState, useCallback, useEffect } from 'react'
import { Spinner } from '@/components/ui/Spinner'
import styles from './FileBrowser.module.css'

interface FileEntry {
  name: string
  type: 'file' | 'dir'
}

interface FileBrowserProps {
  repo:         string           // repo name for API calls
  repoRootAbs:  string           // absolute path to repo root (for constructing final path)
  onSelect:     (absolutePath: string) => void
  onCancel:     () => void
  selectLabel?: string           // button label, default "Open here"
}

export function FileBrowser({ repo, repoRootAbs, onSelect, onCancel, selectLabel = 'Open here' }: FileBrowserProps) {
  const [subpath,  setSubpath]  = useState('')   // relative to repo root
  const [stack,    setStack]    = useState<string[]>([])
  const [entries,  setEntries]  = useState<FileEntry[]>([])
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [query,    setQuery]    = useState('')
  const [loaded,   setLoaded]   = useState(false)

  const loadPath = useCallback(async (p: string) => {
    setSubpath(p)
    setLoading(true)
    setError('')
    setQuery('')
    setEntries([])
    try {
      const res = await fetch(`/api/repos/${encodeURIComponent(repo)}/tree?path=${encodeURIComponent(p)}`)
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const { entries: data } = await res.json() as { entries: FileEntry[] }
      setEntries((data ?? []).filter(e => e.type === 'dir')) // show dirs only
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error loading directory')
    } finally {
      setLoading(false)
      setLoaded(true)
    }
  }, [repo])

  // Load root on mount
  useEffect(() => { loadPath('') }, [loadPath])

  const handleDir = (name: string) => {
    const newPath = subpath ? `${subpath}/${name}` : name
    setStack(s => [...s, subpath])
    loadPath(newPath)
  }

  const handleBack = () => {
    const prev = stack[stack.length - 1] ?? ''
    setStack(s => s.slice(0, -1))
    loadPath(prev)
  }

  const handleSelect = () => {
    const abs = subpath ? `${repoRootAbs}/${subpath}` : repoRootAbs
    onSelect(abs)
  }

  const filtered = entries.filter(e => e.name.toLowerCase().includes(query.toLowerCase().trim()))

  return (
    <div className={styles.browser}>
      <div className={styles.header}>
        <button className={styles.backBtn} onClick={handleBack} disabled={stack.length === 0}>← Back</button>
        <span className={styles.path}>/{subpath || ''}</span>
        <button className={styles.cancelBtn} onClick={onCancel}>✕</button>
      </div>

      <input
        className={styles.search}
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Filter folders…"
        autoComplete="off"
        spellCheck={false}
      />

      <div className={styles.list}>
        {loading && <div className={styles.status}><Spinner size="sm" label="Loading…" /></div>}
        {error   && <div className={styles.statusError}>{error}</div>}
        {!loading && !error && filtered.map(e => (
          <div key={e.name} className={styles.entry} onClick={() => handleDir(e.name)}>
            <span className={styles.icon}>▸</span>
            <span className={styles.name}>{e.name}/</span>
          </div>
        ))}
        {!loading && !error && filtered.length === 0 && loaded && (
          <div className={styles.status}>{query ? 'No match' : 'No subdirectories'}</div>
        )}
      </div>

      <div className={styles.footer}>
        <span className={styles.currentDir}>Selected: /{subpath || ''}</span>
        <button className={styles.selectBtn} onClick={handleSelect}>{selectLabel}</button>
      </div>
    </div>
  )
}
