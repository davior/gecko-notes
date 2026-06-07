import { useEffect, useRef, useState, useCallback } from 'react'
import { Play, Pause, Square, Volume2, VolumeX, GripVertical } from 'lucide-react'
import type { UseTextToSpeechReturn } from '@/hooks/useTextToSpeech'

const POS_KEY = 'tts_controls_pos'
const PANEL_FALLBACK_W = 220
const PANEL_FALLBACK_H = 44

interface Props {
  tts: UseTextToSpeechReturn
  anchorRef: React.RefObject<HTMLElement>
  onPlayPause: () => void
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v))
}

/**
 * Floating, draggable read-aloud control panel: play/pause toggle, a stop
 * button (always visible, disabled when not speaking) and an always-visible
 * volume control. Its position is remembered across notes in localStorage and
 * defaults to sitting next to the export button.
 */
export default function TTSPlaybackControls({ tts, anchorRef, onPlayPause }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const lastVolRef = useRef(tts.volume || 1)

  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      const raw = localStorage.getItem(POS_KEY)
      if (raw) {
        const p = JSON.parse(raw)
        if (typeof p?.x === 'number' && typeof p?.y === 'number') return p
      }
    } catch { /* ignore */ }
    return null
  })

  // First mount with no saved position: anchor next to the export button.
  useEffect(() => {
    if (pos !== null) return
    const el = anchorRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      setPos({ x: clamp(r.left, 8, window.innerWidth - PANEL_FALLBACK_W), y: r.bottom + 8 })
    } else {
      setPos({ x: window.innerWidth - PANEL_FALLBACK_W - 16, y: 80 })
    }
  }, [pos, anchorRef])

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!dragRef.current) return
    const w = panelRef.current?.offsetWidth ?? PANEL_FALLBACK_W
    const h = panelRef.current?.offsetHeight ?? PANEL_FALLBACK_H
    setPos({
      x: clamp(e.clientX - dragRef.current.dx, 0, window.innerWidth - w),
      y: clamp(e.clientY - dragRef.current.dy, 0, window.innerHeight - h),
    })
  }, [])

  const onPointerUp = useCallback(() => {
    dragRef.current = null
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    setPos((p) => {
      if (p) { try { localStorage.setItem(POS_KEY, JSON.stringify(p)) } catch { /* ignore */ } }
      return p
    })
  }, [onPointerMove])

  const onHandlePointerDown = useCallback((e: React.PointerEvent) => {
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    e.preventDefault()
  }, [onPointerMove, onPointerUp])

  // Keep within the viewport when the window resizes; clean up listeners.
  useEffect(() => {
    function onResize() {
      setPos((p) => {
        if (!p) return p
        const w = panelRef.current?.offsetWidth ?? PANEL_FALLBACK_W
        const h = panelRef.current?.offsetHeight ?? PANEL_FALLBACK_H
        return { x: clamp(p.x, 0, window.innerWidth - w), y: clamp(p.y, 0, window.innerHeight - h) }
      })
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [onPointerMove, onPointerUp])

  function toggleMute() {
    if (tts.volume === 0) {
      tts.setVolume(lastVolRef.current || 1)
    } else {
      lastVolRef.current = tts.volume
      tts.setVolume(0)
    }
  }

  const isLoading = tts.status === 'loading'
  const isPlaying = tts.status === 'playing'

  return (
    <div
      ref={panelRef}
      className="fixed z-40 flex items-center gap-1 rounded-full border border-gray-200 dark:border-gray-700 bg-white/95 dark:bg-gray-800/95 backdrop-blur px-1.5 py-1 shadow-lg no-print"
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
    >
      <button
        className="cursor-grab active:cursor-grabbing text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400 touch-none"
        onPointerDown={onHandlePointerDown}
        title="Drag to move"
        aria-label="Move playback controls"
      >
        <GripVertical className="w-4 h-4" />
      </button>

      <button
        className="p-1.5 rounded-full text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-50"
        onClick={onPlayPause}
        disabled={isLoading}
        title={isPlaying ? 'Pause' : 'Play'}
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isLoading ? (
          <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        ) : isPlaying ? (
          <Pause className="w-4 h-4" />
        ) : (
          <Play className="w-4 h-4" />
        )}
      </button>

      <button
        className="p-1.5 rounded-full text-gray-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-500"
        onClick={() => tts.stop()}
        disabled={!tts.isSpeaking}
        title="Stop"
        aria-label="Stop"
      >
        <Square className="w-4 h-4" />
      </button>

      <div className="flex items-center gap-1 pl-1 pr-1.5">
        <button
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          onClick={toggleMute}
          title={tts.volume === 0 ? 'Unmute' : 'Mute'}
          aria-label={tts.volume === 0 ? 'Unmute' : 'Mute'}
        >
          {tts.volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={tts.volume}
          className="w-20 accent-blue-600"
          onChange={(e) => tts.setVolume(parseFloat(e.target.value))}
          aria-label="Volume"
        />
      </div>
    </div>
  )
}
