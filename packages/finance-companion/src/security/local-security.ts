import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import * as argon2 from 'argon2';

const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SESSION_IDLE_MILLISECONDS = 30 * 60 * 1000;
const SESSION_ABSOLUTE_MILLISECONDS = 12 * 60 * 60 * 1000;
const LOGIN_BUCKET_CAPACITY = 5;
const LOGIN_REFILL_MILLISECONDS = 60 * 1000;

export type LocalPrincipal = Readonly<{
  id: string;
  credentialHash: string;
}>;

export type LocalPrincipalRepository = Readonly<{
  readOwner: () => Promise<LocalPrincipal | null>;
  writeOwner: (principal: LocalPrincipal) => Promise<void>;
  replaceOwnerCredentialHash: (
    principalId: string,
    credentialHash: string,
    rotatedAt: string,
  ) => Promise<boolean>;
}>;

type Session = Readonly<{
  csrfToken: string;
  expiresAt: number;
  lastUsedAt: number;
  principalId: string;
  createdAt: number;
}>;

export type FinanceCompanionSecurity = Readonly<{
  login: (credential: string) => Promise<LoginResult | 'rate-limited' | null>;
  readSession: (
    sessionId: string | undefined,
    csrfToken?: string,
  ) => SessionResult | 'csrf-rejected' | null;
  revokeSession: (sessionId: string | undefined) => boolean;
  rotateOwnerCredential: (
    credential: string,
  ) => Promise<RotateOwnerCredentialResult | null>;
}>;

export type LoginResult = Readonly<{
  csrfToken: string;
  expiresAt: string;
  principalId: string;
  sessionId: string;
}>;

export type SessionResult = Readonly<{
  principalId: string;
}>;

export type RotateOwnerCredentialResult = Readonly<{
  principalId: string;
  rotatedAt: string;
}>;

export type CreateFinanceCompanionSecurityOptions = Readonly<{
  bootstrapCredential?: string;
  bootstrapCredentialFile?: string;
  localPrincipalRepository: LocalPrincipalRepository;
  now?: () => number;
}>;

export function createInMemoryLocalPrincipalRepository(): LocalPrincipalRepository {
  let principal: LocalPrincipal | null = null;
  return {
    readOwner: async () => principal,
    writeOwner: async nextPrincipal => {
      principal = nextPrincipal;
    },
    replaceOwnerCredentialHash: async (
      principalId,
      credentialHash,
      _rotatedAt,
    ) => {
      if (principal?.id !== principalId) return false;
      principal = { ...principal, credentialHash };
      return true;
    },
  };
}

export async function createFinanceCompanionSecurity({
  bootstrapCredential,
  bootstrapCredentialFile,
  localPrincipalRepository,
  now = Date.now,
}: CreateFinanceCompanionSecurityOptions): Promise<FinanceCompanionSecurity> {
  const existingPrincipal = await localPrincipalRepository.readOwner();
  const credential = await readBootstrapCredential(
    bootstrapCredential,
    bootstrapCredentialFile,
  );
  if (existingPrincipal === null && credential === undefined) {
    throw new Error('An owner credential must be configured before startup.');
  }
  let principal =
    existingPrincipal ??
    (credential === undefined
      ? null
      : await createOwnerPrincipal(credential, localPrincipalRepository));
  const dummyHash = await hashCredential(randomBytes(32).toString('base64url'));
  const sessions = new Map<string, Session>();
  let loginTokens = LOGIN_BUCKET_CAPACITY;
  let lastRefillAt = now();

  return {
    login: async submittedCredential => {
      const currentTime = now();
      loginTokens = Math.min(
        LOGIN_BUCKET_CAPACITY,
        loginTokens +
          Math.floor((currentTime - lastRefillAt) / LOGIN_REFILL_MILLISECONDS),
      );
      if (loginTokens < LOGIN_BUCKET_CAPACITY) {
        lastRefillAt +=
          Math.floor((currentTime - lastRefillAt) / LOGIN_REFILL_MILLISECONDS) *
          LOGIN_REFILL_MILLISECONDS;
      } else {
        lastRefillAt = currentTime;
      }
      if (loginTokens < 1) return 'rate-limited';
      loginTokens -= 1;

      const hash = principal?.credentialHash ?? dummyHash;
      const verified = await verifyCredential(submittedCredential, hash);
      if (!verified || principal === null) return null;

      const sessionId = randomBytes(32).toString('base64url');
      const csrfToken = randomBytes(32).toString('base64url');
      const expiresAt = currentTime + SESSION_ABSOLUTE_MILLISECONDS;
      sessions.set(sessionId, {
        csrfToken,
        expiresAt,
        lastUsedAt: currentTime,
        principalId: principal.id,
        createdAt: currentTime,
      });
      return {
        csrfToken,
        expiresAt: new Date(expiresAt).toISOString(),
        principalId: principal.id,
        sessionId,
      };
    },
    readSession: (sessionId, csrfToken) => {
      if (sessionId === undefined) return null;
      const session = sessions.get(sessionId);
      const currentTime = now();
      if (
        session === undefined ||
        currentTime >= session.expiresAt ||
        currentTime - session.lastUsedAt >= SESSION_IDLE_MILLISECONDS
      ) {
        sessions.delete(sessionId);
        return null;
      }
      if (
        csrfToken !== undefined &&
        !hasEqualSecret(session.csrfToken, csrfToken)
      ) {
        return 'csrf-rejected';
      }
      sessions.set(sessionId, { ...session, lastUsedAt: currentTime });
      return { principalId: session.principalId };
    },
    revokeSession: sessionId =>
      sessionId !== undefined && sessions.delete(sessionId),
    rotateOwnerCredential: async credentialToRotate => {
      if (principal === null) return null;
      const credentialHash = await hashCredential(
        validateCredential(credentialToRotate),
      );
      const rotatedAt = new Date(now()).toISOString();
      const replaced =
        await localPrincipalRepository.replaceOwnerCredentialHash(
          principal.id,
          credentialHash,
          rotatedAt,
        );
      if (!replaced) return null;
      principal = { ...principal, credentialHash };
      sessions.clear();
      return { principalId: principal.id, rotatedAt };
    },
  };
}

async function createOwnerPrincipal(
  credential: string,
  localPrincipalRepository: LocalPrincipalRepository,
): Promise<LocalPrincipal> {
  const principal: LocalPrincipal = {
    id: randomUUID(),
    credentialHash: await hashCredential(credential),
  };
  await localPrincipalRepository.writeOwner(principal);
  return principal;
}

async function readBootstrapCredential(
  directCredential: string | undefined,
  credentialFile: string | undefined,
): Promise<string | undefined> {
  if (directCredential !== undefined && credentialFile !== undefined) {
    throw new Error('Only one owner bootstrap credential source is allowed.');
  }
  if (directCredential !== undefined) {
    return validateCredential(directCredential);
  }
  if (credentialFile === undefined) return undefined;
  if (process.platform === 'win32') {
    throw new Error(
      'Owner credential files are not supported on Windows; use the development credential environment source.',
    );
  }

  const sourcePathStatus = await lstat(credentialFile);
  if (!sourcePathStatus.isFile() || sourcePathStatus.isSymbolicLink()) {
    throw new Error('The owner bootstrap credential file is invalid.');
  }
  const resolvedPath = await realpath(credentialFile);
  if (!hasSamePath(path.resolve(credentialFile), resolvedPath)) {
    throw new Error('The owner bootstrap credential file is invalid.');
  }
  const fileStatus = await lstat(resolvedPath);
  if (!fileStatus.isFile() || fileStatus.isSymbolicLink()) {
    throw new Error('The owner bootstrap credential file is invalid.');
  }
  if ((fileStatus.mode & 0o077) !== 0) {
    throw new Error('The owner bootstrap credential file is invalid.');
  }
  const source = await readFile(resolvedPath);
  try {
    const content = source.toString('ascii');
    if (!source.equals(Buffer.from(content, 'ascii'))) {
      throw new Error('The owner bootstrap credential file is invalid.');
    }
    return validateCredential(content.replace(/\r?\n$/, ''));
  } finally {
    source.fill(0);
  }
}

function hasSamePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = path.normalize(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function validateCredential(credential: string): string {
  if (!CREDENTIAL_PATTERN.test(credential) || credential.includes('=')) {
    throw new Error('The owner bootstrap credential is invalid.');
  }
  const decoded = Buffer.from(credential, 'base64url');
  if (
    decoded.length < 32 ||
    decoded.length > 64 ||
    decoded.toString('base64url') !== credential
  ) {
    throw new Error('The owner bootstrap credential is invalid.');
  }
  return credential;
}

async function hashCredential(credential: string): Promise<string> {
  return argon2.hash(credential, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
}

async function verifyCredential(
  credential: string,
  hash: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, credential);
  } catch {
    return false;
  }
}

function hasEqualSecret(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}
