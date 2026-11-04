import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react'
import './App.css'

type EngineHealth = {
  ready: boolean
  message: string
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
  files: TrackFile[]
  visual_tracks: {
    piano: NoteEvent[]
    guitar_lead: NoteEvent[]
    guitar_rhythm: NoteEvent[]
  }
  tempo_bpm: number
  notes: {
    piano: number
    guitar: number
  }
  warnings: string[]
}

const apiBase = (import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? '' : 'http://127.0.0.1:8000')).replace(/\/$/, '')
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

function PianoRoll({ notes, start, playhead }: { notes: NoteEvent[]; start: number; playhead: number }) {
  const width = 1080
  const rowHeight = 16
  const lowest = notes.length ? Math.min(...notes.map((note) => note.pitch)) : 48
  const highest = notes.length ? Math.max(...notes.map((note) => note.pitch)) : 72
  const minPitch = Math.floor((lowest - 2) / 12) * 12
  const maxPitch = Math.ceil((highest + 2) / 12) * 12
  const pitches = Array.from({ length: maxPitch - minPitch + 1 }, (_, index) => maxPitch - index)
  const height = pitches.length * rowHeight
  const visibleNotes = notes.filter((note) => note.start < start + 12 && note.start + note.duration >= start)

  return (
    <div className="visual-scroll">
      <svg className="piano-roll" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Piano roll showing detected notes by pitch and time">
        {pitches.map((pitch, index) => {
          const y = index * rowHeight
          const isBlackKey = [1, 3, 6, 8, 10].includes(pitch % 12)
          return (
            <g key={pitch}>
              <rect x="0" y={y} width={width} height={rowHeight} className={isBlackKey ? 'piano-lane black-lane' : 'piano-lane'} />
              <text x="5" y={y + 11} className="pitch-label">{pitchName(pitch)}</text>
              <line x1="44" x2={width} y1={y + rowHeight} y2={y + rowHeight} className="piano-grid-line" />
            </g>
          )
        })}
        {Array.from({ length: 13 }, (_, index) => (
          <g key={index}>
            <line x1={44 + index * 86} x2={44 + index * 86} y1="0" y2={height} className={index % 2 === 0 ? 'time-grid-line strong-grid' : 'time-grid-line'} />
            <text x={47 + index * 86} y="12" className="time-label">{formatTime(start + index)}</text>
          </g>
        ))}
        {visibleNotes.map((note, index) => {
          const row = maxPitch - note.pitch
          const noteStart = Math.max(start, note.start)
          const noteEnd = Math.min(start + 12, note.start + note.duration)
          const x = 44 + (noteStart - start) * 86
          const noteWidth = Math.min(Math.max(4, (noteEnd - noteStart) * 86), width - x)
          return (
            <rect
              key={`${note.pitch}-${note.start}-${index}`}
              x={x}
              y={row * rowHeight + 3}
              width={noteWidth}
              height={rowHeight - 6}
              rx="3"
              className="piano-note"
            >
              <title>{pitchName(note.pitch)} · {formatTime(note.start)}</title>
            </rect>
          )
        })}
        {playhead >= start && playhead <= start + 12 && (
          <line x1={44 + (playhead - start) * 86} x2={44 + (playhead - start) * 86} y1="0" y2={height} className="playhead-line" />
        )}
      </svg>
    </div>
  )
}

function GuitarTab({ notes, start, playhead }: { notes: NoteEvent[]; start: number; playhead: number }) {
  const width = 1080
  const xOffset = 50
  const visibleNotes = notes.filter((note) => note.start >= start && note.start < start + 12)

  return (
    <div className="visual-scroll">
      <svg className="guitar-tab" viewBox={`0 0 ${width} 220`} role="img" aria-label="Estimated guitar tablature by string and fret">
        {Array.from({ length: 13 }, (_, index) => (
          <g key={index}>
            <line x1={xOffset + index * 84} x2={xOffset + index * 84} y1="32" y2="196" className={index % 4 === 0 ? 'time-grid-line strong-grid' : 'time-grid-line'} />
            <text x={xOffset + index * 84 + 2} y="20" className="time-label">{formatTime(start + index)}</text>
          </g>
        ))}
        {guitarStrings.map((string, index) => (
          <g key={string.name}>
            <text x="18" y={55 + index * 27} className="string-label">{string.name}</text>
            <line x1={xOffset} x2={width} y1={52 + index * 27} y2={52 + index * 27} className="guitar-string" />
          </g>
        ))}
        {visibleNotes.map((note, index) => {
          const playable = guitarStrings
            .map((string, stringIndex) => ({ stringIndex, fret: note.pitch - string.pitch }))
            .filter(({ fret }) => fret >= 0 && fret <= 22)
            .sort((a, b) => a.fret - b.fret)[0]
          if (!playable) return null
          const x = xOffset + (note.start - start) * 84
          const y = 52 + playable.stringIndex * 27
          return (
            <g key={`${note.pitch}-${note.start}-${index}`}>
              <circle cx={x} cy={y} r="9" className="tab-note" />
              <text x={x} y={y + 3.5} className="fret-label">{playable.fret}</text>
              <title>{pitchName(note.pitch)} · fret {playable.fret} · {formatTime(note.start)}</title>
            </g>
          )
        })}
        {playhead >= start && playhead <= start + 12 && (
          <line x1={xOffset + (playhead - start) * 84} x2={xOffset + (playhead - start) * 84} y1="32" y2="196" className="playhead-line" />
        )}
      </svg>
    </div>
  )
}

function App() {
  const inputRef = useRef<HTMLInputElement>(null)
  const originalAudioRef = useRef<HTMLAudioElement>(null)
  const audioUrlRef = useRef('')
  const [file, setFile] = useState<File | null>(null)
  const [audioUrl, setAudioUrl] = useState('')
  const [health, setHealth] = useState<EngineHealth | null>(null)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [error, setError] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
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
        message: 'Local engine is offline. Start it using the setup guide.',
      })
    }
  }, [])

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
        body: formData,
      })
      const body = (await response.json()) as AnalysisResult & { detail?: string }
      if (!response.ok) {
        throw new Error(body.detail ?? 'Analysis failed. Check the local engine logs.')
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
    { id: 'lead', label: 'Guitar lead', icon: '⌁' },
    { id: 'rhythm', label: 'Guitar rhythm', icon: '♫' },
    { id: 'bass', label: 'Bass', icon: '≋' },
    { id: 'vocals', label: 'Vocals', icon: '◖' },
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
          <span className="beta-tag">LOCAL BETA</span>
        </a>
        <div className={`engine-status ${health?.ready ? 'online' : 'offline'}`}>
          <span className="status-dot" />
          {health?.ready ? 'Engine ready' : health ? 'Engine offline' : 'Engine not checked'}
          <button className="icon-button refresh-button" onClick={() => void checkEngine()} aria-label="Refresh engine status">
            ↻
          </button>
        </div>
      </header>

      <section className="hero">
        <div className="eyebrow"><span className="eyebrow-line" /> YOUR SONG, UNPACKED</div>
        <h1>Hear every part.<br /><span>See how it’s played.</span></h1>
        <p className="hero-copy">
          Turn a song into separate instrument tracks, piano MIDI, and guitar tabs — processed on your computer.
        </p>
        <div className="privacy-note"><span aria-hidden="true">◈</span> Your audio stays on this device</div>
      </section>

      <section className={`workspace ${result ? 'has-result' : ''}`}>
        <div className="section-heading">
          <div>
            <span className="step-label">01 / IMPORT</span>
            <h2>Start with a song</h2>
          </div>
          <span className="file-limit">Up to 150 MB</span>
        </div>

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
              {health?.message ?? 'Checking local engine…'}
            </div>
            <button className="primary-button" disabled={!health?.ready || isAnalyzing} onClick={() => void analyze()}>
              {isAnalyzing ? <><span className="spinner" /> Analyzing song…</> : <>Analyze song <span aria-hidden="true">→</span></>}
            </button>
          </div>
        )}
      </section>

      {isAnalyzing && (
        <section className="progress-card" aria-live="polite">
          <div className="progress-top"><span>Listening to your song</span><span className="pulse-dot" /></div>
          <div className="progress-track"><div className="progress-indicator" /></div>
          <p>Separating instruments and transcribing piano and guitar. This can take several minutes on a CPU.</p>
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
              <span>Original audio · stays on your device</span>
            </div>
            {audioUrl && <audio ref={originalAudioRef} className="audio-player" controls src={audioUrl} onTimeUpdate={syncPlayback} onSeeked={syncPlayback} />}
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
                <div><span className="panel-kicker">PIANO TRANSCRIPTION</span><h3>Piano roll</h3></div>
                <span>{result.notes.piano} notes · {result.tempo_bpm || 120} BPM</span>
              </div>
              <div className="panel-player">
                {getTrack('Piano') && <audio controls src={`${apiBase}${getTrack('Piano')!.url}`} aria-label="Play piano stem" />}
                {downloadLink('Piano MIDI') && <a className="panel-download" href={downloadLink('Piano MIDI')} download>Download MIDI <span aria-hidden="true">↓</span></a>}
              </div>
              {(result.visual_tracks?.piano ?? []).length ? (
                <PianoRoll notes={result.visual_tracks.piano} start={viewStart} playhead={playhead} />
              ) : <p className="empty-state">No piano notes are available. Check whether the separator returned a piano stem.</p>}
              {(result.visual_tracks?.piano ?? []).length > 0 && <p className="playback-hint"><span className="playhead-dot" /> Auto-follow follows the original song playback</p>}
              <div className="visual-controls"><button onClick={() => setViewStart(Math.max(0, viewStart - 12))} disabled={viewStart === 0}>← Previous</button><span>{formatTime(viewStart)} – {formatTime(Math.min(result.duration_seconds, viewStart + 12))}</span><button onClick={() => setViewStart(Math.min(Math.max(0, result.duration_seconds - 12), viewStart + 12))} disabled={viewStart + 12 >= result.duration_seconds}>Next →</button></div>
            </section>
          )}

          {(activeSection === 'lead' || activeSection === 'rhythm') && (() => {
            const isLead = activeSection === 'lead'
            const notes = isLead ? result.visual_tracks?.guitar_lead ?? [] : result.visual_tracks?.guitar_rhythm ?? []
            const title = isLead ? 'Guitar lead' : 'Guitar rhythm'
            const midiLabel = `${title} MIDI`
            const tabLabel = `${title} TAB`
            return (
              <section className="instrument-panel">
                <div className="panel-heading">
                  <div><span className="panel-kicker">GUITAR TRANSCRIPTION</span><h3>{title} · fretboard view</h3></div>
                  <span>{notes.length} notes · estimated part</span>
                </div>
                <div className="panel-player">
                  {getTrack('Guitar') && <audio controls src={`${apiBase}${getTrack('Guitar')!.url}`} aria-label="Play guitar stem" />}
                  {downloadLink(midiLabel) && <a className="panel-download" href={downloadLink(midiLabel)} download>Download MIDI <span aria-hidden="true">↓</span></a>}
                  {downloadLink(tabLabel) && <a className="panel-download secondary-download" href={downloadLink(tabLabel)} download>Download TAB <span aria-hidden="true">↓</span></a>}
                </div>
                {notes.length ? <GuitarTab notes={notes} start={viewStart} playhead={playhead} /> : <p className="empty-state">No notes are available for this guitar part.</p>}
                {notes.length > 0 && <p className="playback-hint"><span className="playhead-dot" /> Auto-follow follows the original song playback</p>}
                <div className="visual-controls"><button onClick={() => setViewStart(Math.max(0, viewStart - 12))} disabled={viewStart === 0}>← Previous</button><span>{formatTime(viewStart)} – {formatTime(Math.min(result.duration_seconds, viewStart + 12))}</span><button onClick={() => setViewStart(Math.min(Math.max(0, result.duration_seconds - 12), viewStart + 12))} disabled={viewStart + 12 >= result.duration_seconds}>Next →</button></div>
                <p className="panel-footnote">Standard tuning · fret positions are estimated from detected pitches.</p>
              </section>
            )
          })()}

          {(activeSection === 'bass' || activeSection === 'vocals') && (() => {
            const name = activeSection === 'bass' ? 'Bass' : 'Vocals'
            const track = getTrack(name)
            return (
              <section className="instrument-panel stem-panel">
                <div className="panel-heading">
                  <div><span className="panel-kicker">SEPARATED AUDIO</span><h3>{name} track</h3></div>
                  <span>{track ? 'Ready to play' : 'Not available'}</span>
                </div>
                <div className={`stem-art ${name.toLowerCase()}`} aria-hidden="true">{name === 'Bass' ? '≋' : '◖'}</div>
                <p className="stem-description">{track ? `Listen to the isolated ${name.toLowerCase()} part from the separation model.` : `The separation model did not return a ${name.toLowerCase()} stem for this file.`}</p>
                {track && <audio className="stem-audio" controls src={`${apiBase}${track.url}`} aria-label={`Play ${name} stem`} />}
                {track && <a className="panel-download" href={`${apiBase}${track.url}`} download>{`Download ${name} audio`} <span aria-hidden="true">↓</span></a>}
                <p className="panel-footnote">Pitch transcription for this part is planned for a later phase.</p>
              </section>
            )
          })()}

          <div className="quality-note">
            <span aria-hidden="true">ⓘ</span>
            <p>{result.warnings.join(' ')} Rhythm/lead are preliminary parts inferred from one guitar stem, not separately isolated recordings.</p>
          </div>
        </section>
      )}

      {!result && !isAnalyzing && (
        <section className="workflow">
          <span className="step-label">WHAT YOU’LL GET</span>
          <div className="workflow-steps">
            <div className="workflow-item"><span className="workflow-number">01</span><div><strong>Separate the mix</strong><p>Vocals, bass, piano, and guitar stems</p></div></div>
            <div className="workflow-item"><span className="workflow-number">02</span><div><strong>Transcribe instruments</strong><p>Piano MIDI and draft guitar parts</p></div></div>
            <div className="workflow-item"><span className="workflow-number">03</span><div><strong>Take it further</strong><p>Listen, download, and refine your parts</p></div></div>
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
