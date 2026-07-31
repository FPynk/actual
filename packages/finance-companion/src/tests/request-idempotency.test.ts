import {
  calculateRequestReplayHash,
  createAmazonUploadSemanticRequest,
} from '#http/request-idempotency';

describe('FIN-13 request semantic hashing', () => {
  it('is domain-prefixed and canonical across object key order and integer spelling', () => {
    expect(
      calculateRequestReplayHash({ nested: { amount: 1, kind: 'import' } }),
    ).toBe(
      calculateRequestReplayHash({ nested: { kind: 'import', amount: 1.0 } }),
    );
    expect(
      calculateRequestReplayHash({ nested: { amount: 1, kind: 'import' } }),
    ).not.toBe(
      calculateRequestReplayHash({ nested: { amount: 2, kind: 'import' } }),
    );
  });

  it('rejects unknown upload fields and accepts only byte hashes instead of raw bytes', () => {
    const valid = {
      adapterVersion: 'amazon-import/v1',
      mediaKind: 'text/csv',
      byteHash: 'a'.repeat(64),
    };
    expect(createAmazonUploadSemanticRequest(valid)).toEqual(valid);
    expect(
      createAmazonUploadSemanticRequest({ ...valid, rawBytes: 'secret' }),
    ).toBeNull();
    expect(() =>
      calculateRequestReplayHash({ amount: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow('safe integers');
  });
});
