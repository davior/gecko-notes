import { useCallback, useEffect, useRef, useState } from 'react'
import { connectFluxStream, type FluxStreamEvent, type FluxStreamHandle } from '@/api/fluxStream'
import { useTextToSpeech } from '@/hooks/useTextToSpeech'

// The explicit conversational states the voice overlay renders.
export type VoiceState =
  | 'idle'        // not running
  | 'connecting'  // requesting mic + opening the Flux socket
  | 'listening'   // mic live, waiting for / hearing the user
  | 'thinking'    // user's turn ended, the assistant is working
  | 'speaking'    // the assistant is talking back
  | 'barge_in'    // the user interrupted while the assistant was speaking
  | 'error'

export interface UseVoiceModeOptions {
  // Called once per completed user turn (Flux EndOfTurn) with the transcript.
  // The panel runs the assistant pipeline and calls speak() with the reply.
  onUserTurn: (transcript: string) => void
  // Called when the user starts talking over the assistant (barge-in) so the
  // panel can abort any in-flight LLM/plan work.
  onBargeIn?: () => void
  // Called on an unrecoverable error (mic denied, socket failure) so the caller
  // can fall back to normal mode.
  onError?: (message: string) => void
}

export interface UseVoiceModeReturn {
  state: VoiceState
  interimText: string
  errorMessage: string
  active: boolean
  start: () => Promise<void>
  stop: () => void
  /** Speak the assistant's reply, then return to listening. */
  speak: (text: string) => void
  /** Mark the assistant as working (used by the panel before a slow turn). */
  setThinking: () => void
}

export function useVoiceMode(options: UseVoiceModeOptions): UseVoiceModeReturn {
  const [state, setState] = useState<VoiceState>('idle')
  const [interimText, setInterimText] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  const tts = useTextToSpeech()

  const activeRef = useRef(false)
  const stateRef = useRef<VoiceState>('idle')
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const handleRef = useRef<FluxStreamHandle | null>(null)

  // Keep option callbacks fresh so the long-lived socket handler never calls a
  // stale closure.
  const optsRef = useRef(options)
  useEffect(() => { optsRef.current = options })

  const setStateSafe = useCallback((s: VoiceState) => {
    stateRef.current = s
    setState(s)
  }, [])

  const teardown = useCallback(() => {
    try { recorderRef.current?.stop() } catch { /* already stopped */ }
    recorderRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    handleRef.current?.close()
    handleRef.current = null
    tts.stop()
  }, [tts])

  const stop = useCallback(() => {
    if (!activeRef.current && stateRef.current === 'idle') return
    activeRef.current = false
    // Ask the backend to close the Flux stream gracefully, then release the mic.
    handleRef.current?.stop()
    teardown()
    setInterimText('')
    setStateSafe('idle')
  }, [teardown, setStateSafe])

  // Drive speaking → listening off the player's own status (see useTextToSpeech):
  // once playback finishes (or fails) while we're in the speaking state, hand the
  // turn back to the user.
  useEffect(() => {
    if (!activeRef.current) return
    if (stateRef.current === 'speaking' && (tts.status === 'idle' || tts.status === 'error')) {
      setStateSafe('listening')
    }
  }, [tts.status, setStateSafe])

  const speak = useCallback((text: string) => {
    if (!activeRef.current) return
    const trimmed = (text || '').trim()
    if (!trimmed) { setStateSafe('listening'); return }
    setStateSafe('speaking')
    tts.play(trimmed)
  }, [tts, setStateSafe])

  const setThinking = useCallback(() => {
    if (activeRef.current) setStateSafe('thinking')
  }, [setStateSafe])

  const handleEvent = useCallback((event: FluxStreamEvent) => {
    if (!activeRef.current) return
    switch (event.type) {
      case 'start_of_turn': {
        // The user began a new turn. If the assistant was mid-reply or mid-think,
        // that's a barge-in: stop the audio and abort in-flight work.
        if (stateRef.current === 'speaking') {
          tts.stop()
          optsRef.current.onBargeIn?.()
          setStateSafe('barge_in')
        } else if (stateRef.current === 'thinking') {
          optsRef.current.onBargeIn?.()
          setStateSafe('listening')
        } else {
          setStateSafe('listening')
        }
        break
      }
      case 'update':
        setInterimText(event.text)
        if (stateRef.current !== 'speaking') setStateSafe('listening')
        break
      case 'end_of_turn': {
        const transcript = (event.text || '').trim()
        setInterimText('')
        if (transcript) {
          setStateSafe('thinking')
          optsRef.current.onUserTurn(transcript)
        } else {
          setStateSafe('listening')
        }
        break
      }
      case 'turn_resumed':
        // Only emitted with eager EOT (unused here); treat as "keep listening".
        setStateSafe('listening')
        break
      case 'eager_eot':
        // Not used for turn-taking here; ignore.
        break
      case 'error':
        setErrorMessage(event.message)
        setStateSafe('error')
        activeRef.current = false
        teardown()
        optsRef.current.onError?.(event.message)
        break
    }
  }, [tts, setStateSafe, teardown])

  const handleClose = useCallback((code: number, reason: string) => {
    if (!activeRef.current) return
    // A close while we're still active is unexpected (we didn't call stop()).
    activeRef.current = false
    teardown()
    const msg = reason || 'Voice session ended unexpectedly'
    setErrorMessage(msg)
    setStateSafe('error')
    optsRef.current.onError?.(msg)
  }, [teardown, setStateSafe])

  const start = useCallback(async () => {
    if (activeRef.current) return
    setErrorMessage('')
    setInterimText('')
    setStateSafe('connecting')

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch {
      const msg = 'Microphone access was denied'
      setErrorMessage(msg)
      setStateSafe('error')
      optsRef.current.onError?.(msg)
      return
    }
    streamRef.current = stream
    activeRef.current = true

    handleRef.current = connectFluxStream(handleEvent, handleClose)

    try {
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg'
      const recorder = new MediaRecorder(stream, { mimeType: mime })
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) handleRef.current?.sendAudioChunk(e.data)
      }
      recorder.start(250)  // 250ms timeslices, matching the dictation path
      recorderRef.current = recorder
    } catch {
      const msg = 'Audio recording is not supported in this browser'
      setErrorMessage(msg)
      activeRef.current = false
      teardown()
      setStateSafe('error')
      optsRef.current.onError?.(msg)
      return
    }

    setStateSafe('listening')
  }, [handleEvent, handleClose, teardown, setStateSafe])

  // Clean up on unmount.
  useEffect(() => () => {
    activeRef.current = false
    teardown()
  }, [teardown])

  return {
    state,
    interimText,
    errorMessage,
    active: state !== 'idle' && state !== 'error',
    start,
    stop,
    speak,
    setThinking,
  }
}
