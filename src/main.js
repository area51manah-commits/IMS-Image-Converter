import './style.css';

import {
  DEFAULT_OUTPUT_FORMAT,
  MAX_FILE_BYTES,
  MAX_FILE_LABEL,
  OUTPUT_FORMATS,
  displayFormat,
  formatBytes,
  getExtension,
  getOutputFormat,
  isHeicFile,
  isSupportedImage,
  outputFileName,
} from './lib/formats.js';

/* -------------------------------------------------------------------------- */
/*  Elements                                                                  */
/* -------------------------------------------------------------------------- */

const els = {
  form: document.getElementById('convertForm'),
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('fileInput'),
  fileCard: document.getElementById('fileCard'),
  filePreview: document.getElementById('filePreview'),
  fileBadge: document.getElementById('fileBadge'),
  fileName: document.getElementById('fileName'),
  fileMeta: document.getElementById('fileMeta'),
  removeFile: document.getElementById('removeFile'),
  format: document.getElementById('formatSelect'),
  convertBtn: document.getElementById('convertBtn'),
  btnLabel: document.getElementById('btnLabel'),
  btnIcon: document.getElementById('btnIcon'),
  spinner: document.getElementById('spinner'),
  status: document.getElementById('status'),
  error: document.getElementById('error'),
  engineChip: document.getElementById('engineChip'),
  engineText: document.getElementById('engineText'),
  result: document.getElementById('result'),
  resultName: document.getElementById('resultName'),
  resultImage: document.getElementById('resultImage'),
  statOriginal: document.getElementById('statOriginal'),
  statConverted: document.getElementById('statConverted'),
  statChange: document.getElementById('statChange'),
  statChangeLabel: document.getElementById('statChangeLabel'),
  resultDetail: document.getElementById('resultDetail'),
  downloadAgain: document.getElementById('downloadAgain'),
  convertAnother: document.getElementById('convertAnother'),
  autoNote: document.getElementById('autoNote'),
  year: document.getElementById('year'),
};

/* -------------------------------------------------------------------------- */
/*  State                                                                     */
/* -------------------------------------------------------------------------- */

const state = {
  worker: null,
  engineStatus: 'loading',
  busy: false,
  file: null,
  inputUrl: null,
  resultUrl: null,
  requestCounter: 0,
  statusText: '',
};

/** id -> { resolve, reject, timer } */
const pending = new Map();

const CONVERT_TIMEOUT_MS = 5 * 60 * 1000;

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* -------------------------------------------------------------------------- */
/*  Worker lifecycle                                                          */
/* -------------------------------------------------------------------------- */

function spawnWorker() {
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }

  setEngineState('loading');

  let worker;
  try {
    worker = new Worker(new URL('./converter.worker.js', import.meta.url), { type: 'module' });
  } catch (error) {
    setEngineState('error', {
      message: `Web Workers are unavailable: ${error?.message || 'unknown error'}`,
    });
    showError(
      'This browser could not start the compression worker. Try a current version of Chrome, Edge, Firefox or Safari.',
    );
    return;
  }

  worker.addEventListener('message', onWorkerMessage);
  worker.addEventListener('error', onWorkerCrash);
  worker.addEventListener('messageerror', onWorkerCrash);

  state.worker = worker;
}

function queueWarmup({ immediate = false } = {}) {
  const warm = () => {
    state.worker?.postMessage({ type: 'warmup' });
  };

  if (immediate) {
    setTimeout(warm, 0);
    return;
  }

  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(warm, { timeout: 1600 });
  } else {
    setTimeout(warm, 500);
  }
}

function restartWorker({ immediate = true } = {}) {
  failAllPending('The compression engine was restarted. Please try again.');
  spawnWorker();
  queueWarmup({ immediate });
}

function failAllPending(message) {
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.reject(new Error(message));
  }
  pending.clear();
}

function onWorkerCrash(event) {
  const message =
    event?.message || 'The compression engine stopped unexpectedly. Reload it and try again.';

  setEngineState('error', { message });
  failAllPending(message);

  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
}

function onWorkerMessage(event) {
  const message = event.data || {};

  switch (message.type) {
    case 'engine-progress': {
      if (state.engineStatus !== 'loading') break;
      setEngineState('loading', message);

      if (state.busy) {
        const total = Number(message.total) || 0;
        const loaded = Number(message.loaded) || 0;
        const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : null;
        setStatus(
          percent === null
            ? `Loading the engine (${formatBytes(loaded)}) — your image is queued…`
            : `Loading the engine (${percent}%) — your image is queued…`,
        );
      }
      break;
    }

    case 'engine-compiling': {
      setEngineState('loading', { compiling: true });
      if (state.busy) {
        setStatus('Compiling the compression engine — your image is queued…');
      }
      break;
    }

    case 'ready': {
      setEngineState('ready');
      if (state.busy && !(state.statusText || '').startsWith('Decoding')) {
        setStatus('Engine ready — starting conversion…');
      }
      break;
    }

    case 'engine-error': {
      setEngineState('error', { message: message.message });
      if (!state.busy) {
        showError(`${message.message} Use the engine status in the header to retry.`);
      }
      break;
    }

    case 'phase': {
      if (pending.has(message.id)) {
        setStatus(message.text);
      }
      break;
    }

    case 'done': {
      const job = pending.get(message.id);
      if (!job) break;
      pending.delete(message.id);
      clearTimeout(job.timer);
      job.resolve(message);
      break;
    }

    case 'error': {
      const job = pending.get(message.id);
      if (!job) break;
      pending.delete(message.id);
      clearTimeout(job.timer);
      job.reject(new Error(message.message));
      break;
    }

    default:
      break;
  }
}

function setEngineState(status, info = {}) {
  state.engineStatus = status;
  els.engineChip.dataset.state = status;

  if (status === 'loading') {
    const total = Number(info.total) || 0;
    const loaded = Number(info.loaded) || 0;

    if (info.compiling) {
      els.engineChip.style.setProperty('--progress', '100');
      els.engineText.textContent = 'Compiling engine…';
      els.engineChip.title =
        'The WebAssembly binary is downloaded. Your browser is compiling it once — the result is cached.';
    } else if (total > 0) {
      const percent = Math.min(100, Math.round((loaded / total) * 100));
      els.engineChip.style.setProperty('--progress', String(percent));
      els.engineText.textContent = `Loading engine ${percent}%`;
      els.engineChip.title = `${formatBytes(loaded)} of ${formatBytes(total)} downloaded. The engine is cached after the first load.`;
    } else if (loaded > 0) {
      els.engineText.textContent = `Loading engine · ${formatBytes(loaded)}`;
      els.engineChip.title = 'Downloading the ImageMagick WebAssembly engine.';
    } else {
      els.engineText.textContent = 'Starting engine…';
      els.engineChip.title = 'Preparing the ImageMagick WebAssembly engine.';
    }

    els.engineChip.tabIndex = -1;
    els.engineChip.setAttribute('aria-disabled', 'true');
    return;
  }

  if (status === 'ready') {
    els.engineChip.style.setProperty('--progress', '100');
    els.engineText.textContent = 'Engine ready';
    els.engineChip.title =
      'ImageMagick WebAssembly is loaded. The browser keeps it cached for instant reuse.';
    els.engineChip.tabIndex = -1;
    els.engineChip.setAttribute('aria-disabled', 'true');
    return;
  }

  els.engineText.textContent = 'Engine unavailable · Retry';
  els.engineChip.title = info.message
    ? `${info.message} Activate to reload the engine.`
    : 'The engine failed to load. Activate to retry.';
  els.engineChip.tabIndex = 0;
  els.engineChip.setAttribute('aria-disabled', 'false');
}

/* -------------------------------------------------------------------------- */
/*  Conversion                                                                */
/* -------------------------------------------------------------------------- */

function convertInWorker(file, target) {
  if (!state.worker) {
    return Promise.reject(
      new Error('The compression engine is not running. Reload it and try again.'),
    );
  }

  const id = `job-${++state.requestCounter}`;

  return new Promise((resolve, reject) => {
    file
      .arrayBuffer()
      .then((buffer) => {
        if (!state.worker) {
          reject(new Error('The compression engine stopped before the job could start.'));
          return;
        }

        const timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(
            new Error(
              'The conversion timed out after 5 minutes. The engine has been restarted — try a smaller image.',
            ),
          );
          restartWorker();
        }, CONVERT_TIMEOUT_MS);

        pending.set(id, { resolve, reject, timer });

        state.worker.postMessage(
          {
            type: 'convert',
            id,
            buffer,
            target,
          },
          [buffer],
        );
      })
      .catch((error) => {
        reject(new Error(`The file could not be read: ${error?.message || 'unknown error'}`));
      });
  });
}

async function runConversion() {
  const file = state.file;
  if (!file || state.busy) return;

  const target = els.format.value;

  state.busy = true;
  clearError();
  setBusy(true);
  setStatus('Preparing your image…');

  let succeeded = false;

  try {
    const result = await convertInWorker(file, target);
    const blob = new Blob([result.buffer], { type: result.mimeType });

    showResult({
      blob,
      target,
      width: result.width,
      height: result.height,
      sourceFormat: result.sourceFormat,
      elapsedMs: result.elapsedMs,
      fileName: outputFileName(file.name, result.extension),
      originalBytes: file.size,
    });

    succeeded = true;
  } catch (error) {
    setStatus('');
    showError(humanizeError(error));
    if (isUnreadableFileError(error)) {
      // The browser revoked access to the picked file (common on Android
      // after the input value is reset). Drop the stale reference and let
      // the user pick it again.
      clearSelectedFile();
    }
  } finally {
    state.busy = false;
    if (!succeeded) {
      setBusy(false);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Result UI                                                                 */
/* -------------------------------------------------------------------------- */

function showResult({ blob, target, width, height, sourceFormat, elapsedMs, fileName, originalBytes }) {
  if (state.resultUrl) {
    URL.revokeObjectURL(state.resultUrl);
  }
  state.resultUrl = URL.createObjectURL(blob);

  const format = getOutputFormat(target);
  const sourceLabel = displayFormat(sourceFormat);
  const savedBytes = originalBytes - blob.size;
  const changePercent = originalBytes > 0 ? (Math.abs(savedBytes) / originalBytes) * 100 : 0;
  const percentText =
    changePercent >= 9.95
      ? `${Math.round(changePercent)}%`
      : `${Math.round(changePercent * 10) / 10}%`;

  els.resultName.textContent = fileName;
  els.resultImage.src = state.resultUrl;
  els.resultImage.alt = `Preview of ${fileName}`;

  els.statOriginal.textContent = formatBytes(originalBytes);
  els.statConverted.textContent = formatBytes(blob.size);

  if (savedBytes > 0) {
    els.statChangeLabel.textContent = 'Saved';
    els.statChange.textContent = `${percentText} smaller`;
    els.statChange.classList.remove('is-bigger');
  } else if (savedBytes < 0) {
    els.statChangeLabel.textContent = 'Change';
    els.statChange.textContent = `${percentText} larger`;
    els.statChange.classList.add('is-bigger');
  } else {
    els.statChangeLabel.textContent = 'Change';
    els.statChange.textContent = 'Same size';
    els.statChange.classList.remove('is-bigger');
  }

  const profile =
    target === 'webp'
      ? sourceFormat === 'PNG'
        ? 'lossless · method 6'
        : 'quality 80 · method 6'
      : target === 'jpg'
        ? 'progressive · optimised'
        : 'lossless · level 9';

  const seconds = Math.max(elapsedMs, 0) / 1000;
  const timeText = seconds >= 10 ? `${Math.round(seconds)} s` : `${seconds.toFixed(1)} s`;

  els.resultDetail.textContent = `${width} × ${height} px · ${sourceLabel} → ${format.shortLabel} (${profile}) · ${timeText}`;

  els.downloadAgain.href = state.resultUrl;
  els.downloadAgain.download = fileName;
  els.autoNote.textContent =
    'Your download started automatically. If it was blocked, use “Download again”.';

  setStatus('');
  clearError();
  els.form.hidden = true;
  els.result.hidden = false;
  els.result.focus({ preventScroll: true });
  els.result.scrollIntoView({
    behavior: prefersReducedMotion ? 'auto' : 'smooth',
    block: 'nearest',
  });

  triggerDownload(state.resultUrl, fileName);
}

function triggerDownload(href, fileName) {
  const link = document.createElement('a');
  link.href = href;
  link.download = fileName;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function resetToForm() {
  if (state.resultUrl) {
    URL.revokeObjectURL(state.resultUrl);
    state.resultUrl = null;
  }

  els.resultImage.removeAttribute('src');
  els.result.hidden = true;
  els.form.hidden = false;
  els.resultName.textContent = '';
  els.statChange.classList.remove('is-bigger');

  state.busy = false;
  clearSelectedFile();
  setBusy(false);
  clearError();
  setStatus('');

  els.dropzone.focus({ preventScroll: true });
  els.dropzone.scrollIntoView({
    behavior: prefersReducedMotion ? 'auto' : 'smooth',
    block: 'center',
  });
}

/* -------------------------------------------------------------------------- */
/*  File selection                                                            */
/* -------------------------------------------------------------------------- */

function chooseFile(file) {
  if (state.busy) return;
  clearError();

  if (!file) return;

  if (!isSupportedImage(file)) {
    // Clear only rejected picks so the same file can be selected again.
    els.fileInput.value = '';
    showError(
      'That file type is not supported. Choose a JPG, PNG, HEIC, HEIF, WebP or AVIF image.',
    );
    return;
  }

  if (file.size === 0) {
    els.fileInput.value = '';
    showError('That file is empty. Choose a different image.');
    return;
  }

  if (file.size > MAX_FILE_BYTES) {
    els.fileInput.value = '';
    showError(
      `That file is ${formatBytes(file.size)} — larger than the ${MAX_FILE_LABEL} limit. Please choose a smaller image.`,
    );
    return;
  }

  selectFile(file);
}

function selectFile(file) {
  if (state.inputUrl) {
    URL.revokeObjectURL(state.inputUrl);
    state.inputUrl = null;
  }

  state.file = file;
  state.inputUrl = URL.createObjectURL(file);

  const heic = isHeicFile(file);

  els.fileBadge.classList.remove('is-fill');
  els.filePreview.onerror = null;

  if (heic) {
    els.filePreview.hidden = true;
    els.filePreview.removeAttribute('src');
    els.filePreview.alt = '';
    els.fileBadge.hidden = false;
    els.fileBadge.classList.add('is-fill');
    els.fileBadge.textContent = 'HEIC';
  } else {
    els.filePreview.hidden = false;
    els.filePreview.src = state.inputUrl;
    els.filePreview.alt = `Preview of ${file.name}`;
    els.fileBadge.hidden = true;

    els.filePreview.onerror = () => {
      els.filePreview.hidden = true;
      els.fileBadge.hidden = false;
      els.fileBadge.classList.add('is-fill');
      els.fileBadge.textContent = fileTypeLabel(file);
    };
  }

  els.fileName.textContent = file.name;
  els.fileMeta.textContent = `${fileTypeLabel(file)} · ${formatBytes(file.size)}`;

  els.fileCard.hidden = false;
  els.dropzone.hidden = true;
  els.convertBtn.disabled = false;

  // Do NOT clear the file input here. On Android Chrome the File object can
  // be backed by a content:// URI whose read permission is tied to the input
  // value; clearing it causes `file.arrayBuffer()` to fail with
  // NotReadableError when Convert is pressed.
  setStatus('');
}

function clearSelectedFile() {
  if (state.inputUrl) {
    URL.revokeObjectURL(state.inputUrl);
    state.inputUrl = null;
  }

  state.file = null;

  els.filePreview.removeAttribute('src');
  els.filePreview.onerror = null;
  els.filePreview.hidden = false;
  els.fileBadge.hidden = true;
  els.fileBadge.textContent = '';
  els.fileName.textContent = '';
  els.fileMeta.textContent = '';
  els.fileCard.hidden = true;
  els.dropzone.hidden = false;
  els.fileInput.value = '';
  els.convertBtn.disabled = true;
}

function fileTypeLabel(file) {
  const extension = getExtension(file.name);
  if (!extension) {
    const mime = String(file.type || '');
    return mime.startsWith('image/') ? displayFormat(mime.slice(6)) : 'Image';
  }
  if (extension === 'jpeg' || extension === 'jpg') return 'JPG';
  if (extension === 'heif') return 'HEIC';
  return extension.toUpperCase();
}

/* -------------------------------------------------------------------------- */
/*  Busy / messages                                                           */
/* -------------------------------------------------------------------------- */

function setBusy(busy) {
  els.form.setAttribute('aria-busy', String(busy));
  els.convertBtn.classList.toggle('is-loading', busy);
  els.convertBtn.disabled = busy || !state.file;
  els.spinner.hidden = !busy;
  els.btnIcon.hidden = busy;
  els.btnLabel.textContent = busy
    ? 'Compressing locally... this takes CPU power'
    : 'Convert image';
  els.format.disabled = busy;
  els.removeFile.disabled = busy;
}

function setStatus(text) {
  state.statusText = text;
  els.status.textContent = text;
}

function clearError() {
  els.error.hidden = true;
  els.error.textContent = '';
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

function humanizeError(error) {
  let message = String(error?.message || 'The conversion failed.').replace(/\s+/g, ' ').trim();

  if (isUnreadableFileError(message)) {
    return 'Your browser lost access to the selected image. Please choose the file again.';
  }

  if (/out of memory|cannot allocate|failed to allocate|memory access out of bounds|grow/i.test(message)) {
    return 'This image needs more memory than the browser could provide. Try a smaller image or close other tabs.';
  }

  if (/timed out/i.test(message)) {
    return message;
  }

  if (
    /no decode delegate|unable to read|improper image header|not a supported|corrupt|unsupported image/i.test(
      message,
    )
  ) {
    return 'The image could not be decoded. It may be corrupt or use a variant that this engine cannot read.';
  }

  if (message.length > 260) {
    message = `${message.slice(0, 257)}…`;
  }

  return message || 'The conversion failed.';
}

function isUnreadableFileError(value) {
  return /requested file could not be read|notreadableerror|permission problems|reference to a file was acquired/i.test(
    String(value || ''),
  );
}

/* -------------------------------------------------------------------------- */
/*  Events                                                                    */
/* -------------------------------------------------------------------------- */

function initFormats() {
  els.format.replaceChildren();

  for (const format of OUTPUT_FORMATS) {
    const option = document.createElement('option');
    option.value = format.id;
    option.textContent = format.label;
    els.format.append(option);
  }

  els.format.value = DEFAULT_OUTPUT_FORMAT;
}

function bindEvents() {
  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    runConversion();
  });

  els.dropzone.addEventListener('click', () => {
    if (!state.busy) els.fileInput.click();
  });

  els.dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!state.busy) els.fileInput.click();
    }
  });

  els.fileInput.addEventListener('change', () => {
    chooseFile(els.fileInput.files?.[0]);
  });

  els.removeFile.addEventListener('click', () => {
    if (state.busy) return;
    clearSelectedFile();
    clearError();
    setStatus('');
    els.dropzone.focus({ preventScroll: true });
  });

  els.convertAnother.addEventListener('click', resetToForm);

  els.engineChip.addEventListener('click', () => {
    if (state.engineStatus !== 'error') return;
    clearError();
    setStatus('Reloading the compression engine…');
    restartWorker();
  });

  // Drag & drop: a depth counter avoids flicker when children are crossed.
  let dragDepth = 0;

  for (const type of ['dragenter', 'dragover']) {
    els.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.busy) return;
      if (type === 'dragenter') dragDepth += 1;
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      els.dropzone.classList.add('is-dragging');
    });
  }

  els.dropzone.addEventListener('dragleave', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      els.dropzone.classList.remove('is-dragging');
    }
  });

  els.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    els.dropzone.classList.remove('is-dragging');
    if (state.busy) return;
    chooseFile(event.dataTransfer?.files?.[0]);
  });

  // Dropping an image outside the dropzone must never navigate away.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
}

/* -------------------------------------------------------------------------- */
/*  Boot                                                                      */
/* -------------------------------------------------------------------------- */

function init() {
  initFormats();
  bindEvents();

  els.year.textContent = String(new Date().getFullYear());

  spawnWorker();
  queueWarmup();

  setBusy(false);
}

init();
