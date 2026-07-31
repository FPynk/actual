import { randomBytes } from 'node:crypto';
import { chmod, link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readIntegrityMacKey } from '#integrity/anchor';

describe.runIf(process.platform !== 'win32')(
  'POSIX integrity MAC key files',
  () => {
    let temporaryDirectory: string;

    beforeEach(async () => {
      temporaryDirectory = await mkdtemp(
        path.join(os.tmpdir(), 'finance-companion-integrity-key-'),
      );
    });

    afterEach(async () => {
      await rm(temporaryDirectory, { recursive: true, force: true });
    });

    it('reads only an effective-user-owned 0400 or 0600 regular file through its validated handle', async () => {
      const keyPath = await writeKey('integrity.key', 0o400);
      const key = await readIntegrityMacKey(keyPath);
      try {
        expect(key).toHaveLength(32);
      } finally {
        key.fill(0);
      }
    });

    it('rejects an over-permissioned key file', async () => {
      const keyPath = await writeKey('integrity.key', 0o644);
      await expect(readIntegrityMacKey(keyPath)).rejects.toThrow(
        'The integrity key is invalid.',
      );
    });

    it('rejects a symbolic-link key path', async () => {
      const targetPath = await writeKey('target.key', 0o600);
      const keyPath = path.join(temporaryDirectory, 'integrity.key');
      await symlink(targetPath, keyPath);
      await expect(readIntegrityMacKey(keyPath)).rejects.toThrow(
        'The integrity key is invalid.',
      );
    });

    it('rejects a multiply linked key file before reading it', async () => {
      const keyPath = await writeKey('integrity.key', 0o600);
      await link(keyPath, path.join(temporaryDirectory, 'integrity-copy.key'));
      await expect(readIntegrityMacKey(keyPath)).rejects.toThrow(
        'The integrity key is invalid.',
      );
    });

    async function writeKey(name: string, mode: number): Promise<string> {
      const keyPath = path.join(temporaryDirectory, name);
      await writeFile(keyPath, randomBytes(32), { mode });
      await chmod(keyPath, mode);
      return keyPath;
    }
  },
);

describe.runIf(process.platform === 'win32')(
  'Windows integrity MAC key files',
  () => {
    it('fails closed because Node cannot prove the frozen ACL and ADS contract', async () => {
      await expect(
        readIntegrityMacKey('C:\\synthetic-integrity.key'),
      ).rejects.toThrow('The integrity key is invalid.');
    });
  },
);
