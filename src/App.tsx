import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type SyntheticEvent } from 'react'
import './App.css'

type EngineHealth = {
  ready: boolean
  message: string
  password_required?: boolean
  access_configured?: boolean
  solola_compatible_ready?: boolean
  solola_compatible_message?: string
}

type TrackFile = {
  label: string
  kind: 'audio' | 'midi' | 'tab'
  url: string
}

type Chord = {
  name: string
  time: number
}

type NoteEvent = {
  pitch: number
  start: number
  duration: number
}

type AnalysisResult = {
  id: string
  duration_seconds: number
  chords: Chord[]
  chord_source?: 'guitar' | 'piano' | null
  selected_parts?: string[]
  lead_engine?: 'basic_pitch' | 'solola_compatible'
  files: TrackFile[]
  guitar_lead_start_seconds: number | null
  visual_tracks: {
    piano: NoteEvent[]
    guitar_lead: NoteEvent[]
  }
  tempo_bpm: number
  notes: {
    piano: number
    guitar: number
  }
  warnings: string[]
}

const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')
const isHosted = import.meta.env.VITE_HOSTED_MODE === 'true'
const maxFileSize = 150 * 1024 * 1024
const acceptedTypes = '.mp3,.wav,.flac,.m4a,.ogg,.aac'
const analysisParts = [
  { id: 'vocals', label: 'Vocals' },
  { id: 'piano', label: 'Piano' },
  { id: 'guitar_chords', label: 'Guitar chords' },
  { id: 'guitar_lead', label: 'Guitar lead / notes' },
  { id: 'bass', label: 'Bass' },
]
const pitchNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const guitarStrings = [
  { name: 'e', pitch: 64 },
  { name: 'B', pitch: 59 },
  { name: 'G', pitch: 55 },
  { name: 'D', pitch: 50 },
  { name: 'A', pitch: 45 },
  { name: 'E', pitch: 40 },
]
const chordGuitarStrings = [...guitarStrings].reverse()
const chordIntervals: Record<string, number[]> = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '5': [0, 7],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  mMaj7: [0, 3, 7, 11],
  dim7: [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  add9: [0, 2, 4, 7],
  '9': [0, 2, 4, 7, 10],
}

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${remaining}`
}

function pitchName(pitch: number) {
  return `${pitchNames[pitch % 12]}${Math.floor(pitch / 12) - 1}`
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.text()
  if (!body.trim()) {
    throw new Error(
      `The API returned an empty response (HTTP ${response.status}) from ${response.url}. The backend may be offline or may have restarted during analysis.`,
    )
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new Error(
      `The API returned non-JSON content (HTTP ${response.status}) from ${response.url}. GitHub Pages serves only the frontend; start the Python engine or configure VITE_API_BASE_URL to point to a deployed API.`,
    )
  }
  try {
    return JSON.parse(body) as T
  } catch {
    throw new Error(
      `The API returned invalid JSON (HTTP ${response.status}) from ${response.url}. The backend may have restarted during analysis.`,
    )
  }
}

function chordPitchClasses(name: string) {
  const match = name.match(/^([A-G])(#?)(.*)$/)
  if (!match) return []
  const root = pitchNames.indexOf(`${match[1]}${match[2].replace('#', '♯')}`)
  const suffix = ({ M: '', maj: '', major: '', min: 'm' } as Record<string, string>)[match[3]] ?? match[3]
  const intervals = chordIntervals[suffix]
  return root >= 0 && intervals ? intervals.map((interval) => (root + interval) % 12) : []
}

function findGuitarVoicing(chordTones: number[]) {
  if (!chordTones.length) return null
  const best: { voicing: number[] | null; score: number } = {
    voicing: null,
    score: Number.POSITIVE_INFINITY,
  }
  for (let firstFret = 0; firstFret <= 8; firstFret += 1) {
    const options = chordGuitarStrings.map((string) => {
      const frets = [0, ...Array.from(
        { length: Math.min(5, 13 - firstFret) },
        (_, index) => firstFret + index,
      )]
        .filter((fret, index, values) => values.indexOf(fret) === index)
        .filter((fret) => chordTones.includes((string.pitch + fret) % 12))
      return [-1, ...frets]
    })
    const voicing: number[] = []
    const covered = new Set<number>()

    function search(stringIndex: number, fretTotal: number, muted: number) {
      if (stringIndex === chordGuitarStrings.length) {
        if (chordTones.some((tone) => !covered.has(tone))) return
        const score = muted * 10 + fretTotal + Math.max(0, ...voicing) * 0.2
        if (score < best.score) {
          best.voicing = [...voicing]
          best.score = score
        }
        return
      }

      for (const fret of options[stringIndex]) {
        const tone = fret < 0 ? -1 : (chordGuitarStrings[stringIndex].pitch + fret) % 12
        const wasCovered = tone >= 0 && covered.has(tone)
        if (tone >= 0) covered.add(tone)
        voicing.push(fret)
        search(stringIndex + 1, fretTotal + Math.max(0, fret), muted + Number(fret < 0))
        voicing.pop()
        if (tone >= 0 && !wasCovered) covered.delete(tone)
      }
    }

    search(0, 0, 0)
  }
  return best.voicing
}

function PianoChordDiagram({ tones }: { tones: number[] }) {
  const width = 336
  const keyWidth = width / 14
  const pitches = Array.from({ length: 24 }, (_, index) => index + 60)
  let whiteIndex = 0
  const keys = pitches.map((pitch) => {
    const isBlack = [1, 3, 6, 8, 10].includes(pitch % 12)
    if (isBlack) {
      return {
        pitch,
        isBlack,
        x: Math.max(0, (whiteIndex - 0.34) * keyWidth),
        width: keyWidth * 0.68,
      }
    }
    const key = { pitch, isBlack, x: whiteIndex * keyWidth, width: keyWidth }
    whiteIndex += 1
    return key
  })

  return (
    <svg className="chord-piano" viewBox={`0 0 ${width} 112`} role="img" aria-label="Piano chord fingering">
      {keys.filter((key) => !key.isBlack).map((key) => (
        <g key={key.pitch}>
          <rect
            x={key.x}
            y="8"
            width={key.width}
            height="82"
            className={`chord-piano-key ${tones.includes(key.pitch % 12) ? 'chord-tone' : ''}`}
          />
          {tones.includes(key.pitch % 12) && (
            <text x={key.x + key.width / 2} y="104" className="chord-piano-label">
              {pitchNames[key.pitch % 12]}
            </text>
          )}
        </g>
      ))}
      {keys.filter((key) => key.isBlack).map((key) => (
        <g key={key.pitch}>
          <rect
            x={key.x}
            y="8"
            width={key.width}
            height="50"
            rx="1"
            className={`chord-piano-key black ${tones.includes(key.pitch % 12) ? 'chord-tone' : ''}`}
          />
          {tones.includes(key.pitch % 12) && (
            <circle cx={key.x + key.width / 2} cy="48" r="2.5" className="chord-piano-dot" />
          )}
        </g>
      ))}
    </svg>
  )
}

function GuitarChordDiagram({ chordName, tones }: { chordName: string; tones: number[] }) {
  const voicing = useMemo(() => findGuitarVoicing(tones), [tones])
  const fretted = voicing?.filter((fret) => fret > 0) ?? []
  const firstFret = fretted.length ? Math.min(...fretted) : 1
  const stringXs = chordGuitarStrings.map((_, index) => 70 + index * 32)
  const fretY = (fret: number) => 34 + (fret - firstFret + 0.5) * 23

  return (
    <svg className="chord-guitar" viewBox="0 0 270 174" role="img" aria-label={`${chordName} guitar chord fingering`}>
      {firstFret > 1 && <text x="15" y="23" className="chord-fret-label">{firstFret}fr</text>}
      {chordGuitarStrings.map((string, index) => (
        <g key={string.name}>
          <text x={stringXs[index]} y="22" textAnchor="middle" className="chord-string-mark">
            {voicing?.[index] === -1 ? '×' : voicing?.[index] === 0 ? '○' : ''}
          </text>
          <line x1={stringXs[index]} x2={stringXs[index]} y1="31" y2="146" className="chord-fret-string" />
        </g>
      ))}
      {Array.from({ length: 6 }, (_, index) => (
        <g key={index}>
          <line
            x1="54"
            x2="246"
            y1={31 + index * 23}
            y2={31 + index * 23}
            className={index === 0 && firstFret === 1 ? 'chord-nut' : 'chord-fret-line'}
          />
          {index < 5 && (
            <text x="38" y={fretY(firstFret + index) + 3} textAnchor="middle" className="chord-fret-label">
              {firstFret + index}
            </text>
          )}
        </g>
      ))}
      {voicing?.map((fret, index) => fret > 0 && (
        <circle key={`${index}-${fret}`} cx={stringXs[index]} cy={fretY(fret)} r="7" className="chord-finger-dot" />
      ))}
    </svg>
  )
}

function ChordVoicings({ chord }: { chord: Chord }) {
  const tones = useMemo(() => chordPitchClasses(chord.name), [chord.name])

  return (
    <section className="chord-voicings" aria-label={`${chord.name} chord fingering`}>
      <div className="chord-voicings-heading">
        <div><span className="panel-kicker">CHORD SHAPES</span><h4>{chord.name} · {formatTime(chord.time)}</h4></div>
        <span>Reference fingering</span>
      </div>
      <div className="chord-shape-grid">
        <article className="chord-shape">
          <h5>Piano</h5>
          <PianoChordDiagram tones={tones} />
          <span>{tones.map((tone) => pitchNames[tone]).join(' · ') || 'No diagram available'}</span>
        </article>
        <article className="chord-shape">
          <h5>Guitar</h5>
          <GuitarChordDiagram chordName={chord.name} tones={tones} />
          <span>× muted · ○ open</span>
        </article>
      </div>
    </section>
  )
}

function guitarTabNotes(notes: NoteEvent[]) {
  const groups: Array<Array<{ note: NoteEvent; index: number }>> = []
  notes
    .map((note, index) => ({ note, index }))
    .sort((a, b) => a.note.start - b.note.start)
    .forEach((entry) => {
      const currentGroup = groups[groups.length - 1]
      if (!currentGroup || entry.note.start - currentGroup[0].note.start > 0.12) {
        groups.push([entry])
      } else {
        currentGroup.push(entry)
      }
    })

  const placements = new Map<number, { stringIndex: number; fret: number }>()
  for (const group of groups) {
    const uniquePitches = [...new Set(group.map(({ note }) => note.pitch))]
      .map((pitch) => ({
        pitch,
        entries: group.filter(({ note }) => note.pitch === pitch),
        positions: guitarStrings
          .map((string, stringIndex) => ({ stringIndex, fret: pitch - string.pitch }))
          .filter(({ fret }) => fret >= 0 && fret <= 24)
          .sort((a, b) => a.fret - b.fret),
      }))
      .filter(({ positions }) => positions.length > 0)
      .sort((a, b) => a.positions.length - b.positions.length || b.pitch - a.pitch)
    const usedStrings = new Set<number>()

    for (const item of uniquePitches) {
      const position = item.positions.find(({ stringIndex }) => !usedStrings.has(stringIndex))
      if (!position) continue
      usedStrings.add(position.stringIndex)
      for (const entry of item.entries.slice(0, 1)) {
        placements.set(entry.index, position)
      }
    }
  }
  return placements
}

function PianoRoll({ notes, playhead, isPlaying, audioRef }: { notes: NoteEvent[]; playhead: number; isPlaying: boolean; audioRef: { current: HTMLAudioElement | null } }) {
  const [frameTime, setFrameTime] = useState(playhead)
  useEffect(() => {
    if (!isPlaying) return
    let frame = 0
    let lastUpdate = 0
    const update = (timestamp: number) => {
      if (timestamp - lastUpdate >= 30) {
        setFrameTime(audioRef.current?.currentTime ?? 0)
        lastUpdate = timestamp
      }
      frame = requestAnimationFrame(update)
    }
    frame = requestAnimationFrame(update)
    return () => cancelAnimationFrame(frame)
  }, [audioRef, isPlaying])
  const width = 1080
  const height = 510
  const keyboardTop = 426
  const keyboardHeight = height - keyboardTop
  const pixelsPerSecond = 46
  const lookAheadSeconds = keyboardTop / pixelsPerSecond
  const lowest = notes.length ? Math.min(...notes.map((note) => note.pitch)) : 48
  const highest = notes.length ? Math.max(...notes.map((note) => note.pitch)) : 72
  let minPitch = Math.max(21, Math.floor((lowest - 2) / 12) * 12)
  let maxPitch = Math.min(109, Math.ceil((highest + 3) / 12) * 12)
  if (maxPitch - minPitch < 24) {
    maxPitch = Math.min(109, minPitch + 24)
    minPitch = Math.max(21, maxPitch - 24)
  }
  const pitches = Array.from({ length: maxPitch - minPitch }, (_, index) => minPitch + index)
  const whitePitches = pitches.filter((pitch) => ![1, 3, 6, 8, 10].includes(pitch % 12))
  const whiteKeyWidth = width / whitePitches.length
  let whiteKeyIndex = 0
  const keys = pitches.map((pitch) => {
    const isBlack = [1, 3, 6, 8, 10].includes(pitch % 12)
    if (isBlack) {
      return {
        pitch,
        isBlack,
        x: Math.max(0, (whiteKeyIndex - 0.36) * whiteKeyWidth),
        width: whiteKeyWidth * 0.72,
      }
    }
    const key = { pitch, isBlack, x: whiteKeyIndex * whiteKeyWidth, width: whiteKeyWidth }
    whiteKeyIndex += 1
    return key
  })
  const currentTime = isPlaying ? frameTime : playhead
  const activePitches = new Set(
    isPlaying
      ? notes
        .filter((note) => note.start <= currentTime && note.start + note.duration > currentTime)
        .map((note) => note.pitch)
      : [],
  )
  const visibleNotes = notes.filter(
    (note) => note.start + note.duration > currentTime && note.start < currentTime + lookAheadSeconds,
  )
  const noteAreaId = 'falling-notes-area'

  return (
    <div className="visual-scroll">
      <svg className="piano-roll" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Piano keys light up as detected notes reach them">
        <defs>
          <clipPath id={noteAreaId}>
            <rect x="0" y="0" width={width} height={keyboardTop} />
          </clipPath>
        </defs>
        <rect x="0" y="0" width={width} height={keyboardTop} className="falling-note-background" />
        {keys.map((key) => (
          <rect
            key={`lane-${key.pitch}`}
            x={key.x}
            y="0"
            width={key.width}
            height={keyboardTop}
            className={key.isBlack ? 'piano-lane black-lane' : 'piano-lane'}
          />
        ))}
        {Array.from({ length: Math.floor(lookAheadSeconds) + 1 }, (_, secondsAhead) => {
          const y = keyboardTop - secondsAhead * pixelsPerSecond
          return (
            <g key={`time-${secondsAhead}`}>
              <line x1="0" x2={width} y1={y} y2={y} className={secondsAhead === 0 ? 'piano-now-line' : 'piano-time-line'} />
              <text x="7" y={Math.max(13, y - 4)} className="piano-time-label">
                {secondsAhead === 0 ? 'NOW' : `+${secondsAhead}s`}
              </text>
            </g>
          )
        })}
        <g clipPath={`url(#${noteAreaId})`}>
          {visibleNotes.map((note, index) => {
            const key = keys.find((candidate) => candidate.pitch === note.pitch)
            if (!key) return null
            const noteTop = keyboardTop - (note.start + note.duration - currentTime) * pixelsPerSecond
            const noteBottom = keyboardTop - (note.start - currentTime) * pixelsPerSecond
            const noteWidth = Math.max(3, key.width * (key.isBlack ? 0.72 : 0.64))
            return (
              <rect
                key={`${note.pitch}-${note.start}-${index}`}
                x={key.x + (key.width - noteWidth) / 2}
                y={noteTop}
                width={noteWidth}
                height={Math.max(3, noteBottom - noteTop)}
                rx="3"
                className="falling-piano-note"
              >
                <title>{pitchName(note.pitch)} · {formatTime(note.start)} · {(note.duration).toFixed(2)}s</title>
              </rect>
            )
          })}
        </g>
        {keys.filter((key) => !key.isBlack).map((key) => (
          <g key={`white-${key.pitch}`}>
            <rect
              x={key.x}
              y={keyboardTop}
              width={key.width}
              height={keyboardHeight}
              className={`piano-key white-key ${activePitches.has(key.pitch) ? 'active-key' : ''}`}
            />
            {key.pitch % 12 === 0 && key.width >= 18 && (
              <text x={key.x + 3} y={height - 8} className="piano-key-label">{pitchName(key.pitch)}</text>
            )}
          </g>
        ))}
        {keys.filter((key) => key.isBlack).map((key) => (
          <g key={`black-${key.pitch}`}>
            <rect
              x={key.x}
              y={keyboardTop}
              width={key.width}
              height={keyboardHeight * 0.64}
              rx="1"
              className={`piano-key black-key ${activePitches.has(key.pitch) ? 'active-key' : ''}`}
            />
            {activePitches.has(key.pitch) && (
              <circle cx={key.x + key.width / 2} cy={keyboardTop + keyboardHeight * 0.53} r="3" className="active-black-key-dot" />
            )}
          </g>
        ))}
      </svg>
    </div>
  )
}

function GuitarTab({ notes, start, playhead, isPlaying, audioRef, tempoBpm }: { notes: NoteEvent[]; start: number; playhead: number; isPlaying: boolean; audioRef: { current: HTMLAudioElement | null }; tempoBpm: number }) {
  const [frameTime, setFrameTime] = useState(playhead)
  useEffect(() => {
    if (!isPlaying) return
    let frame = 0
    let lastUpdate = 0
    const update = (timestamp: number) => {
      if (timestamp - lastUpdate >= 30) {
        setFrameTime(audioRef.current?.currentTime ?? 0)
        lastUpdate = timestamp
      }
      frame = requestAnimationFrame(update)
    }
    frame = requestAnimationFrame(update)
    return () => cancelAnimationFrame(frame)
  }, [audioRef, isPlaying])
  const currentTime = isPlaying ? frameTime : playhead
  const visibleStart = isPlaying ? Math.floor(currentTime / 12) * 12 : start
  const width = 1260
  const xOffset = 58
  const timelineWidth = width - xOffset - 10
  const secondsWidth = timelineWidth / 12
  const secondsPerBeat = 60 / Math.max(1, tempoBpm || 120)
  const visibleNotes = notes
    .map((note, index) => ({ note, index }))
    .filter(({ note }) => note.start >= visibleStart && note.start < visibleStart + 12)
    .sort((a, b) => a.note.start - b.note.start || b.note.pitch - a.note.pitch)
  const placements = guitarTabNotes(notes)
  const firstBeat = Math.ceil(visibleStart / secondsPerBeat)
  const lastBeat = Math.floor((visibleStart + 12) / secondsPerBeat)

  return (
    <div className="visual-scroll">
      <svg className="guitar-tab" viewBox={`0 0 ${width} 250`} role="img" aria-label={`Guitar tablature in reading order, ${tempoBpm || 120} beats per minute`}>
        {Array.from({ length: lastBeat - firstBeat + 1 }, (_, index) => firstBeat + index).map((beat) => {
          const x = xOffset + (beat * secondsPerBeat - visibleStart) * secondsWidth
          const beatInBar = beat % 4
          return (
            <g key={beat}>
              <line x1={x} x2={x} y1="37" y2="224" className={beatInBar === 0 ? 'time-grid-line strong-grid' : 'time-grid-line'} />
              <text x={x + 3} y="25" className="time-label">{`${Math.floor(beat / 4) + 1}.${beatInBar + 1}`}</text>
            </g>
          )
        })}
        <text x={xOffset} y="241" className="tab-reading-hint">Read left to right · bar.beat</text>
        {guitarStrings.map((string, index) => (
          <g key={string.name}>
            <text x="20" y={64 + index * 32} className="string-label">{string.name}</text>
            <line x1={xOffset} x2={width - 10} y1={60 + index * 32} y2={60 + index * 32} className="guitar-string" />
          </g>
        ))}
        {visibleNotes.map(({ note, index }) => {
          const playable = placements.get(index)
          if (!playable) return null
          const x = xOffset + (note.start - visibleStart) * secondsWidth
          const y = 60 + playable.stringIndex * 32
          return (
            <g key={`${note.pitch}-${note.start}-${index}`}>
              <circle cx={x} cy={y} r="9" className="tab-note" />
              <text x={x} y={y + 4} className="fret-label">{playable.fret}</text>
              <title>{pitchName(note.pitch)} · fret {playable.fret} · {formatTime(note.start)}</title>
            </g>
          )
        })}
        {currentTime >= visibleStart && currentTime <= visibleStart + 12 && (
          <line x1={xOffset + (currentTime - visibleStart) * secondsWidth} x2={xOffset + (currentTime - visibleStart) * secondsWidth} y1="37" y2="224" className="playhead-line" />
        )}
      </svg>
    </div>
  )
}

function LiveInstrumentTools() {
  const [midiInputs, setMidiInputs] = useState<Array<{ id: string; name: string }>>([])
  const [selectedMidi, setSelectedMidi] = useState('')
  const [midiNote, setMidiNote] = useState('')
  const [midiMessage, setMidiMessage] = useState('MIDI device not connected')
  const [audioInputs, setAudioInputs] = useState<Array<{ id: string; name: string }>>([])
  const [selectedAudio, setSelectedAudio] = useState('')
  const [audioMessage, setAudioMessage] = useState('Input monitoring is local only')
  const [isMonitoring, setIsMonitoring] = useState(false)
  const [inputLevel, setInputLevel] = useState(0)
  const [inputPitch, setInputPitch] = useState('')
  const midiAccessRef = useRef<MIDIAccess | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const monitorFrameRef = useRef(0)

  useEffect(() => {
    void navigator.mediaDevices?.enumerateDevices().then((devices) => {
      const inputs = devices
        .filter((device) => device.kind === 'audioinput')
        .map((device, index) => ({ id: device.deviceId, name: device.label || `Audio input ${index + 1}` }))
      setAudioInputs(inputs)
      setSelectedAudio((current) => current || inputs[0]?.id || '')
    }).catch((reason: unknown) => {
      setAudioMessage(reason instanceof Error ? reason.message : 'Could not list audio input devices.')
    })
  }, [])

  useEffect(() => {
    const access = midiAccessRef.current
    if (!access) return
    for (const input of access.inputs.values()) input.onmidimessage = null
    const input = access.inputs.get(selectedMidi)
    if (!input) return
    input.onmidimessage = (event) => {
      const data = event.data
      if (!data) return
      const status = data[0]
      const note = data[1]
      const velocity = data[2]
      if (status === undefined || note === undefined) return
      if ((status & 0xf0) === 0x90 && (velocity ?? 0) > 0) {
        setMidiNote(pitchName(note))
      } else if ((status & 0xf0) === 0x80 || ((status & 0xf0) === 0x90 && velocity === 0)) {
        setMidiNote('')
      }
    }
  }, [selectedMidi])

  useEffect(() => () => {
    cancelAnimationFrame(monitorFrameRef.current)
    streamRef.current?.getTracks().forEach((track) => track.stop())
    void audioContextRef.current?.close()
  }, [])

  async function connectMidi() {
    const browser = navigator as Navigator & {
      requestMIDIAccess?: () => Promise<MIDIAccess>
    }
    if (!browser.requestMIDIAccess) {
      setMidiMessage('MIDI input is not supported in this browser. Try a current Chrome or Edge over HTTPS or localhost.')
      return
    }
    try {
      const access = await browser.requestMIDIAccess()
      midiAccessRef.current = access
      const updateInputs = () => {
        const inputs = Array.from(access.inputs.values()).map((input) => ({
          id: input.id,
          name: input.name || 'MIDI device',
        }))
        setMidiInputs(inputs)
        setSelectedMidi((current) => current || inputs[0]?.id || '')
        setMidiMessage(inputs.length ? 'MIDI connected' : 'No MIDI input found. Connect a device and refresh.')
      }
      access.onstatechange = updateInputs
      updateInputs()
    } catch (reason) {
      setMidiMessage(reason instanceof Error ? reason.message : 'Could not connect to the MIDI device.')
    }
  }

  async function toggleAudioMonitor() {
    if (isMonitoring) {
      cancelAnimationFrame(monitorFrameRef.current)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      await audioContextRef.current?.close()
      audioContextRef.current = null
      setIsMonitoring(false)
      setInputLevel(0)
      setInputPitch('')
      setAudioMessage('Input monitoring is local only')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: selectedAudio ? { deviceId: { exact: selectedAudio } } : true,
      })
      const context = new AudioContext()
      const analyser = context.createAnalyser()
      analyser.fftSize = 2048
      context.createMediaStreamSource(stream).connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      streamRef.current = stream
      audioContextRef.current = context
      setIsMonitoring(true)
      setAudioMessage('Listening for notes…')
      let lastAnalysis = 0
      const update = (timestamp: number) => {
        if (timestamp - lastAnalysis < 100) {
          monitorFrameRef.current = requestAnimationFrame(update)
          return
        }
        lastAnalysis = timestamp
        analyser.getFloatTimeDomainData(samples)
        let energy = 0
        for (const sample of samples) energy += sample * sample
        const level = Math.sqrt(energy / samples.length)
        setInputLevel(Math.min(1, level * 4))

        if (level > 0.008) {
          let bestOffset = 0
          let bestCorrelation = 0
          for (let offset = 20; offset < samples.length / 2; offset += 1) {
            let correlation = 0
            for (let index = 0; index < samples.length - offset; index += 1) {
              correlation += samples[index] * samples[index + offset]
            }
            correlation /= samples.length - offset
            if (correlation > bestCorrelation) {
              bestCorrelation = correlation
              bestOffset = offset
            }
          }
          const frequency = bestOffset ? context.sampleRate / bestOffset : 0
          setInputPitch(bestCorrelation > 0.55 && frequency > 35 && frequency < 1200
            ? pitchName(Math.round(69 + 12 * Math.log2(frequency / 440)))
            : '')
        } else {
          setInputPitch('')
        }
        monitorFrameRef.current = requestAnimationFrame(update)
      }
      monitorFrameRef.current = requestAnimationFrame(update)
      const devices = await navigator.mediaDevices.enumerateDevices()
      setAudioInputs(devices
        .filter((device) => device.kind === 'audioinput')
        .map((device, index) => ({ id: device.deviceId, name: device.label || `Audio input ${index + 1}` })))
    } catch (reason) {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      await audioContextRef.current?.close()
      audioContextRef.current = null
      setInputPitch('')
      setIsMonitoring(false)
      setAudioMessage(reason instanceof Error ? reason.message : 'Could not access the audio input.')
    }
  }

  return (
    <details className="live-tools">
      <summary>Connect MIDI keyboard or audio interface <span>Play along and check live input</span></summary>
      <div className="live-tools-grid">
        <section className="live-tool">
          <div className="live-tool-heading"><strong>MIDI keyboard</strong><span>{midiNote || midiMessage}</span></div>
          <div className="live-tool-controls">
            <select aria-label="MIDI input device" value={selectedMidi} onChange={(event) => setSelectedMidi(event.currentTarget.value)}>
              <option value="">Select MIDI input</option>
              {midiInputs.map((input) => <option key={input.id} value={input.id}>{input.name}</option>)}
            </select>
            <button type="button" className="text-button" onClick={() => void connectMidi()}>Connect MIDI</button>
          </div>
        </section>
        <section className="live-tool">
          <div className="live-tool-heading"><strong>Audio interface</strong><span>{isMonitoring ? inputPitch || 'Listening for notes…' : audioMessage}</span></div>
          <div className="live-tool-controls">
            <select aria-label="Audio input device" disabled={isMonitoring} value={selectedAudio} onChange={(event) => setSelectedAudio(event.currentTarget.value)}>
              <option value="">Default audio input</option>
              {audioInputs.map((input) => <option key={input.id} value={input.id}>{input.name}</option>)}
            </select>
            <button type="button" className="text-button" onClick={() => void toggleAudioMonitor()}>
              {isMonitoring ? 'Stop monitor' : 'Start monitor'}
            </button>
          </div>
          <div className="input-meter" role="meter" aria-label="Audio input level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(inputLevel * 100)}>
            <span style={{ width: `${inputLevel * 100}%` }} />
          </div>
        </section>
      </div>
      <p className="panel-footnote">Audio input is not recorded or uploaded. Pitch detection is a simple live guide, not a transcription.</p>
    </details>
  )
}

function App() {
  const inputRef = useRef<HTMLInputElement>(null)
  const originalAudioRef = useRef<HTMLAudioElement>(null)
  const pianoAudioRef = useRef<HTMLAudioElement>(null)
  const guitarAudioRef = useRef<HTMLAudioElement>(null)
  const playbackAudioRef = useRef<HTMLAudioElement>(null)
  const audioUrlRef = useRef('')
  const [file, setFile] = useState<File | null>(null)
  const [audioUrl, setAudioUrl] = useState('')
  const [health, setHealth] = useState<EngineHealth | null>(null)
  const [accessPassword, setAccessPassword] = useState(() => sessionStorage.getItem('chordcraft-password') ?? '')
  const [passwordDraft, setPasswordDraft] = useState(() => sessionStorage.getItem('chordcraft-password') ?? '')
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [error, setError] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [isCheckingPassword, setIsCheckingPassword] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [activeSection, setActiveSection] = useState('')
  const [viewStart, setViewStart] = useState(0)
  const [playhead, setPlayhead] = useState(0)
  const [selectedParts, setSelectedParts] = useState(analysisParts.map((part) => part.id))
  const [chordStyle, setChordStyle] = useState('song')
  const [leadEngine, setLeadEngine] = useState<'basic_pitch' | 'solola_compatible'>('basic_pitch')

  const checkEngine = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase}/api/health`)
      if (!response.ok) throw new Error('Local engine did not respond.')
      const data = await readJsonResponse<EngineHealth>(response)
      setHealth(data)
    } catch {
      setHealth({
        ready: false,
        message: isHosted
          ? 'Analysis API is offline or misconfigured. Check the API URL and backend logs.'
          : 'Python engine is not responding. Start it in a second terminal; GitHub only serves the frontend.',
      })
    }
  }, [])

  useEffect(() => {
    // Load server state on page open so hosted users can enter the beta password before uploading.
    // oxlint-disable-next-line react/set-state-in-effect
    void checkEngine()
  }, [checkEngine])

  useEffect(() => {
    return () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
    }
  }, [])

  function updateFile(nextFile: File | null) {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
    audioUrlRef.current = nextFile ? URL.createObjectURL(nextFile) : ''
    setAudioUrl(audioUrlRef.current)
    setFile(nextFile)
  }

  function chooseFile(candidate?: File) {
    if (!candidate) return
    setError('')
    setResult(null)
    if (!candidate.name.match(/\.(mp3|wav|flac|m4a|ogg|aac)$/i)) {
      updateFile(null)
      setError('Choose an MP3, WAV, FLAC, M4A, OGG, or AAC audio file.')
      return
    }
    if (candidate.size > maxFileSize) {
      updateFile(null)
      setError('The maximum file size is 150 MB.')
      return
    }
    updateFile(candidate)
    if (!health) void checkEngine()
  }

  async function saveAccessPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!passwordDraft) return
    setIsCheckingPassword(true)
    setError('')
    try {
      const response = await fetch(`${apiBase}/api/auth/verify`, {
        method: 'POST',
        headers: { 'X-Chordcraft-Password': passwordDraft },
      })
      const body = await readJsonResponse<{ detail?: string }>(response)
      if (!response.ok) {
        throw new Error(body.detail ?? 'Could not verify the beta password.')
      }
      sessionStorage.setItem('chordcraft-password', passwordDraft)
      setAccessPassword(passwordDraft)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not verify the beta password.')
    } finally {
      setIsCheckingPassword(false)
    }
  }

  function clearAccessPassword() {
    sessionStorage.removeItem('chordcraft-password')
    setAccessPassword('')
    setPasswordDraft('')
  }

  async function analyze() {
    if (!file) return
    setIsAnalyzing(true)
    setError('')
    setResult(null)

    const formData = new FormData()
    formData.append('file', file)
    formData.append('parts', selectedParts.length === analysisParts.length ? 'all' : selectedParts.join(','))
    formData.append('chord_style', chordStyle)
    formData.append('lead_engine', leadEngine)

    try {
      const response = await fetch(`${apiBase}/api/analyze`, {
        method: 'POST',
        headers: accessPassword ? { 'X-Chordcraft-Password': accessPassword } : undefined,
        body: formData,
      })
      const body = await readJsonResponse<AnalysisResult & { detail?: string }>(response)
      if (response.status === 401) clearAccessPassword()
      if (!response.ok) {
        throw new Error(body.detail ?? (isHosted ? 'Analysis failed on the server.' : 'Analysis failed. Check the local engine logs.'))
      }
      setResult(body)
      const parts = body.selected_parts ?? selectedParts
      setActiveSection(
        parts.includes('guitar_chords') ? 'chords'
          : parts.includes('piano') ? 'piano'
            : parts.includes('guitar_lead') ? 'lead'
              : parts.includes('vocals') ? 'vocals' : 'bass',
      )
      setViewStart(0)
      setPlayhead(0)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to analyze this audio.')
    } finally {
      setIsAnalyzing(false)
    }
  }

  const resultParts = new Set(result?.selected_parts ?? selectedParts)
  const sectionOptions = [
    ...(resultParts.has('guitar_chords') ? [{ id: 'chords', label: 'Guitar chords', icon: '⌁' }] : []),
    ...(resultParts.has('piano') ? [{ id: 'piano', label: 'Piano', icon: '▤' }] : []),
    ...(resultParts.has('guitar_lead') ? [{ id: 'lead', label: 'Guitar tab', icon: '⌁' }] : []),
    ...(resultParts.has('vocals') ? [{ id: 'vocals', label: 'Vocals', icon: '◖' }] : []),
    ...(resultParts.has('bass') ? [{ id: 'bass', label: 'Bass', icon: '≋' }] : []),
  ]
  const activeChordIndex = result?.chords.reduce(
    (activeIndex, chord, index) => chord.time <= playhead ? index : activeIndex,
    -1,
  ) ?? -1
  const selectedChordIndex = Math.max(0, activeChordIndex)
  const selectedChord = result?.chords[selectedChordIndex]
  const uniqueChords = result?.chords.reduce<Array<Chord & { count: number }>>((items, chord) => {
    const existing = items.find((item) => item.name === chord.name)
    if (existing) existing.count += 1
    else items.push({ ...chord, count: 1 })
    return items
  }, []) ?? []

  function getTrack(label: string) {
    return result?.files.find((track) => track.label.toLowerCase() === label.toLowerCase())
  }

  function downloadLink(label: string) {
    const track = getTrack(label)
    return track ? `${apiBase}${track.url}` : undefined
  }

  function seekTo(time: number) {
    if (!originalAudioRef.current) return
    originalAudioRef.current.currentTime = time
    playbackAudioRef.current = originalAudioRef.current
    setPlayhead(time)
    setViewStart(Math.floor(time / 12) * 12)
    void originalAudioRef.current.play()
  }

  function syncPlayback(event: SyntheticEvent<HTMLAudioElement>) {
    const time = event.currentTarget.currentTime
    setPlayhead(time)
  }

  function startPlayback(event: SyntheticEvent<HTMLAudioElement>) {
    const activeAudio = event.currentTarget
    if (playbackAudioRef.current && playbackAudioRef.current !== activeAudio && !playbackAudioRef.current.paused) {
      playbackAudioRef.current.pause()
    }
    for (const audio of [originalAudioRef.current, pianoAudioRef.current, guitarAudioRef.current]) {
      if (audio && audio !== activeAudio && !audio.paused) audio.pause()
    }
    playbackAudioRef.current = activeAudio
    syncPlayback(event)
    setIsPlaying(true)
  }

  function stopPlayback(event?: SyntheticEvent<HTMLAudioElement>) {
    if (event && event.currentTarget === playbackAudioRef.current) {
      const time = event.currentTarget.currentTime
      setPlayhead(time)
      setViewStart(Math.floor(time / 12) * 12)
    }
    const activeAudio = [originalAudioRef.current, pianoAudioRef.current, guitarAudioRef.current, playbackAudioRef.current]
      .find((audio) => audio && !audio.paused)
    playbackAudioRef.current = activeAudio ?? null
    setIsPlaying(Boolean(activeAudio))
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Chordcraft home">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
          <span>chordcraft</span>
          <span className="beta-tag">BETA</span>
        </a>
        <div className={`engine-status ${health?.ready ? 'online' : 'offline'}`}>
          <span className="status-dot" />
          {health?.ready ? (health.password_required ? 'Server ready · beta access' : 'Engine ready') : health?.message ?? 'Engine not checked'}
          <button className="icon-button refresh-button" onClick={() => void checkEngine()} aria-label="Refresh engine status">
            ↻
          </button>
        </div>
      </header>

      <section className="hero">
        <div className="eyebrow"><span className="eyebrow-line" /> YOUR SONG, UNPACKED</div>
        <h1>See how your song<br /><span>is played.</span></h1>
        <p className="hero-copy">Choose the parts you want to explore.</p>
        <div className="privacy-note"><span aria-hidden="true">◈</span> {isHosted ? 'Audio is uploaded securely for analysis and deleted after 24 hours' : 'Your audio stays on this device'}</div>
      </section>

      <section className={`workspace ${result ? 'has-result' : ''}`}>
        <div className="section-heading">
          <div>
            <span className="step-label">01 / IMPORT</span>
            <h2>Start with a song</h2>
          </div>
          <span className="file-limit">Up to 150 MB</span>
        </div>

        {health?.password_required && (
          <form className="access-panel" onSubmit={saveAccessPassword}>
            <label htmlFor="access-password">Shared beta password</label>
            {health.access_configured ? (
              <>
                <div className="access-form-row">
                  <input
                    id="access-password"
                    type="password"
                    autoComplete="current-password"
                    value={passwordDraft}
                    onChange={(event) => setPasswordDraft(event.currentTarget.value)}
                    placeholder="Enter the password shared by the app owner"
                  />
                  <button className="text-button" type="submit" disabled={!passwordDraft || isCheckingPassword}>
                    {isCheckingPassword ? 'Checking…' : 'Verify'}
                  </button>
                </div>
                <span className="access-help">{accessPassword ? 'Password is kept in this browser session.' : 'Ask the app owner for the beta password.'}</span>
              </>
            ) : (
              <span className="access-help" role="status">{health.message}</span>
            )}
          </form>
        )}

        {!file ? (
          <button
            className={`dropzone ${isDragging ? 'dragging' : ''}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => { event.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => {
              event.preventDefault()
              setIsDragging(false)
              chooseFile(event.dataTransfer.files[0])
            }}
          >
            <span className="upload-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4.5 14.5v4A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-4" /></svg>
            </span>
            <strong>Drop an audio file here</strong>
            <span className="dropzone-caption">or <span className="browse-link">browse files</span></span>
            <span className="format-list">MP3 · WAV · FLAC · M4A · OGG · AAC</span>
          </button>
        ) : (
          <div className="selected-file">
            <div className="record-icon" aria-hidden="true">♫</div>
            <div className="selected-file-info">
              <strong title={file.name}>{file.name}</strong>
              <span>{(file.size / (1024 * 1024)).toFixed(1)} MB · Ready to analyze</span>
            </div>
            <button className="text-button" onClick={() => { updateFile(null); setResult(null); setError('') }}>Remove</button>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={acceptedTypes}
          hidden
          onChange={(event) => {
            chooseFile(event.target.files?.[0])
            event.currentTarget.value = ''
          }}
        />
        <fieldset className="analysis-options">
          <legend>Analyze these parts</legend>
          <div className="part-options">
            <button
              type="button"
              className={`part-option all-option ${selectedParts.length === analysisParts.length ? 'selected' : ''}`}
              onClick={() => setSelectedParts(analysisParts.map((part) => part.id))}
            >
              All parts
            </button>
            {analysisParts.map((part) => (
              <label className={`part-option ${selectedParts.includes(part.id) ? 'selected' : ''}`} key={part.id}>
                <input
                  type="checkbox"
                  checked={selectedParts.includes(part.id)}
                  onChange={() => setSelectedParts((current) => current.includes(part.id)
                    ? current.filter((item) => item !== part.id)
                    : [...current, part.id])}
                />
                {part.label}
              </label>
            ))}
          </div>
          <div className="analysis-option-footer">
            <label htmlFor="chord-style">Chord detail</label>
            <select id="chord-style" value={chordStyle} onChange={(event) => setChordStyle(event.currentTarget.value)}>
              <option value="basic">Basic · major/minor</option>
              <option value="song">Song-like · smooth changes</option>
              <option value="complex">Complex · extended chords</option>
            </select>
            <span>Only selected parts are converted and transcribed. Separation still runs once for the full mix.</span>
          </div>
          {selectedParts.includes('guitar_lead') && (
            <div className="analysis-option-footer">
              <label htmlFor="lead-engine">Guitar lead engine</label>
              <select
                id="lead-engine"
                value={leadEngine}
                onChange={(event) => {
                  if (event.currentTarget.value === 'basic_pitch' || event.currentTarget.value === 'solola_compatible') {
                    setLeadEngine(event.currentTarget.value)
                  }
                }}
              >
                <option value="basic_pitch">Basic Pitch · current</option>
                <option value="solola_compatible">SoloLa-style · compatible</option>
              </select>
              <span className={health?.solola_compatible_ready ? '' : 'engine-setup-needed'}>
                SoloLa-style: {health?.solola_compatible_message ?? 'Checking engine…'}
              </span>
            </div>
          )}
        </fieldset>
        {error && <div className="error-message" role="alert">{error}</div>}

        {file && (
          <div className="analyze-row">
            <div className="engine-hint">
              <span className={`mini-dot ${health?.ready ? 'ready' : ''}`} />
              {health?.message ?? (isHosted ? 'Checking analysis server…' : 'Checking local engine…')}
            </div>
            <button className="primary-button" disabled={!selectedParts.length || !health?.ready || (health.password_required && !accessPassword) || isAnalyzing} onClick={() => void analyze()}>
              {isAnalyzing ? <><span className="spinner" /> Analyzing song…</> : <>Analyze song <span aria-hidden="true">→</span></>}
            </button>
          </div>
        )}
      </section>

      <LiveInstrumentTools />

      {isAnalyzing && (
        <section className="progress-card" aria-live="polite">
          <div className="progress-top"><span>Listening to your song</span><span className="pulse-dot" /></div>
          <div className="progress-track"><div className="progress-indicator" /></div>
          <p>{isHosted ? 'Uploading the audio to the analysis server. ' : 'Processing on your computer. ' }The selected tracks are being separated and transcribed.</p>
        </section>
      )}

      {result && (
        <section className="results">
          <div className="section-heading results-heading">
            <div><span className="step-label">02 / YOUR ARRANGEMENT</span><h2>Song breakdown</h2></div>
            <span className="duration-pill">{formatTime(result.duration_seconds)}</span>
          </div>

          <div className="song-player">
            <div className="player-cover" aria-hidden="true"><span>♫</span></div>
            <div className="player-track">
              <strong>{file?.name.replace(/\.[^.]+$/, '')}</strong>
              <span>{isHosted ? 'Original audio · uploaded to the analysis server' : 'Original audio · stays on this device'}</span>
            </div>
            {audioUrl && (
              <audio
                ref={originalAudioRef}
                className="audio-player"
                controls
                src={audioUrl}
                onPlaying={startPlayback}
                onPause={stopPlayback}
                onEnded={stopPlayback}
                onTimeUpdate={syncPlayback}
                onSeeked={syncPlayback}
              />
            )}
          </div>

          <nav className="instrument-nav" aria-label="Song parts">
            {sectionOptions.map((section) => (
              <button
                className={`instrument-tab ${activeSection === section.id ? 'selected' : ''}`}
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                aria-pressed={activeSection === section.id}
              >
                <span aria-hidden="true">{section.icon}</span>{section.label}
              </button>
            ))}
          </nav>

          {activeSection === 'chords' && (
            <section className="instrument-panel">
              <div className="panel-heading">
                <div>
                  <span className="panel-kicker">
                    {result.chord_source === 'piano' ? 'PIANO STEM · GUITAR FALLBACK' : 'GUITAR STEM · CHORD MAP'}
                  </span>
                  <h3>Chord shapes</h3>
                </div>
                <span>{uniqueChords.length} chord types · {result.chords.length} changes</span>
              </div>
              {result.chords.length > 0 ? (
                <>
                  <p className="chord-summary">Repeated chords are grouped. Select a chord to jump to its first occurrence.</p>
                  <div className="chord-list">
                    {uniqueChords.map((chord) => (
                      <button className={`chord-item ${selectedChord?.name === chord.name ? 'current-chord' : ''}`} key={chord.name} onClick={() => seekTo(chord.time)} title={`${chord.count} occurrences · play from ${formatTime(chord.time)}`} aria-current={selectedChord?.name === chord.name ? 'true' : undefined}>
                        <span className="chord-time">×{chord.count} · {formatTime(chord.time)}</span>
                        <strong>{chord.name}</strong>
                      </button>
                    ))}
                  </div>
                  {selectedChord && <ChordVoicings chord={selectedChord} />}
                </>
              ) : <p className="empty-state">No chords could be identified in the separated guitar or piano tracks.</p>}
              {getTrack('Guitar') && <audio className="stem-audio" controls src={`${apiBase}${getTrack('Guitar')!.url}`} aria-label="Play guitar stem" onPlaying={startPlayback} onPause={stopPlayback} onEnded={stopPlayback} onTimeUpdate={syncPlayback} onSeeked={syncPlayback} />}
            </section>
          )}

          {activeSection === 'piano' && (
            <section className="instrument-panel">
              <div className="panel-heading">
                <div><span className="panel-kicker">PIANO TRANSCRIPTION</span><h3>Falling notes · piano keys</h3></div>
                <span>{result.notes.piano} notes · {result.tempo_bpm || 120} BPM</span>
              </div>
              <div className="panel-player">
                {getTrack('Piano') && (
                  <audio
                    ref={pianoAudioRef}
                    controls
                    src={`${apiBase}${getTrack('Piano')!.url}`}
                    aria-label="Play piano stem"
                    onPlaying={startPlayback}
                    onPause={stopPlayback}
                    onEnded={stopPlayback}
                    onTimeUpdate={syncPlayback}
                    onSeeked={syncPlayback}
                  />
                )}
                {downloadLink('Piano MIDI') && <a className="panel-download" href={downloadLink('Piano MIDI')} download>Download MIDI <span aria-hidden="true">↓</span></a>}
              </div>
              {(result.visual_tracks?.piano ?? []).length ? (
                <PianoRoll notes={result.visual_tracks.piano} playhead={playhead} isPlaying={isPlaying} audioRef={playbackAudioRef} />
              ) : <p className="empty-state">No piano notes are available. Check whether the separator returned a piano stem.</p>}
              {(result.visual_tracks?.piano ?? []).length > 0 && <p className="playback-hint"><span className="playhead-dot" /> Notes fall to the keys; keys light up when played</p>}
              {(result.visual_tracks?.piano ?? []).length > 0 && (
                <div className="visual-controls">
                  <button type="button" disabled={isPlaying || viewStart === 0} onClick={() => setViewStart(Math.max(0, viewStart - 12))}>← Previous</button>
                  <span>{isPlaying ? 'Auto-follow' : 'Page'} · {formatTime(isPlaying ? Math.floor(playhead / 12) * 12 : viewStart)} – {formatTime(Math.min(result.duration_seconds, (isPlaying ? Math.floor(playhead / 12) * 12 : viewStart) + 12))}</span>
                  <button type="button" disabled={isPlaying || viewStart >= Math.max(0, Math.floor((result.duration_seconds - 0.01) / 12) * 12)} onClick={() => setViewStart(Math.min(Math.max(0, Math.floor((result.duration_seconds - 0.01) / 12) * 12), viewStart + 12))}>Next →</button>
                </div>
              )}
            </section>
          )}

          {activeSection === 'lead' && (() => {
            const notes = result.visual_tracks?.guitar_lead ?? []
            return (
              <section className="instrument-panel">
                <div className="panel-heading">
                  <div><span className="panel-kicker">GUITAR TRANSCRIPTION</span><h3>Lead guitar · fretboard tab</h3></div>
                  <span>{result.lead_engine === 'solola_compatible' ? 'SoloLa-style · compatible' : 'Basic Pitch'} · {notes.length} notes · {result.guitar_lead_start_seconds === null ? 'no lead detected' : `lead from ${formatTime(result.guitar_lead_start_seconds)}`}</span>
                </div>
                <div className="panel-player">
                  {getTrack('Guitar') && (
                    <audio
                      ref={guitarAudioRef}
                      controls
                      src={`${apiBase}${getTrack('Guitar')!.url}`}
                      aria-label="Play guitar stem"
                      onPlaying={startPlayback}
                      onPause={stopPlayback}
                      onEnded={stopPlayback}
                      onTimeUpdate={syncPlayback}
                      onSeeked={syncPlayback}
                    />
                  )}
                  {downloadLink('Guitar MIDI') && <a className="panel-download" href={downloadLink('Guitar MIDI')} download>Download MIDI <span aria-hidden="true">↓</span></a>}
                  {downloadLink('Guitar TAB') && <a className="panel-download secondary-download" href={downloadLink('Guitar TAB')} download>Download TAB <span aria-hidden="true">↓</span></a>}
                </div>
                {notes.length ? <GuitarTab notes={notes} start={viewStart} playhead={playhead} isPlaying={isPlaying} audioRef={playbackAudioRef} tempoBpm={result.tempo_bpm} /> : <p className="empty-state">No clear lead phrase was detected. The app hides the guitar tab rather than treating the intro accompaniment as a lead.</p>}
                {notes.length > 0 && <p className="playback-hint"><span className="playhead-dot" /> Guitar stem playback follows the tablature</p>}
                {notes.length > 0 && (
                  <div className="visual-controls">
                    <button type="button" disabled={isPlaying || viewStart === 0} onClick={() => setViewStart(Math.max(0, viewStart - 12))}>← Previous</button>
                    <span>{isPlaying ? 'Auto-follow' : 'Page'} · {formatTime(isPlaying ? Math.floor(playhead / 12) * 12 : viewStart)} – {formatTime(Math.min(result.duration_seconds, (isPlaying ? Math.floor(playhead / 12) * 12 : viewStart) + 12))}</span>
                    <button type="button" disabled={isPlaying || viewStart >= Math.max(0, Math.floor((result.duration_seconds - 0.01) / 12) * 12)} onClick={() => setViewStart(Math.min(Math.max(0, Math.floor((result.duration_seconds - 0.01) / 12) * 12), viewStart + 12))}>Next →</button>
                  </div>
                )}
                <p className="panel-footnote">Standard tuning · lead start and fret positions are inferred from the guitar stem and may need correction.</p>
              </section>
            )
          })()}

          {(activeSection === 'bass' || activeSection === 'vocals') && (() => {
            const name = activeSection === 'bass' ? 'Bass' : 'Vocals'
            const track = getTrack(name)
            return (
              <section className="instrument-panel stem-panel">
                <div className="panel-heading">
                  <div><span className="panel-kicker">SEPARATED AUDIO</span><h3>{`${name} track`}</h3></div>
                  <span>{track ? 'Ready to play' : 'Not available'}</span>
                </div>
                <div className={`stem-art ${name.toLowerCase()}`} aria-hidden="true">{name === 'Vocals' ? '◖' : '≋'}</div>
                <p className="stem-description">{track ? `Listen to the isolated ${name.toLowerCase()} part from the separation model.` : `The separation model did not return a ${name.toLowerCase()} stem for this file.`}</p>
                {track && <audio className="stem-audio" controls src={`${apiBase}${track.url}`} aria-label={`Play ${name} stem`} onPlaying={startPlayback} onPause={stopPlayback} onEnded={stopPlayback} onTimeUpdate={syncPlayback} onSeeked={syncPlayback} />}
                {track && <a className="panel-download" href={`${apiBase}${track.url}`} download>Download {name.toLowerCase()} audio <span aria-hidden="true">↓</span></a>}
              </section>
            )
          })()}

          <div className="quality-note">
            <span aria-hidden="true">ⓘ</span>
            <p>{result.warnings.join(' ')}</p>
          </div>
        </section>
      )}

      <footer className="footer">
        <span>Built for musicians who want to understand every layer.</span>
        <span className="footer-local"><span className="status-dot online-dot" /> Local processing</span>
      </footer>
    </main>
  )
}

export default App
