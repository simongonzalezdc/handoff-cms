import {
  ImageMagick,
  MagickColors,
  MagickFormat,
  type IMagickImage,
} from '@imagemagick/magick-wasm';
import { beforeAll, describe, expect, it } from 'vitest';

import type { ImageFormat, MediaImageProcessor } from '../src/blob-store.js';
import {
  ImageMagickProcessor,
  initializeImageMagickRuntime,
} from '../src/imagemagick-processor.js';

const ICC = Buffer.from(
  'AAACTGxjbXMEQAAAbW50clJHQiBYWVogB+oABwAbABAAAAAKYWNzcEFQUEwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1sY21zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALZGVzYwAAAQgAAAA2Y3BydAAAAUAAAABMd3RwdAAAAYwAAAAUY2hhZAAAAaAAAAAsclhZWgAAAcwAAAAUYlhZWgAAAeAAAAAUZ1hZWgAAAfQAAAAUclRSQwAAAggAAAAgZ1RSQwAAAggAAAAgYlRSQwAAAggAAAAgY2hybQAAAigAAAAkbWx1YwAAAAAAAAABAAAADGVuVVMAAAAaAAAAHABzAFIARwBCACAAYgB1AGkAbAB0AC0AaQBuAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAADAAAAAcAE4AbwAgAGMAbwBwAHkAcgBpAGcAaAB0ACwAIAB1AHMAZQAgAGYAcgBlAGUAbAB5WFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDEIAAAXe///zJQAAB5MAAP2Q///7of///aIAAAPcAADAblhZWiAAAAAAAABvoAAAOPUAAAOQWFlaIAAAAAAAACSfAAAPhAAAtsNYWVogAAAAAAAAYpcAALeHAAAY2XBhcmEAAAAAAAMAAAACZmYAAPKnAAANWQAAE9AAAApbY2hybQAAAAAAAwAAAACj1wAAVHsAAEzNAACZmgAAJmYAAA9c',
  'base64',
);
const EXIF = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0]);
const FORMATS: readonly ImageFormat[] = ['jpeg', 'png', 'webp', 'avif'];

function magickFormat(format: ImageFormat): MagickFormat {
  switch (format) {
    case 'jpeg': return MagickFormat.Jpeg;
    case 'png': return MagickFormat.Png;
    case 'webp': return MagickFormat.WebP;
    case 'avif': return MagickFormat.Avif;
  }
}

function profile(image: IMagickImage, name: string): Uint8Array | null {
  const actual = image.profileNames.find((candidate) => candidate.toLowerCase() === name);
  const value = actual ? image.getProfile(actual) : null;
  return value ? new Uint8Array(value.data) : null;
}

function equal(left: Uint8Array | null, right: Uint8Array): boolean {
  if (left === null || left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

async function fixture(options: { icc?: boolean; exif?: boolean } = {}): Promise<Uint8Array> {
  await initializeImageMagickRuntime();
  return ImageMagick.read(MagickColors.CornflowerBlue, 256, 192, (image) => {
    if (options.icc) image.setProfile('icc', ICC);
    if (options.exif) image.setProfile('exif', EXIF);
    return image.write(MagickFormat.Jpeg, (bytes) => new Uint8Array(bytes));
  });
}

describe('ImageMagickProcessor', () => {
  let plain: Uint8Array;
  let profiled: Uint8Array;

  beforeAll(async () => {
    plain = await fixture();
    profiled = await fixture({ icc: true, exif: true });
  });

  it('satisfies the production processor contract', () => {
    const processor: MediaImageProcessor = new ImageMagickProcessor();
    expect(processor.decode).toBeTypeOf('function');
    expect(processor.encode).toBeTypeOf('function');
  });

  it('decodes dimensions and enforces the pixel ceiling before full processing', async () => {
    const decoded = await new ImageMagickProcessor().decode({ bytes: plain });
    expect(decoded).toEqual({ width: 256, height: 192, hasIccProfile: false });
    await expect(
      new ImageMagickProcessor({ maxInputPixels: 100 }).decode({ bytes: plain }),
    ).rejects.toMatchObject({ code: 'E_DECODE_FAILED' });
  });

  it('crops, resizes, and emits each responsive format', async () => {
    const processor = new ImageMagickProcessor();
    for (const format of FORMATS) {
      const output = await processor.encode({
        bytes: plain,
        width: 64,
        height: 64,
        format,
        crop: { x: 64, y: 32, width: 128, height: 128 },
      });
      expect(output.width, format).toBe(64);
      expect(output.height, format).toBe(64);
      expect(output.privacyExifStripped, format).toBe(true);
      expect(output.iccPreserved, format).toBe(true);
      ImageMagick.read(output.bytes, (image) => {
        expect(image.format, format).toBe(magickFormat(format));
      });
    }
  });

  it('strips EXIF, preserves exact ICC bytes, and refuses unsupported profile formats', async () => {
    ImageMagick.read(profiled, (image) => {
      expect(profile(image, 'exif')).not.toBeNull();
      expect(equal(profile(image, 'icc'), ICC)).toBe(true);
    });
    const processor = new ImageMagickProcessor();
    for (const format of FORMATS) {
      if (format === 'png') {
        await expect(
          processor.encode({ bytes: profiled, width: 128, height: 96, format }),
        ).rejects.toMatchObject({ code: 'E_ICC_ATTESTATION_MISSING' });
        continue;
      }
      const output = await processor.encode({
        bytes: profiled,
        width: 128,
        height: 96,
        format,
      });
      ImageMagick.read(output.bytes, (image) => {
        expect(profile(image, 'exif'), format).toBeNull();
        expect(equal(profile(image, 'icc'), ICC), format).toBe(true);
      });
    }
  });

  it('rejects an out-of-bounds crop deterministically', async () => {
    await expect(
      new ImageMagickProcessor().encode({
        bytes: plain,
        width: 64,
        height: 64,
        format: 'webp',
        crop: { x: 250, y: 0, width: 20, height: 20 },
      }),
    ).rejects.toMatchObject({ code: 'E_CROP_OUT_OF_BOUNDS' });
  });
});
