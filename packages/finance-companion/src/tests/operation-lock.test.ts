import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalJson } from '#actual/canonical-json';
import { acquireActualApiLock } from '#actual/operation-lock';

describe('Actual API cross-process lock', () => {
  let actualApiDirectory: string;
  beforeEach(async () => {
    actualApiDirectory = await mkdtemp(path.join(tmpdir(), 'finance-lock-'));
  });
  afterEach(async () => {
    await rm(actualApiDirectory, { recursive: true, force: true });
  });

  it('binds release to the exact canonical lock owner', async () => {
    const release = await acquireActualApiLock(
      actualApiDirectory,
      '22222222-2222-4222-8222-222222222222',
      'a'.repeat(43),
      's'.repeat(43),
    );
    const markerPath = path.join(
      actualApiDirectory,
      'locks',
      'actual-api.lock',
      'owner.json',
    );
    const owner = JSON.parse(await readFile(markerPath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      markerPath,
      canonicalJson({
        ...owner,
        workerOperationId: '33333333-3333-4333-8333-333333333333',
      }),
    );
    await expect(release()).rejects.toThrow('ownership changed');
  });

  it('reclaims a complete lock only when the recorded process is absent', async () => {
    const lockDirectory = path.join(
      actualApiDirectory,
      'locks',
      'actual-api.lock',
    );
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(
      path.join(lockDirectory, 'owner.json'),
      canonicalJson({
        acquiredAt: '2026-07-31T12:00:00.000Z',
        directoryOwnershipNonce: 'a'.repeat(43),
        formatVersion: 1,
        pid: 2_147_483_647,
        processStartIdentity: 'absent-process',
        serviceInstanceNonce: 'old'.repeat(14) + 'x',
        workerOperationId: '33333333-3333-4333-8333-333333333333',
      }),
    );
    const release = await acquireActualApiLock(
      actualApiDirectory,
      '22222222-2222-4222-8222-222222222222',
      'a'.repeat(43),
      's'.repeat(43),
    );
    await expect(
      access(`${lockDirectory}.stale-33333333-3333-4333-8333-333333333333`),
    ).resolves.toBeUndefined();
    await release();
  });

  it('fails closed on an incomplete stale lock marker', async () => {
    const lockDirectory = path.join(
      actualApiDirectory,
      'locks',
      'actual-api.lock',
    );
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(path.join(lockDirectory, 'owner.json'), '{}');
    await expect(
      acquireActualApiLock(
        actualApiDirectory,
        '22222222-2222-4222-8222-222222222222',
        'a'.repeat(43),
        's'.repeat(43),
      ),
    ).rejects.toThrow('lock marker is invalid');
  });
});
