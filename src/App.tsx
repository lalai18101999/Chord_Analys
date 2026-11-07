import { useCallback, useEffect, useRef, useState, type FormEvent, type SyntheticEvent } from 'react'
import './App.css'

type EngineHealth = {
  ready: boolean
  message: string
  password_required?: boolean
  access_configured?: boolean
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

type LyricWord = {
  start: number
  end: number
  text: string
}

type LyricLine = {
  start: number
  words: LyricWord[]
}

type AnalysisResult = {
  id: string
  duration_seconds: number
  chords: Chord[]
  files: TrackFile[]
  lyrics: LyricLine[]
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
const pitchNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const guitarStrings = [
  { name: 'e', pitch: 64 },
  { name: 'B', pitch: 59 },
  { name: 'G', pitch: 55 },
  { name: 'D', pitch: 50 },
  { name: 'A', pitch: 45 },
  { name: 'E', pitch: 40 },
]
function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${remaining}`
}

function pitchName(pitch: number) {
  return `${pitchNames[pitch % 12]}${Math.floor(pitch / 12) - 1}`
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
          .filter(({ fret }) => fret >= 0 && fret <= 22)
          .sort((a, b) => a.fret - b.fret),
      }))
      .filter(({ positions }) => positions.length > 0)
      .sort((a, b) => a.positions.length - b.positions.length || b.pitch - a.pitch)
    const usedStrings = new Set<number>()

    for (const item of uniquePitches) {
      const position = item.positions.find(({ stringIndex }) => !usedStrings.has(stringIndex))
        ?? item.positions[0]
      usedStrings.add(position.stringIndex)
      for (const entry of item.entries.slice(0, 1)) {
        placements.set(entry.index, position)
      }
    }
  }
  return placements
}

function PianoRoll({ notes, start, playhead, isPlaying }: { notes: NoteEvent[]; start: number; playhead: number; isPlaying: boolean }) {
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
  const currentTime = Math.max(start, Math.min(playhead, start + 12))
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

function ChordLyrics({ lyrics, chords }: { lyrics: LyricLine[]; chords: Chord[] }) {
  return (
    <div className="lyrics-sheet">
      {lyrics.map((line, lineIndex) => {
        const chordsByWord = line.words.map((word) => chords.reduce(
          (active, item) => item.time <= word.start ? item.name : active,
          '',
        ))
        return (
          <p className="lyric-line" key={`${line.start}-${lineIndex}`}>
            {line.words.map((word, wordIndex) => {
              const chord = chordsByWord[wordIndex]
              const previousChord = wordIndex > 0 ? chordsByWord[wordIndex - 1] : ''
              const chordLabel = chord && chord !== previousChord ? chord : ''
              return (
                <span className="lyric-word" key={`${word.start}-${wordIndex}`}>
                  <span className="lyric-chord">{chordLabel || '\u00a0'}</span>
                  <span>{word.text.trim()}</span>
                </span>
              )
            })}
          </p>
        )
      })}
    </div>
  )
}

function GuitarTab({ notes, start, playhead }: { notes: NoteEvent[]; start: number; playhead: number }) {
  const secondsWidth = 132
  const width = 1666
  const xOffset = 50
  const visibleNotes = notes
    .map((note, index) => ({ note, index }))
    .filter(({ note }) => note.start >= start && note.start < start + 12)
  const placements = guitarTabNotes(notes)

  return (
    <div className="visual-scroll">
      <svg className="guitar-tab" viewBox={`0 0 ${width} 220`} role="img" aria-label="Estimated guitar tablature by string and fret">
        {Array.from({ length: 13 }, (_, index) => (
          <g key={index}>
            <line x1={xOffset + index * secondsWidth} x2={xOffset + index * secondsWidth} y1="32" y2="196" className={index % 4 === 0 ? 'time-grid-line strong-grid' : 'time-grid-line'} />
            <text x={xOffset + index * secondsWidth + 2} y="20" className="time-label">{formatTime(start + index)}</text>
          </g>
        ))}
        {guitarStrings.map((string, index) => (
          <g key={string.name}>
            <text x="18" y={55 + index * 27} className="string-label">{string.name}</text>
            <line x1={xOffset} x2={width} y1={52 + index * 27} y2={52 + index * 27} className="guitar-string" />
          </g>
        ))}
        {visibleNotes.map(({ note, index }) => {
          const playable = placements.get(index)
          if (!playable) return null
          const x = xOffset + (note.start - start) * secondsWidth
          const y = 52 + playable.stringIndex * 27
          return (
            <g key={`${note.pitch}-${note.start}-${index}`}>
              <circle cx={x} cy={y} r="7" className="tab-note" />
              <text x={x} y={y + 3.5} className="fret-label">{playable.fret}</text>
              <title>{pitchName(note.pitch)} · fret {playable.fret} · {formatTime(note.start)}</title>
            </g>
          )
        })}
        {playhead >= start && playhead <= start + 12 && (
          <line x1={xOffset + (playhead - start) * secondsWidth} x2={xOffset + (playhead - start) * secondsWidth} y1="32" y2="196" className="playhead-line" />
        )}
      </svg>
    </div>
  )
}

function App() {
  const inputRef = useRef<HTMLInputElement>(null)
  const originalAudioRef = useRef<HTMLAudioElement>(null)
  const pianoAudioRef = useRef<HTMLAudioElement>(null)
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
  const [activeSection, setActiveSection] = useState('overview')
  const [viewStart, setViewStart] = useState(0)
  const [playhead, setPlayhead] = useState(0)

  const checkEngine = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase}/api/health`)
      if (!response.ok) throw new Error('Local engine did not respond.')
      const data = (await response.json()) as EngineHealth
      setHealth(data)
    } catch {
      setHealth({
        ready: false,
        message: isHosted ? 'Analysis server is offline.' : 'Local engine is offline. Start it using the setup guide.',
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
      const body = (await response.json()) as { detail?: string }
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

    try {
      const response = await fetch(`${apiBase}/api/analyze`, {
        method: 'POST',
        headers: accessPassword ? { 'X-Chordcraft-Password': accessPassword } : undefined,
        body: formData,
      })
      const body = (await response.json()) as AnalysisResult & { detail?: string }
      if (response.status === 401) clearAccessPassword()
      if (!response.ok) {
        throw new Error(body.detail ?? (isHosted ? 'Analysis failed on the server.' : 'Analysis failed. Check the local engine logs.'))
      }
      setResult(body)
      setActiveSection('overview')
      setViewStart(0)
      setPlayhead(0)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to analyze this audio.')
    } finally {
      setIsAnalyzing(false)
    }
  }

  const sectionOptions = [
    { id: 'overview', label: 'Overview', icon: '◫' },
    { id: 'piano', label: 'Piano', icon: '▤' },
    { id: 'lead', label: 'Guitar tab', icon: '⌁' },
    { id: 'bass', label: 'Bass', icon: '≋' },
    { id: 'vocals', label: 'Lyrics + chords', icon: '◖' },
  ]
  const activeChordIndex = result?.chords.reduce(
    (activeIndex, chord, index) => chord.time <= playhead ? index : activeIndex,
    -1,
  ) ?? -1

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
    setPlayhead(time)
    setViewStart(Math.floor(time / 12) * 12)
    void originalAudioRef.current.play()
  }

  function syncPlayback(event: SyntheticEvent<HTMLAudioElement>) {
    const time = event.currentTarget.currentTime
    setPlayhead(time)
    setViewStart(Math.floor(time / 12) * 12)
  }

  function startPlayback(event: SyntheticEvent<HTMLAudioElement>) {
    const activeAudio = event.currentTarget
    const otherAudio = activeAudio === originalAudioRef.current
      ? pianoAudioRef.current
      : originalAudioRef.current
    if (otherAudio && !otherAudio.paused) otherAudio.pause()
    syncPlayback(event)
    setIsPlaying(true)
  }

  function stopPlayback() {
    setIsPlaying(Boolean(
      (originalAudioRef.current && !originalAudioRef.current.paused)
      || (pianoAudioRef.current && !pianoAudioRef.current.paused),
    ))
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
        <h1>Hear every part.<br /><span>See how it’s played.</span></h1>
        <p className="hero-copy">
          Turn a song into separate instrument tracks, piano MIDI, a lead guitar tab, and lyrics with chords.
        </p>
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
        {error && <div className="error-message" role="alert">{error}</div>}

        {file && (
          <div className="analyze-row">
            <div className="engine-hint">
              <span className={`mini-dot ${health?.ready ? 'ready' : ''}`} />
              {health?.message ?? (isHosted ? 'Checking analysis server…' : 'Checking local engine…')}
            </div>
            <button className="primary-button" disabled={!health?.ready || (health.password_required && !accessPassword) || isAnalyzing} onClick={() => void analyze()}>
              {isAnalyzing ? <><span className="spinner" /> Analyzing song…</> : <>Analyze song <span aria-hidden="true">→</span></>}
            </button>
          </div>
        )}
      </section>

      {isAnalyzing && (
        <section className="progress-card" aria-live="polite">
          <div className="progress-top"><span>Listening to your song</span><span className="pulse-dot" /></div>
          <div className="progress-track"><div className="progress-indicator" /></div>
          <p>{isHosted ? 'Uploading the audio to the analysis server. ' : 'Processing on your computer. ' }The first lyrics run downloads its speech model; processing can take several minutes.</p>
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
                onPlay={startPlayback}
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

          {activeSection === 'overview' && (
            <section className="instrument-panel">
              <div className="panel-heading">
                <div><span className="panel-kicker">ARRANGEMENT MAP</span><h3>Chord timeline</h3></div>
                <span>{result.chords.length} chord changes</span>
              </div>
              {result.chords.length > 0 ? (
                <div className="chord-list">
                  {result.chords.map((chord, index) => (
                    <button className={`chord-item ${activeChordIndex === index ? 'current-chord' : ''}`} key={`${chord.time}-${index}`} onClick={() => seekTo(chord.time)} title={`Play from ${formatTime(chord.time)}`}>
                      <span className="chord-time">{formatTime(chord.time)}</span>
                      <strong>{chord.name}</strong>
                    </button>
                  ))}
                </div>
              ) : <p className="empty-state">No chord changes were detected for this song.</p>}
              <div className="panel-divider" />
              <div className="panel-heading"><div><span className="panel-kicker">SEPARATED AUDIO</span><h3>Instrument stems</h3></div><span>Listen to each part</span></div>
              <div className="track-grid">
                {['Piano', 'Guitar', 'Bass', 'Vocals'].map((name) => {
                  const track = getTrack(name)
                  return (
                    <article className={`track-card ${track ? '' : 'not-ready'}`} key={name}>
                      <div className={`instrument-icon ${name.toLowerCase()}`} aria-hidden="true">{name === 'Piano' ? '▤' : name === 'Guitar' ? '⌁' : name === 'Bass' ? '≋' : '◖'}</div>
                      <div className="track-card-body"><strong>{name}</strong><span>{track ? 'Stem ready' : 'Not returned by this model'}</span></div>
                      {track ? <audio controls src={`${apiBase}${track.url}`} aria-label={`Play ${name} stem`} /> : <span className="coming-label">—</span>}
                    </article>
                  )
                })}
              </div>
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
                    onPlay={startPlayback}
                    onPause={stopPlayback}
                    onEnded={stopPlayback}
                    onTimeUpdate={syncPlayback}
                    onSeeked={syncPlayback}
                  />
                )}
                {downloadLink('Piano MIDI') && <a className="panel-download" href={downloadLink('Piano MIDI')} download>Download MIDI <span aria-hidden="true">↓</span></a>}
              </div>
              {(result.visual_tracks?.piano ?? []).length ? (
                <PianoRoll notes={result.visual_tracks.piano} start={viewStart} playhead={playhead} isPlaying={isPlaying} />
              ) : <p className="empty-state">No piano notes are available. Check whether the separator returned a piano stem.</p>}
              {(result.visual_tracks?.piano ?? []).length > 0 && <p className="playback-hint"><span className="playhead-dot" /> Notes fall to the keys; keys light up when played</p>}
              <div className="visual-controls"><button onClick={() => setViewStart(Math.max(0, viewStart - 12))} disabled={viewStart === 0}>← Previous</button><span>{formatTime(viewStart)} – {formatTime(Math.min(result.duration_seconds, viewStart + 12))}</span><button onClick={() => setViewStart(Math.min(Math.max(0, result.duration_seconds - 12), viewStart + 12))} disabled={viewStart + 12 >= result.duration_seconds}>Next →</button></div>
            </section>
          )}

          {activeSection === 'lead' && (() => {
            const notes = result.visual_tracks?.guitar_lead ?? []
            return (
              <section className="instrument-panel">
                <div className="panel-heading">
                  <div><span className="panel-kicker">GUITAR TRANSCRIPTION</span><h3>Lead guitar · fretboard tab</h3></div>
                  <span>{notes.length} notes · {result.guitar_lead_start_seconds === null ? 'no lead detected' : `lead from ${formatTime(result.guitar_lead_start_seconds)}`}</span>
                </div>
                <div className="panel-player">
                  {getTrack('Guitar') && <audio controls src={`${apiBase}${getTrack('Guitar')!.url}`} aria-label="Play guitar stem" />}
                  {downloadLink('Guitar MIDI') && <a className="panel-download" href={downloadLink('Guitar MIDI')} download>Download MIDI <span aria-hidden="true">↓</span></a>}
                  {downloadLink('Guitar TAB') && <a className="panel-download secondary-download" href={downloadLink('Guitar TAB')} download>Download TAB <span aria-hidden="true">↓</span></a>}
                </div>
                {notes.length ? <GuitarTab notes={notes} start={viewStart} playhead={playhead} /> : <p className="empty-state">No clear lead phrase was detected. The app hides the guitar tab rather than treating the intro accompaniment as a lead.</p>}
                {notes.length > 0 && <p className="playback-hint"><span className="playhead-dot" /> Auto-follow follows the original song playback</p>}
                <div className="visual-controls"><button onClick={() => setViewStart(Math.max(0, viewStart - 12))} disabled={viewStart === 0}>← Previous</button><span>{formatTime(viewStart)} – {formatTime(Math.min(result.duration_seconds, viewStart + 12))}</span><button onClick={() => setViewStart(Math.min(Math.max(0, result.duration_seconds - 12), viewStart + 12))} disabled={viewStart + 12 >= result.duration_seconds}>Next →</button></div>
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
                  <div><span className="panel-kicker">{name === 'Vocals' ? 'VOICE RECOGNITION' : 'SEPARATED AUDIO'}</span><h3>{name === 'Vocals' ? 'Lyrics + chords' : `${name} track`}</h3></div>
                  <span>{track ? 'Ready to play' : 'Not available'}</span>
                </div>
                {name === 'Vocals' ? (
                  <>
                    {result.lyrics.length ? (
                      <ChordLyrics lyrics={result.lyrics} chords={result.chords} />
                    ) : (
                      <p className="empty-state">No lyrics were recognized. Try a clearer vocal stem or check the original audio.</p>
                    )}
                    {track && <audio className="stem-audio" controls src={`${apiBase}${track.url}`} aria-label="Play vocals stem" />}
                    {track && <a className="panel-download" href={`${apiBase}${track.url}`} download>Download vocals audio <span aria-hidden="true">↓</span></a>}
                    <p className="panel-footnote">Lyrics are transcribed locally; chord positions are matched to estimated word timings.</p>
                  </>
                ) : (
                  <>
                    <div className="stem-art bass" aria-hidden="true">≋</div>
                    <p className="stem-description">{track ? 'Listen to the isolated bass part from the separation model.' : 'The separation model did not return a bass stem for this file.'}</p>
                    {track && <audio className="stem-audio" controls src={`${apiBase}${track.url}`} aria-label="Play Bass stem" />}
                    {track && <a className="panel-download" href={`${apiBase}${track.url}`} download>Download Bass audio <span aria-hidden="true">↓</span></a>}
                    <p className="panel-footnote">Pitch transcription for this part is planned for a later phase.</p>
                  </>
                )}
              </section>
            )
          })()}

          <div className="quality-note">
            <span aria-hidden="true">ⓘ</span>
            <p>{result.warnings.join(' ')}</p>
          </div>
        </section>
      )}

      {!result && !isAnalyzing && (
        <section className="workflow">
          <span className="step-label">WHAT YOU’LL GET</span>
          <div className="workflow-steps">
            <div className="workflow-item"><span className="workflow-number">01</span><div><strong>Separate the mix</strong><p>Vocals, bass, piano, and guitar stems</p></div></div>
            <div className="workflow-item"><span className="workflow-number">02</span><div><strong>Transcribe instruments</strong><p>Piano MIDI and a lead-focused guitar tab</p></div></div>
            <div className="workflow-item"><span className="workflow-number">03</span><div><strong>Follow the song</strong><p>Read lyrics with chords, listen, and download</p></div></div>
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
