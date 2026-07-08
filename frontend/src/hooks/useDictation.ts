import { useState, useRef, useEffect, useCallback } from 'react'

// Self-contained type declarations for the Web Speech API — not universally present
// in all TypeScript DOM lib versions, so we declare them explicitly here.
interface SpeechRecognitionAlternative {
  readonly transcript: string
  readonly confidence: number
}

interface SpeechRecognitionResult {
  readonly length: number
  readonly isFinal: boolean
  readonly [index: number]: SpeechRecognitionAlternative
}

interface SpeechRecognitionResultList {
  readonly length: number
  readonly [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultList
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  abort(): void
  onstart: ((ev: Event) => void) | null
  onresult: ((ev: SpeechRecognitionEvent) => void) | null
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null
  onend: ((ev: Event) => void) | null
}

interface SpeechRecognitionConstructor {
  new(): SpeechRecognitionInstance
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
}

export type DictationStatus = 'idle' | 'recording' | 'transcribing' | 'error' | 'unsupported'

/** Which control started the active recording session, or null when idle. */
export type DictationMode = 'dictation' | 'record' | null

export interface UseDictationReturn {
  status: DictationStatus
  /** Which control owns the in-progress session, so the UI can light up the
   *  right button (mic vs. record). Null when no session is active. */
  mode: DictationMode
  interimText: string
  errorMessage: string
  isSupported: boolean
  /** True when audio can be recorded and transcribed (MediaRecorder + a
   *  transcribe backend). The Record button requires this regardless of whether
   *  the Web Speech API is available. */
  canRecord: boolean
  startDictation: () => void
  stopDictation: () => void
  toggleDictation: () => void
  startRecording: () => void
  stopRecording: () => void
  toggleRecording: () => void
}

const SPEECH_ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone access denied',
  'no-speech': 'No speech detected',
  'network': 'Network error — check your connection',
  'audio-capture': 'No microphone found',
  'aborted': 'Dictation was aborted',
}

const hasSpeechRecognition =
  typeof window !== 'undefined' &&
  (!!window.SpeechRecognition || !!window.webkitSpeechRecognition)

const hasMediaRecorder =
  typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined'

export function useDictation(
  onFinalResult: (text: string) => void,
  options?: {
    transcribeAudio?: (blob: Blob) => Promise<string>
    /** Called when a Record-button session finishes, with the transcription
     *  (possibly empty if transcription failed) and the recorded audio blob. */
    onRecordingComplete?: (text: string, blob: Blob) => void
  },
): UseDictationReturn {
  const useRecorderFallback = !hasSpeechRecognition && hasMediaRecorder && !!options?.transcribeAudio
  const isSupported = hasSpeechRecognition || useRecorderFallback
  // The Record button always needs to capture the audio file, which only the
  // MediaRecorder path can do — so it's available whenever MediaRecorder and a
  // transcribe backend exist, independent of Web Speech API support.
  const canRecord = hasMediaRecorder && !!options?.transcribeAudio

  const [status, setStatus] = useState<DictationStatus>(isSupported ? 'idle' : 'unsupported')
  const [mode, setMode] = useState<DictationMode>(null)
  const [interimText, setInterimText] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const onFinalResultRef = useRef(onFinalResult)
  const transcribeAudioRef = useRef(options?.transcribeAudio)
  const onRecordingCompleteRef = useRef(options?.onRecordingComplete)
  const userStoppedRef = useRef(false)
  // Whether the in-progress MediaRecorder session was started by the Record
  // button (true) or is a dictation fallback (false). Read inside async onstop.
  const recordModeRef = useRef(false)

  useEffect(() => { onFinalResultRef.current = onFinalResult })
  useEffect(() => { transcribeAudioRef.current = options?.transcribeAudio })
  useEffect(() => { onRecordingCompleteRef.current = options?.onRecordingComplete })

  // Sync status when support becomes available after initial mount
  // (e.g. the fal.ai key loads asynchronously from settings)
  useEffect(() => {
    if (isSupported && status === 'unsupported') setStatus('idle')
    if (!isSupported && status === 'idle') setStatus('unsupported')
  }, [isSupported, status])

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort()
      mediaRecorderRef.current?.stop()
    }
  }, [])

  const startSpeechRecognition = useCallback(() => {
    userStoppedRef.current = false

    const Impl = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!Impl) return

    const recognition = new Impl()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = navigator.language ?? 'en-US'

    recognition.onstart = () => {
      setStatus('recording')
      setInterimText('')
      setErrorMessage('')
    }

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalText = ''
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]
        if (r.isFinal) finalText += r[0].transcript
        else interim += r[0].transcript
      }
      setInterimText(interim)
      if (finalText.trim()) onFinalResultRef.current(finalText)
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'aborted' && userStoppedRef.current) return
      setErrorMessage(SPEECH_ERRORS[event.error] ?? `Speech recognition error: ${event.error}`)
      setStatus('error')
      setMode(null)
      setInterimText('')
    }

    recognition.onend = () => {
      setStatus((prev) => (prev === 'recording' ? 'idle' : prev))
      setMode(null)
      setInterimText('')
    }

    recognitionRef.current = recognition
    recognition.start()
  }, [])

  const startMediaRecorder = useCallback((asRecord: boolean) => {
    recordModeRef.current = asRecord
    userStoppedRef.current = false
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      audioChunksRef.current = []
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg'
      const recorder = new MediaRecorder(stream, { mimeType })

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType })
        audioChunksRef.current = []
        const isRecord = recordModeRef.current

        if (!userStoppedRef.current) { setMode(null); return }

        setStatus('transcribing')
        setInterimText('Transcribing...')
        let text = ''
        try {
          text = await transcribeAudioRef.current!(blob)
        } catch {
          setErrorMessage('Transcription failed — set a fal.ai key in Settings → AI Services → Providers')
          // In record mode we still want to keep the audio, so don't bail here.
          if (!isRecord) setStatus('error')
        } finally {
          setInterimText('')
          setStatus((prev) => (prev === 'transcribing' ? 'idle' : prev))
          setMode(null)
        }

        if (isRecord) {
          // Hand back the audio even if transcription came back empty/failed.
          onRecordingCompleteRef.current?.(text, blob)
        } else if (text.trim()) {
          onFinalResultRef.current(text)
        }
      }

      mediaRecorderRef.current = recorder
      recorder.start()
      setStatus('recording')
      setErrorMessage('')
    }).catch(() => {
      setErrorMessage('Microphone access denied')
      setStatus('error')
      setMode(null)
    })
  }, [])

  const startDictation = useCallback(() => {
    if (!isSupported) { setStatus('unsupported'); return }
    setMode('dictation')
    if (useRecorderFallback) startMediaRecorder(false)
    else startSpeechRecognition()
  }, [isSupported, useRecorderFallback, startMediaRecorder, startSpeechRecognition])

  const stopDictation = useCallback(() => {
    userStoppedRef.current = true
    if (useRecorderFallback) {
      mediaRecorderRef.current?.stop()
    } else {
      recognitionRef.current?.stop()
      setStatus('idle')
      setMode(null)
      setInterimText('')
    }
  }, [useRecorderFallback])

  const toggleDictation = useCallback(() => {
    if (status === 'recording' && mode === 'dictation') stopDictation()
    else if (status === 'idle' || status === 'error') startDictation()
  }, [status, mode, startDictation, stopDictation])

  // Record: always capture audio via MediaRecorder (the only path that exposes
  // the recorded file), regardless of Web Speech API availability.
  const startRecording = useCallback(() => {
    if (!canRecord) return
    setMode('record')
    startMediaRecorder(true)
  }, [canRecord, startMediaRecorder])

  const stopRecording = useCallback(() => {
    userStoppedRef.current = true
    mediaRecorderRef.current?.stop()
  }, [])

  const toggleRecording = useCallback(() => {
    if (status === 'recording' && mode === 'record') stopRecording()
    else if (status === 'idle' || status === 'error') startRecording()
  }, [status, mode, startRecording, stopRecording])

  return {
    status,
    mode,
    interimText,
    errorMessage,
    isSupported,
    canRecord,
    startDictation,
    stopDictation,
    toggleDictation,
    startRecording,
    stopRecording,
    toggleRecording,
  }
}
