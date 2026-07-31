import {
  createFinanceCompanionSecurity,
  createInMemoryLocalPrincipalRepository,
} from '#security/local-security';

const credential = Buffer.alloc(32, 9).toString('base64url');

describe('createFinanceCompanionSecurity', () => {
  it('uses Argon2id, rotates session values, and expires sessions', async () => {
    let time = 0;
    const security = await createFinanceCompanionSecurity({
      bootstrapCredential: credential,
      localPrincipalRepository: createInMemoryLocalPrincipalRepository(),
      now: () => time,
    });
    expect(await security.login('invalid')).toBeNull();
    const first = requireSuccessfulLogin(await security.login(credential));
    const second = requireSuccessfulLogin(await security.login(credential));
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.csrfToken).not.toBe(second.csrfToken);
    expect(
      security.readSession(first.sessionId, first.csrfToken),
    ).not.toBeNull();
    time += 29 * 60 * 1000;
    expect(security.readSession(first.sessionId, second.csrfToken)).toBe(
      'csrf-rejected',
    );
    time += 60 * 1000;
    expect(security.readSession(first.sessionId, first.csrfToken)).toBeNull();
    expect(security.readSession(second.sessionId, second.csrfToken)).toBeNull();
  });

  it('rate limits login attempts and refills with the injected clock', async () => {
    let time = 0;
    const security = await createFinanceCompanionSecurity({
      bootstrapCredential: credential,
      localPrincipalRepository: createInMemoryLocalPrincipalRepository(),
      now: () => time,
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await security.login('invalid')).toBeNull();
    }
    expect(await security.login('invalid')).toBe('rate-limited');
    time += 60 * 1000;
    expect(await security.login('invalid')).toBeNull();
  });

  it('does not preserve sessions across restart while retaining the stable owner', async () => {
    const repository = createInMemoryLocalPrincipalRepository();
    const firstSecurity = await createFinanceCompanionSecurity({
      bootstrapCredential: credential,
      localPrincipalRepository: repository,
    });
    const session = requireSuccessfulLogin(
      await firstSecurity.login(credential),
    );
    const restartedSecurity = await createFinanceCompanionSecurity({
      localPrincipalRepository: repository,
    });
    expect(
      restartedSecurity.readSession(session.sessionId, session.csrfToken),
    ).toBeNull();
    expect(await restartedSecurity.login(credential)).not.toBeNull();
  });

  it('fails startup when neither a durable owner nor bootstrap credential exists', async () => {
    await expect(
      createFinanceCompanionSecurity({
        localPrincipalRepository: createInMemoryLocalPrincipalRepository(),
      }),
    ).rejects.toThrow('An owner credential must be configured before startup.');
  });

  it.runIf(process.platform === 'win32')(
    'fails closed for credential-file bootstrap when Windows ACLs cannot be proven',
    async () => {
      await expect(
        createFinanceCompanionSecurity({
          bootstrapCredentialFile: 'synthetic-credential-file',
          localPrincipalRepository: createInMemoryLocalPrincipalRepository(),
        }),
      ).rejects.toThrow('Owner credential files are not supported on Windows');
    },
  );

  it('rotates the stable credential through the repository seam and revokes sessions', async () => {
    const repository = createInMemoryLocalPrincipalRepository();
    const security = await createFinanceCompanionSecurity({
      bootstrapCredential: credential,
      localPrincipalRepository: repository,
    });
    const session = requireSuccessfulLogin(await security.login(credential));
    const nextCredential = Buffer.alloc(32, 10).toString('base64url');
    const rotation = await security.rotateOwnerCredential(nextCredential);
    expect(rotation).not.toBeNull();
    expect(
      security.readSession(session.sessionId, session.csrfToken),
    ).toBeNull();
    expect(await security.login(credential)).toBeNull();
    expect(await security.login(nextCredential)).not.toBeNull();
  });
});

function requireSuccessfulLogin(
  result: Awaited<
    ReturnType<
      Awaited<ReturnType<typeof createFinanceCompanionSecurity>>['login']
    >
  >,
) {
  if (result === null || result === 'rate-limited') {
    throw new Error('Expected a successful synthetic login.');
  }
  return result;
}
