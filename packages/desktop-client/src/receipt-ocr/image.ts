const supportedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

export const maxReceiptImageBytes = 12 * 1024 * 1024;
export const maxReceiptImagePixels = 16_000_000;
export const maxReceiptImageSide = 2_048;

type ImageMetadata = {
  width: number;
  height: number;
  isAnimated: boolean;
};

export class ReceiptImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptImageValidationError';
  }
}

export async function validateReceiptImageFile(file: File): Promise<void> {
  if (!supportedImageTypes.has(file.type)) {
    throw new ReceiptImageValidationError(
      'Receipt images must be JPEG, PNG, or WebP.',
    );
  }
  if (file.size === 0 || file.size > maxReceiptImageBytes) {
    throw new ReceiptImageValidationError(
      'Receipt image file size is outside the allowed bounds.',
    );
  }

  const metadata = readImageMetadata(
    new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer()),
    file.type,
  );
  if (metadata.isAnimated) {
    throw new ReceiptImageValidationError(
      'Animated WebP receipt images are not supported.',
    );
  }
  if (
    metadata.width === 0 ||
    metadata.height === 0 ||
    metadata.width * metadata.height > maxReceiptImagePixels
  ) {
    throw new ReceiptImageValidationError(
      'Receipt image dimensions are outside the allowed bounds.',
    );
  }
}

export async function createReceiptOcrImage(
  file: File,
  rotationDegrees: 0 | 90 | 180 | 270,
): Promise<ImageBitmap> {
  await validateReceiptImageFile(file);
  const source = await createImageBitmap(file, {
    imageOrientation: 'from-image',
  });
  try {
    return flattenRotateAndResize(source, rotationDegrees);
  } finally {
    source.close();
  }
}

export function flattenRotateAndResize(
  source: ImageBitmap,
  rotationDegrees: 0 | 90 | 180 | 270,
): ImageBitmap {
  const isQuarterTurn = rotationDegrees === 90 || rotationDegrees === 270;
  const rotatedWidth = isQuarterTurn ? source.height : source.width;
  const rotatedHeight = isQuarterTurn ? source.width : source.height;
  const scale = Math.min(
    1,
    maxReceiptImageSide / Math.max(rotatedWidth, rotatedHeight),
  );
  const width = Math.max(1, Math.round(rotatedWidth * scale));
  const height = Math.max(1, Math.round(rotatedHeight * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context)
    throw new Error('The browser could not create a receipt image canvas.');

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.save();
  if (rotationDegrees === 90) {
    context.translate(width, 0);
    context.rotate(Math.PI / 2);
  } else if (rotationDegrees === 180) {
    context.translate(width, height);
    context.rotate(Math.PI);
  } else if (rotationDegrees === 270) {
    context.translate(0, height);
    context.rotate(-Math.PI / 2);
  }
  const drawnWidth = isQuarterTurn ? height : width;
  const drawnHeight = isQuarterTurn ? width : height;
  context.drawImage(source, 0, 0, drawnWidth, drawnHeight);
  context.restore();
  return canvas.transferToImageBitmap();
}

function readImageMetadata(
  bytes: Uint8Array,
  contentType: string,
): ImageMetadata {
  if (contentType === 'image/png') return readPngMetadata(bytes);
  if (contentType === 'image/jpeg') return readJpegMetadata(bytes);
  return readWebpMetadata(bytes);
}

function readPngMetadata(bytes: Uint8Array): ImageMetadata {
  if (!hasBytes(bytes, 0, 24) || readAscii(bytes, 1, 3) !== 'PNG') {
    throw new ReceiptImageValidationError('The PNG image is invalid.');
  }
  return {
    width: readUint32BigEndian(bytes, 16),
    height: readUint32BigEndian(bytes, 20),
    isAnimated: false,
  };
}

function readJpegMetadata(bytes: Uint8Array): ImageMetadata {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new ReceiptImageValidationError('The JPEG image is invalid.');
  }
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    const length = readUint16BigEndian(bytes, offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        width: readUint16BigEndian(bytes, offset + 5),
        height: readUint16BigEndian(bytes, offset + 3),
        isAnimated: false,
      };
    }
    offset += length;
  }
  throw new ReceiptImageValidationError(
    'The JPEG image has no supported dimensions.',
  );
}

function readWebpMetadata(bytes: Uint8Array): ImageMetadata {
  if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WEBP') {
    throw new ReceiptImageValidationError('The WebP image is invalid.');
  }
  let offset = 12;
  let isAnimated = false;
  let dimensions: ImageMetadata | undefined;
  while (offset + 8 <= bytes.length) {
    const chunk = readAscii(bytes, offset, 4);
    const length = readUint32LittleEndian(bytes, offset + 4);
    const dataOffset = offset + 8;
    if (!hasBytes(bytes, dataOffset, length)) break;
    if (chunk === 'ANIM') isAnimated = true;
    if (chunk === 'VP8X' && length >= 10) {
      isAnimated ||= (bytes[dataOffset] & 0x02) !== 0;
      dimensions = {
        width: readUint24LittleEndian(bytes, dataOffset + 4) + 1,
        height: readUint24LittleEndian(bytes, dataOffset + 7) + 1,
        isAnimated: false,
      };
    }
    if (chunk === 'VP8 ' && length >= 10) {
      dimensions ??= {
        width: readUint16LittleEndian(bytes, dataOffset + 6) & 0x3fff,
        height: readUint16LittleEndian(bytes, dataOffset + 8) & 0x3fff,
        isAnimated: false,
      };
    }
    if (chunk === 'VP8L' && length >= 5) {
      const bits =
        bytes[dataOffset + 1] |
        (bytes[dataOffset + 2] << 8) |
        (bytes[dataOffset + 3] << 16) |
        (bytes[dataOffset + 4] << 24);
      dimensions ??= {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
        isAnimated: false,
      };
    }
    offset = dataOffset + length + (length % 2);
  }
  if (dimensions) return { ...dimensions, isAnimated };
  throw new ReceiptImageValidationError(
    'The WebP image has no supported dimensions.',
  );
}

function hasBytes(bytes: Uint8Array, offset: number, length: number): boolean {
  return offset >= 0 && length >= 0 && offset + length <= bytes.length;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function readUint16BigEndian(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] * 2 ** 24 +
      (bytes[offset + 1] << 16) +
      (bytes[offset + 2] << 8) +
      bytes[offset + 3]) >>>
    0
  );
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset + 3] * 2 ** 24 +
      (bytes[offset + 2] << 16) +
      (bytes[offset + 1] << 8) +
      bytes[offset]) >>>
    0
  );
}
