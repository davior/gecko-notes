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

export interface UseDictationReturn {
  status: DictationStatus
  interimText: string
  errorMessage: string
  isSupported: boolean
  startDictation: () => void
  stopDictation: () => void
  toggleDictation: () => void
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
  options?: { transcribeAudio?: (blob: Blob) => Promise<string> },
): UseDictationReturn {
  const useRecorderFallback = !hasSpeechRecognition && hasMediaRecorder && !!options?.transcribeAudio
  const isSupported = hasSpeechRecognition || useRecorderFallback

  const [status, setStatus] = useState<DictationStatus>(isSupported ? 'idle' : 'unsupported')
  const [interimText, setInterimText] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const onFinalResultRef = useRef(onFinalResult)
  const transcribeAudioRef = useRef(options?.transcribeAudio)
  const userStoppedRef = useRef(false)

  useEffect(() => { onFinalResultRef.current = onFinalResult })
  useEffect(() => { transcribeAudioRef.current = options?.transcribeAudio })

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
      setInterimText('')
    }

    recognition.onend = () => {
      setStatus((prev) => (prev === 'recording' ? 'idle' : prev))
      setInterimText('')
    }

    recognitionRef.current = recognition
    recognition.start()
  }, [])

  const startMediaRecorder = useCallback(() => {
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

        if (!userStoppedRef.current) return

        setStatus('transcribing')
        setInterimText('Transcribing...')
        try {
          const text = await transcribeAudioRef.current!(blob)
          if (text.trim()) onFinalResultRef.current(text)
        } catch {
          setErrorMessage('Transcription failed — check your Deepgram key in Settings → Speech')
          setStatus('error')
        } finally {
          setInterimText('')
          setStatus((prev) => (prev === 'transcribing' ? 'idle' : prev))
        }
      }

      mediaRecorderRef.current = recorder
      recorder.start()
      setStatus('recording')
      setErrorMessage('')
    }).catch(() => {
      setErrorMessage('Microphone access denied')
      setStatus('error')
    })
  }, [])

  const startDictation = useCallback(() => {
    if (!isSupported) { setStatus('unsupported'); return }
    if (useRecorderFallback) startMediaRecorder()
    else startSpeechRecognition()
  }, [isSupported, useRecorderFallback, startMediaRecorder, startSpeechRecognition])

  const stopDictation = useCallback(() => {
    userStoppedRef.current = true
    if (useRecorderFallback) {
      mediaRecorderRef.current?.stop()
    } else {
      recognitionRef.current?.stop()
      setStatus('idle')
      setInterimText('')
    }
  }, [useRecorderFallback])

  const toggleDictation = useCallback(() => {
    if (status === 'recording') stopDictation()
    else if (status === 'idle' || status === 'error') startDictation()
  }, [status, startDictation, stopDictation])

  return { status, interimText, errorMessage, isSupported, startDictation, stopDictation, toggleDictation }
}
