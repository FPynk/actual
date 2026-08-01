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
  rename,
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
import { hasRestoreRecoveryArtifacts } from './restore-journal.ts';

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

export type CompanionRestorePhase =
  | 'intent-written'
  | 'database-original-staged'
  | 'database-replaced'
  | 'anchor-original-staged'
  | 'anchor-replaced';

export type CompanionRestoreTestHooks = Readonly<{
  afterPhase?: (phase: CompanionRestorePhase) => void;
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
  assertNoRestoreArtifacts(request.databasePath, request.anchorPath);
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
  const artifact = await readVerifiedBackupArtifact(request, backupPath);
  try {
    if (
      artifact.metadata.instanceId !== expectedMetadata.instanceId ||
      artifact.metadata.budgetKeyHash !== expectedMetadata.budgetKeyHash ||
      artifact.metadata.currencyCode !== expectedMetadata.currencyCode ||
      artifact.metadata.schemaVersion !== expectedMetadata.schemaVersion
    ) {
      throw new Error('The companion backup metadata does not match.');
    }
    return artifact.result;
  } finally {
    artifact.snapshot.fill(0);
    artifact.anchor.fill(0);
  }
}

type VerifiedBackupArtifact = Readonly<{
  anchor: Buffer;
  metadata: GenerationZeroMetadata;
  result: CompanionBackupResult;
  snapshot: Buffer;
}>;

async function readVerifiedBackupArtifact(
  request: CompanionBackupRequest,
  backupPath: string,
): Promise<VerifiedBackupArtifact> {
  const temporaryPath = `${backupPath}.${randomUUID()}.verify.sqlite`;
  let snapshot: Buffer | undefined;
  let anchorBytes: Buffer | undefined;
  try {
    const envelope = await readEnvelope(backupPath);
    snapshot = decryptSnapshot(envelope, request.encryptionKey);
    anchorBytes = Buffer.from(envelope.anchor, 'base64');
    if (
      sha256(snapshot) !== envelope.databaseSha256 ||
      sha256(anchorBytes) !== envelope.anchorSha256
    ) {
      throw new Error('The companion backup hash does not match.');
    }
    const anchorPayload = parseIntegrityAnchorBytes(
      anchorBytes,
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
        metadata.schemaVersion !== envelope.schemaVersion
      ) {
        throw new Error('The companion backup metadata does not match.');
      }
      return {
        anchor: anchorBytes,
        metadata,
        result: {
          backupSha256: sha256(await readFile(backupPath)),
          schemaVersion: envelope.schemaVersion,
          budgetKeyHash: envelope.budgetKeyHash,
        },
        snapshot,
      };
    } finally {
      database.close();
    }
  } finally {
    if (snapshot === undefined || anchorBytes === undefined) {
      snapshot?.fill(0);
      anchorBytes?.fill(0);
    }
    await rm(temporaryPath, { force: true });
    await removeSqliteSidecars(temporaryPath);
  }
}

export async function restoreCompanionOnlyBackup(
  request: CompanionBackupRequest,
  testHooks: CompanionRestoreTestHooks = {},
): Promise<CompanionBackupResult> {
  validateEncryptionKey(request.encryptionKey);
  assertNoRestoreArtifacts(request.databasePath, request.anchorPath);
  const paths = await validateBackupPaths(request, 'existing');
  assertNoRestoreArtifacts(paths.databasePath, paths.anchorPath);
  return withExclusiveMaintenanceLock(paths.databasePath, async () => {
    await assertNoSqliteSidecars(paths.databasePath);
    assertNoRestoreArtifacts(paths.databasePath, paths.anchorPath);
    const artifact = await readVerifiedBackupArtifact(
      request,
      paths.backupPath,
    );
    try {
      return await replaceCompanionPair(paths, artifact, request, testHooks);
    } finally {
      artifact.snapshot.fill(0);
      artifact.anchor.fill(0);
    }
  });
}

type RestorePaths = Readonly<{
  databasePath: string;
  anchorPath: string;
  backupPath: string;
}>;

async function replaceCompanionPair(
  paths: RestorePaths,
  artifact: VerifiedBackupArtifact,
  request: CompanionBackupRequest,
  testHooks: CompanionRestoreTestHooks,
): Promise<CompanionBackupResult> {
  const operationId = randomUUID();
  const databaseStagePath = restoreSibling(
    paths.databasePath,
    operationId,
    'stage',
  );
  const databaseRollbackPath = restoreSibling(
    paths.databasePath,
    operationId,
    'rollback',
  );
  const anchorStagePath = restoreSibling(
    paths.anchorPath,
    operationId,
    'stage',
  );
  const anchorRollbackPath = restoreSibling(
    paths.anchorPath,
    operationId,
    'rollback',
  );
  const intentPath = path.join(
    path.dirname(paths.anchorPath),
    `.finance-companion-restore-intent-${operationId}.json`,
  );
  const state = {
    anchorInstalled: false,
    anchorOriginalStaged: false,
    databaseInstalled: false,
    databaseOriginalStaged: false,
  };
  try {
    await writePublishedBackup(databaseStagePath, artifact.snapshot);
    await writePublishedBackup(anchorStagePath, artifact.anchor);
    await verifyRestoreStages(
      databaseStagePath,
      anchorStagePath,
      request,
      artifact.metadata,
    );
    await writeRestoreIntent(intentPath, artifact.result.backupSha256);
    testHooks.afterPhase?.('intent-written');

    await rename(paths.databasePath, databaseRollbackPath);
    state.databaseOriginalStaged = true;
    testHooks.afterPhase?.('database-original-staged');
    await rename(databaseStagePath, paths.databasePath);
    state.databaseInstalled = true;
    testHooks.afterPhase?.('database-replaced');

    await rename(paths.anchorPath, anchorRollbackPath);
    state.anchorOriginalStaged = true;
    testHooks.afterPhase?.('anchor-original-staged');
    await rename(anchorStagePath, paths.anchorPath);
    state.anchorInstalled = true;
    testHooks.afterPhase?.('anchor-replaced');

    await removeRestoreArtifacts([
      databaseRollbackPath,
      anchorRollbackPath,
      intentPath,
    ]);
    return artifact.result;
  } catch (error) {
    if (error instanceof SimulatedRestoreInterruption) {
      throw error;
    }
    const wasRolledBack = await rollbackCompanionPair(paths, {
      anchorRollbackPath,
      databaseRollbackPath,
      ...state,
    });
    if (!wasRolledBack) {
      throw new Error('Companion restore requires recovery.');
    }
    await removeRestoreArtifacts([
      databaseStagePath,
      anchorStagePath,
      databaseRollbackPath,
      anchorRollbackPath,
      intentPath,
    ]);
    throw error;
  }
}

async function verifyRestoreStages(
  databasePath: string,
  anchorPath: string,
  request: CompanionBackupRequest,
  expectedMetadata: GenerationZeroMetadata,
): Promise<void> {
  const database = openCompanionDatabase(databasePath, true);
  try {
    verifySqliteDatabase(database);
    const metadata = generationZeroMetadata(database, request);
    const anchor = await readIntegrityAnchor(anchorPath, request.anchorMacKey);
    validateGenerationZeroAnchor(anchor, metadata);
    if (
      metadata.instanceId !== expectedMetadata.instanceId ||
      metadata.budgetKeyHash !== expectedMetadata.budgetKeyHash ||
      metadata.currencyCode !== expectedMetadata.currencyCode ||
      metadata.schemaVersion !== expectedMetadata.schemaVersion
    ) {
      throw new Error(
        'The staged companion restore does not match its backup.',
      );
    }
  } finally {
    database.close();
  }
  await assertNoSqliteSidecars(databasePath);
}

async function writeRestoreIntent(
  intentPath: string,
  backupSha256: string,
): Promise<void> {
  await writePublishedBackup(
    intentPath,
    Buffer.from(canonicalJson({ backupSha256, formatVersion: 1 }), 'utf8'),
  );
}

async function rollbackCompanionPair(
  paths: RestorePaths,
  state: Readonly<{
    databaseOriginalStaged: boolean;
    databaseInstalled: boolean;
    anchorOriginalStaged: boolean;
    anchorInstalled: boolean;
    databaseRollbackPath: string;
    anchorRollbackPath: string;
  }>,
): Promise<boolean> {
  try {
    if (state.anchorInstalled) await unlink(paths.anchorPath);
    if (state.anchorOriginalStaged) {
      await rename(state.anchorRollbackPath, paths.anchorPath);
    }
    if (state.databaseInstalled) await unlink(paths.databasePath);
    if (state.databaseOriginalStaged) {
      await rename(state.databaseRollbackPath, paths.databasePath);
    }
    return true;
  } catch {
    return false;
  }
}

function restoreSibling(
  protectedPath: string,
  operationId: string,
  type: 'stage' | 'rollback',
): string {
  return path.join(
    path.dirname(protectedPath),
    `.${path.basename(protectedPath)}.restore-${operationId}.${type}`,
  );
}

function assertNoRestoreArtifacts(
  databasePath: string,
  anchorPath: string,
): void {
  if (hasRestoreRecoveryArtifacts(databasePath, anchorPath)) {
    throw new Error('Companion restore requires recovery.');
  }
}

async function removeRestoreArtifacts(paths: readonly string[]): Promise<void> {
  for (const artifactPath of paths) {
    await unlink(artifactPath).catch(error => {
      if (!isMissingPathError(error)) throw error;
    });
  }
}

export class SimulatedRestoreInterruption extends Error {
  constructor() {
    super('The synthetic restore was interrupted.');
    this.name = 'SimulatedRestoreInterruption';
  }
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

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
