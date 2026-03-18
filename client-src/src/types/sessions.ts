export interface SessionMetadata {
  sessionId: string    // full tmux name: "claude-myrepo-ab1c2d"
  repo:      string | null
  label:     string
  mode:      'claude' | 'shell'
  workdir:   string
  created:   number    // ms timestamp
  windows:   number
}
