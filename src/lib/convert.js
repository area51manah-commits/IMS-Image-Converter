/**
 * The heart of the converter.
 *
 * Decoding (including HEIC/HEIF and AVIF) and the JPG/PNG writers use
 * ImageMagick's WebAssembly build. Lossy WebP is written by ImageMagick with
 * `webp:method=6`. PNG -> WebP lossless is handed to libwebp (the Squoosh
 * codec) so near-lossless preprocessing can be switched off explicitly while
 * still using maximum effort — ImageMagick's lossless path does not expose
 * that control and becomes pathologically slow at method 6.
 *
 * No <canvas> is involved anywhere, so encoder effort can be set explicitly.
 *
 * The module is free of worker / DOM code and can run in Node for smoke tests.
 */

import {
  AlphaAction,
  ImageMagick,
  Interlace,
  MagickColors,
  MagickFormat,
} from '@imagemagick/magick-wasm';
import encodeWebp from '@jsquash/webp/encode.js';

import { getOutputFormat } from './formats.js';

/** Specification: lossy WebP uses quality 80 at maximum effort. */
const WEBP_LOSSY_QUALITY = 80;

/** libwebp's slowest and best compression mode (equivalent to -define webp:method=6). */
const WEBP_MAX_METHOD = 6;

/**
 * In lossless mode libwebp uses `quality` as a speed/effort hint, not as a
 * fidelity knob. 90 is pixel-exact when `near_lossless` is 100, and is both
 * faster and (in our tests) marginally smaller than 100, which has a
 * pathological search path at method 6.
 */
const WEBP_LOSSLESS_QUALITY = 90;

/** Visually transparent JPEG at a sane quality/size trade-off. */
const JPEG_QUALITY = 86;

/** zlib level 9 + adaptive filtering for the smallest lossless PNG. */
const PNG_COMPRESSION_LEVEL = 9;
const PNG_ADAPTIVE_FILTER = 5;

/**
 * Convert encoded image bytes into the requested output format.
 *
 * @param {Uint8Array} input Encoded source image.
 * @param {object} options
 * @param {'webp'|'jpg'|'png'} options.target
 * @param {(stage: string, info: object) => void} [options.onPhase]
 * @returns {Promise<{ data: Uint8Array, mimeType: string, extension: string,
 *            width: number, height: number, sourceFormat: string }>}
 */
export async function convertImage(input, options = {}) {
  const { target, onPhase = () => {} } = options;
  const output = getOutputFormat(target);

  if (target === 'webp') {
    // Decode once. Non-PNG sources are encoded by ImageMagick itself (which
    // handles colour spaces and large photos efficiently) with the WebP
    // method define. PNG sources are handed to libwebp directly so the
    // lossless path can use near_lossless=100 without ImageMagick's
    // pathological slow path at maximum effort.
    const prepared = ImageMagick.read(input, (image) => {
      image.autoOrient();
      image.strip();

      if (image.depth !== 8) {
        image.depth = 8;
      }

      const sourceFormat = String(image.format || '').toUpperCase();
      const width = image.width;
      const height = image.height;

      if (sourceFormat !== 'PNG') {
        image.quality = WEBP_LOSSY_QUALITY;
        image.settings.setDefine(MagickFormat.WebP, 'method', WEBP_MAX_METHOD);
        image.settings.setDefine(MagickFormat.WebP, 'alpha-quality', 100);

        onPhase('encode', { target: 'webp', sourceFormat, lossless: false });

        const data = image.write(MagickFormat.WebP, (buffer) => Uint8Array.from(buffer));

        return {
          data,
          mimeType: output.mimeType,
          extension: output.extension,
          width,
          height,
          sourceFormat,
        };
      }

      const pixels = image.write(MagickFormat.Rgba, (buffer) => Uint8ClampedArray.from(buffer));

      if (pixels.length !== width * height * 4) {
        throw new Error('The decoded image could not be converted to RGBA pixels.');
      }

      return { pixels, width, height, sourceFormat, lossless: true };
    });

    if (prepared.data) {
      return prepared;
    }

    onPhase('encode', {
      target: 'webp',
      sourceFormat: prepared.sourceFormat,
      lossless: true,
    });

    const encoded = await encodeWebp(
      {
        data: prepared.pixels,
        width: prepared.width,
        height: prepared.height,
      },
      {
        lossless: 1,
        method: WEBP_MAX_METHOD,
        quality: WEBP_LOSSLESS_QUALITY,
        // 100 = no near-lossless preprocessing, i.e. truly lossless.
        near_lossless: 100,
        exact: 1,
      },
    );

    return {
      data: new Uint8Array(encoded),
      mimeType: output.mimeType,
      extension: output.extension,
      width: prepared.width,
      height: prepared.height,
      sourceFormat: prepared.sourceFormat,
    };
  }

  return ImageMagick.read(input, (image) => {
    image.autoOrient();

    const sourceFormat = String(image.format || '').toUpperCase();

    if (target === 'jpg') {
      // JPEG has no alpha channel. Composite transparency over white instead
      // of letting libjpeg turn it into black.
      if (image.hasAlpha) {
        image.backgroundColor = MagickColors.White;
        image.alpha(AlphaAction.Remove);
      }
      image.quality = JPEG_QUALITY;
      image.settings.interlace = Interlace.Jpeg; // progressive
      image.settings.setDefine(MagickFormat.Jpeg, 'optimize-coding', true);
      image.settings.setDefine(MagickFormat.Jpeg, 'sampling-factor', '4:2:0');
    }

    if (target === 'png') {
      image.settings.setDefine(MagickFormat.Png, 'compression-level', PNG_COMPRESSION_LEVEL);
      image.settings.setDefine(MagickFormat.Png, 'compression-filter', PNG_ADAPTIVE_FILTER);
      image.settings.setDefine(MagickFormat.Png, 'compression-strategy', 0);
    }

    // Auto-orientation is already baked in. Dropping EXIF/XMP/GPS/ICC also
    // removes a few KB and avoids leaking location data with the download.
    image.strip();

    const width = image.width;
    const height = image.height;

    onPhase('encode', { target, sourceFormat });

    const data = image.write(MagickFormat[target === 'jpg' ? 'Jpeg' : 'Png'], (buffer) =>
      Uint8Array.from(buffer),
    );

    return {
      data,
      mimeType: output.mimeType,
      extension: output.extension,
      width,
      height,
      sourceFormat,
    };
  });
}
