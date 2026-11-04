# Chordcraft

Chordcraft is an experimental, local-first song analysis app. The web interface runs in a browser; the analysis engine runs on your computer. Audio files are uploaded only to that local engine, not to a hosted service.

## Phase 1 scope

- Separate a mix into vocal, bass, piano, and guitar stems with Demucs' `htdemucs_6s` model.
- Transcribe the piano and guitar stems to MIDI with Spotify Basic Pitch.
- Estimate a chord timeline from the transcribed MIDI.
- Create separate draft guitar lead/rhythm MIDI files and plain-text tablature from one guitar transcription.
- Browse results in separate Overview, Piano, Guitar Lead, Guitar Rhythm, Bass, and Vocals views.
- Inspect piano notes in a piano roll and guitar notes on a standard-tuning fretboard view, with MIDI/TAB downloads.
- Listen to the available stems and download outputs.

This is a prototype, not a finished transcription service. Separation and transcription can take several minutes and may need a capable CPU/GPU. The guitar rhythm/lead tracks are heuristic guesses from one guitar stem, not independently separated performances. Chord names, MIDI, and tablature are drafts that need musical review. Bass and vocal transcription are not included.

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

   The `--no-deps` install is intentional: Basic Pitch's package metadata otherwise pulls in its incompatible TensorFlow pin. Its required Python dependencies and ONNX Runtime are installed from `engine\requirements.txt`. PyTorch and audio packages are large downloads. The first Demucs analysis also downloads model weights. The engine finds its tools next to `.venv314\Scripts\python.exe`, so there is no need to activate the environment.
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

## Test with friends

Push the repository to GitHub and invite friends to clone it. Each tester must run both the web app and the local engine on their own computer; this keeps their uploaded audio on their own device. The included GitHub Actions workflow can publish the static web UI to GitHub Pages after Pages is enabled for the repository. A hosted UI still needs a local engine on each tester's computer.

For a GitHub Pages UI, configure the local engine's CORS allowlist with the origin of the Pages site before starting it. For example:

```powershell
$env:CHORDCRAFT_CORS_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173,https://YOUR-ACCOUNT.github.io"
.\.venv314\Scripts\python.exe -m uvicorn engine.main:app --host 127.0.0.1 --port 8000
```

In the Pages build, the browser connects to `http://127.0.0.1:8000`. Browser private-network protections may require users to approve this local connection. The app does not expose the engine to the public internet.

## Tech

- React, TypeScript, Vite
- FastAPI local API
- Demucs `htdemucs_6s`, Basic Pitch with ONNX Runtime (no TensorFlow), and Mido

## License

The application code in this repository is licensed under the MIT License. The audio models and their model weights have their own licenses and terms; review those before redistributing an installer or using the application commercially.
