<template>
  <div class="relative" ref="containerRef">
    <button
      class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-sm hover:border-gray-300 hover:bg-gray-50 transition-colors"
      @click="open = !open"
    >
      <span v-if="selectedCategory">
        {{ selectedCategory.emoji }} {{ selectedCategory.label }}
      </span>
      <span v-else class="text-gray-400">Select category</span>
      <ChevronDown class="w-4 h-4 text-gray-400" />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="dropdownRef"
        class="fixed z-50 mt-1 w-56 bg-white rounded-xl border border-gray-200 shadow-lg overflow-hidden"
        :style="dropdownStyle"
      >
        <div class="p-1">
          <button
            v-for="cat in categories"
            :key="cat.id"
            class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors text-left"
            :class="{ 'bg-blue-50 text-blue-700': cat.id === modelValue }"
            @click="select(cat.id)"
          >
            <span
              class="w-2 h-2 rounded-full shrink-0"
              :style="{ backgroundColor: cat.color }"
            />
            <span>{{ cat.emoji }}</span>
            <span>{{ cat.label }}</span>
            <Check v-if="cat.id === modelValue" class="w-4 h-4 ml-auto text-blue-600" />
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { ChevronDown, Check } from 'lucide-vue-next'
import { useCategoriesStore } from '@/stores/categories'

const props = defineProps<{
  modelValue: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const categoriesStore = useCategoriesStore()
const categories = computed(() => categoriesStore.categories)
const selectedCategory = computed(() => categoriesStore.getCategoryById(props.modelValue))

const open = ref(false)
const containerRef = ref<HTMLElement | null>(null)
const dropdownRef = ref<HTMLElement | null>(null)
const dropdownStyle = ref<Record<string, string>>({})

function updateDropdownPosition() {
  if (!containerRef.value) return
  const rect = containerRef.value.getBoundingClientRect()
  dropdownStyle.value = {
    top: `${rect.bottom + 4}px`,
    left: `${rect.left}px`,
  }
}

function select(id: string) {
  emit('update:modelValue', id)
  open.value = false
}

function handleClickOutside(e: MouseEvent) {
  const target = e.target as Node
  const inTrigger = containerRef.value?.contains(target) ?? false
  const inDropdown = dropdownRef.value?.contains(target) ?? false
  if (!inTrigger && !inDropdown) {
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

onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutside)
})
</script>
