import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useSettingsStore } from '@/stores/settings'
import { useCategoriesStore } from '@/stores/categories'
import ListView from '@/views/ListView'
import EditorView from '@/views/EditorView'
import SettingsView from '@/views/SettingsView'

export default function App() {
  const loadSettings = useSettingsStore((s) => s.loadSettings)
  const loadCategories = useCategoriesStore((s) => s.loadCategories)
  const theme = useSettingsStore((s) => s.theme)

  useEffect(() => {
    Promise.all([loadSettings(), loadCategories()])
  }, [])

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [theme])

  return (
    <div id="app-root" className="h-screen flex flex-col overflow-hidden">
      <Routes>
        <Route path="/" element={<Navigate to="/notes" replace />} />
        <Route path="/notes" element={<ListView />} />
        <Route path="/notes/new" element={<EditorView />} />
        <Route path="/notes/:id" element={<EditorView />} />
        <Route path="/settings" element={<Navigate to="/settings/categories" replace />} />
        <Route path="/settings/:tab" element={<SettingsView />} />
      </Routes>
    </div>
  )
}
