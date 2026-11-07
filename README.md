# Chordcraft

Chordcraft is an experimental song analysis app. When run locally, its analysis engine processes audio on your computer. The hosted beta runs the interface and engine together on Railway; audio uploaded there is processed on the server and retained temporarily.

## Phase 1 scope

- Separate a mix into vocal, bass, piano, and guitar stems with Demucs' `htdemucs_6s` model.
- Transcribe the piano and guitar stems to MIDI with Spotify Basic Pitch; infer one lead-focused guitar tab after a sustained melodic phrase is detected.
- Estimate a chord timeline from the transcribed MIDI.
- Transcribe vocal lyrics locally with Whisper and align estimated chord labels to lyric word timings.
- Browse results in separate Overview, Piano, Guitar Tab, Bass, and Lyrics + Chords views.
- Inspect piano notes on a keyboard-style piano roll and guitar notes on a standard-tuning fretboard, with MIDI/TAB downloads.
- Listen to the available stems and download outputs.

This is a prototype, not a finished transcription service. Separation and transcription can take several minutes and may need a capable CPU/GPU. Lead entry and notes are inferred from one guitar stem, not independently separated performances; the filter can miss or misclassify notes. Chord names, lyrics, MIDI, and tablature are drafts that need musical review. Bass pitch transcription is not included.

## Run locally (Windows)

Use Python 3.14 for the local audio engine and Node.js 22 or newer for the web app. Basic Pitch's published package pins TensorFlow below 2.15.1 on Python 3.11+, so this project uses its ONNX model runtime instead of overriding that TensorFlow constraint. Basic Pitch currently lists official Python support only through 3.11; its ONNX inference was smoke-tested on Python 3.14 for this project, but that is not an upstream support guarantee.

1. Install Python 3.14 if needed (`py install 3.14`). FFmpeg and ffprobe are installed with the Python environment; no separate system FFmpeg/PATH setup is required.
2. From the project folder, create an isolated Python environment and install the local engine:

   ```powershell
   py -3.14 -m venv .venv314
   .\.venv314\Scripts\python.exe -m pip install --upgrade pip
   .\.venv314\Scripts\python.exe -m pip install -r engine\requirements.txt
   .\.venv314\Scripts\python.exe -m pip install --no-deps "basic-pitch[onnx]==0.4.0"
   ```

   The `--no-deps` install is intentional: Basic Pitch's package metadata otherwise pulls in its incompatible TensorFlow pin. Its required Python dependencies and ONNX Runtime are installed from `engine\requirements.txt`. PyTorch and audio packages are large downloads. The first Demucs analysis downloads separator weights, and the first lyrics transcription downloads Whisper's multilingual `base` model. Both models run locally after download. The engine finds its tools next to `.venv314\Scripts\python.exe`, so there is no need to activate the environment.
3. Install and start the web app:

   ```powershell
   npm.cmd ci
   npm.cmd run dev
   ```

4. In a second terminal, start the engine from the project folder:

   ```powershell
   .\.venv314\Scripts\python.exe -m uvicorn engine.main:app --host 127.0.0.1 --port 8000
   ```

5. Open the Vite URL (normally `http://localhost:5173`). Choose a supported audio file up to 150 MB and select **Analyze song**.

Analysis results are stored under `engine\data\jobs` so the browser can play/download them. This folder is ignored by git. Remove individual job folders when you no longer need their audio and outputs.

## Publish the hosted beta on Railway

The Railway deployment serves both the web interface and the Python engine from one URL. Users only need a browser and the shared beta password; they do not install Python or run a local engine. **Audio is uploaded to your Railway server for analysis.** Temporary uploads and outputs are deleted after 24 hours. Only share the app with people who agree to this.

1. Push the repository to GitHub.
2. Sign in to Railway, create a project from this GitHub repository, and deploy it. Railway uses the included `Dockerfile` and `railway.json`.
3. In the Railway service, add a Volume mounted at `/data`.
4. In **Variables**, add:

   ```text
   CHORDCRAFT_REQUIRE_PASSWORD=true
   CHORDCRAFT_ACCESS_PASSWORD=<a random password of at least 16 characters>
   CHORDCRAFT_DATA_DIR=/data
   XDG_CACHE_HOME=/data/cache
   ```

   Keep the password in Railway's private variables; do not commit it to GitHub. Give it to beta users privately. Anyone who has it can use the shared analyzer.
5. In Railway's service settings, choose a plan with at least 8 GB RAM and enough CPU for long audio analysis. The free/trial tier may run out of memory, time out, or incur usage charges. Set a spending limit/usage alert in Railway before sharing the link.
6. Generate a public domain for the service in **Settings → Networking**. Wait until `/api/health` reports that the server setup is ready, then open the Railway domain. The first analysis downloads the Demucs and Whisper models into the `/data` volume and may take longer.
7. Send beta users the Railway URL and the shared password. They can upload an audio file up to 150 MB directly in the browser.

The server accepts one analysis at a time; while one song is processing, other users will be asked to wait. Results are temporary and old job folders are cleaned hourly. The shared password is suitable only for a small private beta, not for individual accounts or a public commercial service. Before making the app open to everyone, add per-user authentication, stricter rate limits/quotas, monitoring, and a privacy policy. Review Railway and model-provider terms and costs before launch.

The GitHub Pages workflow publishes only a static UI preview; it does **not** include the Python engine. Share the Railway domain for the hosted beta, not the Pages preview.

## Tech

- React, TypeScript, Vite
- FastAPI local API
- Demucs `htdemucs_6s`, Basic Pitch with ONNX Runtime (no TensorFlow), Whisper, and Mido

## License

The application code in this repository is licensed under the MIT License. The audio models and their model weights, including Whisper's downloaded model, have their own licenses and terms; review those before redistributing an installer or using the application commercially.
j