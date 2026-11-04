import { useEffect } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { applyThemeToDom, useSettingsStore } from '@/stores/settings'
import { cachedTheme } from '@/api/suiteThemes'
import { useCategoriesStore } from '@/stores/categories'
import { useRecipesStore } from '@/stores/recipes'
import { useAuthStore } from '@/stores/auth'
import ListView from '@/views/ListView'
import EditorView from '@/views/EditorView'
import SettingsView from '@/views/SettingsView'
import LoginView from '@/views/LoginView'
import VerifyEmailView from '@/views/VerifyEmailView'
import ResetPasswordView from '@/views/ResetPasswordView'
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
  const loadRecipes = useRecipesStore((s) => s.loadRecipes)
  const theme = useSettingsStore((s) => s.theme)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)

  useEffect(() => {
    if (isAuthenticated) {
      Promise.all([loadSettings(), loadCategories(), loadRecipes()])
    }
  }, [isAuthenticated])

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [theme])

  // The theme Notes last wore from Gecko Suite (M7), drawn before the suite is asked, so
  // a reload does not flash the plain look. After the effect above, which would otherwise
  // take its dark mode off. Only ever written in suite mode, and cleared on sign-out.
  useEffect(() => {
    const cached = cachedTheme()
    if (cached) applyThemeToDom(cached)
  }, [])

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
        <Route path="/verify-email" element={<VerifyEmailView />} />
        <Route path="/reset-password" element={<ResetPasswordView />} />
        <Route path="/" element={<Navigate to="/notes" replace />} />
        <Route path="/notes" element={<ProtectedRoute><ListView /></ProtectedRoute>} />
        <Route path="/notes/new" element={<ProtectedRoute><EditorView /></ProtectedRoute>} />
        <Route path="/notes/:id" element={<ProtectedRoute><EditorView /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><Navigate to="/settings/profile" replace /></ProtectedRoute>} />
        <Route path="/settings/ai" element={<ProtectedRoute><Navigate to="/settings/ai/providers" replace /></ProtectedRoute>} />
        <Route path="/settings/ai/:section" element={<ProtectedRoute><SettingsView /></ProtectedRoute>} />
        <Route path="/settings/:tab" element={<ProtectedRoute><SettingsView /></ProtectedRoute>} />
        <Route path="/shared/:token" element={<SharedNoteView />} />
      </Routes>
    </div>
  )
}
