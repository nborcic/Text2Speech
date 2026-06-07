import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";

type Book = {
  id: string;
  title: string;
  fileName: string;
  extension: string;
  size: number;
  modified: number;
  progress: number;
};

type Job = {
  id: string;
  status: "queued" | "running" | "done" | "error";
  message: string;
  audio?: string;
  nextOffset?: number;
  chars?: number;
};

const sourceDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.APP_ROOT ?? join(sourceDir, ".."));
const booksDir = join(root, "books");
const voicesDir = join(root, "voices");
const generatedDir = join(root, "generated");
const staticDir = join(root, "static");
const cacheDir = join(root, "cache");
const scriptsDir = join(root, "scripts");
const progressPath = join(root, "library-progress.json");

const supportedBookExtensions = new Set([".txt", ".md", ".pdf", ".epub"]);
const defaultVoice = process.env.PIPER_VOICE ?? "en_US-lessac-medium";
const localVenvPython = process.platform === "win32"
  ? join(root, ".venv", "Scripts", "python.exe")
  : join(root, ".venv", "bin", "python");
const piperPython = process.env.PIPER_PYTHON ?? (existsSync(localVenvPython) ? localVenvPython : process.platform === "win32" ? "python" : "python3");
const bundledPdfToText = "C:\\tools\\poppler-26.02.0\\Library\\bin\\pdftotext.exe";
const pdfToTextBin = process.env.PDFTOTEXT_BIN ?? (existsSync(bundledPdfToText) ? bundledPdfToText : "pdftotext");
const maxCharsPerJob = Number(process.env.MAX_CHARS_PER_JOB ?? 12000);
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "127.0.0.1";

const jobs = new Map<string, Job>();

type CachedBook = {
  sourcePath: string;
  sourceSize: number;
  sourceModified: number;
  title: string;
  author?: string;
  text: string;
  warning?: string;
};

for (const dir of [booksDir, voicesDir, generatedDir, staticDir, cacheDir]) {
  mkdirSync(dir, { recursive: true });
}

function readProgress(): Record<string, number> {
  if (!existsSync(progressPath)) return {};
  try {
    return JSON.parse(readFileSync(progressPath, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

function writeProgress(progress: Record<string, number>) {
  writeFileSync(progressPath, JSON.stringify(progress, null, 2));
}

function getProgress(bookId: string): number {
  return readProgress()[bookId] ?? 0;
}

function setProgress(bookId: string, offset: number) {
  const progress = readProgress();
  progress[bookId] = Math.max(0, Math.floor(offset));
  writeProgress(progress);
}

function walkFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(fullPath);
    return [fullPath];
  });
}

function toBookId(filePath: string): string {
  return relative(booksDir, filePath).split(sep).join("/");
}

function safeBookPath(bookId: string): string {
  const decoded = decodeURIComponent(bookId);
  const fullPath = resolve(booksDir, decoded);
  const rootWithSep = booksDir.endsWith(sep) ? booksDir : booksDir + sep;
  if (fullPath !== booksDir && !fullPath.startsWith(rootWithSep)) {
    throw httpError(400, "Invalid book path");
  }
  if (!existsSync(fullPath) || !supportedBookExtensions.has(extname(fullPath).toLowerCase())) {
    throw httpError(404, "Book not found");
  }
  return fullPath;
}

function listBooks(): Book[] {
  return walkFiles(booksDir)
    .filter((file) => supportedBookExtensions.has(extname(file).toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => {
      const stats = statSync(file);
      const id = toBookId(file);
      return {
        id,
        title: titleFromFile(file),
        fileName: file.split(/[\\/]/).at(-1) ?? file,
        extension: extname(file).toLowerCase(),
        size: stats.size,
        modified: Math.floor(stats.mtimeMs / 1000),
        progress: getProgress(id),
      };
    });
}

function titleFromFile(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).at(-1) ?? filePath;
  return fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
}

async function extractText(filePath: string): Promise<{ text: string; warning?: string; title?: string; author?: string }> {
  const cached = await readOrCreateCachedBook(filePath);
  return {
    text: cached.text,
    warning: cached.warning,
    title: cached.title,
    author: cached.author,
  };
}

async function readOrCreateCachedBook(filePath: string): Promise<CachedBook> {
  const stats = statSync(filePath);
  const cachePath = join(cacheDir, `${safeName(filePath)}.json`);
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as CachedBook;
      if (
        cached.sourcePath === filePath &&
        cached.sourceSize === stats.size &&
        cached.sourceModified === Math.floor(stats.mtimeMs)
      ) {
        cached.text = cleanText(cached.text);
        return cached;
      }
    } catch {
      // Bad cache files are ignored and rebuilt.
    }
  }

  const extracted = await extractFreshBook(filePath);
  const cached: CachedBook = {
    sourcePath: filePath,
    sourceSize: stats.size,
    sourceModified: Math.floor(stats.mtimeMs),
    title: extracted.title ?? titleFromFile(filePath),
    author: extracted.author,
    text: cleanText(extracted.text),
    warning: extracted.warning,
  };
  writeFileSync(cachePath, JSON.stringify(cached, null, 2), "utf8");
  return cached;
}

async function extractFreshBook(filePath: string): Promise<{ text: string; warning?: string; title?: string; author?: string }> {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".txt" || extension === ".md") {
    return { text: cleanText(await readFile(filePath, "utf8")), title: titleFromFile(filePath) };
  }

  if (extension === ".pdf") {
    const tool = pdfToTextBin;
    const check = spawnSync(tool, ["-v"], { windowsHide: true });
    if (check.error) {
      return {
        text: "",
        warning: "PDF support needs pdftotext or OCR tooling. TXT and Markdown work now.",
      };
    }

    try {
      const text = await runPdfToText(tool, filePath);
      if (!text) {
        return {
          text: "",
          warning: "No selectable text was found. This PDF probably needs OCR first.",
        };
      }
      return { text };
    } catch (error) {
      return {
        text: "",
        warning: `PDF extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (extension === ".epub") {
    try {
      return await runEpubExtractor(filePath);
    } catch (error) {
      return {
        text: "",
        title: titleFromFile(filePath),
        warning: `EPUB extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return { text: "", warning: `Unsupported file type: ${extension}` };
}

function runEpubExtractor(filePath: string): Promise<{ text: string; warning?: string; title?: string; author?: string }> {
  return new Promise((resolvePromise, reject) => {
    const helperPath = join(scriptsDir, "extract_epub.py");
    const child = spawn(piperPython, [helperPath, filePath], { windowsHide: true });
    const stdout: Buffer[] = [];
    let stderr = "";

    child.stdout.on("data", (data) => stdout.push(Buffer.from(data)));
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error((stderr || `EPUB extractor exited with code ${code}`).trim()));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8")) as {
          title?: string;
          author?: string;
          text?: string;
          warning?: string;
        };
        resolvePromise({
          title: parsed.title,
          author: parsed.author,
          text: cleanText(parsed.text ?? ""),
          warning: parsed.warning,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function runPdfToText(tool: string, filePath: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(tool, ["-layout", filePath, "-"], { windowsHide: true });
    const stdout: Buffer[] = [];
    let stderr = "";

    child.stdout.on("data", (data) => stdout.push(Buffer.from(data)));
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(cleanText(Buffer.concat(stdout).toString("utf8")));
      else reject(new Error((stderr || `pdftotext exited with code ${code}`).trim()));
    });
  });
}

function cleanText(text: string): string {
  return text
    .replace(/[\uD800-\uDFFF]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\f/g, "\n\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/-\n(?=\w)/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textSlice(text: string, offset: number, limit: number): { text: string; nextOffset: number } {
  const start = Math.max(0, Math.min(offset, text.length));
  let end = Math.min(text.length, start + limit);
  if (end < text.length) {
    const boundaries = ["\n\n", ". ", "! ", "? "].map((marker) => text.lastIndexOf(marker, end));
    const boundary = Math.max(...boundaries);
    if (boundary > start + 500) end = boundary + 1;
  }
  return { text: text.slice(start, end).trim(), nextOffset: end };
}

function listVoices() {
  return walkFiles(voicesDir)
    .filter((file) => extname(file).toLowerCase() === ".onnx")
    .map((modelPath) => ({
      name: modelPath.split(/[\\/]/).at(-1)?.replace(/\.onnx$/, "") ?? modelPath,
      modelPath: relative(root, modelPath).split(sep).join("/"),
      hasConfig: existsSync(`${modelPath}.json`),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function startTtsJob(bookId: string, offset: number, voice: string, speed: number): Promise<Job> {
  const job: Job = { id: randomUUID().slice(0, 12), status: "queued", message: "Queued" };
  jobs.set(job.id, job);

  void runTtsJob(job.id, bookId, offset, voice, speed);
  return job;
}

async function runTtsJob(jobId: string, bookId: string, offset: number, voice: string, speed: number) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    job.status = "running";
    job.message = "Extracting text...";

    const filePath = safeBookPath(bookId);
    const { text, warning } = await extractText(filePath);
    if (!text) throw new Error(warning ?? "There is no readable text in this book.");

    const chunk = textSlice(cleanText(text), offset, maxCharsPerJob);
    if (!chunk.text) throw new Error("There is no text to synthesize at this position.");

    const outputName = `${safeName(bookId)}-${jobId}.wav`;
    const outputPath = join(generatedDir, outputName);
    const voiceName = voice || defaultVoice;
    const safeSpeed = clamp(Number.isFinite(speed) ? speed : 1, 0.65, 1.6);

    job.message = `Piper is generating audio at ${safeSpeed.toFixed(2)}x...`;
    await runPiper(cleanText(chunk.text), voiceName, outputPath, safeSpeed);

    setProgress(bookId, chunk.nextOffset);
    job.status = "done";
    job.message = "Audio ready";
    job.audio = `/generated/${outputName}`;
    job.nextOffset = chunk.nextOffset;
    job.chars = chunk.text.length;
  } catch (error) {
    job.status = "error";
    job.message = error instanceof Error ? error.message : String(error);
  }
}

function runPiper(text: string, voice: string, outputPath: string, speed: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const lengthScale = clamp(1 / speed, 0.6, 1.55).toFixed(3);
    const child = spawn(
      piperPython,
      ["-m", "piper", "--data-dir", voicesDir, "-m", voice, "-f", outputPath, "--length-scale", lengthScale],
      { windowsHide: true }
    );

    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error((stderr || stdout || `Piper exited with code ${code}`).trim()));
    });
    child.stdin.end(text);
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function safeName(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 10);
}

function httpError(status: number, message: string) {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function sendJson(res: ServerResponse, payload: unknown, status = 200) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
  });
  res.end(body);
}

function sendFile(res: ServerResponse, filePath: string) {
  if (!existsSync(filePath)) {
    sendJson(res, { error: "File not found" }, 404);
    return;
  }

  const extension = extname(filePath).toLowerCase();
  const contentType =
    extension === ".html"
      ? "text/html; charset=utf-8"
      : extension === ".css"
        ? "text/css; charset=utf-8"
        : extension === ".js"
          ? "text/javascript; charset=utf-8"
          : extension === ".wav"
            ? "audio/wav"
            : "application/octet-stream";

  res.writeHead(200, { "content-type": contentType });
  createReadStream(filePath).pipe(res);
}

function routeStatic(url: URL, res: ServerResponse) {
  const base = url.pathname.startsWith("/generated/") ? generatedDir : staticDir;
  const requested = url.pathname.startsWith("/generated/")
    ? url.pathname.replace("/generated/", "")
    : url.pathname.replace("/static/", "");
  const filePath = resolve(base, decodeURIComponent(requested));
  const baseWithSep = base.endsWith(sep) ? base : base + sep;
  if (filePath !== base && !filePath.startsWith(baseWithSep)) {
    sendJson(res, { error: "Forbidden" }, 403);
    return;
  }
  sendFile(res, filePath);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/") {
      sendFile(res, join(staticDir, "index.html"));
      return;
    }

    if (method === "GET" && url.pathname === "/api/books") {
      sendJson(res, { books: listBooks() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/voices") {
      sendJson(res, { defaultVoice, voices: listVoices() });
      return;
    }

    if (method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      const job = jobs.get(url.pathname.split("/").at(-1) ?? "");
      sendJson(res, job ?? { error: "Job not found" }, job ? 200 : 404);
      return;
    }

    const bookTextMatch = url.pathname.match(/^\/api\/books\/(.+)\/text$/);
    if (method === "GET" && bookTextMatch) {
      const bookId = bookTextMatch[1];
      const offset = Number(url.searchParams.get("offset") ?? getProgress(decodeURIComponent(bookId)));
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 20000), 60000);
      const filePath = safeBookPath(bookId);
      const { text, warning } = await extractText(filePath);
      const chunk = textSlice(text, offset, limit);
      sendJson(res, {
        id: decodeURIComponent(bookId),
        title: titleFromFile(filePath),
        text: chunk.text,
        offset,
        nextOffset: chunk.nextOffset,
        totalChars: text.length,
        progress: getProgress(decodeURIComponent(bookId)),
        warning,
      });
      return;
    }

    const listenMatch = url.pathname.match(/^\/api\/books\/(.+)\/listen$/);
    if (method === "POST" && listenMatch) {
      const payload = await readJson(req);
      const job = await startTtsJob(
        decodeURIComponent(listenMatch[1]),
        Number(payload.offset ?? 0),
        String(payload.voice ?? defaultVoice),
        Number(payload.speed ?? 1)
      );
      sendJson(res, { jobId: job.id });
      return;
    }

    const progressMatch = url.pathname.match(/^\/api\/books\/(.+)\/progress$/);
    if (method === "POST" && progressMatch) {
      const payload = await readJson(req);
      setProgress(decodeURIComponent(progressMatch[1]), Number(payload.offset ?? 0));
      sendJson(res, { ok: true });
      return;
    }

    if (method === "GET" && (url.pathname.startsWith("/static/") || url.pathname.startsWith("/generated/"))) {
      routeStatic(url, res);
      return;
    }

    sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
    sendJson(res, { error: error instanceof Error ? error.message : String(error) }, status);
  }
});

server.listen(port, host, () => {
  console.log(`Local TTS library running at http://${host}:${port}`);
  console.log(`Books folder: ${booksDir}`);
  console.log(`Voices folder: ${voicesDir}`);
});
