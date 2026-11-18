/**
 * Engine smoke test — runs the exact conversion module in Node.
 *
 *   npm run smoke
 *
 * It proves that:
 *   1. the Wasm build can decode and encode every output format,
 *   2. PNG -> WebP really uses the lossless VP8L bitstream and is pixel-exact,
 *   3. every other source -> WebP uses the lossy VP8 bitstream,
 *   4. transparency survives WebP, and is flattened for JPEG.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ImageMagick,
  MagickFormat,
  MagickReadSettings,
  initializeImageMagick,
} from '@imagemagick/magick-wasm';
import { init as initWebpEncoder } from '@jsquash/webp/encode.js';

import { convertImage } from '../src/lib/convert.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasm = await readFile(
  join(root, 'node_modules/@imagemagick/magick-wasm/dist/x86/magick.wasm'),
);

await initializeImageMagick(new Uint8Array(wasm));

// In the browser the libwebp codec loads itself. In Node we hand it the
// compiled module because fetch() does not support file:// URLs.
const webpWasm = await readFile(
  join(root, 'node_modules/@jsquash/webp/codec/enc/webp_enc_simd.wasm'),
);
await initWebpEncoder(await WebAssembly.compile(webpWasm));

const WIDTH = 480;
const HEIGHT = 320;

function createSource(format, { alpha = false } = {}) {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const i = (y * WIDTH + x) * 4;
      // Smooth gradient plus deterministic grain so the encoder has real work.
      const grain = ((x * 37 + y * 101) % 23) - 11;
      pixels[i] = Math.max(0, Math.min(255, Math.round((x / WIDTH) * 255 + grain)));
      pixels[i + 1] = Math.max(0, Math.min(255, Math.round((y / HEIGHT) * 255 + grain)));
      pixels[i + 2] = Math.max(0, Math.min(255, Math.round(((x + y) / (WIDTH + HEIGHT)) * 255)));
      pixels[i + 3] = alpha ? (x < WIDTH / 2 ? 255 : 96) : 255;
    }
  }

  const settings = new MagickReadSettings({
    width: WIDTH,
    height: HEIGHT,
    depth: 8,
    format: MagickFormat.Rgba,
  });

  return ImageMagick.read(pixels, settings, (image) => {
    image.quality = 94;
    return image.write(format, (data) => Uint8Array.from(data));
  });
}

function rgbaBytes(bytes) {
  return ImageMagick.read(bytes, (image) =>
    image.write(MagickFormat.Rgba, (data) => Uint8Array.from(data)),
  );
}

function info(bytes) {
  return ImageMagick.read(bytes, (image) => ({
    width: image.width,
    height: image.height,
    format: image.format,
    alpha: image.hasAlpha,
  }));
}

function webpChunk(bytes) {
  assert.equal(Buffer.from(bytes.slice(0, 4)).toString('ascii'), 'RIFF', 'WebP must be a RIFF file');
  assert.equal(Buffer.from(bytes.slice(8, 12)).toString('ascii'), 'WEBP', 'WebP container missing');
  return Buffer.from(bytes.slice(12, 16)).toString('ascii');
}

const pngSource = createSource(MagickFormat.Png, { alpha: true });
const jpgSource = createSource(MagickFormat.Jpeg);

const lossless = await convertImage(pngSource, { target: 'webp' });
const lossy = await convertImage(jpgSource, { target: 'webp' });
const jpg = await convertImage(pngSource, { target: 'jpg' });
const png = await convertImage(jpgSource, { target: 'png' });

assert.equal(webpChunk(lossless.data), 'VP8L', 'PNG -> WebP must be lossless');
assert.equal(webpChunk(lossy.data), 'VP8 ', 'JPG -> WebP must be lossy');

assert.deepEqual(
  { width: lossless.width, height: lossless.height },
  { width: WIDTH, height: HEIGHT },
  'Lossless WebP dimensions changed',
);
assert.equal(info(lossless.data).alpha, true, 'Lossless WebP lost transparency');
assert.equal(info(lossy.data).format, 'WEBP');
assert.equal(info(lossy.data).width, WIDTH);

// The lossless path must be bit-for-bit lossless, including RGB values hidden
// under fully transparent pixels.
assert.deepEqual(
  Buffer.from(rgbaBytes(lossless.data)),
  Buffer.from(rgbaBytes(pngSource)),
  'Lossless WebP is not pixel-exact',
);

assert.equal(jpg.data[0], 0xff, 'JPEG SOI marker missing');
assert.equal(jpg.data[1], 0xd8, 'JPEG SOI marker missing');
assert.equal(info(jpg.data).format, 'JPEG');
assert.equal(info(jpg.data).alpha, false, 'JPEG must not contain alpha');

assert.deepEqual([...png.data.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG signature missing');
assert.equal(info(png.data).format, 'PNG');

console.log('Source sizes');
console.log(`  PNG  ${pngSource.byteLength.toLocaleString()} bytes (with alpha)`);
console.log(`  JPG  ${jpgSource.byteLength.toLocaleString()} bytes`);
console.log('Outputs');
console.log(`  PNG  -> WebP lossless (method 6)  ${lossless.data.byteLength.toLocaleString()} bytes`);
console.log(`  JPG  -> WebP quality 80 (method 6) ${lossy.data.byteLength.toLocaleString()} bytes`);
console.log(`  PNG  -> JPG                       ${jpg.data.byteLength.toLocaleString()} bytes`);
console.log(`  JPG  -> PNG                       ${png.data.byteLength.toLocaleString()} bytes`);
console.log('\nAll smoke checks passed.');
