# Local TTS Library

A small TypeScript web app for listening to local books with Piper.

## What it does

- Scans `books/` for `.txt`, `.md`, and text-based `.pdf` files.
- Shows a local browser library and reader.
- Sends the current chunk of text to Piper.
- Saves generated `.wav` files in `generated/`.
- Tracks reading/listening progress in `library-progress.json`.

## Setup

This version has no Node package dependencies. It runs directly on Node 22.

Install Piper in the Python environment that Node can call:

```sh
python -m pip install piper-tts
```

Download a voice into `voices/`:

```sh
python -m piper.download_voices --data-dir voices en_US-lessac-medium
```

Run the app:

```sh
npm run dev
```

If npm resolves paths incorrectly on your portable Windows setup, run Node directly:

```powershell
$env:APP_ROOT="C:\Users\John Doe\Desktop\VSCodePortable\Projects\Text2Speach"
node --experimental-strip-types "C:\Users\John Doe\Desktop\VSCodePortable\Projects\Text2Speach\src\server.ts"
```

Open:

```text
http://127.0.0.1:8080
```

## Folders

- `books/` - put your books here.
- `voices/` - Piper `.onnx` and `.onnx.json` voice files.
- `generated/` - generated audio chunks.
- `static/` - browser UI.
- `src/` - TypeScript backend.

## Notes

PDF support uses `pdftotext` when it is available on your machine. It works for PDFs that already contain selectable text. Scanned books need OCR first.

The app calls Piper through:

```sh
python -m piper
```

If your Piper install uses a different Python executable, set `PIPER_PYTHON`:

```sh
PIPER_PYTHON=/path/to/python npm run dev
```

On Windows PowerShell:

```powershell
$env:PIPER_PYTHON="C:\path\to\python.exe"
npm run dev
```

## Later Docker version

The current layout is ready for Docker later: copy the app, install Piper, install `poppler-utils` for `pdftotext`, mount `books/`, `voices/`, and `generated/` as volumes, then expose port `8080`.
