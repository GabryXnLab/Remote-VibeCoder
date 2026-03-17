import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { LoginPage }    from './pages/LoginPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { TerminalPage } from './pages/TerminalPage'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"         element={<LoginPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/terminal" element={<TerminalPage />} />
        <Route path="*"         element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
