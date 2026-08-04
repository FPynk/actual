import { describe, expect, it } from 'vitest';

import { ReceiptImageValidationError, validateReceiptImageFile } from './image';

function imageFile(bytes: number[], type: string): File {
  return new File([new Uint8Array(bytes)], 'receipt', { type });
}

describe('validateReceiptImageFile', () => {
  it('accepts a bounded PNG header', async () => {
    await expect(
      validateReceiptImageFile(
        imageFile(
          [
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0,
            2, 0, 0, 0, 1, 0,
          ],
          'image/png',
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects animated WebP images', async () => {
    await expect(
      validateReceiptImageFile(
        imageFile(
          [
            82, 73, 70, 70, 22, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 88, 10, 0,
            0, 0, 2, 0, 0, 0, 99, 0, 0, 99, 0, 0,
          ],
          'image/webp',
        ),
      ),
    ).rejects.toBeInstanceOf(ReceiptImageValidationError);
  });
});
