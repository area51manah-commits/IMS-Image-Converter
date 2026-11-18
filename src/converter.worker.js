/**
 * Compression worker.
 *
 * The entire ImageMagick Wasm engine lives here so multi-second, maximum-effort
 * encodes never block the UI thread. The Wasm binary is fetched once, with
 * progress, and stays warm for subsequent conversions.
 */

import { initializeImageMagick } from '@imagemagick/magick-wasm';
import wasmUrl from '@imagemagick/magick-wasm/magick.wasm?url';

import { convertImage } from './lib/convert.js';

const ENGINE_URL = new URL(wasmUrl, self.location.href).href;

let enginePromise = null;
let engineBroken = false;

function send(message, transfer) {
  if (transfer) {
    self.postMessage(message, transfer);
  } else {
    self.postMessage(message);
  }
}

async function fetchWasm() {
  send({ type: 'engine-progress', loaded: 0, total: 0 });

  let response;
  try {
    response = await fetch(ENGINE_URL);
  } catch {
    throw new Error('Could not download the compression engine. Check your connection and try again.');
  }

  if (!response.ok) {
    throw new Error(`Could not download the compression engine (HTTP ${response.status}).`);
  }

  const total = Number(response.headers.get('content-length')) || 0;

  // Stream so the header can show real progress on the initial 15 MB download.
  if (!response.body || typeof response.body.getReader !== 'function') {
    const bytes = new Uint8Array(await response.arrayBuffer());
    send({ type: 'engine-progress', loaded: bytes.byteLength, total: bytes.byteLength });
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  let lastReport = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;

    const now = performance.now();
    if (now - lastReport > 100) {
      send({ type: 'engine-progress', loaded, total });
      lastReport = now;
    }
  }

  send({ type: 'engine-progress', loaded, total });

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function loadEngine() {
  if (typeof WebAssembly === 'undefined') {
    throw new Error('This browser does not support WebAssembly, so the engine cannot start.');
  }

  const bytes = await fetchWasm();

  send({ type: 'engine-compiling' });

  try {
    await initializeImageMagick(bytes);
  } catch (error) {
    throw new Error(
      `The compression engine failed to initialise${error?.message ? `: ${error.message}` : '.'}`,
    );
  }

  send({ type: 'ready' });
}

function ensureEngine() {
  if (engineBroken) {
    return Promise.reject(new Error('The compression engine is not available. Reload the engine to retry.'));
  }

  if (!enginePromise) {
    enginePromise = loadEngine().catch((error) => {
      engineBroken = true;
      const message = error?.message || 'The compression engine failed to start.';
      send({ type: 'engine-error', message });
      throw error;
    });
  }

  return enginePromise;
}

function getPhaseMessage(stage, info) {
  if (stage === 'encode') {
    if (info.target === 'webp') {
      return info.lossless
        ? 'Encoding lossless WebP — method 6, maximum effort…'
        : 'Encoding WebP — quality 80, method 6, maximum effort…';
    }    if (info.target === 'jpg') {
      return 'Encoding progressive JPG — optimised Huffman tables…';
    }
    if (info.target === 'png') {
      return 'Encoding PNG — level 9 zlib, adaptive filtering…';
    }
  }
  return 'Working…';
}

async function handleConvert(job) {
  const startedAt = performance.now();

  try {
    await ensureEngine();

    send({ type: 'phase', id: job.id, text: 'Decoding image at full resolution…' });
    // Give the UI thread a moment to paint the phase before Wasm blocks this thread.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = await convertImage(new Uint8Array(job.buffer), {
      target: job.target,
      onPhase: (stage, info) => {
        send({ type: 'phase', id: job.id, text: getPhaseMessage(stage, info) });
      },
    });

    send(
      {
        type: 'done',
        id: job.id,
        buffer: result.data.buffer,
        mimeType: result.mimeType,
        extension: result.extension,
        width: result.width,
        height: result.height,
        sourceFormat: result.sourceFormat,
        elapsedMs: Math.round(performance.now() - startedAt),
      },
      [result.data.buffer],
    );
  } catch (error) {
    send({
      type: 'error',
      id: job.id,
      message: error?.message || 'The conversion failed for an unknown reason.',
    });
  }
}

self.addEventListener('message', (event) => {
  const message = event.data || {};

  if (message.type === 'warmup') {
    ensureEngine().catch(() => {
      // The engine-error message has already notified the UI.
    });
    return;
  }

  if (message.type === 'convert') {
    handleConvert(message);
  }
});
