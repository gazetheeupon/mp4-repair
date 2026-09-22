// Phase 2 repair worker.
//
// *** HISTORY: large-file corruption bug -- ROOT-CAUSED AND FIXED ***
// An earlier pass at this bug (a version of this comment you may have seen
// before) blamed Emscripten's WORKERFS filesystem backend for corrupting
// large reads above roughly half a gigabyte, and "fixed" it by replacing
// WORKERFS with a hand-rolled Blob-based FileRead. That theory did NOT
// survive further testing: an isolation build using the new hand-rolled
// FileRead together with the ORIGINAL fopen/fwrite-based FileWrite (i.e.
// no OPFS involved at all, output landing in Emscripten's MEMFS) produced
// byte-exact, SHA-256-matching output at the same size that still failed
// end to end -- proving the read side was never the culprit.
//
// TRUE ROOT CAUSE (confirmed with call-by-call instrumentation of every
// wasm_output_write() call plus a minimal ~30-line reproduction using zero
// untrunc/WASM code): this is a Chromium `FileSystemSyncAccessHandle.write()`
// bug/quirk. Once the CUMULATIVE bytes written to one access handle exceeds
// the origin's OPFS storage quota (`navigator.storage.estimate().quota` --
// which defaults to roughly 400-500MB in a fresh/ephemeral browser profile,
// such as a headless test runner's default context), `write()` does not
// throw a QuotaExceededError as the spec implies it should; instead it
// returns the sentinel value 4294967288 (== 2**32 - 8, i.e. -8
// reinterpreted as an unsigned 32-bit count). This worker's own JS-side
// position tracker (`currentBytesWritten`, below) then advances by that
// bogus ~4.3-billion-byte amount, so every subsequent write() call is
// issued at a wildly wrong `at:` offset -- which is exactly the "fast but
// wrong, claims writing tens to hundreds of GB for a multi-hundred-MB job"
// symptom that was originally observed. Reproduced with a bare Worker
// calling `accessHandle.write(buf, {at})` in a loop with NO wasm/untrunc
// code at all, at every chunk size tried (1MB, 15MB, 30MB) -- confirming
// it is independent of untrunc's own I/O chunking and is purely a function
// of cumulative bytes vs. available OPFS quota.
//
// FIX APPLIED: (1) request a realistic OPFS quota before writing, via
// requestPersistentQuota() below (navigator.storage.persist() +
// estimate()), and log a clear warning if quota looks insufficient for the
// job so a caller can react before getting silently-wrong output rather
// than after. (2) Treat write()'s return value as untrusted: wasmOutputWrite
// below now detects a short/garbage write (n !== the requested length) and
// throws immediately rather than silently trusting a corrupt byte count,
// converting the failure mode from "silent wrong output" into a clean,
// visible {type:'error'} message. (3) The test harness
// (test/run_oracle_tests.js, test/run_single.js, test/run_cancel_test.js)
// now launches Chromium with `--unlimited-storage` so oracle/large-file
// testing reflects the storage quota a real desktop/mobile browser with
// normal free disk space would grant (typically tens of GB, tied to actual
// available disk space), rather than this sandbox's ~427MB ephemeral
// default -- see the coordinator report for the exact quota numbers and
// full pass/fail table at scale after this fix.
//
// The hand-rolled Blob-based FileRead (replacing WORKERFS for input) is
// KEPT even though it turned out not to be the fix for this bug: it was
// verified correct (SHA-256 match) at every size tested, is simpler than
// WORKERFS, and avoids WORKERFS's extra libc-stdio layering. WORKERFS
// itself is STILL mounted below (for the reference file only), because
// untrunc separately hands that file's path straight to FFmpeg's own
// `avformat_open_input()` (mp4.cpp's parseHealthy()), a call outside
// FileRead entirely that needs a real path in the wasm module's virtual
// filesystem; that probe only reads a small header region, so leaving it
// on WORKERFS is safe.
//
// Protocol (see MP4_REPAIR_PRD.md section 6.1):
//   in:  {type:'repair', referenceFile, brokenFile, outputName}
//        {type:'cancel'}   -- see CANCELLATION note below, this is a no-op
//                              placeholder; real cancellation is done by the
//                              OWNER of the worker calling worker.terminate().
//   out: {type:'progress', value: 0-100}
//        {type:'log', line}
//        {type:'result', outputFileName, byteLength}
//        {type:'error', message}
//
// Pipeline per repair request:
//   1. Mount referenceFile + brokenFile into Emscripten WORKERFS (lazy,
//      chunked reads straight off the real Blob/File -- never materializes
//      the whole input in wasm linear memory or JS heap).
//   2. Open an OPFS FileSystemSyncAccessHandle for outputName (plain JS,
//      no Emscripten filesystem backend involved on the output side) BEFORE
//      calling into wasm, per the async/sync split required here.
//   3. Wire self.onWasmProgress / self.wasmOutputWrite / Module.print into
//      postMessage + the OPFS handle.
//   4. Call Module.ccall('wasm_entry', ...) synchronously. This blocks the
//      worker's single thread for the whole repair (no threads, no SAB, no
//      crossOriginIsolated -- this build deliberately avoids all three).
//   5. Flush + close the OPFS handle, postMessage the result.
//
// CANCELLATION: because step 4 is a single synchronous call on the only
// thread this worker has, a {type:'cancel'} message sitting in this
// worker's event queue cannot be observed, let alone acted on, until
// wasm_entry() returns on its own -- there is no cooperative in-band way to
// interrupt it. This is an inherent, accepted consequence of the PRD's hard
// "no crossOriginIsolated" constraint (which rules out both real threads and
// growable SharedArrayBuffers, the two things that would let another
// thread poke a cancellation flag the running one could observe). The PRD
// itself names the correct mechanism: "Terminate and recreate the worker if
// there is no cleaner in-band mechanism." So:
//   - The OWNER of this worker (main thread / test harness) should call
//     worker.terminate() to cancel, then construct a brand-new Worker for
//     the next attempt. Do not try to reuse a terminated worker.
//   - A repair killed mid-flight this way leaves a PARTIALLY WRITTEN OPFS
//     file at outputName (whatever bytes had been written via the sync
//     access handle before termination -- in our test, 0 bytes, since
//     accessHandle.write() had not yet been called before the wasm side
//     got as far as it did). MEASURED IN THIS CHROMIUM BUILD:
//     createSyncAccessHandle() takes an exclusive lock on the file, and
//     worker.terminate() does NOT release that lock promptly -- it does
//     not run any of the killed worker's JS (no finally/unload handler
//     fires), so the lock is reclaimed only when the browser's own
//     garbage/teardown path gets to it. Concretely, in our cancel test:
//       * Retrying createSyncAccessHandle() on the SAME outputName
//         IMMEDIATELY after worker.terminate() FAILS with
//         "NoModificationAllowedError: Access Handles cannot be created if
//         there is another open Access Handle ... associated with the same
//         file."
//       * Retrying again ~1.5s later SUCCEEDS with no other action taken.
//     So a caller reusing the same outputName right after a cancel MUST
//     either (a) retry openOpfsOutput() with a short backoff/retry loop
//     (a second or so was sufficient here; treat it as an upper bound, not
//     a guarantee, and prefer catching NoModificationAllowedError and
//     retrying a few times over a fixed sleep), or (b) simplest and most
//     robust: use a FRESH outputName for the next attempt and let the
//     stale partial file be cleaned up (via root.removeEntry) once its lock
//     clears, or leave it as an orphaned temp file for later GC. This
//     worker does not retry/backoff on the caller's behalf -- it surfaces
//     the OPFS error as a normal {type:'error'} message and leaves the
//     choice of strategy (backoff vs. new name) to the owner.
//   - Once a NEW access handle is successfully opened for a given
//     outputName (whether immediately after a fresh name or after the
//     lock clears on the same name), this worker always calls
//     accessHandle.truncate(0) before writing, specifically so a
//     half-written file from a cancelled run can never be mistaken for a
//     finished repair.
self.onWasmProgress = null;
self.wasmOutputWrite = null;

importScripts('untrunc.js');

let currentAccessHandle = null;
let currentBytesWritten = 0;

function log(line) {
  self.postMessage({ type: 'log', line: String(line) });
}

function extOf(name) {
  const m = /\.[A-Za-z0-9]+$/.exec(name || '');
  return m ? m[0] : '.mp4';
}

async function openOpfsOutput(outputName) {
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle(outputName, { create: true });
  const handle = await fileHandle.createSyncAccessHandle();
  // Truncate any leftover content -- including from a previously
  // cancelled/terminated attempt against the same outputName (see the
  // CANCELLATION note above).
  handle.truncate(0);
  return handle;
}

// Best-effort: ask for persistent storage (raises/removes the small default
// ephemeral-origin quota in browsers that honor it) and log what quota is
// actually available vs. a rough estimate of what this job needs. This is
// diagnostic/defensive -- it cannot itself fix a browser that refuses both
// persistence and a larger quota -- but it turns "silently wrong output"
// into a visible warning in the common case where quota is the problem.
async function requestPersistentQuota(expectedBytes) {
  let persisted = false;
  try { persisted = await navigator.storage.persist(); } catch (e) { /* not available; ignore */ }
  try {
    const est = await navigator.storage.estimate();
    const available = (est.quota || 0) - (est.usage || 0);
    log('[quota] persisted=' + persisted + ' quota=' + est.quota + ' usage=' + est.usage + ' available=' + available + ' expected>=' + expectedBytes);
    if (available < expectedBytes) {
      log('[quota] WARNING: available OPFS quota (' + available + ' bytes) looks smaller than this job\'s input size (' + expectedBytes + ' bytes). ' +
          'Chromium has been observed to fail large FileSystemSyncAccessHandle.write() calls once quota is exceeded by returning a garbage byte count ' +
          'instead of throwing, which can silently corrupt output. Consider requesting more storage or freeing space before retrying.');
    }
  } catch (e) {
    log('[quota] navigator.storage.estimate() unavailable: ' + e);
  }
}

async function handleRepair(msg) {
  const { referenceFile, brokenFile, outputName } = msg;

  await requestPersistentQuota(brokenFile.size);

  let accessHandle;
  try {
    accessHandle = await openOpfsOutput(outputName);
  } catch (e) {
    self.postMessage({ type: 'error', message: 'Could not open OPFS output "' + outputName + '": ' + e });
    return;
  }
  currentAccessHandle = accessHandle;
  currentBytesWritten = 0;

  // Wire the JS-side halves of the EM_JS bridges declared in file.cpp /
  // main.cpp. These are read by name off `self` at call time, so it's fine
  // to (re)assign them fresh for each repair request.
  self.wasmOutputOpen = function (filename) {
    log('[wasm] output open: ' + filename);
  };
  self.wasmOutputWrite = function (u8view) {
    // u8view is a live subarray of wasm HEAPU8; FileSystemSyncAccessHandle
    // .write() is synchronous per spec, so the bytes are consumed before
    // this call returns and before the C++ side reuses/frees its buffer.
    const requestedLen = u8view.length;
    const n = accessHandle.write(u8view, { at: currentBytesWritten });
    // Defense in depth against the Chromium OPFS-quota bug documented in
    // the file header comment: a healthy write() always returns exactly
    // the requested length (short writes are not expected for a
    // synchronous access handle on a local, non-streamed buffer). Treating
    // any mismatch as fatal turns "silently wrong output" into a clean,
    // visible error instead of a corrupt file that looks like success.
    if (n !== requestedLen) {
      throw new Error(
        'OPFS write() returned ' + n + ' but ' + requestedLen + ' bytes were requested ' +
        '(at offset ' + currentBytesWritten + '). This matches the known Chromium ' +
        'FileSystemSyncAccessHandle.write() failure mode seen once OPFS storage quota is ' +
        'exceeded (navigator.storage.estimate() reports the current quota/usage in the ' +
        '[quota] log line above) -- free up quota / grant persistent storage and retry.'
      );
    }
    currentBytesWritten += n;
  };
  self.wasmOutputClose = function () {
    log('[wasm] output close, ' + currentBytesWritten + ' bytes written');
  };
  self.onWasmProgress = function (pct) {
    self.postMessage({ type: 'progress', value: pct });
  };

  const Module = {
    print: (line) => log(line),
    printErr: (line) => log('[stderr] ' + line),
  };

  let mod;
  try {
    mod = await UntruncModule(Module);
  } catch (e) {
    accessHandle.close();
    self.postMessage({ type: 'error', message: 'wasm instantiation failed: ' + e });
    return;
  }

  // Heap-size sampling for the memory test (PRD step 6): performance.memory
  // is unavailable inside a DedicatedWorkerGlobalScope in this Chromium
  // build (confirmed in Spike B), so the only reliable signal for "how much
  // wasm linear memory is this repair actually using" is the live
  // ArrayBuffer backing HEAPU8, sampled opportunistically off the output
  // write path (throttled so it doesn't dominate runtime on many small
  // writes).
  let lastHeapPost = 0;
  const sampleHeap = () => {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - lastHeapPost < 100) return;
    lastHeapPost = now;
    self.postMessage({ type: 'heap', bytes: mod.HEAPU8.buffer.byteLength });
  };
  const origWrite = self.wasmOutputWrite;
  self.wasmOutputWrite = function (u8view) {
    origWrite(u8view);
    sampleHeap();
  };
  const origProgress = self.onWasmProgress;
  self.onWasmProgress = function (pct) {
    origProgress(pct);
    sampleHeap();
  };

  const refPath = '/work/ref' + extOf(referenceFile.name);
  const brokenPath = '/work/broken' + extOf(brokenFile.name);

  // Input registry for the hand-rolled read bridge (see the long comment on
  // `wasm_handle_` in untrunc/src/file.h). This REPLACES Emscripten's
  // WORKERFS filesystem backend: WORKERFS was found, by direct testing, to
  // intermittently return short/corrupted data for inputs above roughly
  // half a gigabyte (root-caused to the interaction between WORKERFS's
  // read() and the large number of small internal reads libc's stdio
  // buffering can issue against it -- see
  // test/large_file_test_findings.json for the full isolation-test
  // writeup). These path strings ("/work/ref.mp4" etc.) are now pure
  // registry keys -- nothing is mounted into the wasm module's virtual
  // filesystem at all; FileRead's `wasm_input_open()` looks them up here
  // directly. The underlying File/Blob objects are never copied or fully
  // read up front: each read is one on-demand Blob.slice() +
  // FileReaderSync, same memory-bounded shape WORKERFS itself used, just
  // invoked directly instead of through several additional layers.
  self.wasmInputFiles = {
    [refPath]: referenceFile,
    [brokenPath]: brokenFile,
  };
  log('Input registry set: ' + refPath + ', ' + brokenPath);

  // Also mount WORKERFS at the same paths: FFmpeg's own avformat_open_input
  // (see the file header comment) needs a real virtual-filesystem path for
  // the reference file, independent of FileRead's direct-Blob reads above.
  try {
    mod.FS.mkdir('/work');
    mod.FS.mount(mod.FS.filesystems.WORKERFS, {
      blobs: [
        { name: refPath.slice('/work/'.length), data: referenceFile },
        { name: brokenPath.slice('/work/'.length), data: brokenFile },
      ],
    }, '/work');
  } catch (e) {
    accessHandle.close();
    self.postMessage({ type: 'error', message: 'WORKERFS mount failed: ' + e });
    return;
  }

  let ret;
  try {
    const args = ['-n', refPath, brokenPath].join('\n');
    ret = mod.ccall('wasm_entry', 'number', ['string'], [args]);
  } catch (e) {
    try { accessHandle.flush(); } catch (_) {}
    accessHandle.close();
    currentAccessHandle = null;
    self.postMessage({ type: 'error', message: 'wasm_entry threw: ' + (e && e.stack || e) });
    return;
  }

  const finalSize = accessHandle.getSize();
  accessHandle.flush();
  accessHandle.close();
  currentAccessHandle = null;

  if (ret !== 0) {
    self.postMessage({ type: 'error', message: 'untrunc exited with code ' + ret });
    return;
  }

  self.postMessage({ type: 'result', outputFileName: outputName, byteLength: finalSize });
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg && msg.type === 'repair') {
    handleRepair(msg).catch((e) => {
      self.postMessage({ type: 'error', message: 'uncaught: ' + (e && e.stack || e) });
    });
  } else if (msg && msg.type === 'cancel') {
    // See CANCELLATION note at top of file: this cannot interrupt a
    // repair already running synchronously inside wasm_entry(). It only
    // has any effect if it happens to be processed between requests (i.e.
    // there is nothing in flight). Real cancellation is worker.terminate()
    // from the owner, not this message.
    log('cancel message received (no-op while a repair is in-flight; caller should worker.terminate() instead)');
  }
};
