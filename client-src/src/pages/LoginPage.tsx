import { useState, useEffect, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Input, FormField, Alert, Header, Card } from '@/components'
import styles from './LoginPage.module.css'

export function LoginPage() {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')

  // Redirect if already authenticated
  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then((d: { authenticated: boolean }) => {
        if (d.authenticated) navigate('/projects', { replace: true })
      })
      .catch(() => { /* not authenticated, stay on login */ })
  }, [navigate])

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const res = await fetch('/api/auth/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password }),
      })

      if (res.ok) {
        navigate('/projects', { replace: true })
      } else {
        const data = await res.json().catch(() => ({ error: 'Login failed' })) as { error?: string }
        setError(data.error ?? 'Invalid password')
        setPassword('')
      }
    } catch {
      setError('Connection error — server unreachable')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.page}>
      <Header variant="default">
        <div className={styles.logo}>⌘ <span>Remote</span>VibeCoder</div>
      </Header>

      <main className={styles.container}>
        <Card variant="login">
          <h2 className={styles.title}>$ claude --login</h2>
          <p className={styles.subtitle}>Enter your password to access Claude Code.</p>

          <form onSubmit={handleSubmit} autoComplete="off">
            <FormField label="Password" htmlFor="password">
              <Input
                type="password"
                id="password"
                name="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                autoFocus
                required
              />
            </FormField>

            <Button
              variant="primary"
              type="submit"
              fullWidth
              loading={loading}
            >
              Connect
            </Button>

            {error && (
              <Alert variant="error" style={{ marginTop: '8px' }}>{error}</Alert>
            )}
          </form>
        </Card>
      </main>
    </div>
  )
}
