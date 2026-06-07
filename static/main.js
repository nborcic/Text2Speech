const state = {
  books: [],
  voices: [],
  selectedBook: null,
  chapters: [],
  offset: 0,
  currentText: "",
  previousOffsets: [],
};

const els = {
  bookList: document.querySelector("#bookList"),
  refreshBooks: document.querySelector("#refreshBooks"),
  bookTitle: document.querySelector("#bookTitle"),
  bookMeta: document.querySelector("#bookMeta"),
  voiceSelect: document.querySelector("#voiceSelect"),
  chapterSelect: document.querySelector("#chapterSelect"),
  cacheButton: document.querySelector("#cacheButton"),
  clearCacheButton: document.querySelector("#clearCacheButton"),
  editButton: document.querySelector("#editButton"),
  editorPanel: document.querySelector("#editorPanel"),
  editTextArea: document.querySelector("#editTextArea"),
  saveEditButton: document.querySelector("#saveEditButton"),
  cancelEditButton: document.querySelector("#cancelEditButton"),
  resetEditButton: document.querySelector("#resetEditButton"),
  speedRange: document.querySelector("#speedRange"),
  speedValue: document.querySelector("#speedValue"),
  listenButton: document.querySelector("#listenButton"),
  textView: document.querySelector("#textView"),
  notice: document.querySelector("#notice"),
  audioPlayer: document.querySelector("#audioPlayer"),
  previousChunk: document.querySelector("#previousChunk"),
  nextChunk: document.querySelector("#nextChunk"),
  status: document.querySelector("#status"),
};

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function loadBooks() {
  els.status.textContent = "Loading books...";
  const data = await api("/api/books");
  state.books = data.books;
  renderBooks();
  els.status.textContent = state.books.length ? "Idle" : "No books found";
}

async function loadVoices() {
  const data = await api("/api/voices");
  state.voices = data.voices;
  els.voiceSelect.innerHTML = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = data.defaultVoice;
  defaultOption.textContent = `${data.defaultVoice} (default)`;
  els.voiceSelect.append(defaultOption);

  for (const voice of state.voices) {
    const option = document.createElement("option");
    option.value = voice.name;
    option.textContent = voice.hasConfig ? voice.name : `${voice.name} (missing config)`;
    els.voiceSelect.append(option);
  }
}

function renderBooks() {
  els.bookList.innerHTML = "";
  for (const book of state.books) {
    const button = document.createElement("button");
    button.className = `book-item ${state.selectedBook?.id === book.id ? "active" : ""}`;
    button.innerHTML = `
      <span class="book-item-title"></span>
      <span class="book-item-meta">${book.extension.toUpperCase()} - ${formatBytes(book.size)} - ${book.cache?.fresh ? "cached" : "not cached"}</span>
    `;
    button.querySelector(".book-item-title").textContent = book.title;
    button.addEventListener("click", () => selectBook(book));
    els.bookList.append(button);
  }
}

async function selectBook(book, offset = book.progress || 0) {
  state.selectedBook = book;
  state.offset = offset;
  state.chapters = [];
  state.previousOffsets = [];
  closeEditor();
  renderBooks();
  renderChapters();
  updateCacheButtons(book.cache);
  await loadText(offset);
  if (book.cache?.fresh) {
    await loadChapters();
  }
}

async function loadText(offset) {
  if (!state.selectedBook) return;
  els.status.textContent = "Loading text...";
  els.listenButton.disabled = true;
  const data = await api(`/api/books/${encodeURIComponent(state.selectedBook.id)}/text?offset=${offset}`);

  if (!data.text && data.totalChars > 0 && offset > 0) {
    await api(`/api/books/${encodeURIComponent(state.selectedBook.id)}/progress`, {
      method: "POST",
      body: JSON.stringify({ offset: 0 }),
    });
    await loadText(0);
    return;
  }

  state.offset = data.offset;
  state.currentText = data.text || "";
  els.bookTitle.textContent = data.title;
  els.bookMeta.textContent = `${Math.min(data.nextOffset, data.totalChars).toLocaleString()} / ${data.totalChars.toLocaleString()} characters`;
  els.textView.textContent = data.text || "No readable text found for this section.";
  els.notice.textContent = data.warning || "";
  els.notice.classList.toggle("hidden", !data.warning);
  els.listenButton.disabled = !data.text;
  els.editButton.disabled = !data.text;
  els.previousChunk.disabled = state.previousOffsets.length === 0;
  els.nextChunk.disabled = data.nextOffset >= data.totalChars;
  els.nextChunk.dataset.nextOffset = String(data.nextOffset);
  els.status.textContent = "Idle";
}

function updateCacheButtons(cache) {
  const hasBook = Boolean(state.selectedBook);
  els.cacheButton.disabled = !hasBook;
  els.clearCacheButton.disabled = !hasBook || !cache?.exists;
  els.cacheButton.textContent = cache?.fresh ? "Rebuild Cache" : "Cache";
}

function renderChapters() {
  els.chapterSelect.innerHTML = '<option value="">Chapters</option>';
  for (const chapter of state.chapters) {
    const option = document.createElement("option");
    option.value = String(chapter.charStart);
    option.textContent = `${chapter.index + 1}. ${chapter.title}`;
    els.chapterSelect.append(option);
  }
  els.chapterSelect.disabled = state.chapters.length === 0;
}

async function loadChapters() {
  if (!state.selectedBook) return;
  const data = await api(`/api/books/${encodeURIComponent(state.selectedBook.id)}/chapters`);
  state.chapters = data.chapters || [];
  renderChapters();
}

async function cacheSelectedBook() {
  if (!state.selectedBook) return;
  els.cacheButton.disabled = true;
  els.status.textContent = "Caching book...";
  const data = await api(`/api/books/${encodeURIComponent(state.selectedBook.id)}/cache`, { method: "POST" });
  state.selectedBook.cache = data.cache;
  updateCacheButtons(data.cache);
  await loadChapters();
  await loadBooks();
  els.status.textContent = data.warning || `Cached ${data.totalChars.toLocaleString()} characters`;
}

async function clearSelectedCache() {
  if (!state.selectedBook) return;
  els.clearCacheButton.disabled = true;
  els.status.textContent = "Removing cache...";
  const data = await api(`/api/books/${encodeURIComponent(state.selectedBook.id)}/cache`, { method: "DELETE" });
  state.selectedBook.cache = data.cache;
  state.chapters = [];
  state.currentText = "";
  renderChapters();
  closeEditor();
  updateCacheButtons(data.cache);
  await loadBooks();
  els.status.textContent = "Cache removed";
}

function openEditor() {
  if (!state.currentText) return;
  els.editTextArea.value = state.currentText;
  els.editorPanel.classList.remove("hidden");
  els.textView.classList.add("hidden");
  els.status.textContent = "Editing cached text chunk";
}

function closeEditor() {
  els.editorPanel.classList.add("hidden");
  els.textView.classList.remove("hidden");
}

async function saveCurrentEdits() {
  if (!state.selectedBook) return;
  els.saveEditButton.disabled = true;
  els.status.textContent = "Saving edits...";
  await api(`/api/books/${encodeURIComponent(state.selectedBook.id)}/edits`, {
    method: "POST",
    body: JSON.stringify({
      offset: state.offset,
      oldText: state.currentText,
      newText: els.editTextArea.value,
    }),
  });
  closeEditor();
  await loadText(state.offset);
  els.saveEditButton.disabled = false;
  els.status.textContent = "Edits saved";
}

async function resetBookEdits() {
  if (!state.selectedBook) return;
  els.resetEditButton.disabled = true;
  els.status.textContent = "Resetting edits...";
  await api(`/api/books/${encodeURIComponent(state.selectedBook.id)}/edits`, { method: "DELETE" });
  closeEditor();
  await loadText(state.offset);
  els.resetEditButton.disabled = false;
  els.status.textContent = "Book edits reset";
}

async function listen() {
  if (!state.selectedBook) return;
  els.listenButton.disabled = true;
  els.status.textContent = "Starting Piper...";
  const data = await api(`/api/books/${encodeURIComponent(state.selectedBook.id)}/listen`, {
    method: "POST",
    body: JSON.stringify({ offset: state.offset, voice: els.voiceSelect.value }),
  });
  pollJob(data.jobId);
}

async function pollJob(jobId) {
  const job = await api(`/api/jobs/${jobId}`);
  els.status.textContent = job.message;

  if (job.status === "done") {
    els.audioPlayer.src = job.audio;
    els.audioPlayer.playbackRate = Number(els.speedRange.value || 1);
    els.audioPlayer.play().catch(() => {});
    els.listenButton.disabled = false;
    if (typeof job.nextOffset === "number") {
      els.nextChunk.dataset.nextOffset = String(job.nextOffset);
      els.nextChunk.disabled = false;
    }
    return;
  }

  if (job.status === "error") {
    els.status.textContent = job.message;
    els.listenButton.disabled = false;
    return;
  }

  setTimeout(() => pollJob(jobId), 1200);
}

els.refreshBooks.addEventListener("click", loadBooks);
els.listenButton.addEventListener("click", listen);
els.cacheButton.addEventListener("click", cacheSelectedBook);
els.clearCacheButton.addEventListener("click", clearSelectedCache);
els.editButton.addEventListener("click", openEditor);
els.cancelEditButton.addEventListener("click", closeEditor);
els.saveEditButton.addEventListener("click", saveCurrentEdits);
els.resetEditButton.addEventListener("click", resetBookEdits);
els.chapterSelect.addEventListener("change", async () => {
  if (!els.chapterSelect.value) return;
  state.previousOffsets.push(state.offset);
  await loadText(Number(els.chapterSelect.value));
});
els.speedRange.addEventListener("input", () => {
  const speed = Number(els.speedRange.value || 1);
  els.speedValue.textContent = `${speed.toFixed(2)}x`;
  els.audioPlayer.playbackRate = speed;
  if (els.audioPlayer.src) {
    els.status.textContent = `Playback speed ${speed.toFixed(2)}x`;
  }
});
els.nextChunk.addEventListener("click", async () => {
  state.previousOffsets.push(state.offset);
  await loadText(Number(els.nextChunk.dataset.nextOffset || 0));
});
els.previousChunk.addEventListener("click", async () => {
  const previous = state.previousOffsets.pop();
  if (typeof previous === "number") await loadText(previous);
});

await Promise.all([loadVoices(), loadBooks()]);
