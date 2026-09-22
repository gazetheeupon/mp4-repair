const $ = (id) => document.getElementById(id);

function setStatus(msg, isWarn) {
  const el = $('status');
  el.textContent = msg || '';
  el.classList.toggle('warn', !!isWarn);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function row(label, valueHtml) {
  return `<tr><td>${escapeHtml(label)}</td><td>${valueHtml}</td></tr>`;
}

function showError(msg) {
  $('errorCard').classList.remove('hidden');
  $('errorText').textContent = msg;
  $('resultsCard').classList.add('hidden');
}

function clearError() {
  $('errorCard').classList.add('hidden');
}

function fmtBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 2 : 0)} ${units[i]}`;
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return m > 0 ? `${m}m ${rs}s` : `${rs}s`;
}

// Verdict kind -> banner tone. "missing-index" is colored good because it is
// this tool's best-case finding: the problem is diagnosed and repairable.
const TONE = {
  intact: 'neutral',
  'missing-index': 'good',
  'media-data-truncated': 'bad',
  'no-media-data': 'bad',
  'not-iso-bmff': 'bad',
  'zero-byte': 'bad',
};

let brokenFile = null;
let referenceFile = null;
let lastVerdict = null;
let activeWorker = null;
let repairStartTime = 0;
let elapsedTimer = null;
let currentOutputName = null;

function renderVerdict(v, file) {
  $('resultsCard').classList.remove('hidden');
  const tone = TONE[v.kind] || 'neutral';
  $('summaryBanner').innerHTML = `<div class="banner ${tone}"><strong>${escapeHtml(v.summary)}</strong>${escapeHtml(v.message)}</div>`;

  let rows = '';
  rows += row('File', `${escapeHtml(file.name)} (${fmtBytes(file.size)})`);
  if (v.brand) {
    rows += row('Container brand', `${escapeHtml(v.brand.majorBrand ? v.brand.majorBrand.trim() : '?')} &mdash; ${escapeHtml(v.brand.label)}`);
  }
  if (v.faststart !== undefined && v.faststart !== null) {
    rows += row('Layout', v.faststart ? 'Faststart (index before media data)' : 'Standard (index after media data)');
  }
  if (v.fragmented) {
    rows += row('Fragmented MP4', 'Yes (contains "moof" boxes) &mdash; repair behavior for fragmented files is not yet verified.');
  }
  if (v.mdatTruncated !== undefined) {
    rows += row('Media data', v.mdatTruncated ? 'Shorter than the index/container says it should be' : 'Fully present, size checks out');
  }
  rows += row('Repairable by this tool', v.repairable ? 'Yes, with a matching reference file' : 'No');
  if (v.detail) {
    rows += row('Detail', `<code>${escapeHtml(v.detail)}</code>`);
  }
  $('detailTable').innerHTML = rows;

  if (v.repairable) {
    $('repairSection').classList.remove('hidden');
  } else {
    $('repairSection').classList.add('hidden');
  }
  resetRepairUi();
}

async function handleBrokenFile(file) {
  clearError();
  brokenFile = file;
  $('fname').textContent = file.name;
  setStatus('Reading container structure…');
  $('resultsCard').classList.add('hidden');
  try {
    const readChunk = BmffDiagnostic.readChunkForBlob(file);
    const verdict = await BmffDiagnostic.diagnose(readChunk, file.size);
    lastVerdict = verdict;
    setStatus(`Checked ${file.name} (${fmtBytes(file.size)}).`);
    renderVerdict(verdict, file);
  } catch (err) {
    setStatus('', false);
    showError((err && err.message) || String(err));
  }
}

function bindDrop(zoneId, inputId, onFile) {
  const dz = $(zoneId);
  const input = $(inputId);
  const setDrag = (on) => dz.classList.toggle('drag', on);
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); setDrag(true); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); setDrag(false); }));
  dz.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) onFile(file);
  });
  dz.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) onFile(input.files[0]);
  });
}

// ---- Repair flow -----------------------------------------------------

// `createSyncAccessHandle` is a Worker-only extension of the File System
// Access API by spec -- it does not exist on `FileSystemFileHandle` in the
// main-thread global at all, even in browsers that fully support it inside
// workers (confirmed directly: this returns false in the same Chromium
// build that Phase 2 proved OPFS sync access handles work in, inside a
// worker). So the only correct way to detect support is to actually try it
// in a worker, once, rather than probe the wrong object from the main
// thread and report a false negative.
function probeRepairSupport() {
  if (typeof Worker === 'undefined' || !('storage' in navigator) || typeof navigator.storage.getDirectory !== 'function') {
    return Promise.resolve(false);
  }
  const code = `(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle('__mp4repair_capability_probe__', { create: true });
      const handle = await fh.createSyncAccessHandle();
      handle.close();
      await root.removeEntry('__mp4repair_capability_probe__');
      self.postMessage(true);
    } catch (e) {
      self.postMessage(false);
    }
  })();`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const blob = new Blob([code], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      worker.onmessage = (ev) => { finish(!!ev.data); worker.terminate(); URL.revokeObjectURL(url); };
      worker.onerror = () => { finish(false); worker.terminate(); URL.revokeObjectURL(url); };
      setTimeout(() => finish(false), 3000);
    } catch (e) {
      finish(false);
    }
  });
}

const repairSupportPromise = probeRepairSupport();

async function resetRepairUi() {
  $('referenceFname').textContent = '';
  $('repairWarning').classList.add('hidden');
  $('repairProgressWrap').classList.add('hidden');
  $('repairResultCard').classList.add('hidden');
  $('repairErrorCard').classList.add('hidden');
  $('repairLog').textContent = '';
  $('repairBtn').disabled = true;
  $('repairBtn').textContent = 'Repair';
  $('cancelBtn').classList.add('hidden');
  referenceFile = null;
  currentOutputName = null;
  const supported = await repairSupportPromise;
  if (!supported) {
    $('repairUnsupported').classList.remove('hidden');
    $('repairControls').classList.add('hidden');
  } else {
    $('repairUnsupported').classList.add('hidden');
    $('repairControls').classList.remove('hidden');
  }
}

async function handleReferenceFile(file) {
  $('referenceFname').textContent = file.name;
  $('repairWarning').classList.add('hidden');
  $('repairErrorCard').classList.add('hidden');

  try {
    const readChunk = BmffDiagnostic.readChunkForBlob(file);
    const refVerdict = await BmffDiagnostic.diagnose(readChunk, file.size);
    if (refVerdict.kind !== 'intact') {
      referenceFile = null;
      $('repairBtn').disabled = true;
      showRepairError(
        `This reference file looks broken too (${refVerdict.summary}). Pick a working video from the same device instead ` +
        `— see "I don't have a working video" below if you're not sure where to get one.`
      );
      return;
    }
    if (lastVerdict && lastVerdict.brand && refVerdict.brand && lastVerdict.brand.majorBrand !== refVerdict.brand.majorBrand) {
      $('repairWarning').textContent =
        `Heads up: the reference file's container brand (${refVerdict.brand.majorBrand ? refVerdict.brand.majorBrand.trim() : '?'}) ` +
        `doesn't match the broken file's (${lastVerdict.brand.majorBrand ? lastVerdict.brand.majorBrand.trim() : '?'}). ` +
        `This tool will still try, but the odds of a clean repair are lower when the reference isn't from the same device/settings.`;
      $('repairWarning').classList.remove('hidden');
    }
    referenceFile = file;
    $('repairBtn').disabled = false;
  } catch (err) {
    referenceFile = null;
    $('repairBtn').disabled = true;
    showRepairError((err && err.message) || String(err));
  }
}

function showRepairError(msg) {
  $('repairErrorCard').classList.remove('hidden');
  $('repairErrorText').textContent = msg;
}

function appendLog(line) {
  const el = $('repairLog');
  el.textContent += (el.textContent ? '\n' : '') + line;
  el.scrollTop = el.scrollHeight;
}

function makeOutputName(name) {
  const base = (name || 'video').replace(/[^a-zA-Z0-9_.-]+/g, '_');
  return `repaired-${Date.now()}-${base}`;
}

function startElapsedTimer() {
  repairStartTime = performance.now();
  $('repairElapsed').textContent = '0s';
  elapsedTimer = setInterval(() => {
    $('repairElapsed').textContent = fmtElapsed(performance.now() - repairStartTime);
  }, 500);
}

function stopElapsedTimer() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function startRepair() {
  if (!brokenFile || !referenceFile) return;
  $('repairErrorCard').classList.add('hidden');
  $('repairResultCard').classList.add('hidden');
  $('repairLog').textContent = '';
  $('repairProgressWrap').classList.remove('hidden');
  $('repairProgressBar').style.width = '0%';
  $('repairPhase').textContent = 'Starting…';
  $('repairBtn').disabled = true;
  $('cancelBtn').classList.remove('hidden');
  startElapsedTimer();

  currentOutputName = makeOutputName(brokenFile.name);
  const worker = new Worker('worker.js');
  activeWorker = worker;

  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === 'progress') {
      $('repairProgressBar').style.width = Math.max(2, Math.min(100, msg.value)) + '%';
      $('repairPhase').textContent = `Working… ${msg.value.toFixed(0)}% (current phase)`;
    } else if (msg.type === 'log') {
      appendLog(msg.line);
    } else if (msg.type === 'heap') {
      // Informational only; not surfaced in the UI.
    } else if (msg.type === 'result') {
      finishRepair(true, msg);
    } else if (msg.type === 'error') {
      finishRepair(false, msg);
    }
  };
  worker.onerror = (ev) => {
    finishRepair(false, { message: ev.message || 'worker crashed' });
  };

  worker.postMessage({
    type: 'repair',
    referenceFile,
    brokenFile,
    outputName: currentOutputName,
  });
}

function finishRepair(ok, msg) {
  stopElapsedTimer();
  $('cancelBtn').classList.add('hidden');
  $('repairBtn').disabled = false;
  activeWorker = null;

  if (ok) {
    $('repairProgressBar').style.width = '100%';
    $('repairPhase').textContent = 'Done.';
    $('repairResultCard').classList.remove('hidden');
    $('repairResultText').textContent = `Repaired file ready: ${fmtBytes(msg.byteLength)}.`;
    $('saveBtn').onclick = () => saveRepairedFile(msg.outputFileName, brokenFile.name);
  } else {
    $('repairPhase').textContent = 'Failed.';
    showRepairError(msg.message || 'Unknown error during repair.');
  }
}

function cancelRepair() {
  if (!activeWorker) return;
  // See worker.js's CANCELLATION note: a synchronous in-progress wasm call
  // cannot be interrupted cooperatively without threads, which this project
  // deliberately avoids (it would require crossOriginIsolated, breaking the
  // ad slot). Terminating and discarding the worker is the correct, PRD-
  // sanctioned mechanism.
  activeWorker.terminate();
  activeWorker = null;
  stopElapsedTimer();
  $('cancelBtn').classList.add('hidden');
  $('repairBtn').disabled = false;
  $('repairPhase').textContent = 'Cancelled.';
  appendLog('[cancelled by user]');
}

async function saveRepairedFile(outputFileName, originalName) {
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle(outputFileName);
  const file = await fileHandle.getFile();
  const suggestedName = originalName.replace(/(\.[^.]+)?$/, (ext) => `_fixed${ext || '.mp4'}`);

  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName });
      const writable = await handle.createWritable();
      await file.stream().pipeTo(writable);
      await cleanupOutput(root, outputFileName);
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user cancelled the save dialog
      appendLog('showSaveFilePicker failed, falling back to a direct download: ' + err);
    }
  }

  // Fallback for browsers without the File System Access API save dialog
  // (Firefox, Safari): a normal Blob-URL download, per PRD section 6.5.
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  await cleanupOutput(root, outputFileName);
}

async function cleanupOutput(root, outputFileName) {
  try {
    await root.removeEntry(outputFileName);
  } catch (e) {
    // best-effort; an orphaned OPFS temp file isn't visible to the user and
    // will eventually be reclaimed as normal browser site-data.
  }
}

bindDrop('dropzone', 'fileInput', handleBrokenFile);
bindDrop('referenceDropzone', 'referenceInput', handleReferenceFile);
$('repairBtn').addEventListener('click', startRepair);
$('cancelBtn').addEventListener('click', cancelRepair);
resetRepairUi();
