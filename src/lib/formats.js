/**
 * Shared format metadata used by both the UI and the Wasm worker.
 * Keeping this in one place means the `<select>` options, MIME types,
 * download extensions and validation can never drift apart.
 */

export const OUTPUT_FORMATS = Object.freeze([
  Object.freeze({
    id: 'webp',
    label: 'To WebP Max Compression',
    shortLabel: 'WebP',
    mimeType: 'image/webp',
    extension: 'webp',
  }),
  Object.freeze({
    id: 'jpg',
    label: 'To JPG',
    shortLabel: 'JPG',
    mimeType: 'image/jpeg',
    extension: 'jpg',
  }),
  Object.freeze({
    id: 'png',
    label: 'To PNG',
    shortLabel: 'PNG',
    mimeType: 'image/png',
    extension: 'png',
  }),
]);

export const DEFAULT_OUTPUT_FORMAT = 'webp';

const OUTPUT_BY_ID = new Map(OUTPUT_FORMATS.map((format) => [format.id, format]));

export function getOutputFormat(id) {
  const format = OUTPUT_BY_ID.get(id);
  if (!format) {
    throw new Error(`Unknown output format: ${id}`);
  }
  return format;
}

export const SUPPORTED_EXTENSIONS = Object.freeze([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'avif',
  'heic',
  'heif',
]);

const SUPPORTED_EXTENSION_SET = new Set(SUPPORTED_EXTENSIONS);

const SUPPORTED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/png',
  'image/x-png',
  'image/webp',
  'image/avif',
  'image/avif-sequence',
  'image/heic',
  'image/heic-sequence',
  'image/heif',
  'image/heif-sequence',
]);

/** 64 MB is well beyond any normal camera file, but still bounded. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_LABEL = '64 MB';

export function getExtension(fileName = '') {
  const dot = fileName.lastIndexOf('.');
  return dot > -1 ? fileName.slice(dot + 1).toLowerCase() : '';
}

export function isHeicFile(file) {
  const extension = getExtension(file?.name);
  const type = String(file?.type || '').toLowerCase();
  return extension === 'heic' || extension === 'heif' || type.includes('heic') || type.includes('heif');
}

export function isSupportedImage(file) {
  if (!file) return false;
  return (
    SUPPORTED_EXTENSION_SET.has(getExtension(file.name)) ||
    SUPPORTED_MIME_TYPES.has(String(file.type || '').toLowerCase())
  );
}

/** Normalises ImageMagick's format names for display. */
export function displayFormat(format) {
  const upper = String(format || '').toUpperCase();
  if (upper === 'JPEG' || upper === 'JPG') return 'JPG';
  if (upper === 'HEIF') return 'HEIC';
  if (upper === 'WEBP') return 'WebP';
  return upper || 'Image';
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  const rounded = index === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[index]}`;
}

/**
 * `photo.heic` -> `photo.webp`
 * `photo.webp` -> `photo-converted.webp` (avoids silently replacing the original)
 */
export function outputFileName(inputName, extension) {
  const dot = inputName.lastIndexOf('.');
  const rawBase = dot > 0 ? inputName.slice(0, dot) : inputName;
  const base = rawBase.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim() || 'image';
  const sourceExtension = getExtension(inputName);
  const suffix = sourceExtension === extension ? '-converted' : '';
  return `${base}${suffix}.${extension}`;
}
