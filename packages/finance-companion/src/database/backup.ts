import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  link,
  lstat,
  mkdtemp,
  open,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  parseIntegrityAnchorBytes,
  readIntegrityAnchor,
  readIntegrityAnchorBytes,
} from '#integrity/anchor';
import type { IntegrityAnchorV1 } from '#integrity/anchor';
import { canonicalJson, sha256 } from '#integrity/canonical-hash';

import { openCompanionDatabase, verifySqliteDatabase } from './connection.ts';
import { withExclusiveMaintenanceLock } from './maintenance-lock.ts';
import {
  assertDistinctExistingFiles,
  assertDistinctPaths,
  assertNoSqliteSidecars,
  canonicalExistingRegularFile,
  canonicalUnusedFile,
} from './path-safety.ts';

type GenerationZeroMetadata = Readonly<{
  instanceId: string;
  budgetKeyHash: string;
  currencyCode: string;
  schemaVersion: number;
}>;

type CompanionBackupEnvelope = Readonly<{
  formatVersion: 1;
  databaseSha256: string;
  instanceId: string;
  budgetKeyHash: string;
  currencyCode: string;
  schemaVersion: number;
  anchorSha256: string;
  anchor: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}>;

export type CompanionBackupRequest = Readonly<{
  databasePath: string;
  backupPath: string;
  encryptionKey: Buffer;
  anchorPath: string;
  anchorMacKey: Buffer;
  expectedInstanceId: string;
  expectedBudgetKeyHash: string;
  expectedCurrencyCode: string;
}>;

export type CompanionBackupResult = Readonly<{
  backupSha256: string;
  schemaVersion: number;
  budgetKeyHash: string;
}>;

export async function createCompanionOnlyBackup(
  request: CompanionBackupRequest,
): Promise<CompanionBackupResult> {
  validateEncryptionKey(request.encryptionKey);
  const paths = await validateBackupPaths(request, 'unused');
  return withExclusiveMaintenanceLock(paths.databasePath, async () => {
    await assertNoSqliteSidecars(paths.databasePath);
    const temporaryDirectory = await createOwnedBackupTemporaryDirectory(
      paths.backupPath,
    );
    const snapshotPath = path.join(temporaryDirectory, 'companion.sqlite');
    const stagedBackupPath = path.join(temporaryDirectory, 'container.staged');
    try {
      const database = openCompanionDatabase(paths.databasePath, true);
      let metadata: GenerationZeroMetadata;
      try {
        metadata = generationZeroMetadata(database, request);
        await database.backup(snapshotPath);
      } finally {
        database.close();
      }
      const snapshot = await readFile(snapshotPath);
      await readAndValidateLiveAnchor(
        paths.databasePath,
        paths.anchorPath,
        request,
        metadata,
      );
      const anchor = await readIntegrityAnchorBytes(paths.anchorPath);
      const envelope = encryptSnapshot(
        snapshot,
        anchor,
        metadata,
        request.encryptionKey,
      );
      const backupBytes = Buffer.from(canonicalJson(envelope), 'utf8');
      await writePublishedBackup(stagedBackupPath, backupBytes);
      const verified = await verifyBackupArtifact(
        request,
        stagedBackupPath,
        metadata,
      );
      await link(stagedBackupPath, paths.backupPath);
      return verified;
    } finally {
      await removeOwnedBackupTemporaryDirectory(
        temporaryDirectory,
        paths.backupPath,
      );
    }
  });
}

async function createOwnedBackupTemporaryDirectory(
  backupPath: string,
): Promise<string> {
  const parentDirectory = path.dirname(backupPath);
  const temporaryDirectory = await mkdtemp(
    path.join(parentDirectory, '.finance-companion-backup-'),
  );
  const status = await lstat(temporaryDirectory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error('The backup temporary directory is invalid.');
  }
  return temporaryDirectory;
}

async function removeOwnedBackupTemporaryDirectory(
  temporaryDirectory: string,
  backupPath: string,
): Promise<void> {
  const expectedParent = path.dirname(backupPath);
  if (
    path.dirname(temporaryDirectory) !== expectedParent ||
    !path.basename(temporaryDirectory).startsWith('.finance-companion-backup-')
  ) {
    throw new Error('The backup temporary directory cannot be removed safely.');
  }
  const status = await lstat(temporaryDirectory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error('The backup temporary directory cannot be removed safely.');
  }
  await rm(temporaryDirectory, { recursive: true, force: false });
}

export async function verifyCompanionOnlyBackup(
  request: CompanionBackupRequest,
): Promise<CompanionBackupResult> {
  validateEncryptionKey(request.encryptionKey);
  const paths = await validateBackupPaths(request, 'existing');
  return withExclusiveMaintenanceLock(paths.databasePath, async () => {
    await assertNoSqliteSidecars(paths.databasePath);
    const liveDatabase = openCompanionDatabase(paths.databasePath, true);
    let liveMetadata: GenerationZeroMetadata;
    try {
      liveMetadata = generationZeroMetadata(liveDatabase, request);
    } finally {
      liveDatabase.close();
    }
    await readAndValidateLiveAnchor(
      paths.databasePath,
      paths.anchorPath,
      request,
      liveMetadata,
    );
    return verifyBackupArtifact(request, paths.backupPath, liveMetadata);
  });
}

async function verifyBackupArtifact(
  request: CompanionBackupRequest,
  backupPath: string,
  expectedMetadata: GenerationZeroMetadata,
): Promise<CompanionBackupResult> {
  const temporaryPath = `${backupPath}.${randomUUID()}.verify.sqlite`;
  try {
    const envelope = await readEnvelope(backupPath);
    const snapshot = decryptSnapshot(envelope, request.encryptionKey);
    if (
      sha256(snapshot) !== envelope.databaseSha256 ||
      sha256(Buffer.from(envelope.anchor, 'base64')) !== envelope.anchorSha256
    ) {
      throw new Error('The companion backup hash does not match.');
    }
    const anchorPayload = parseIntegrityAnchorBytes(
      Buffer.from(envelope.anchor, 'base64'),
      request.anchorMacKey,
    );
    await writeFile(temporaryPath, snapshot, { mode: 0o600, flag: 'wx' });
    const database = openCompanionDatabase(temporaryPath, true);
    try {
      verifySqliteDatabase(database);
      const metadata = generationZeroMetadata(database, request);
      validateGenerationZeroAnchor(anchorPayload, metadata);
      if (
        metadata.instanceId !== envelope.instanceId ||
        metadata.budgetKeyHash !== envelope.budgetKeyHash ||
        metadata.currencyCode !== envelope.currencyCode ||
        metadata.schemaVersion !== envelope.schemaVersion ||
        metadata.instanceId !== expectedMetadata.instanceId ||
        metadata.budgetKeyHash !== expectedMetadata.budgetKeyHash ||
        metadata.currencyCode !== expectedMetadata.currencyCode ||
        metadata.schemaVersion !== expectedMetadata.schemaVersion
      ) {
        throw new Error('The companion backup metadata does not match.');
      }
    } finally {
      database.close();
    }
    return {
      backupSha256: sha256(await readFile(backupPath)),
      schemaVersion: envelope.schemaVersion,
      budgetKeyHash: envelope.budgetKeyHash,
    };
  } finally {
    await rm(temporaryPath, { force: true });
    await removeSqliteSidecars(temporaryPath);
  }
}

export async function restoreCompanionOnlyBackup(
  _request: CompanionBackupRequest,
): Promise<CompanionBackupResult> {
  throw new Error(
    'Companion restore activation requires explicit destructive-capability authorization.',
  );
}

function generationZeroMetadata(
  database: ReturnType<typeof openCompanionDatabase>,
  request: CompanionBackupRequest,
): GenerationZeroMetadata {
  const instance = database
    .prepare(
      'SELECT instance_id, budget_key_hash, budget_currency_code, write_capability_generation, write_capability_event_hash, write_capability_state FROM companion_instance WHERE singleton_key = ?',
    )
    .get('main') as
    | Readonly<{
        instance_id: string;
        budget_key_hash: string;
        budget_currency_code: string;
        write_capability_generation: number;
        write_capability_event_hash: string | null;
        write_capability_state: string;
      }>
    | undefined;
  const eventCount = (
    database
      .prepare('SELECT COUNT(*) AS count FROM write_capability_events')
      .get() as Readonly<{ count: number }>
  ).count;
  const principalCount = (
    database
      .prepare('SELECT COUNT(*) AS count FROM local_principals')
      .get() as Readonly<{ count: number }>
  ).count;
  if (
    instance === undefined ||
    instance.write_capability_generation !== 0 ||
    instance.write_capability_event_hash !== null ||
    eventCount !== 0 ||
    principalCount !== 1 ||
    instance.write_capability_state !== 'disabled' ||
    instance.instance_id !== request.expectedInstanceId ||
    instance.budget_key_hash !== request.expectedBudgetKeyHash ||
    instance.budget_currency_code !== request.expectedCurrencyCode
  ) {
    throw new Error(
      'A companion-only backup is not allowed for this database.',
    );
  }
  const schema = database
    .prepare('SELECT MAX(version) AS version FROM schema_migrations')
    .get() as Readonly<{ version: number }>;
  return {
    instanceId: instance.instance_id,
    budgetKeyHash: instance.budget_key_hash,
    currencyCode: instance.budget_currency_code,
    schemaVersion: schema.version,
  };
}

function encryptSnapshot(
  snapshot: Buffer,
  anchor: Buffer,
  metadata: GenerationZeroMetadata,
  key: Buffer,
): CompanionBackupEnvelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const authenticatedMetadata = {
    formatVersion: 1,
    databaseSha256: sha256(snapshot),
    instanceId: metadata.instanceId,
    budgetKeyHash: metadata.budgetKeyHash,
    currencyCode: metadata.currencyCode,
    schemaVersion: metadata.schemaVersion,
    anchorSha256: sha256(anchor),
    anchor: anchor.toString('base64'),
  } as const;
  cipher.setAAD(Buffer.from(canonicalJson(authenticatedMetadata), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(snapshot), cipher.final()]);
  return {
    ...authenticatedMetadata,
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptSnapshot(
  envelope: CompanionBackupEnvelope,
  key: Buffer,
): Buffer {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(envelope.nonce, 'base64'),
  );
  decipher.setAAD(
    Buffer.from(canonicalJson(authenticatedBackupMetadata(envelope)), 'utf8'),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
}

async function readEnvelope(
  backupPath: string,
): Promise<CompanionBackupEnvelope> {
  const serialized = await readFile(backupPath, 'utf8');
  const parsed: unknown = JSON.parse(serialized);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('The companion backup is invalid.');
  }
  const envelope = parsed as Partial<CompanionBackupEnvelope>;
  if (
    Object.keys(envelope).length !== 11 ||
    envelope.formatVersion !== 1 ||
    !isHash(envelope.databaseSha256) ||
    typeof envelope.instanceId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      envelope.instanceId,
    ) ||
    !isHash(envelope.budgetKeyHash) ||
    typeof envelope.currencyCode !== 'string' ||
    !/^[A-Z]{3}$/.test(envelope.currencyCode) ||
    typeof envelope.schemaVersion !== 'number' ||
    !Number.isSafeInteger(envelope.schemaVersion) ||
    envelope.schemaVersion < 1 ||
    !isHash(envelope.anchorSha256) ||
    !isCanonicalBase64(envelope.anchor) ||
    !isCanonicalBase64(envelope.nonce, 12) ||
    !isCanonicalBase64(envelope.tag, 16) ||
    !isCanonicalBase64(envelope.ciphertext) ||
    envelope.ciphertext.length === 0
  ) {
    throw new Error('The companion backup is invalid.');
  }
  const validatedEnvelope = envelope as CompanionBackupEnvelope;
  if (serialized !== canonicalJson(validatedEnvelope)) {
    throw new Error('The companion backup is not canonical.');
  }
  return validatedEnvelope;
}

async function writePublishedBackup(
  destination: string,
  bytes: Buffer,
): Promise<void> {
  const file = await open(destination, 'wx', 0o600);
  let didWrite = false;
  try {
    await file.writeFile(bytes);
    await file.sync();
    didWrite = true;
  } finally {
    await file.close();
    if (!didWrite) {
      await unlink(destination).catch(() => undefined);
    }
  }
}

function validateEncryptionKey(key: Buffer): void {
  if (key.length !== 32) {
    throw new Error('The backup encryption key is invalid.');
  }
}

async function validateBackupPaths(
  request: CompanionBackupRequest,
  backupState: 'existing' | 'unused',
): Promise<
  Readonly<{ databasePath: string; anchorPath: string; backupPath: string }>
> {
  const databasePath = await canonicalExistingRegularFile(request.databasePath);
  const anchorPath = await canonicalExistingRegularFile(request.anchorPath);
  const backupPath =
    backupState === 'existing'
      ? await canonicalExistingRegularFile(request.backupPath)
      : await canonicalUnusedFile(request.backupPath);
  assertDistinctPaths([databasePath, anchorPath, backupPath]);
  await assertDistinctExistingFiles(
    backupState === 'existing'
      ? [databasePath, anchorPath, backupPath]
      : [databasePath, anchorPath],
  );
  return { databasePath, anchorPath, backupPath };
}

function validateGenerationZeroAnchor(
  anchor: IntegrityAnchorV1,
  metadata: GenerationZeroMetadata,
): void {
  if (
    anchor.budgetKeyHash !== metadata.budgetKeyHash ||
    anchor.writeCapabilityGeneration !== 0 ||
    anchor.writeCapabilityEventHash !== null ||
    anchor.highestIssuedIntentSequence !== 0 ||
    anchor.highestIssuedIntentHash !== null ||
    anchor.highestAppliedReceiptSequence !== 0 ||
    anchor.highestAppliedReceiptHash !== null ||
    anchor.lastVerifiedPairedBackupManifestHash !== null
  ) {
    throw new Error('The generation-zero integrity anchor does not match.');
  }
}

async function readAndValidateLiveAnchor(
  databasePath: string,
  anchorPath: string,
  request: CompanionBackupRequest,
  metadata: GenerationZeroMetadata,
): Promise<IntegrityAnchorV1> {
  try {
    const anchor = await readIntegrityAnchor(anchorPath, request.anchorMacKey);
    validateGenerationZeroAnchor(anchor, metadata);
    return anchor;
  } catch (error) {
    markRecoveryRequired(databasePath);
    throw error;
  }
}

function markRecoveryRequired(databasePath: string): void {
  const database = openCompanionDatabase(databasePath, true);
  try {
    database
      .prepare(
        "UPDATE companion_instance SET write_capability_state = 'recovery_required' WHERE singleton_key = 'main'",
      )
      .run();
  } finally {
    database.close();
  }
}

function authenticatedBackupMetadata(
  envelope: CompanionBackupEnvelope,
): Omit<CompanionBackupEnvelope, 'nonce' | 'tag' | 'ciphertext'> {
  return {
    formatVersion: envelope.formatVersion,
    databaseSha256: envelope.databaseSha256,
    instanceId: envelope.instanceId,
    budgetKeyHash: envelope.budgetKeyHash,
    currencyCode: envelope.currencyCode,
    schemaVersion: envelope.schemaVersion,
    anchorSha256: envelope.anchorSha256,
    anchor: envelope.anchor,
  };
}

async function removeSqliteSidecars(databasePath: string): Promise<void> {
  await Promise.all(
    ['-wal', '-shm', '-journal'].map(suffix =>
      rm(`${databasePath}${suffix}`, { force: true }),
    ),
  );
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isCanonicalBase64(
  value: unknown,
  expectedBytes?: number,
): value is string {
  if (typeof value !== 'string') return false;
  const bytes = Buffer.from(value, 'base64');
  return (
    bytes.toString('base64') === value &&
    (expectedBytes === undefined || bytes.length === expectedBytes)
  );
}
