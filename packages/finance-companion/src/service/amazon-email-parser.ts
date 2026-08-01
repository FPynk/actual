import { TextDecoder } from 'node:util';

import { sha256 } from '#integrity/canonical-hash';
import {
  normalizeAmazonRecordDto,
  sha256Parts,
} from '#service/amazon-export-repository';
import type {
  AmazonExportParser,
  AmazonExportRecord,
} from '#service/amazon-export-repository';

const MAXIMUM_EMAIL_BYTES = 10 * 1024 * 1024;
const MAXIMUM_HEADER_BYTES = 64 * 1024;
const MAXIMUM_HEADER_FIELDS = 128;
const MAXIMUM_MIME_PARTS = 32;
const MAXIMUM_MIME_DEPTH = 4;
const MAXIMUM_DECODED_BYTES = 2 * 1024 * 1024;
const MAXIMUM_VISIBLE_LINES = 100_000;
const MAXIMUM_VISIBLE_LINE_BYTES = 8 * 1024;
const MAXIMUM_EMAIL_RECORDS = 1_000;
const RECORD_POSITION_MULTIPLIER = 1_000_000;
const RECORD_MARKER = 'Actual-Amazon-Record-V1: ';
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

type AmazonEmailMessageType = 'confirmation' | 'shipment' | 'refund';
type MimeState = {
  partCount: number;
  decodedBytes: number;
};
type VisiblePart = Readonly<{
  partNumber: number;
  body: string;
}>;

export type AmazonEmailParser = AmazonExportParser;

export function createRfc5322AmazonEmailParser(version = 1): AmazonEmailParser {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('Invalid Amazon email parser version.');
  }
  return {
    name: 'amazon-eml-rfc5322',
    version,
    parse: parseAmazonEmail,
  };
}

function parseAmazonEmail(bytes: Buffer): readonly AmazonExportRecord[] {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAXIMUM_EMAIL_BYTES) {
    throw new Error('Invalid Amazon email input.');
  }
  const rawMessage = canonicalizeLineEndings(decodeUtf8(bytes));
  const message = splitEntity(rawMessage);
  const headers = parseHeaders(message.headers);
  if (
    headers.get('mime-version') !== '1.0' ||
    headers.get('x-actual-amazon-adapter') !== 'v1'
  ) {
    throw new Error('Unsupported Amazon email format.');
  }
  const messageType = requiredMessageType(headers);
  const messageIdentityHash = sha256Parts([
    normalizedMessageIdentity(headers.get('message-id')) ?? sha256(bytes),
  ]);
  const state: MimeState = { partCount: 0, decodedBytes: 0 };
  const visibleParts = collectVisibleParts(headers, message.body, 0, state);
  if (visibleParts.length === 0) {
    throw new Error('Amazon email has no supported visible body.');
  }

  const records: AmazonExportRecord[] = [];
  for (const part of visibleParts) {
    const lines = splitVisibleLines(part.body);
    if (lines.length > MAXIMUM_VISIBLE_LINES) {
      throw new Error('Amazon email body has too many lines.');
    }
    for (const [lineIndex, line] of lines.entries()) {
      if (Buffer.byteLength(line, 'utf8') > MAXIMUM_VISIBLE_LINE_BYTES) {
        throw new Error('Amazon email body line is too long.');
      }
      if (!line.startsWith(RECORD_MARKER)) continue;
      if (records.length >= MAXIMUM_EMAIL_RECORDS) {
        throw new Error('Amazon email has too many records.');
      }
      records.push(
        parseVisibleRecord(
          line.slice(RECORD_MARKER.length),
          messageIdentityHash,
          part.partNumber,
          lineIndex + 1,
        ),
      );
    }
  }
  validateMessageRecords(messageType, records);
  return records;
}

function parseVisibleRecord(
  json: string,
  messageIdentityHash: string,
  partNumber: number,
  lineNumber: number,
): AmazonExportRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid Amazon email record.');
  }
  if (!isObject(parsed)) {
    throw new Error('Invalid Amazon email record.');
  }
  for (const reserved of ['sectionName', 'recordNumber', 'sourceRowKey']) {
    if (reserved in parsed) {
      throw new Error('Invalid Amazon email record.');
    }
  }
  const kind = parsed.kind;
  if (!['order', 'shipment', 'item', 'refund'].includes(String(kind))) {
    throw new Error('Invalid Amazon email record.');
  }
  const sourcePosition = `${partNumber}.${lineNumber}`;
  const recordNumber =
    (partNumber - 1) * RECORD_POSITION_MULTIPLIER + lineNumber;
  return normalizeAmazonRecordDto({
    ...parsed,
    sectionName: 'email',
    recordNumber,
    sourceRowKey: `eml/${messageIdentityHash}/${String(kind)}/${sourcePosition}`,
  });
}

function validateMessageRecords(
  messageType: AmazonEmailMessageType,
  records: readonly AmazonExportRecord[],
): void {
  if (records.length === 0) {
    throw new Error('Amazon email has no supported records.');
  }
  const allowedKinds: Readonly<
    Record<AmazonEmailMessageType, readonly string[]>
  > = {
    confirmation: ['order', 'item'],
    shipment: ['order', 'shipment', 'item'],
    refund: ['order', 'item', 'refund'],
  };
  const requiredKind: Readonly<Record<AmazonEmailMessageType, string>> = {
    confirmation: 'order',
    shipment: 'shipment',
    refund: 'refund',
  };
  if (
    records.some(record => !allowedKinds[messageType].includes(record.kind)) ||
    !records.some(record => record.kind === requiredKind[messageType])
  ) {
    throw new Error('Amazon email records do not match its message type.');
  }
  const first = records[0];
  if (
    first === undefined ||
    records.some(
      record =>
        record.marketplace !== first.marketplace ||
        record.externalOrderId !== first.externalOrderId,
    )
  ) {
    throw new Error('Amazon email contains multiple orders.');
  }
}

function collectVisibleParts(
  headers: ReadonlyMap<string, string>,
  body: string,
  depth: number,
  state: MimeState,
): readonly VisiblePart[] {
  if (depth > MAXIMUM_MIME_DEPTH) {
    throw new Error('Amazon email MIME nesting is too deep.');
  }
  const contentType = withTransferEncoding(
    headers,
    parseContentType(headers.get('content-type')),
  );
  if (contentType.mediaType.startsWith('multipart/')) {
    if (contentType.transferEncoding !== '7bit') {
      throw new Error('Unsupported multipart transfer encoding.');
    }
    const boundary = contentType.parameters.get('boundary');
    if (boundary === undefined || !isValidBoundary(boundary)) {
      throw new Error('Invalid Amazon email MIME boundary.');
    }
    const visible: VisiblePart[] = [];
    for (const entity of splitMultipartBody(body, boundary)) {
      const child = splitEntity(entity);
      visible.push(
        ...collectVisibleParts(
          parseHeaders(child.headers),
          child.body,
          depth + 1,
          state,
        ),
      );
    }
    return visible;
  }

  state.partCount += 1;
  if (state.partCount > MAXIMUM_MIME_PARTS) {
    throw new Error('Amazon email has too many MIME parts.');
  }
  const decoded = decodeTransferBody(body, contentType.transferEncoding);
  state.decodedBytes += decoded.length;
  if (state.decodedBytes > MAXIMUM_DECODED_BYTES) {
    throw new Error('Amazon email decoded content is too large.');
  }
  const disposition = headers.get('content-disposition')?.toLowerCase();
  if (disposition?.startsWith('attachment')) return [];
  if (contentType.mediaType !== 'text/plain') return [];
  const charset = (contentType.parameters.get('charset') ?? 'us-ascii')
    .toLowerCase()
    .replace(/^"|"$/g, '');
  if (charset !== 'utf-8' && charset !== 'us-ascii') {
    throw new Error('Unsupported Amazon email charset.');
  }
  if (charset === 'us-ascii' && decoded.some(byte => byte > 0x7f)) {
    throw new Error('Invalid Amazon email text encoding.');
  }
  const visibleText = canonicalizeLineEndings(decodeUtf8(decoded));
  return [{ partNumber: state.partCount, body: visibleText }];
}

function parseContentType(value: string | undefined): Readonly<{
  mediaType: string;
  parameters: ReadonlyMap<string, string>;
  transferEncoding: '7bit' | '8bit' | 'base64' | 'quoted-printable';
}> {
  const fields = splitParameters(value ?? 'text/plain; charset=us-ascii');
  const mediaType = fields[0]?.toLowerCase();
  if (
    mediaType === undefined ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)
  ) {
    throw new Error('Invalid Amazon email content type.');
  }
  const parameters = new Map<string, string>();
  for (const field of fields.slice(1)) {
    const separator = field.indexOf('=');
    if (separator < 1) throw new Error('Invalid MIME parameter.');
    const name = field.slice(0, separator).trim().toLowerCase();
    const parameterValue = parseParameterValue(field.slice(separator + 1));
    if (!/^[a-z0-9!#$&^_.+-]+$/.test(name) || parameters.has(name)) {
      throw new Error('Invalid MIME parameter.');
    }
    parameters.set(name, parameterValue);
  }
  return {
    mediaType,
    parameters,
    transferEncoding: '7bit',
  };
}

function withTransferEncoding(
  headers: ReadonlyMap<string, string>,
  parsed: ReturnType<typeof parseContentType>,
): ReturnType<typeof parseContentType> {
  const value = (
    headers.get('content-transfer-encoding') ?? '7bit'
  ).toLowerCase();
  if (!['7bit', '8bit', 'base64', 'quoted-printable'].includes(value)) {
    throw new Error('Unsupported Amazon email transfer encoding.');
  }
  return {
    ...parsed,
    transferEncoding: value as ReturnType<
      typeof parseContentType
    >['transferEncoding'],
  };
}

function parseHeaders(rawHeaders: string): ReadonlyMap<string, string> {
  if (Buffer.byteLength(rawHeaders, 'utf8') > MAXIMUM_HEADER_BYTES) {
    throw new Error('Amazon email headers are too large.');
  }
  const lines = rawHeaders.length === 0 ? [] : rawHeaders.split('\r\n');
  const unfolded: string[] = [];
  for (const line of lines) {
    if (
      Buffer.byteLength(line, 'utf8') > 998 ||
      [...line].some(character => {
        const code = character.charCodeAt(0);
        return code !== 9 && (code < 32 || code > 126);
      })
    ) {
      throw new Error('Invalid Amazon email header line.');
    }
    if (/^[ \t]/.test(line)) {
      const previous = unfolded.at(-1);
      if (previous === undefined) {
        throw new Error('Invalid folded email header.');
      }
      unfolded[unfolded.length - 1] = `${previous} ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }
  if (unfolded.length > MAXIMUM_HEADER_FIELDS) {
    throw new Error('Amazon email has too many headers.');
  }
  const headers = new Map<string, string>();
  for (const line of unfolded) {
    const separator = line.indexOf(':');
    if (separator < 1) throw new Error('Invalid Amazon email header.');
    const name = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      throw new Error('Invalid Amazon email header name.');
    }
    if (headers.has(name)) {
      throw new Error('Duplicate Amazon email header.');
    }
    headers.set(name, value);
  }
  return headers;
}

function splitEntity(raw: string): Readonly<{ headers: string; body: string }> {
  const separator = raw.indexOf('\r\n\r\n');
  if (separator < 0) throw new Error('Invalid Amazon email entity.');
  return {
    headers: raw.slice(0, separator),
    body: raw.slice(separator + 4),
  };
}

function splitMultipartBody(body: string, boundary: string): readonly string[] {
  const opening = `--${boundary}`;
  const closing = `--${boundary}--`;
  const lines = body.split('\r\n');
  const parts: string[] = [];
  let current: string[] | null = null;
  let closed = false;
  for (const line of lines) {
    if (line === opening) {
      if (closed) throw new Error('Invalid Amazon email MIME boundary.');
      if (current !== null) parts.push(current.join('\r\n'));
      current = [];
      continue;
    }
    if (line === closing) {
      if (current === null || closed) {
        throw new Error('Invalid Amazon email MIME boundary.');
      }
      parts.push(current.join('\r\n'));
      current = null;
      closed = true;
      continue;
    }
    if (current !== null) current.push(line);
  }
  if (!closed || parts.length === 0) {
    throw new Error('Incomplete Amazon email MIME body.');
  }
  return parts;
}

function decodeTransferBody(
  body: string,
  transferEncoding: ReturnType<typeof parseContentType>['transferEncoding'],
): Buffer {
  if (transferEncoding === 'base64') {
    const compact = body.replaceAll('\r\n', '');
    if (
      compact.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        compact,
      )
    ) {
      throw new Error('Invalid base64 email body.');
    }
    return Buffer.from(compact, 'base64');
  }
  if (transferEncoding === 'quoted-printable') {
    return decodeQuotedPrintable(body);
  }
  const encoded = Buffer.from(body, 'utf8');
  if (transferEncoding === '7bit' && encoded.some(byte => byte > 0x7f)) {
    throw new Error('Invalid 7bit email body.');
  }
  return encoded;
}

function decodeQuotedPrintable(body: string): Buffer {
  if (
    [...body].some(character => {
      const code = character.charCodeAt(0);
      return (
        code !== 9 && code !== 10 && code !== 13 && (code < 32 || code > 126)
      );
    })
  ) {
    throw new Error('Invalid quoted-printable email body.');
  }
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== '=') {
      bytes.push(character?.charCodeAt(0) ?? 0);
      continue;
    }
    if (body.slice(index, index + 3) === '=\r\n') {
      index += 2;
      continue;
    }
    const encoded = body.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(encoded)) {
      throw new Error('Invalid quoted-printable email body.');
    }
    bytes.push(Number.parseInt(encoded, 16));
    index += 2;
  }
  return Buffer.from(bytes);
}

function requiredMessageType(
  headers: ReadonlyMap<string, string>,
): AmazonEmailMessageType {
  const value = headers.get('x-actual-amazon-type');
  if (value !== 'confirmation' && value !== 'shipment' && value !== 'refund') {
    throw new Error('Unsupported Amazon email message type.');
  }
  return value;
}

function normalizedMessageIdentity(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.normalize('NFC').replace(/^[\t ]+|[\t ]+$/g, '');
  if (
    normalized.length > 998 ||
    !/^<[\x21-\x3d\x3f-\x7e]+@[A-Za-z0-9.-]+>$/.test(normalized)
  ) {
    throw new Error('Invalid Amazon email message identifier.');
  }
  return normalized;
}

function splitParameters(value: string): readonly string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\' && quoted) {
      current += character;
      escaped = true;
    } else if (character === '"') {
      current += character;
      quoted = !quoted;
    } else if (character === ';' && !quoted) {
      fields.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (quoted || escaped) throw new Error('Invalid MIME parameter.');
  fields.push(current.trim());
  return fields;
}

function parseParameterValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"') || trimmed.length < 2) {
      throw new Error('Invalid MIME parameter.');
    }
    const unquoted = trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
    if (
      [...unquoted].some(character => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    ) {
      throw new Error('Invalid MIME parameter.');
    }
    return unquoted;
  }
  if (!/^[a-zA-Z0-9!#$&^_.+/-]+$/.test(trimmed)) {
    throw new Error('Invalid MIME parameter.');
  }
  return trimmed;
}

function isValidBoundary(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 70 &&
    /^[A-Za-z0-9'()+_,./:=? -]+$/.test(value) &&
    !value.endsWith(' ')
  );
}

function splitVisibleLines(value: string): readonly string[] {
  return value.length === 0 ? [] : value.split('\r\n');
}

function canonicalizeLineEndings(value: string): string {
  if (/\r(?!\n)/.test(value)) {
    throw new Error('Amazon email has invalid line endings.');
  }
  return value.replace(/(?<!\r)\n/g, '\r\n');
}

function decodeUtf8(value: Buffer): string {
  try {
    return STRICT_UTF8.decode(value);
  } catch {
    throw new Error('Invalid Amazon email text encoding.');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
