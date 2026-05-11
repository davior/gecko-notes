import { useState, useRef, useEffect, useCallback } from 'react'

export function useDropdown(align: 'left' | 'right' = 'left') {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number }>({ top: 0, left: 0 })

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setPos(
      align === 'right'
        ? { top: rect.bottom + 4, right: window.innerWidth - rect.right }
        : { top: rect.bottom + 4, left: rect.left },
    )
  }, [align])

  useEffect(() => {
    if (!open) return
    updatePos()
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node
      if (!triggerRef.current?.contains(target) && !dropdownRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open, updatePos])

  const style: React.CSSProperties = {
    position: 'fixed',
    top: pos.top,
    ...(pos.left !== undefined ? { left: pos.left } : { right: pos.right }),
  }

  return { open, setOpen, triggerRef, dropdownRef, style }
}
