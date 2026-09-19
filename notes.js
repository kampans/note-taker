/* ==========================================================
   Notebook — logic
   Everything is stored in your browser's localStorage under
   the key below. No server, no account, no internet needed.
   ========================================================== */

const STORAGE_KEY = "notebook.notes.v1";
const DB_NAME = "notebook-db";
const DB_STORE = "handles";
const supportsFileBackup = "showSaveFilePicker" in window;

/* Colours handed out to classes in the order they first appear.
   Add more if you take more than eight subjects. */
const PALETTE = [
  "#2f4d6e", "#8c2f28", "#386641", "#6a4c93",
  "#a5622a", "#1d7874", "#7d5a3c", "#4a4e69"
];

/* ---------- State ------------------------------------------------------ */

let notes = load();        // every note, newest first
let activeClass = "All";   // which rail tab is selected
let query = "";            // what's typed in the search box
let editingId = null;      // id of the note open in the editor, or null

let fileHandle = null;       // the on-disk backup file, once connected
let needsReconnect = false;  // true when permission was lost and needs a click to restore
let fileWriteTimer = null;   // debounce timer for writes to that file

/* ---------- Grab the elements we need ---------------------------------- */

const els = {
  search:      document.getElementById("search"),
  newNoteBtn:  document.getElementById("newNoteBtn"),
  classList:   document.getElementById("classList"),
  noteList:    document.getElementById("noteList"),
  count:       document.getElementById("count"),
  empty:       document.getElementById("empty"),
  editor:      document.getElementById("editor"),
  fClass:      document.getElementById("fClass"),
  fDate:       document.getElementById("fDate"),
  fTitle:      document.getElementById("fTitle"),
  fBody:       document.getElementById("fBody"),
  classOptions:document.getElementById("classOptions"),
  saveBtn:     document.getElementById("saveBtn"),
  cancelBtn:   document.getElementById("cancelBtn"),
  deleteBtn:   document.getElementById("deleteBtn"),
  connectFileBtn:   document.getElementById("connectFileBtn"),
  autosaveStatus:   document.getElementById("autosaveStatus"),
  exportBtn:   document.getElementById("exportBtn"),
  importBtn:   document.getElementById("importBtn"),
  importInput: document.getElementById("importInput"),
  toast:       document.getElementById("toast")
};

/* ---------- Storage ---------------------------------------------------- */

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    // Corrupted or unavailable storage shouldn't take the whole page down.
    console.error("Could not read saved notes:", err);
    return [];
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  } catch (err) {
    console.error("Could not save:", err);
    toast("Saving failed. Your browser may be out of space.");
  }
  scheduleFileWrite();
}

/* ---------- Auto-save to a real file on disk ---------------------------
   This is a second, independent copy of your notes. localStorage above
   is still the copy the app actually reads from — this file is a mirror,
   kept in sync so a browser-storage problem alone can't cost you everything.
   Only Chrome and Edge support writing to disk this way. ------------------ */

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function setAutosaveStatus(message, isError) {
  els.autosaveStatus.textContent = message;
  els.autosaveStatus.classList.toggle("is-error", Boolean(isError));
}

/* Runs once on page load. Tries to pick up a file you connected in an
   earlier visit. Browsers may require you to re-approve access after
   a restart — that shows up here as "needs reconnect", never as a
   silent failure. */
async function restoreFileHandle() {
  if (!supportsFileBackup) {
    els.connectFileBtn.hidden = true;
    setAutosaveStatus("Live file backup needs Chrome or Edge — use Download backup instead.");
    return;
  }

  let handle;
  try {
    handle = await idbGet("backupHandle");
  } catch (err) {
    console.error(err);
  }

  if (!handle) {
    setAutosaveStatus("Not set up. Notes are only in this browser right now.");
    return;
  }

  const permission = await handle.queryPermission({ mode: "readwrite" });
  fileHandle = handle;

  if (permission === "granted") {
    setAutosaveStatus(`Auto-saving to ${handle.name}`);
    els.connectFileBtn.textContent = "Change backup file";
  } else {
    needsReconnect = true;
    els.connectFileBtn.textContent = "Reconnect backup file";
    setAutosaveStatus(`Paused — click "Reconnect backup file" to resume auto-save.`, true);
  }
}

async function chooseBackupFile() {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: "notebook-backup.json",
      types: [{ description: "JSON file", accept: { "application/json": [".json"] } }]
    });
    fileHandle = handle;
    needsReconnect = false;
    await idbSet("backupHandle", handle);
    await writeToFile();
    els.connectFileBtn.textContent = "Change backup file";
  } catch (err) {
    if (err.name !== "AbortError") {
      console.error(err);
      setAutosaveStatus("Couldn't set up the backup file.", true);
    }
  }
}

async function reconnectBackupFile() {
  try {
    const permission = await fileHandle.requestPermission({ mode: "readwrite" });
    if (permission === "granted") {
      needsReconnect = false;
      els.connectFileBtn.textContent = "Change backup file";
      await writeToFile();
    } else {
      setAutosaveStatus("Permission wasn't granted, so auto-save is still paused.", true);
    }
  } catch (err) {
    console.error(err);
    setAutosaveStatus("Couldn't reconnect. Try \"Change backup file\" instead.", true);
  }
}

function scheduleFileWrite() {
  if (!fileHandle || needsReconnect) return;
  clearTimeout(fileWriteTimer);
  fileWriteTimer = setTimeout(writeToFile, 400);
}

async function writeToFile() {
  if (!fileHandle || needsReconnect) return;
  try {
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(notes, null, 2));
    await writable.close();
    const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    setAutosaveStatus(`Saved to ${fileHandle.name} at ${stamp}`);
  } catch (err) {
    console.error("Auto-save to file failed:", err);
    setAutosaveStatus("Couldn't write to the backup file — check it still exists.", true);
  }
}

// If a tab is closed or switched away from mid-debounce, flush right away
// rather than losing whatever was waiting in the timer.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && fileHandle && !needsReconnect) {
    clearTimeout(fileWriteTimer);
    writeToFile();
  }
});

/* ---------- Small helpers ---------------------------------------------- */

function todayISO() {
  // Local date as YYYY-MM-DD, which is what <input type="date"> wants.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    day: "numeric", month: "short", year: "numeric"
  });
}

/* Every class keeps the same colour every time, based on where it sits
   in the alphabetically sorted list of classes. */
function colourFor(className) {
  const index = allClasses().indexOf(className);
  return PALETTE[(index < 0 ? 0 : index) % PALETTE.length];
}

function allClasses() {
  const names = [...new Set(notes.map(n => n.class))];
  return names.sort((a, b) => a.localeCompare(b));
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    els.toast.classList.remove("is-visible");
  }, 2200);
}

/* Turns user text into safe HTML text. Always do this before putting
   anything a person typed onto the page. */
function escapeHTML(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/* ---------- Filtering -------------------------------------------------- */

function visibleNotes() {
  const q = query.trim().toLowerCase();

  return notes
    .filter(n => activeClass === "All" || n.class === activeClass)
    .filter(n => {
      if (!q) return true;
      return (n.title + " " + n.body + " " + n.class).toLowerCase().includes(q);
    })
    .sort((a, b) => {
      // Newest class date first; ties broken by when it was last edited.
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return b.updated - a.updated;
    });
}

/* ---------- Rendering -------------------------------------------------- */

function renderClasses() {
  const classes = allClasses();
  const tabs = ["All", ...classes];

  els.classList.innerHTML = tabs.map(name => {
    const tally = name === "All"
      ? notes.length
      : notes.filter(n => n.class === name).length;

    const colour = name === "All" ? "var(--ink)" : colourFor(name);
    const current = name === activeClass;

    return `
      <li>
        <button type="button"
                class="class-tab"
                style="--tab-color:${colour}"
                aria-current="${current}"
                data-class="${escapeHTML(name)}">
          <span>${escapeHTML(name)}</span>
          <span class="tally">${tally}</span>
        </button>
      </li>`;
  }).join("");

  // Keep the datalist in the editor in sync so old class names autocomplete.
  els.classOptions.innerHTML = classes
    .map(c => `<option value="${escapeHTML(c)}">`)
    .join("");
}

function renderNotes() {
  const list = visibleNotes();

  els.empty.hidden = notes.length > 0;
  els.noteList.hidden = notes.length === 0;

  if (notes.length === 0) {
    els.count.textContent = "";
    els.noteList.innerHTML = "";
    return;
  }

  els.count.textContent =
    list.length === notes.length
      ? `${notes.length} note${notes.length === 1 ? "" : "s"}`
      : `${list.length} of ${notes.length} notes`;

  if (list.length === 0) {
    els.noteList.innerHTML =
      `<li class="note-preview">No notes match that search.</li>`;
    return;
  }

  els.noteList.innerHTML = list.map(n => {
    const heading = n.title || firstLine(n.body) || "Untitled note";
    return `
      <li>
        <button type="button"
                class="note"
                style="--note-color:${colourFor(n.class)}"
                data-id="${n.id}">
          <span class="note-meta">
            <span class="subject">${escapeHTML(n.class)}</span>
            <span>${formatDate(n.date)}</span>
          </span>
          <h2 class="note-title">${escapeHTML(heading)}</h2>
          <p class="note-preview">${escapeHTML(n.body)}</p>
        </button>
      </li>`;
  }).join("");
}

function firstLine(text) {
  return (text || "").split("\n")[0].slice(0, 80);
}

function render() {
  renderClasses();
  renderNotes();
}

/* ---------- The editor ------------------------------------------------- */

function openEditor(id) {
  editingId = id;

  if (id === null) {
    // New note. Prefill the class you're currently filtered to — small thing,
    // but it saves typing when you add three notes for one subject in a row.
    els.fClass.value = activeClass === "All" ? "" : activeClass;
    els.fDate.value = todayISO();
    els.fTitle.value = "";
    els.fBody.value = "";
    els.deleteBtn.hidden = true;
  } else {
    const note = notes.find(n => n.id === id);
    if (!note) return;
    els.fClass.value = note.class;
    els.fDate.value = note.date;
    els.fTitle.value = note.title;
    els.fBody.value = note.body;
    els.deleteBtn.hidden = false;
  }

  els.editor.showModal();
  // Focus the class box for a new note, the writing area for an existing one.
  (id === null ? els.fClass : els.fBody).focus();
}

function saveFromEditor() {
  const className = els.fClass.value.trim();
  const date = els.fDate.value;
  const body = els.fBody.value;

  if (!className) {
    toast("Give the note a class first.");
    els.fClass.focus();
    return;
  }
  if (!date) {
    toast("Pick a date.");
    els.fDate.focus();
    return;
  }

  if (editingId === null) {
    notes.unshift({
      id: crypto.randomUUID(),
      class: className,
      date: date,
      title: els.fTitle.value.trim(),
      body: body,
      created: Date.now(),
      updated: Date.now()
    });
  } else {
    const note = notes.find(n => n.id === editingId);
    Object.assign(note, {
      class: className,
      date: date,
      title: els.fTitle.value.trim(),
      body: body,
      updated: Date.now()
    });
  }

  save();
  render();
  els.editor.close();
  toast("Saved");
}

function deleteCurrent() {
  if (editingId === null) return;
  const note = notes.find(n => n.id === editingId);
  const label = note.title || note.class;

  if (!confirm(`Delete "${label}"? This can't be undone.`)) return;

  notes = notes.filter(n => n.id !== editingId);

  // If that was the last note in the class you're viewing, fall back to All.
  if (!notes.some(n => n.class === activeClass)) activeClass = "All";

  save();
  render();
  els.editor.close();
  toast("Deleted");
}

/* ---------- Backup ----------------------------------------------------- */

function exportNotes() {
  if (notes.length === 0) {
    toast("Nothing to back up yet.");
    return;
  }
  const blob = new Blob([JSON.stringify(notes, null, 2)],
                        { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `notebook-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importNotes(file) {
  const reader = new FileReader();

  reader.onload = () => {
    try {
      const incoming = JSON.parse(reader.result);
      if (!Array.isArray(incoming)) throw new Error("Not a notes file");

      // Merge rather than replace: anything with a new id gets added.
      const existingIds = new Set(notes.map(n => n.id));
      const added = incoming.filter(n => n && n.id && !existingIds.has(n.id));

      notes = [...added, ...notes];
      save();
      render();
      toast(`Restored ${added.length} note${added.length === 1 ? "" : "s"}`);
    } catch (err) {
      console.error(err);
      toast("That file isn't a Notebook backup.");
    }
  };

  reader.readAsText(file);
}

/* ---------- Wiring up the buttons -------------------------------------- */

els.newNoteBtn.addEventListener("click", () => openEditor(null));

// The empty-state button carries data-new-note instead of an id.
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-new-note]")) openEditor(null);
});

els.classList.addEventListener("click", (e) => {
  const tab = e.target.closest(".class-tab");
  if (!tab) return;
  activeClass = tab.dataset.class;
  render();
});

els.noteList.addEventListener("click", (e) => {
  const card = e.target.closest(".note");
  if (!card) return;
  openEditor(card.dataset.id);
});

els.search.addEventListener("input", (e) => {
  query = e.target.value;
  renderNotes();
});

els.saveBtn.addEventListener("click", saveFromEditor);
els.cancelBtn.addEventListener("click", () => els.editor.close());
els.deleteBtn.addEventListener("click", deleteCurrent);

els.connectFileBtn.addEventListener("click", () => {
  if (needsReconnect) reconnectBackupFile();
  else chooseBackupFile();
});

els.exportBtn.addEventListener("click", exportNotes);
els.importBtn.addEventListener("click", () => els.importInput.click());
els.importInput.addEventListener("change", (e) => {
  if (e.target.files[0]) importNotes(e.target.files[0]);
  e.target.value = "";   // lets you pick the same file twice
});

/* Keyboard shortcuts */
document.addEventListener("keydown", (e) => {
  // Ctrl/Cmd + Enter saves while you're writing.
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && els.editor.open) {
    e.preventDefault();
    saveFromEditor();
  }
  // "n" starts a new note when you're not already typing somewhere.
  const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName);
  if (e.key === "n" && !typing && !els.editor.open) {
    e.preventDefault();
    openEditor(null);
  }
});

/* ---------- Go -------------------------------------------------------- */

render();
restoreFileHandle();
