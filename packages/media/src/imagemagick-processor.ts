import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  ImageMagick,
  MagickFormat,
  MagickGeometry,
  MagickImageInfo,
  initializeImageMagick,
  type IMagickImage,
} from '@imagemagick/magick-wasm';

import type {
  ImageFormat,
  MediaImageProcessor,
  MediaPipelineCrop,
} from './blob-store.js';

const DEFAULT_MAX_INPUT_PIXELS = 64 * 1024 * 1024;
let initialization: Promise<void> | undefined;
const require = createRequire(import.meta.url);

export interface ImageMagickProcessorOptions {
  readonly maxInputPixels?: number;
}

export function initializeImageMagickRuntime(): Promise<void> {
  initialization ??= (async () => {
    const entry = require.resolve('@imagemagick/magick-wasm');
    const wasmUrl = new URL('./magick.wasm', pathToFileURL(entry));
    const wasm = await readFile(wasmUrl);
    await initializeImageMagick(wasm);
  })();
  return initialization;
}

function fail(code: string, message: string, cause?: unknown): never {
  const error = new Error(message) as Error & { readonly code: string; readonly cause?: unknown };
  error.name = 'ImageMagickProcessorError';
  Object.defineProperty(error, 'code', { value: code, enumerable: false });
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause, enumerable: false });
  throw error;
}

function formatFor(format: ImageFormat): MagickFormat {
  switch (format) {
    case 'jpeg': return MagickFormat.Jpeg;
    case 'png': return MagickFormat.Png;
    case 'webp': return MagickFormat.WebP;
    case 'avif': return MagickFormat.Avif;
  }
}

function profile(image: IMagickImage, names: readonly string[]): Uint8Array | null {
  const available = new Map(image.profileNames.map((name) => [name.toLowerCase(), name]));
  for (const candidate of names) {
    const actual = available.get(candidate.toLowerCase());
    if (!actual) continue;
    const value = image.getProfile(actual);
    if (value && value.data.byteLength > 0) return new Uint8Array(value.data);
  }
  return null;
}

function equalBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail('E_INVALID_INPUT', `${field} must be a positive integer`);
  }
}

function inspectDimensions(bytes: Uint8Array, maxPixels: number): { width: number; height: number } {
  let info;
  try {
    info = MagickImageInfo.create(bytes);
  } catch (cause) {
    fail('E_DECODE_FAILED', 'ImageMagick could not inspect image headers', cause);
  }
  const { width, height } = info;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    fail('E_DECODE_FAILED', 'ImageMagick reported unusable dimensions');
  }
  if (width * height > maxPixels) {
    fail('E_DECODE_FAILED', `image pixel count ${width * height} exceeds ${maxPixels}`);
  }
  return { width, height };
}

export class ImageMagickProcessor implements MediaImageProcessor {
  readonly #maxInputPixels: number;

  constructor(options: ImageMagickProcessorOptions = {}) {
    const max = options.maxInputPixels ?? DEFAULT_MAX_INPUT_PIXELS;
    assertPositiveInteger(max, 'maxInputPixels');
    this.#maxInputPixels = max;
  }

  get maxInputPixels(): number {
    return this.#maxInputPixels;
  }

  async decode(input: { bytes: Uint8Array }): Promise<{
    width: number;
    height: number;
    hasIccProfile: boolean;
  }> {
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
      fail('E_INVALID_INPUT', 'decode bytes must be non-empty');
    }
    await initializeImageMagickRuntime();
    const dimensions = inspectDimensions(input.bytes, this.#maxInputPixels);
    try {
      return ImageMagick.read(input.bytes, (image) => ({
        ...dimensions,
        hasIccProfile: profile(image, ['icc', 'icm']) !== null,
      }));
    } catch (cause) {
      fail('E_DECODE_FAILED', 'ImageMagick could not decode image', cause);
    }
  }

  async encode(input: {
    bytes: Uint8Array;
    width: number;
    height: number;
    format: ImageFormat;
    crop?: MediaPipelineCrop;
  }): Promise<{
    bytes: Uint8Array;
    width: number;
    height: number;
    iccPreserved: boolean;
    privacyExifStripped: boolean;
  }> {
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
      fail('E_INVALID_INPUT', 'encode bytes must be non-empty');
    }
    assertPositiveInteger(input.width, 'width');
    assertPositiveInteger(input.height, 'height');
    await initializeImageMagickRuntime();
    const sourceDimensions = inspectDimensions(input.bytes, this.#maxInputPixels);
    const crop = input.crop;
    if (crop && (
      !Number.isInteger(crop.x) || !Number.isInteger(crop.y) ||
      !Number.isInteger(crop.width) || !Number.isInteger(crop.height) ||
      crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 ||
      crop.x + crop.width > sourceDimensions.width ||
      crop.y + crop.height > sourceDimensions.height
    )) {
      fail('E_CROP_OUT_OF_BOUNDS', 'crop exceeds source dimensions');
    }

    let encoded: { output: Uint8Array; sourceIcc: Uint8Array | null };
    try {
      encoded = ImageMagick.read(input.bytes, (image) => {
        const sourceIcc = profile(image, ['icc', 'icm']);
        image.strip();
        if (sourceIcc !== null) image.setProfile('icc', sourceIcc);
        if (crop) {
          image.crop(new MagickGeometry(crop.x, crop.y, crop.width, crop.height));
          image.resetPage();
        }
        if (input.width < image.width) {
          const targetHeight = Math.max(1, Math.round(image.height * input.width / image.width));
          image.resize(input.width, targetHeight);
        }
        image.quality = 82;
        return {
          sourceIcc,
          output: image.write(formatFor(input.format), (bytes) => new Uint8Array(bytes)),
        };
      });
    } catch (cause) {
      fail('E_ENCODE_FAILED', 'ImageMagick could not encode image', cause);
    }
    const { output, sourceIcc } = encoded;

    const result = ImageMagick.read(output, (image) => ({
      width: image.width,
      height: image.height,
      icc: profile(image, ['icc', 'icm']),
      hasExif: profile(image, ['exif']) !== null,
      profileNames: [...image.profileNames],
    }));
    if (result.hasExif) fail('E_EXIF_ATTESTATION_MISSING', 'encoded output retained EXIF');
    if (!equalBytes(sourceIcc, result.icc)) {
      fail(
        'E_ICC_ATTESTATION_MISSING',
        `encoded ${input.format} output did not preserve ICC profile bytes (source=${sourceIcc?.byteLength ?? 0}, output=${result.icc?.byteLength ?? 0}, profiles=${result.profileNames.join(',')})`,
      );
    }
    return Object.freeze({
      bytes: output,
      width: result.width,
      height: result.height,
      iccPreserved: true,
      privacyExifStripped: true,
    });
  }
}
