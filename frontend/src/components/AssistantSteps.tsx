import { useEffect, useState, type ReactNode } from 'react'
import { BookOpen, ChevronDown, ChevronRight, Search, Sparkles, TriangleAlert, Wrench } from 'lucide-react'
import type { TurnStep } from '@/api/assistant'
import { formatCost } from '@/api/imageGen'

/**
 * What an assistant turn did, step by step, and what it cost: GVC's steps list.
 *
 * Open while the turn runs, so each search, note read and proposed change shows up as it
 * happens; collapsed to "N steps" under the finished reply, where it is kept.
 */

const STEP_ICON: Record<string, ReactNode> = {
  search: <Search className="h-3 w-3" />,
  read: <BookOpen className="h-3 w-3" />,
  edit: <Wrench className="h-3 w-3" />,
  issue: <TriangleAlert className="h-3 w-3 text-amber-600" />,
  think: <Sparkles className="h-3 w-3" />,
}

export function AssistantSteps({ steps, live }: { steps: TurnStep[]; live: boolean }) {
  const [open, setOpen] = useState(live)
  useEffect(() => setOpen(live), [live])
  if (steps.length === 0) return null
  return (
    <div className="text-xs text-gray-500 dark:text-gray-400">
      <button
        type="button"
        className="flex items-center gap-1 hover:text-gray-700 dark:hover:text-gray-200"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {steps.length} step{steps.length === 1 ? '' : 's'}
      </button>
      {open && (
        <ol className="mt-1 space-y-0.5 border-l border-gray-200 pl-2 dark:border-gray-700">
          {steps.map((step, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <span className="mt-0.5 shrink-0">{STEP_ICON[step.kind] ?? null}</span>
              <span className="line-clamp-3 break-words">{step.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/** "about $0.0123 (estimate)", or nothing while no priced call has landed. */
export function TurnCost({ cost, label = '' }: { cost: number | null | undefined; label?: string }) {
  if (cost == null || cost <= 0) return null
  return (
    <p className="text-[11px] text-gray-400 dark:text-gray-500">
      {label}about {formatCost(cost)} (estimate)
    </p>
  )
}
