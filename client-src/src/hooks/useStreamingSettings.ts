import { useState, useEffect } from 'react'

export interface StreamingSettings {
  streamingCpuWarnThreshold: number
  streamingCpuCriticalThreshold: number
}

/**
 * Fetches and persists streaming CPU threshold settings from /api/settings/streaming.
 * Used by TerminalPage to populate the settings panel inputs.
 */
export function useStreamingSettings() {
  const [streamingSettings, setStreamingSettings] = useState<StreamingSettings | null>(null)

  useEffect(() => {
    fetch('/api/settings/streaming')
      .then(r => r.json())
      .then(setStreamingSettings)
      .catch(() => {})
  }, [])

  async function updateSetting(key: keyof StreamingSettings, value: number) {
    await fetch('/api/settings/streaming', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ [key]: value }),
    })
  }

  return { streamingSettings, updateSetting }
}
