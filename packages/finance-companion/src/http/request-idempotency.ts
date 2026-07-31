import { canonicalJson, sha256 } from '#integrity/canonical-hash';
import type { CanonicalJsonValue } from '#integrity/canonical-hash';

export type AmazonUploadSemanticRequest = Readonly<{
  adapterVersion: 'amazon-import/v1';
  byteHash: string;
  mediaKind: 'text/csv';
}>;

export function calculateRequestReplayHash(value: CanonicalJsonValue): string {
  return sha256(
    Buffer.from(
      `finance-companion/request-replay/semantic/v1\0${canonicalJson(value)}`,
      'utf8',
    ),
  );
}

export function createAmazonUploadSemanticRequest(
  value: unknown,
): AmazonUploadSemanticRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    record.adapterVersion !== 'amazon-import/v1' ||
    record.mediaKind !== 'text/csv' ||
    typeof record.byteHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.byteHash)
  ) {
    return null;
  }
  return {
    adapterVersion: record.adapterVersion,
    mediaKind: record.mediaKind,
    byteHash: record.byteHash,
  };
}
