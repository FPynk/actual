import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createActualApiOwner,
  prepareActualApiOwnerDirectory,
} from '#actual/api-root-owner';
import { canonicalJson } from '#actual/canonical-json';

describe('Actual API ownership marker', () => {
  const instanceId = '123e4567-e89b-42d3-a456-426614174000';
  const budgetBindingHash = 'a'.repeat(64);
  let temporaryDirectory: string;
  let actualApiDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'finance-actual-api-owner-'),
    );
    actualApiDirectory = path.join(temporaryDirectory, 'actual-api');
    await mkdir(actualApiDirectory);
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('creates a canonical owner marker for a fresh empty directory', async () => {
    const prepared = await prepareActualApiOwnerDirectory(
      actualApiDirectory,
      false,
      undefined,
      budgetBindingHash,
    );
    expect(prepared.ownerExists).toBe(false);
    await createActualApiOwner(
      prepared.actualApiDirectory,
      instanceId,
      budgetBindingHash,
    );
    const serialized = await readFile(
      path.join(actualApiDirectory, 'owner.json'),
      'utf8',
    );
    const owner = JSON.parse(serialized) as Record<string, unknown>;
    expect(serialized).toBe(canonicalJson(owner));
    expect(owner).toMatchObject({
      budgetBindingHash,
      companionInstanceId: instanceId,
      formatVersion: 1,
    });
    expect(owner.directoryNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('accepts a valid marker on a database rerun', async () => {
    await createActualApiOwner(
      actualApiDirectory,
      instanceId,
      budgetBindingHash,
    );
    const markerPath = path.join(actualApiDirectory, 'owner.json');
    const originalMarker = await readFile(markerPath, 'utf8');
    await expect(
      prepareActualApiOwnerDirectory(
        actualApiDirectory,
        true,
        instanceId,
        budgetBindingHash,
      ),
    ).resolves.toMatchObject({ ownerExists: true });
    await expect(
      createActualApiOwner(actualApiDirectory, instanceId, budgetBindingHash),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(markerPath, 'utf8')).toBe(originalMarker);
    await expect(
      prepareActualApiOwnerDirectory(
        actualApiDirectory,
        false,
        undefined,
        budgetBindingHash,
      ),
    ).rejects.toThrow('exists before companion initialization');
  });

  it('fails closed for a mismatched or non-empty unowned directory', async () => {
    await createActualApiOwner(
      actualApiDirectory,
      instanceId,
      budgetBindingHash,
    );
    await expect(
      prepareActualApiOwnerDirectory(
        actualApiDirectory,
        true,
        instanceId,
        'b'.repeat(64),
      ),
    ).rejects.toThrow('does not match');

    const emptyDirectory = path.join(temporaryDirectory, 'empty');
    await mkdir(emptyDirectory);
    await writeFile(path.join(emptyDirectory, 'unexpected'), 'synthetic');
    await expect(
      prepareActualApiOwnerDirectory(
        emptyDirectory,
        false,
        undefined,
        budgetBindingHash,
      ),
    ).rejects.toThrow('not empty');
  });

  it('rejects linked owner markers and roots', async () => {
    await createActualApiOwner(
      actualApiDirectory,
      instanceId,
      budgetBindingHash,
    );
    await link(
      path.join(actualApiDirectory, 'owner.json'),
      path.join(temporaryDirectory, 'owner-link.json'),
    );
    await expect(
      prepareActualApiOwnerDirectory(
        actualApiDirectory,
        true,
        instanceId,
        budgetBindingHash,
      ),
    ).rejects.toThrow('protected regular file');

    const linkedDirectory = path.join(temporaryDirectory, 'actual-api-link');
    await symlink(
      actualApiDirectory,
      linkedDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      prepareActualApiOwnerDirectory(
        linkedDirectory,
        true,
        instanceId,
        budgetBindingHash,
      ),
    ).rejects.toThrow('not a regular directory');
  });

  it('removes its owner marker when a post-write directory race is detected', async () => {
    const prepared = await prepareActualApiOwnerDirectory(
      actualApiDirectory,
      false,
      undefined,
      budgetBindingHash,
    );
    await expect(
      createActualApiOwner(
        prepared.actualApiDirectory,
        instanceId,
        budgetBindingHash,
        prepared.directoryIdentity,
        {
          afterOwnerWriteBeforeVerification: () =>
            writeFile(path.join(actualApiDirectory, 'unexpected'), 'synthetic'),
        },
      ),
    ).rejects.toThrow('changed during owner initialization');
    await expect(
      readFile(path.join(actualApiDirectory, 'owner.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
