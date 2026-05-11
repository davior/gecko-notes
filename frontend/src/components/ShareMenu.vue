<template>
  <div class="relative" ref="containerRef">
    <button class="btn-ghost gap-1 text-sm" @click="open = !open">
      <Share2 class="w-4 h-4" />
      Share
      <ChevronDown class="w-3 h-3" />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        class="fixed z-50 w-52 bg-white rounded-xl border border-gray-200 shadow-lg overflow-hidden"
        :style="dropdownStyle"
      >
        <div class="p-1">
          <button
            v-for="item in shareItems"
            :key="item.label"
            class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors text-left"
            @click="handleShare(item)"
          >
            <component :is="item.icon" class="w-4 h-4 text-gray-500" />
            <span>{{ item.label }}</span>
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { Share2, Mail, ChevronDown } from 'lucide-vue-next'
import type { Note } from '@/api/notes'
import { shareViaEmail, shareViaFacebook, shareViaTwitter, shareViaSubstack } from '@/utils/share'

const props = defineProps<{
  note: Note
}>()

const emit = defineEmits<{
  toast: [message: string]
}>()

const open = ref(false)
const containerRef = ref<HTMLElement | null>(null)
const dropdownStyle = ref<Record<string, string>>({})

interface ShareItem {
  label: string
  icon: unknown
  action: () => Promise<void> | void
}

const shareItems: ShareItem[] = [
  {
    label: 'Share via Email',
    icon: Mail,
    action: () => shareViaEmail(props.note),
  },
  {
    label: 'Share on Facebook',
    icon: Share2,
    action: () => shareViaFacebook(props.note),
  },
  {
    label: 'Share on X (Twitter)',
    icon: Share2,
    action: () => shareViaTwitter(props.note),
  },
  {
    label: 'Share on Substack',
    icon: Share2,
    action: async () => {
      await shareViaSubstack(props.note)
      emit('toast', 'Content copied — paste into your Substack draft')
    },
  },
]

async function handleShare(item: ShareItem) {
  open.value = false
  await item.action()
}

function updateDropdownPosition() {
  if (!containerRef.value) return
  const rect = containerRef.value.getBoundingClientRect()
  dropdownStyle.value = {
    top: `${rect.bottom + 4}px`,
    right: `${window.innerWidth - rect.right}px`,
  }
}

function handleClickOutside(e: MouseEvent) {
  if (containerRef.value && !containerRef.value.contains(e.target as Node)) {
    open.value = false
  }
}

watch(open, (val) => {
  if (val) {
    updateDropdownPosition()
    document.addEventListener('mousedown', handleClickOutside)
  } else {
    document.removeEventListener('mousedown', handleClickOutside)
  }
})
</script>
