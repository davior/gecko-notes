import { createPortal } from 'react-dom'
import { useEffect, type ReactNode } from 'react'
import { useDropdown } from '@/hooks/useDropdown'

interface Props {
  /** Inner content of the pill trigger button (icon + label/count). */
  trigger: ReactNode
  /** Content rendered inside the portaled popover panel. */
  children: ReactNode
  /** Width/extra classes for the panel (e.g. "w-72"). */
  panelClassName?: string
  /** Tooltip / aria-label for the trigger. */
  title?: string
  /**
   * Imperative open hook: whenever this number increases the flyout opens.
   * Lets a parent surface the panel after an action (e.g. metadata generation).
   */
  openSignal?: number
}

/**
 * A compact "fold-away" control for the editor's meta bar: a small pill trigger
 * that opens a portaled popover. Built on the same `useDropdown` + portal pattern
 * as `CategoryPicker` (fixed positioning + outside-click-to-close).
 */
export default function MetaFlyout({ trigger, children, panelClassName = 'w-72', title, openSignal }: Props) {
  const { open, setOpen, triggerRef, dropdownRef, style } = useDropdown('left')

  useEffect(() => {
    if (openSignal !== undefined && openSignal > 0) setOpen(true)
  }, [openSignal, setOpen])

  return (
    <div className="relative" ref={triggerRef}>
      <button
        type="button"
        title={title}
        aria-label={title}
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-sm transition-colors ${
          open
            ? 'border-blue-300 bg-blue-50 text-blue-600 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-300'
            : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
        }`}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>

      {open && createPortal(
        <div
          ref={dropdownRef}
          className={`z-50 mt-1 max-h-[60vh] overflow-auto rounded-xl border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800 ${panelClassName}`}
          style={style}
        >
          {children}
        </div>,
        document.body,
      )}
    </div>
  )
}
