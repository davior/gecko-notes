import { createRouter, createWebHistory } from 'vue-router'
import ListView from '@/views/ListView.vue'
import EditorView from '@/views/EditorView.vue'
import SettingsView from '@/views/SettingsView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      redirect: '/notes',
    },
    {
      path: '/notes',
      name: 'notes',
      component: ListView,
    },
    {
      path: '/notes/new',
      name: 'note-new',
      component: EditorView,
    },
    {
      path: '/notes/:id',
      name: 'note-edit',
      component: EditorView,
    },
    {
      path: '/settings',
      name: 'settings',
      component: SettingsView,
      redirect: '/settings/categories',
      children: [
        {
          path: 'categories',
          name: 'settings-categories',
          component: SettingsView,
        },
        {
          path: 'ai-providers',
          name: 'settings-ai-providers',
          component: SettingsView,
        },
        {
          path: 'general',
          name: 'settings-general',
          component: SettingsView,
        },
      ],
    },
  ],
})

export default router
