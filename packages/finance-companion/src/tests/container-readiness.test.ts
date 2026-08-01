import { readFile } from 'node:fs/promises';
import path from 'node:path';

const companionDirectory = path.resolve(import.meta.dirname, '../..');

describe('FIN-49 container readiness contract', () => {
  it('uses a fixed non-root runtime with only the required writable roots', async () => {
    const dockerfile = await readFile(
      path.join(companionDirectory, 'Dockerfile'),
      'utf8',
    );

    expect(dockerfile).toContain('FROM node:22.18.0-bookworm-slim');
    expect(dockerfile).not.toMatch(/FROM\\s+[^\\n]*:latest/i);
    expect(dockerfile).toContain('USER 10001:10001');
    expect(dockerfile).toContain(
      'mkdir /actual-api /data /integrity-anchor /tmp',
    );
    expect(dockerfile).toContain(
      'chown -R finance-companion:finance-companion',
    );
  });

  it('keeps first-release compose internal and separates durable state from secrets', async () => {
    const compose = await readFile(
      path.join(companionDirectory, 'compose.yaml'),
      'utf8',
    );

    expect(compose).not.toMatch(/^\\s*ports:/m);
    expect(compose).toContain('read_only: true');
    expect(compose).toContain('finance-companion-actual-api:/actual-api');
    expect(compose).toContain('finance-companion-data:/data');
    expect(compose).toContain(
      'finance-companion-integrity-anchor:/integrity-anchor',
    );
    expect(compose).not.toContain('/run/finance-companion/config.env');
    expect(compose).toContain('target: integrity-mac-key');
    expect(compose).toContain('target: backup-encryption-key');
    expect(compose).toContain('target: owner-bootstrap-credential');
    expect(compose).toContain('mode: 0400');
    expect(compose).toContain('FINANCE_COMPANION_DATA_DIR: /data');
    expect(compose).toContain('FINANCE_COMPANION_ACTUAL_API_DIR: /actual-api');
    expect(compose).toContain(
      'FINANCE_COMPANION_INTEGRITY_ANCHOR_PATH: /integrity-anchor/integrity-anchor.json',
    );
    expect(compose).toContain(
      'FINANCE_COMPANION_INTEGRITY_MAC_KEY_FILE: /run/secrets/integrity-mac-key',
    );
    expect(compose).toContain(
      'FINANCE_COMPANION_BACKUP_ENCRYPTION_KEY_FILE: /run/secrets/backup-encryption-key',
    );
    expect(compose).toContain(
      'FINANCE_COMPANION_ACTUAL_PASSWORD_FILE: /run/secrets/actual-password',
    );
    expect(compose).toContain(
      'FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL_FILE: /run/secrets/owner-bootstrap-credential',
    );
    expect(compose).toContain('FINANCE_COMPANION_ACTUAL_SERVER_URL:?Set');
    expect(compose).toContain('FINANCE_COMPANION_ACTUAL_BUDGET_ID:?Set');
    expect(compose).toContain('FINANCE_COMPANION_ACTUAL_BUDGET_CURRENCY:?Set');
    expect(compose).toContain('uid=10001,gid=10001,mode=1770');
    expect(compose).toContain("fetch('http://127.0.0.1:4100/health')");
    expect(compose).toContain(
      'environment: FINANCE_COMPANION_INTEGRITY_MAC_KEY_SECRET',
    );
    expect(compose).toContain(
      'environment: FINANCE_COMPANION_BACKUP_ENCRYPTION_KEY_SECRET',
    );
    expect(compose).toContain(
      'environment: FINANCE_COMPANION_ACTUAL_PASSWORD_SECRET',
    );
    expect(compose).toContain(
      'environment: FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL_SECRET',
    );
    expect(compose).not.toContain('FINANCE_COMPANION_INTEGRITY_MAC_KEY:');
    expect(compose).not.toContain('FINANCE_COMPANION_BACKUP_ENCRYPTION_KEY:');
  });

  it('persists every durable mount in the host smoke runner', async () => {
    const smokeRunner = await readFile(
      path.resolve(
        companionDirectory,
        '../../scripts/finance-companion-container-smoke.mjs',
      ),
      'utf8',
    );

    expect(smokeRunner).toContain('/actual-api/.readiness-sentinel');
    expect(smokeRunner).toContain('/data/.readiness-sentinel');
    expect(smokeRunner).toContain('/integrity-anchor/.readiness-sentinel');
    expect(smokeRunner).toContain('actual-api:data:anchor');
    expect(smokeRunner).toContain("'i'.repeat(32)");
    expect(smokeRunner).toContain("'b'.repeat(32)");
    expect(smokeRunner).toContain('/^[A-Za-z0-9_-]{43}$/');
    expect(smokeRunner).toContain('fileURLToPath(import.meta.url)');
    expect(smokeRunner).toContain('cwd: repositoryRoot');
    expect(smokeRunner).toContain("'--project-name'");
    expect(smokeRunner).toContain('composeProject');
    expect(smokeRunner).toContain("compose(['up', '-d'])");
    expect(smokeRunner).toContain("compose(['restart', 'finance-companion'])");
    expect(smokeRunner).toContain('ownerMarkerSetupProgram');
    expect(smokeRunner).toContain(
      "compose(['down', '--volumes', '--rmi', 'local'])",
    );
    expect(smokeRunner).toContain('FINANCE_COMPANION_IMAGE: image');
    expect(smokeRunner).not.toContain('Promise.allSettled');
    expect(smokeRunner).toContain("['info', '--format', '{{.ServerVersion}}']");
    expect(smokeRunner).toContain("['compose', 'version']");
    expect(smokeRunner).toContain("['buildx', 'ls']");
  });

  it('documents the exact owner credential encoding range in ASCII', async () => {
    const guide = await readFile(
      path.resolve(
        companionDirectory,
        '../../docs/project/finance-companion-container-readiness.md',
      ),
      'utf8',
    );

    expect(guide).toContain('decoding to 32-64 bytes');
    expect(guide).not.toContain('32â€“64');
  });
});
