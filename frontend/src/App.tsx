import { useEffect } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useSettingsStore } from '@/stores/settings'
import { useCategoriesStore } from '@/stores/categories'
import { useAuthStore } from '@/stores/auth'
import ListView from '@/views/ListView'
import EditorView from '@/views/EditorView'
import SettingsView from '@/views/SettingsView'
import LoginView from '@/views/LoginView'
import SharedNoteView from '@/views/SharedNoteView'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const location = useLocation()
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  return <>{children}</>
}

export default function App() {
  const loadSettings = useSettingsStore((s) => s.loadSettings)
  const loadCategories = useCategoriesStore((s) => s.loadCategories)
  const theme = useSettingsStore((s) => s.theme)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)

  useEffect(() => {
    if (isAuthenticated) {
      Promise.all([loadSettings(), loadCategories()])
    }
  }, [isAuthenticated])

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [theme])

  return (
    <div id="app-root" className="h-screen flex flex-col overflow-hidden">
      <div
        id="theme-bg"
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: -1,
          background: 'var(--theme-bg, transparent)',
          backgroundSize: 'var(--theme-bg-size, cover)',
          backgroundPosition: 'center',
          filter: 'var(--theme-bg-filter, none)',
        }}
      />
      <Routes>
        <Route path="/login" element={isAuthenticated ? <Navigate to="/notes" replace /> : <LoginView />} />
        <Route path="/" element={<Navigate to="/notes" replace />} />
        <Route path="/notes" element={<ProtectedRoute><ListView /></ProtectedRoute>} />
        <Route path="/notes/new" element={<ProtectedRoute><EditorView /></ProtectedRoute>} />
        <Route path="/notes/:id" element={<ProtectedRoute><EditorView /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><Navigate to="/settings/profile" replace /></ProtectedRoute>} />
        <Route path="/settings/:tab" element={<ProtectedRoute><SettingsView /></ProtectedRoute>} />
        <Route path="/shared/:token" element={<SharedNoteView />} />
      </Routes>
    </div>
  )
}
