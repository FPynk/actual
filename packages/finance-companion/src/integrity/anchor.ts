import { createHmac, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, sha256 } from './canonical-hash.ts';

export type IntegrityAnchorV1 = Readonly<{
  formatVersion: 1;
  budgetKeyHash: string;
  writeCapabilityGeneration: number;
  writeCapabilityEventHash: string | null;
  highestIssuedIntentSequence: number;
  highestIssuedIntentHash: string | null;
  highestAppliedReceiptSequence: number;
  highestAppliedReceiptHash: string | null;
  lastVerifiedPairedBackupManifestHash: string | null;
}>;

export type AuthenticatedIntegrityAnchorV1 = Readonly<{
  payload: IntegrityAnchorV1;
  mac: Readonly<{ algorithm: 'hmac-sha256'; keyId: string; value: string }>;
}>;

const anchorPrefix = 'finance-companion/integrity-anchor/v1\0';
const MAXIMUM_INTEGRITY_MAC_KEY_BYTES = 4096;

export function createGenerationZeroAnchor(
  budgetKeyHash: string,
): IntegrityAnchorV1 {
  return {
    formatVersion: 1,
    budgetKeyHash,
    writeCapabilityGeneration: 0,
    writeCapabilityEventHash: null,
    highestIssuedIntentSequence: 0,
    highestIssuedIntentHash: null,
    highestAppliedReceiptSequence: 0,
    highestAppliedReceiptHash: null,
    lastVerifiedPairedBackupManifestHash: null,
  };
}

export async function readIntegrityMacKey(keyPath: string): Promise<Buffer> {
  if (process.platform === 'win32') {
    throw new Error('The integrity key is invalid.');
  }

  let key: Buffer | undefined;
  let file: FileHandle | undefined;
  try {
    const absoluteKeyPath = path.resolve(keyPath);
    const absoluteParentPath = path.dirname(absoluteKeyPath);
    const parentStatus = await lstat(absoluteParentPath);
    if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink()) {
      throw new Error('The integrity key is invalid.');
    }
    const canonicalParentPath = await realpath(absoluteParentPath);
    if (!hasSamePath(absoluteParentPath, canonicalParentPath)) {
      throw new Error('The integrity key is invalid.');
    }
    const canonicalKeyPath = path.join(
      canonicalParentPath,
      path.basename(absoluteKeyPath),
    );
    const expectedUid = process.geteuid?.();
    if (expectedUid === undefined) {
      throw new Error('The integrity key is invalid.');
    }
    const beforeOpen = await lstat(canonicalKeyPath);
    assertRestrictedIntegrityMacKeyFile(beforeOpen, expectedUid);
    file = await open(
      canonicalKeyPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const openedFile = await file.stat();
    assertRestrictedIntegrityMacKeyFile(openedFile, expectedUid);
    assertSameFile(beforeOpen, openedFile);
    key = await readBoundedIntegrityMacKey(file);
    const afterRead = await lstat(canonicalKeyPath);
    assertRestrictedIntegrityMacKeyFile(afterRead, expectedUid);
    assertSameFile(beforeOpen, afterRead);
    assertSameFile(openedFile, afterRead);
    await file.close();
    file = undefined;
    return key;
  } catch {
    key?.fill(0);
    throw new Error('The integrity key is invalid.');
  } finally {
    await file?.close().catch(() => undefined);
  }
}

export function decodeIntegrityMacKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, 'base64url');
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(encodedKey) ||
    key.length !== 32 ||
    key.toString('base64url') !== encodedKey
  ) {
    key.fill(0);
    throw new Error('The integrity key is invalid.');
  }
  return key;
}

export function authenticateIntegrityAnchor(
  payload: IntegrityAnchorV1,
  macKey: Buffer,
): AuthenticatedIntegrityAnchorV1 {
  const value = anchorMac(payload, macKey);
  return {
    payload,
    mac: {
      algorithm: 'hmac-sha256',
      keyId: sha256(
        Buffer.concat([
          Buffer.from('finance-companion/integrity-key-id/v1\0'),
          macKey,
        ]),
      ).slice(0, 16),
      value,
    },
  };
}

export async function writeIntegrityAnchor(
  anchorPath: string,
  payload: IntegrityAnchorV1,
  macKey: Buffer,
): Promise<void> {
  const temporaryPath = `${anchorPath}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(
    canonicalJson(authenticateIntegrityAnchor(payload, macKey)),
    'utf8',
  );
  try {
    const file = await open(temporaryPath, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, anchorPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function writeNewIntegrityAnchor(
  anchorPath: string,
  payload: IntegrityAnchorV1,
  macKey: Buffer,
): Promise<void> {
  const file = await open(anchorPath, 'wx', 0o600);
  try {
    await file.writeFile(
      Buffer.from(
        canonicalJson(authenticateIntegrityAnchor(payload, macKey)),
        'utf8',
      ),
    );
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function readIntegrityAnchor(
  anchorPath: string,
  macKey: Buffer,
): Promise<IntegrityAnchorV1> {
  return parseIntegrityAnchorBytes(await readFile(anchorPath), macKey);
}

export function parseIntegrityAnchorBytes(
  bytes: Buffer,
  macKey: Buffer,
): IntegrityAnchorV1 {
  const serialized = bytes.toString('utf8');
  const parsed: unknown = JSON.parse(serialized);
  if (!isAuthenticatedAnchor(parsed)) {
    throw new Error('The integrity anchor is invalid.');
  }
  if (serialized !== canonicalJson(parsed)) {
    throw new Error('The integrity anchor is not canonical.');
  }
  const expected = authenticateIntegrityAnchor(parsed.payload, macKey);
  if (
    parsed.mac.keyId !== expected.mac.keyId ||
    parsed.mac.value !== expected.mac.value
  ) {
    throw new Error('The integrity anchor could not be authenticated.');
  }
  return parsed.payload;
}

export async function readIntegrityAnchorBytes(
  anchorPath: string,
): Promise<Buffer> {
  return readFile(anchorPath);
}

function anchorMac(payload: IntegrityAnchorV1, macKey: Buffer): string {
  return createHmac('sha256', macKey)
    .update(Buffer.from(`${anchorPrefix}${canonicalJson(payload)}`, 'utf8'))
    .digest('hex');
}

function isAuthenticatedAnchor(
  value: unknown,
): value is AuthenticatedIntegrityAnchorV1 {
  if (value === null || typeof value !== 'object') return false;
  const anchor = value as Record<string, unknown>;
  if (
    !isIntegrityAnchor(anchor.payload) ||
    anchor.mac === null ||
    typeof anchor.mac !== 'object'
  ) {
    return false;
  }
  const mac = anchor.mac as Record<string, unknown>;
  return (
    Object.keys(anchor).length === 2 &&
    Object.keys(mac).length === 3 &&
    mac.algorithm === 'hmac-sha256' &&
    typeof mac.keyId === 'string' &&
    /^[0-9a-f]{16}$/.test(mac.keyId) &&
    typeof mac.value === 'string' &&
    /^[0-9a-f]{64}$/.test(mac.value)
  );
}

function isIntegrityAnchor(value: unknown): value is IntegrityAnchorV1 {
  if (value === null || typeof value !== 'object') return false;
  const anchor = value as Record<string, unknown>;
  const fields = [
    'formatVersion',
    'budgetKeyHash',
    'writeCapabilityGeneration',
    'writeCapabilityEventHash',
    'highestIssuedIntentSequence',
    'highestIssuedIntentHash',
    'highestAppliedReceiptSequence',
    'highestAppliedReceiptHash',
    'lastVerifiedPairedBackupManifestHash',
  ];
  return (
    Object.keys(anchor).length === fields.length &&
    fields.every(field => field in anchor) &&
    anchor.formatVersion === 1 &&
    isHash(anchor.budgetKeyHash) &&
    isSequence(anchor.writeCapabilityGeneration) &&
    isNullableHash(anchor.writeCapabilityEventHash) &&
    isSequence(anchor.highestIssuedIntentSequence) &&
    isNullableHash(anchor.highestIssuedIntentHash) &&
    isSequence(anchor.highestAppliedReceiptSequence) &&
    isNullableHash(anchor.highestAppliedReceiptHash) &&
    isNullableHash(anchor.lastVerifiedPairedBackupManifestHash) &&
    ((anchor.writeCapabilityGeneration === 0 &&
      anchor.writeCapabilityEventHash === null) ||
      (anchor.writeCapabilityGeneration > 0 &&
        anchor.writeCapabilityEventHash !== null)) &&
    ((anchor.highestIssuedIntentSequence === 0 &&
      anchor.highestIssuedIntentHash === null) ||
      (anchor.highestIssuedIntentSequence > 0 &&
        anchor.highestIssuedIntentHash !== null)) &&
    ((anchor.highestAppliedReceiptSequence === 0 &&
      anchor.highestAppliedReceiptHash === null) ||
      (anchor.highestAppliedReceiptSequence > 0 &&
        anchor.highestAppliedReceiptHash !== null))
  );
}

function isSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isNullableHash(value: unknown): value is string | null {
  return value === null || isHash(value);
}

function hasSamePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = path.normalize(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function assertRestrictedIntegrityMacKeyFile(
  fileStatus: Stats,
  expectedUid: number,
): void {
  const permissions = fileStatus.mode & 0o777;
  if (
    !fileStatus.isFile() ||
    fileStatus.isSymbolicLink() ||
    fileStatus.uid !== expectedUid ||
    fileStatus.nlink !== 1 ||
    (permissions !== 0o400 && permissions !== 0o600)
  ) {
    throw new Error('The integrity key is invalid.');
  }
}

function assertSameFile(left: Stats, right: Stats): void {
  if (left.dev !== right.dev || left.ino !== right.ino) {
    throw new Error('The integrity key is invalid.');
  }
}

async function readBoundedIntegrityMacKey(file: FileHandle): Promise<Buffer> {
  const bytes = Buffer.alloc(MAXIMUM_INTEGRITY_MAC_KEY_BYTES + 1);
  try {
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length < 32 || length > MAXIMUM_INTEGRITY_MAC_KEY_BYTES) {
      throw new Error('The integrity key is invalid.');
    }
    return Buffer.from(bytes.subarray(0, length));
  } finally {
    bytes.fill(0);
  }
}
