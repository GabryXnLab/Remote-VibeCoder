import { useState, useEffect } from 'react'
import { Spinner } from '@/components/ui/Spinner'
import { FileBrowser } from '@/components/FileBrowser/FileBrowser'
import styles from './RepoSelector.module.css'

interface Repo {
  name:    string
  cloned:  boolean
  private: boolean
  archived: boolean
}

interface RepoSelectorProps {
  onSelect:  (repo: string, workdir: string) => void
  onCancel:  () => void
  title?:    string
}

export function RepoSelector({ onSelect, onCancel, title = 'Select project' }: RepoSelectorProps) {
  const [repos,        setRepos]        = useState<Repo[]>([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')
  const [cloning,      setCloning]      = useState<string | null>(null)
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null)

  useEffect(() => {
    fetch('/api/repos')
      .then(r => r.json())
      .then((d: { repos: Repo[] }) => { setRepos(d.repos ?? []); setLoading(false) })
      .catch(() => { setError('Failed to load repos'); setLoading(false) })
  }, [])

  const handleClone = async (repo: Repo) => {
    setCloning(repo.name)
    try {
      const res = await fetch('/api/repos/clone', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: repo.name }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(d.error ?? 'Clone failed')
      }
      setRepos(prev => prev.map(r => r.name === repo.name ? { ...r, cloned: true } : r))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Clone failed')
    } finally {
      setCloning(null)
    }
  }

  const handleSelectRepo = (repo: Repo) => {
    setSelectedRepo(repo)
    // FileBrowser passes __REPO_ROOT__/{repo}/subpath to onSelect — resolved server-side in sessions.js
  }

  if (selectedRepo) {
    return (
      <FileBrowser
        repo={selectedRepo.name}
        repoRootAbs={`__REPO_ROOT__/${selectedRepo.name}`} // special marker; resolved server-side
        onSelect={(absPath) => onSelect(selectedRepo.name, absPath)}
        onCancel={() => setSelectedRepo(null)}
        selectLabel="Open terminal here"
      />
    )
  }

  return (
    <div className={styles.selector}>
      <div className={styles.header}>
        <span className={styles.title}>{title}</span>
        <button className={styles.closeBtn} onClick={onCancel}>✕</button>
      </div>

      {loading && <Spinner size="sm" label="Loading…" style={{ padding: 16 }} />}
      {error   && <div className={styles.error}>{error}</div>}

      <div className={styles.list}>
        {repos.filter(r => !r.archived).map(repo => (
          <div key={repo.name} className={styles.row}>
            <div className={styles.repoInfo}>
              <span className={styles.repoName}>{repo.private ? '🔒' : '🔓'} {repo.name}</span>
            </div>
            {repo.cloned ? (
              <button className={styles.selectBtn} onClick={() => handleSelectRepo(repo)}>
                Select →
              </button>
            ) : (
              <button
                className={styles.cloneBtn}
                disabled={cloning === repo.name}
                onClick={() => handleClone(repo)}
              >
                {cloning === repo.name ? 'Cloning…' : 'Clone'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
