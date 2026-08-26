import { useEffect, useRef, useState, useCallback } from 'react'
import { Play, Pause, Square, Volume2, VolumeX, GripVertical, Mic, Circle, PanelBottom, Maximize2 } from 'lucide-react'
import type { UseTextToSpeechReturn } from '@/hooks/useTextToSpeech'
import type { UseDictationReturn } from '@/hooks/useDictation'
import DictationWaveIcon from '@/components/DictationWaveIcon'
import { DEEPGRAM_TTS_SPEED_MIN, DEEPGRAM_TTS_SPEED_MAX } from '@/api/settings'

const POS_KEY = 'tts_controls_pos'
const PANEL_FALLBACK_W = 280
const PANEL_FALLBACK_H = 44

interface Props {
  tts: UseTextToSpeechReturn
  anchorRef: React.RefObject<HTMLElement>
  onPlayPause: () => void
  dictation?: UseDictationReturn
  onDictationToggle?: () => void
  /** Toggle for the Record button (record + transcribe + save audio). */
  onRecordToggle?: () => void
  /** When true, pressing Play also saves + inserts the TTS audio into the note. */
  insertMode?: boolean
  onToggleInsertMode?: () => void
  ttsSpeed?: number
  onTtsSpeedChange?: (speed: number) => void
  /** When true the controls render inline (e.g. inside the editor status bar)
   *  instead of as a fixed, draggable floating panel. */
  docked?: boolean
  /** Toggle between floating and docked. Renders a dock/undock button when set. */
  onToggleDock?: () => void
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v))
}

/**
 * Read-aloud / dictation control panel: play/pause toggle, a stop button
 * (always visible, disabled when not speaking), an always-visible volume
 * control, a dictation toggle and a speed slider.
 *
 * It can be displayed in two modes:
 *  - Floating (default): a draggable pill whose position is remembered across
 *    notes in localStorage and defaults to sitting next to the export button.
 *  - Docked: rendered inline inside the editor's bottom status bar.
 * A dock/undock button (shown when `onToggleDock` is provided) switches modes.
 */
export default function TTSPlaybackControls({ tts, anchorRef, onPlayPause, dictation, onDictationToggle, onRecordToggle, insertMode = false, onToggleInsertMode, ttsSpeed = 1, onTtsSpeedChange, docked = false, onToggleDock }: Props) {
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
  // Skipped while docked — positioning is irrelevant for the inline variant.
  useEffect(() => {
    if (docked || pos !== null) return
    const el = anchorRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      setPos({ x: clamp(r.left, 8, window.innerWidth - PANEL_FALLBACK_W), y: r.bottom + 8 })
    } else {
      setPos({ x: window.innerWidth - PANEL_FALLBACK_W - 16, y: 80 })
    }
  }, [pos, anchorRef, docked])

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

  const recordActive = dictation?.status === 'recording' && dictation?.mode === 'record'
  const dictationActive = dictation?.status === 'recording' && dictation?.mode === 'dictation'

  // Shared controls, identical in both floating and docked modes.
  const controls = (
    <>
      {onToggleInsertMode && (
        <button
          className="flex items-center gap-1 pl-1 pr-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          onClick={onToggleInsertMode}
          onMouseDown={(e) => e.preventDefault()}
          title={insertMode ? 'Insert Mode on — Play saves the audio into the note' : 'Insert Mode off — Play is transient'}
          aria-label="Toggle Insert Mode"
          aria-pressed={insertMode}
        >
          <span className={`w-2.5 h-2.5 rounded-full ${insertMode ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-xs whitespace-nowrap">Insert Mode</span>
        </button>
      )}

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

      {dictation && onDictationToggle && dictation.isSupported && (
        <button
          className="p-1.5 rounded-full text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-50"
          onClick={onDictationToggle}
          // Keep the editor's focus/cursor so dictated text lands at the cursor
          // position rather than blurring the note (which appends to the end).
          onMouseDown={(e) => e.preventDefault()}
          disabled={dictation.status === 'transcribing' || recordActive}
          title={dictationActive ? 'Stop dictation' : 'Start dictation'}
          aria-label={dictationActive ? 'Stop dictation' : 'Start dictation'}
        >
          {dictationActive ? (
            <DictationWaveIcon className="text-red-500" />
          ) : (
            <Mic className="w-4 h-4" />
          )}
        </button>
      )}

      {dictation && onRecordToggle && dictation.canRecord && (
        <button
          className="p-1.5 rounded-full text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-50"
          onClick={onRecordToggle}
          // Keep editor focus so the recording + transcription land at the cursor.
          onMouseDown={(e) => e.preventDefault()}
          disabled={dictation.status === 'transcribing' || dictationActive}
          title={recordActive ? 'Stop recording' : 'Record (saves audio + transcription)'}
          aria-label={recordActive ? 'Stop recording' : 'Record audio'}
        >
          <Circle className={`w-4 h-4 text-red-500 ${recordActive ? 'fill-red-500 animate-pulse' : ''}`} />
        </button>
      )}

      <div className="flex items-center gap-1 pl-1 pr-1.5">
        <input
          type="range"
          min={DEEPGRAM_TTS_SPEED_MIN}
          max={DEEPGRAM_TTS_SPEED_MAX}
          step={0.05}
          value={ttsSpeed}
          className="w-16 accent-blue-600"
          onChange={(e) => onTtsSpeedChange?.(parseFloat(e.target.value))}
          title={`Speed: ${ttsSpeed.toFixed(2)}x`}
          aria-label="TTS Speed"
        />
        <span className="text-xs text-gray-400 dark:text-gray-500 w-8 text-right">{ttsSpeed.toFixed(2)}x</span>
      </div>
    </>
  )

  // Docked: inline within the editor status bar, no fixed positioning or drag.
  if (docked) {
    return (
      <div ref={panelRef} className="flex items-center gap-1 no-print">
        {controls}
        {onToggleDock && (
          <button
            className="p-1.5 rounded-full text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            onClick={onToggleDock}
            title="Detach to floating panel"
            aria-label="Undock playback controls"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
        )}
      </div>
    )
  }

  // Floating: a draggable pill positioned from localStorage.
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

      {controls}

      {onToggleDock && (
        <button
          className="p-1.5 rounded-full text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          onClick={onToggleDock}
          title="Dock to status bar"
          aria-label="Dock playback controls to status bar"
        >
          <PanelBottom className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}
