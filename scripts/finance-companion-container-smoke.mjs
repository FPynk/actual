import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const smokeId = randomUUID();
const composeFile = path.join(
  repositoryRoot,
  'packages/finance-companion/compose.yaml',
);
const composeProject = `finance-companion-readiness-${smokeId}`;
const image = `finance-companion-readiness:${smokeId}`;
const integrityMacKey = 'i'.repeat(32);
const backupEncryptionKey = 'b'.repeat(32);
const ownerBootstrapCredential = Buffer.alloc(32, 3).toString('base64url');
const dockerEnvironment = {
  ...process.env,
  FINANCE_COMPANION_ACTUAL_BUDGET_CURRENCY: 'USD',
  FINANCE_COMPANION_ACTUAL_BUDGET_ID: 'container-smoke-budget',
  FINANCE_COMPANION_ACTUAL_PASSWORD_SECRET: 'synthetic-only',
  FINANCE_COMPANION_ACTUAL_SERVER_URL: 'http://127.0.0.1:5999',
  FINANCE_COMPANION_BACKUP_ENCRYPTION_KEY_SECRET: backupEncryptionKey,
  FINANCE_COMPANION_IMAGE: image,
  FINANCE_COMPANION_INTEGRITY_MAC_KEY_SECRET: integrityMacKey,
  FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL_SECRET: ownerBootstrapCredential,
};
const healthProgram =
  "fetch('http://127.0.0.1:4100/health').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1));";
const writeSentinelsProgram =
  "const fs=require('node:fs'); fs.writeFileSync('/actual-api/.readiness-sentinel', 'actual-api'); fs.writeFileSync('/data/.readiness-sentinel', 'data'); fs.writeFileSync('/integrity-anchor/.readiness-sentinel', 'anchor');";
const readSentinelsProgram =
  "const fs=require('node:fs'); process.stdout.write(fs.readFileSync('/actual-api/.readiness-sentinel') + ':' + fs.readFileSync('/data/.readiness-sentinel') + ':' + fs.readFileSync('/integrity-anchor/.readiness-sentinel'));";
const ownerMarkerSetupProgram =
  "const crypto=require('node:crypto'); const Database=require('better-sqlite3'); const fs=require('node:fs'); const database=new Database('/data/companion.sqlite',{readonly:true}); const instanceId=database.prepare(\"SELECT instance_id FROM companion_instance WHERE singleton_key = 'main'\").get().instance_id; database.close(); const budgetBindingHash=crypto.createHash('sha256').update('finance-companion/budget-binding/v1\\0').update('http://127.0.0.1:5999').update('\\0').update('container-smoke-budget').digest('hex'); fs.writeFileSync('/actual-api/owner.json', JSON.stringify({budgetBindingHash,companionInstanceId:instanceId,directoryNonce:'a'.repeat(43),formatVersion:1}),{flag:'wx',mode:0o600});";

if (!(await hasContainerToolchain())) {
  process.stdout.write(
    '{"ok":true,"skipped":true,"reason":"container_engine_unavailable"}\n',
  );
  process.exit(0);
}

try {
  assertSyntheticSecretFixtures();
  await compose(['build']);
  await compose([
    'run',
    '--rm',
    '--no-deps',
    'finance-companion',
    'node',
    'dist/service/cli.js',
    'db:migrate',
  ]);
  await compose([
    'run',
    '--rm',
    '--no-deps',
    'finance-companion',
    'node',
    '-e',
    ownerMarkerSetupProgram,
  ]);
  await compose(['up', '-d']);
  await waitForHealthy();
  await compose([
    'exec',
    '-T',
    'finance-companion',
    'node',
    '-e',
    writeSentinelsProgram,
  ]);
  await compose([
    'run',
    '--rm',
    '--no-deps',
    'finance-companion',
    'node',
    'dist/service/cli.js',
    'smoke:container',
  ]);
  await compose(['restart', 'finance-companion']);
  await waitForHealthy();
  const persistence = await compose([
    'exec',
    '-T',
    'finance-companion',
    'node',
    '-e',
    readSentinelsProgram,
  ]);
  if (persistence.stdout.trim() !== 'actual-api:data:anchor') {
    throw new Error('Durable writable volumes did not persist.');
  }
  process.stdout.write(`${JSON.stringify({ image, ok: true })}\n`);
} finally {
  await compose(['down', '--volumes', '--rmi', 'local']).catch(() => undefined);
  await run('docker', ['image', 'rm', '--force', image]).catch(() => undefined);
}

async function hasContainerToolchain() {
  try {
    await run('docker', ['version', '--format', '{{.Server.Version}}']);
    await run('docker', ['info', '--format', '{{.ServerVersion}}']);
    await run('docker', ['compose', 'version']);
    await run('docker', ['buildx', 'ls']);
    return true;
  } catch {
    return false;
  }
}

function assertSyntheticSecretFixtures() {
  if (
    Buffer.byteLength(integrityMacKey, 'ascii') !== 32 ||
    Buffer.byteLength(backupEncryptionKey, 'ascii') !== 32 ||
    !/^[A-Za-z0-9_-]{43}$/.test(ownerBootstrapCredential)
  ) {
    throw new Error('The synthetic secret fixture is invalid.');
  }
}

function compose(arguments_) {
  return run('docker', [
    'compose',
    '--project-name',
    composeProject,
    '--file',
    composeFile,
    ...arguments_,
  ]);
}

async function waitForHealthy() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await compose([
        'exec',
        '-T',
        'finance-companion',
        'node',
        '-e',
        healthProgram,
      ]);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error('The default service command did not become healthy.');
}

function run(command, arguments_) {
  return execute(command, arguments_, {
    cwd: repositoryRoot,
    env: dockerEnvironment,
    windowsHide: true,
  });
}
