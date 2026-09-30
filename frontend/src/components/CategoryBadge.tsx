import type { Category } from '@/api/categories'

export default function CategoryBadge({ category }: { category: Category }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium text-white max-w-full"
      style={{ backgroundColor: category.color }}
    >
      <span className="shrink-0">{category.emoji}</span>
      <span className="truncate">{category.label}</span>
    </span>
  )
}
