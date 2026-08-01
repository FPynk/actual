# Finance companion user guide

## What this guide covers

This is an English, Windows-first guide to the locally running Finance
Companion and the existing Actual workflows it complements. It is intended for
a checkout whose path may contain spaces. The companion listens only at
`http://127.0.0.1:4100`; it is not a remote service and must not be exposed
through a port-forward, reverse proxy, or tunnel.

Actual remains the source of truth for accounts, transactions, categories,
rules, schedules, and reports. The companion reads a bounded Actual snapshot
to create local review suggestions. Its review decisions do not change Actual.
Complete any approved change manually in Actual, then refresh the relevant
review.

The separately operated `job:bank-sync` command is the only mutating
exception. It invokes Actual's linked-account sync and can import transactions
into the configured Actual budget. Run it only with explicit authorization and
follow its fail-stop procedure if the outcome is unknown.

The current release has these deliberate limits:

- Outside the explicitly authorized one-shot bank sync, there is no
  companion-led transaction, rule, category, split, or schedule write. This
  prevents an unsafe race with another Actual client.
- There is no remote access, remote bind address, or deployment procedure.
- The only backup and restore protocol is synthetic, generation-zero,
  companion-only. It does not back up or restore Actual.
- `owner:rotate` is not implemented (FIN-58). Do not rely on it for account
  recovery.

See [the write boundary](distributed-write-boundary.md) for the reason these
paths are deferred and [the Ubuntu homelab guide](finance-companion-ubuntu-homelab.md)
for the separate, synthetic-only container preparation boundary.

## Before you start

Use Node 22 and Corepack. The repository uses its pinned Yarn release, so run
every command below from the repository root. You also need an existing Actual
server and budget that you are authorized to read, plus a modern browser for
the loopback UI.

The following enters a checkout safely even when its path includes spaces.
It changes only the current PowerShell location; close the window or use
`Pop-Location` to reverse it.

```powershell
$checkoutPath = 'C:\Local Projects\Actual Checkout'
Push-Location -LiteralPath $checkoutPath
```

Install the repository dependencies exactly as locked. It may download package
artifacts but does not import a budget or contact an Actual server.

```powershell
corepack yarn install --immutable
```

For a first look at Actual without personal data, start the normal web
application and choose **View demo** during setup. This creates the built-in
demo budget; it is separate from the companion.

```powershell
corepack yarn start
```

Stop that development server with `Ctrl+C` in the same PowerShell window.

## Local companion configuration and secrets

The companion does not read `.env` files. Do not create one, do not commit one,
and do not put passwords or keys in a command history. Configure the allowed
`FINANCE_COMPANION_*` environment variables for the PowerShell process that
will run the companion. An unknown variable fails closed.

Create separate local directories outside the checkout for the companion
database, the Actual API working directory, the integrity anchor, and the two
secret files Windows can safely read. This command creates empty directories
only. It is reversible by removing these exact empty directories after the
companion has been stopped and their contents are no longer needed.

```powershell
$companionRoot = Join-Path $env:LOCALAPPDATA 'ActualFinanceCompanion'
$secretRoot = Join-Path $env:LOCALAPPDATA 'ActualFinanceCompanionSecrets'
$dataDirectory = Join-Path $companionRoot 'data'
$actualApiDirectory = Join-Path $companionRoot 'actual-api'
$anchorDirectory = Join-Path $companionRoot 'anchor'
New-Item -ItemType Directory -Force $dataDirectory, $actualApiDirectory, $anchorDirectory, $secretRoot | Out-Null
```

Use a protected local secret mechanism to create these files outside the
checkout. Do not put their contents in this guide, a script, a scheduled-task
argument, a log, or source control.

| File                    | Required contents                                                         |
| ----------------------- | ------------------------------------------------------------------------- |
| `actual-password`       | The Actual account password.                                              |
| `backup-encryption-key` | Exactly 32 random bytes; required for backup create, verify, and restore. |

Generate the backup-encryption key file without printing its contents. The
command creates only the exact file path below and clears its temporary byte
array. Do this once for a protected local setup; losing the key makes its
encrypted backups unusable.

```powershell
$backupEncryptionKeyPath = Join-Path $secretRoot 'backup-encryption-key'
$backupEncryptionKeyBytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($backupEncryptionKeyBytes)
try {
  [IO.File]::WriteAllBytes($backupEncryptionKeyPath, $backupEncryptionKeyBytes)
} finally {
  [Array]::Clear($backupEncryptionKeyBytes, 0, $backupEncryptionKeyBytes.Length)
}
```

On native Windows, integrity-MAC-key and owner-credential files intentionally
fail closed. Generate their canonical unpadded base64url values in the current
PowerShell process instead. This creates a 43-character integrity key that
decodes to exactly 32 bytes, and an owner bootstrap credential that decodes to
32 bytes. Neither command prints the generated value. Store the owner
credential and the integrity key in a protected password or secret manager
before the first migration. The integrity key is durable identity for the
companion database and anchor: load that exact same key into every future
PowerShell session, and never generate a replacement after initialization or
the companion will fail closed. The owner credential is required for the first
sign-in and `owner:rotate` is not implemented.

```powershell
function New-CanonicalBase64UrlSecret([int] $byteCount) {
  $secretBytes = [byte[]]::new($byteCount)
  [Security.Cryptography.RandomNumberGenerator]::Fill($secretBytes)
  try {
    return [Convert]::ToBase64String($secretBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  } finally {
    [Array]::Clear($secretBytes, 0, $secretBytes.Length)
  }
}
$env:FINANCE_COMPANION_INTEGRITY_MAC_KEY = New-CanonicalBase64UrlSecret 32
$env:FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL = New-CanonicalBase64UrlSecret 32
```

Point the process at the directories and supported Windows secret sources.
These commands contain only local paths, not secret values. The anchor is
deliberately outside both the data and Actual API directories.

```powershell
$env:FINANCE_COMPANION_DATA_DIR = $dataDirectory
$env:FINANCE_COMPANION_ACTUAL_API_DIR = $actualApiDirectory
$env:FINANCE_COMPANION_INTEGRITY_ANCHOR_PATH = Join-Path $anchorDirectory 'integrity-anchor.json'
$env:FINANCE_COMPANION_ACTUAL_PASSWORD_FILE = Join-Path $secretRoot 'actual-password'
$env:FINANCE_COMPANION_BACKUP_ENCRYPTION_KEY_FILE = Join-Path $secretRoot 'backup-encryption-key'
```

Set the three non-secret Actual binding values through your protected local
configuration process before starting: `FINANCE_COMPANION_ACTUAL_SERVER_URL`,
`FINANCE_COMPANION_ACTUAL_BUDGET_ID`, and
`FINANCE_COMPANION_ACTUAL_BUDGET_CURRENCY`. The URL must be an absolute HTTP
or HTTPS origin with no credentials, query, fragment, or path; the currency is
three uppercase letters. Do not guess a budget ID or copy values from a shared
terminal transcript.

If the budget has its own end-to-end encryption password, also provide
`FINANCE_COMPANION_ACTUAL_BUDGET_ENCRYPTION_PASSWORD_FILE`. This is optional:
omit it only when the configured budget has no separate encryption password.
Direct secret environment variables are development-only, except the two
native-Windows sources above that intentionally have no file alternative.

Before a lifecycle or start command, use this read-only check to confirm that
the file paths exist and the required non-secret binding variables are present.
It prints only variable names.

```powershell
$requiredConfiguration = @(
  'FINANCE_COMPANION_DATA_DIR',
  'FINANCE_COMPANION_ACTUAL_API_DIR',
  'FINANCE_COMPANION_INTEGRITY_ANCHOR_PATH',
  'FINANCE_COMPANION_ACTUAL_PASSWORD_FILE',
  'FINANCE_COMPANION_INTEGRITY_MAC_KEY',
  'FINANCE_COMPANION_ACTUAL_SERVER_URL',
  'FINANCE_COMPANION_ACTUAL_BUDGET_ID',
  'FINANCE_COMPANION_ACTUAL_BUDGET_CURRENCY'
)
$missingConfiguration = $requiredConfiguration | Where-Object { [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_, 'Process')) }
if ($missingConfiguration) { throw "Missing configuration: $($missingConfiguration -join ', ')" }
$requiredFiles = @(
  $env:FINANCE_COMPANION_ACTUAL_PASSWORD_FILE
)
$missingFiles = $requiredFiles | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }
if ($missingFiles) { throw 'One or more required secret files are missing.' }
```

Before the first `db:migrate`, separately confirm that
`FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL` is populated in this process.
Before any backup create, verify, or restore command, separately confirm that
the backup-encryption-key file exists. A fresh `db:migrate` and
`integrity:verify` do not require the backup key.

After the first migration succeeds, the owner hash is durable in companion
SQLite. You may clear the owner bootstrap environment value from the current
PowerShell process while retaining the saved credential for later browser
sign-in. Do not clear or regenerate `FINANCE_COMPANION_INTEGRITY_MAC_KEY`;
reload the same protected value into each later PowerShell session.

```powershell
Remove-Item Env:FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL
```

On Linux or inside the reviewed container, use the file sources rather than the
direct Windows-only values. The integrity-MAC-key file must be an
effective-user-owned regular single-link file, mode `0400` or `0600`, with
32 through 4096 raw bytes. The owner credential file must contain canonical
unpadded base64url ASCII decoding to 32 through 64 bytes; one trailing newline
is allowed, and its file permissions must not grant group or other access.

## Initialize, start, sign in, and stop

On a first initialization only, run the forward-only migration with the
companion stopped. It creates companion SQLite state and the integrity anchor;
it does not import, restore, or modify Actual data.

```powershell
corepack yarn workspace @actual-app/finance-companion db:migrate
```

On later upgrades, stop the companion and scheduler first, create and verify a
synthetic generation-zero backup, then use `db:migrate -- --backup-path` as
described below. Migrations are forward-only: do not replace SQLite files by
hand.

Start the local UI. This first builds the companion and then runs it on the
loopback address only.

```powershell
corepack yarn workspace @actual-app/finance-companion start
```

Open `http://127.0.0.1:4100` in the same machine's browser and sign in with
the local owner credential. The session cookie is local, `HttpOnly`, and
`SameSite=Strict`; use **Sign out** when finished. The health endpoint is a
minimal unauthenticated readiness check, not an operational dashboard:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4100/health
```

To stop the companion gracefully, press `Ctrl+C` in the PowerShell window that
started it. Do this before a migration, backup, restore, checkout change, or
any maintenance action.

## Use Actual for imports, rules, and reports

Use Actual's own workflow for source statements and normal ledger changes.
For each account, choose **Import**, select an OFX, QFX, or CSV statement, and
inspect the preview before selecting **Import**. OFX/QFX is normally the safer
repeat-import choice because it can include institution transaction IDs. CSV
requires field and date mapping. Do not use a PDF statement as an import
format.

Actual checks identifiers first and otherwise uses date, amount, and payee
matching. Review duplicates carefully, especially repeated same-amount
purchases. If a previous file import was intentionally deleted, review the
**Reimport deleted transactions** choice before importing again. See the
[upstream import guide](../../packages/docs/docs/transactions/importing.md)
for the detailed UI flow.

For cleanup and categorization in Actual:

1. Normalize a payee or assign the right category on a representative
   transaction.
2. Create or adjust an Actual rule when the behavior should recur; inspect its
   order and test it on one known transaction before relying on it.
3. Use split transactions for purchases that genuinely belong to multiple
   categories. Do not silently overwrite a manually categorized or reconciled
   transaction.
4. Use Actual's **Schedules** and **Find Schedules** for a recurring bill. The
   companion can recognize recurring evidence, but it does not create or edit
   schedules.

For reporting, open Actual's reports, select the desired accounts/categories
and a static date range or a live range such as **Last 30 days**, then use the
summary cards and rolling series. FIN-32 adds total expenditure, daily/weekly/
monthly averages, median expense, month-over-month information, and a rolling
30-day expenditure series for the selected range. Transfers are not expenses;
refunds offset totals; split children are counted rather than their parent.

## Review companion suggestions

After signing in, the navigation provides **Reconciliation**,
**Classification**, **Recurring payments**, and **Amazon**. Review the evidence
and stated reason before choosing an action. The candidate score only orders
work; it is not a decision or authorization to change Actual.

| Queue              | What the decision does                                            | What you must do in Actual                                               |
| ------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Reconciliation     | Records an approve or reject decision in companion SQLite.        | Open the account transaction and complete or reject the merge manually.  |
| Classification     | Records a proposal decision locally.                              | Assign the category, edit the payee, or make an Actual rule manually.    |
| Recurring payments | Records an approved type, deferral, rejection, or reopen locally. | Create or edit a schedule in Actual if you want one.                     |
| Amazon             | Records an allocation review decision locally.                    | Review the matching parent and make splits or category changes manually. |

Use **Defer** for a candidate that needs more evidence. Use **Reopen** to undo
an earlier local review decision. Reopening does not reverse anything already
done in Actual; undo that separately in Actual, then return to the companion
and refresh the candidate.

## Bank sync: one-shot only unless separately operated

Set up linked accounts and provider credentials in Actual using Actual's
supported bank-sync workflow. The companion's one-shot command invokes that
existing workflow; it does not expose provider credentials or a public API.
It is not read-only: it can import transactions and otherwise change the
configured Actual budget. Run it only with explicit authorization, after
checking that the budget is the intended one and that its ordinary
import/reconciliation behavior is understood.

Generate a new idempotency key for each run. This command has no remote
schedule and does not make the companion remotely reachable.

```powershell
$idempotencyKey = [Guid]::NewGuid().ToString('N')
corepack yarn workspace @actual-app/finance-companion job:bank-sync -- --scheduler --idempotency-key $idempotencyKey
```

Keep only the redacted terminal JSON result if a record is required. Do not
enable PowerShell transcript logging or capture command lines. An exit code of
`76` means the outcome is unknown: stop automatic retries, preserve the local
evidence, and follow the offline resolution procedure in the
[scheduler guide](finance-companion-bank-sync-scheduler.md). The repository
does not install a Windows Task Scheduler task by default; read that guide and
perform an operations review before scheduling a real budget.

## Amazon import and review

After signing in to the loopback companion, open `/amazon`. Select exactly one
uncompressed repository-defined Amazon JSON export or EML message and choose
**Import and find candidates**. Do not use CSV, an archive, an ordinary
Amazon-looking email, or a file with an unsupported format. The browser sends
the import as an authenticated, same-origin request with CSRF and idempotency
protection; use the page instead of calling the endpoint manually.

The multipart request is transiently spooled to a restricted temporary file
while it is validated, then that file is deleted on success, replay, conflict,
handler error, connection close, and response completion. The accepted
in-memory raw buffer is zeroed and discarded. Neither action is media erasure:
use encrypted host and temporary storage before importing.
The companion does not durably retain or log the raw file, original
message/export bytes, or filename. It does retain the canonical normalized
order, shipment, item, and refund records needed for matching, including
sensitive identifiers and item titles; treat the companion SQLite database and
its encrypted backups as private financial data. The import response contains
only a privacy-safe result status and counts, without order IDs or item titles.

The project documents 30-day retention for terminal request records and
365-day retention for normalized Amazon detail after its last observation.
Those periods are not automatically scheduled in this release, and Amazon
purge is not implemented; FIN-57 tracks that work. Plan protected storage
capacity accordingly; do not assume data disappears when either period passes.

After parsing, the companion uses read-only, bounded Actual snapshots to find
candidates. The Amazon list intentionally shows generic candidate labels,
status, scores, counts, and timestamps. Open a candidate only when you need
the detail: it may show sanitized, length-limited account, payee, category,
and item labels along with the exact allocation graph, reasons, and the count
of competing pending or deferred candidates.

Review every candidate rather than relying on its score. **Approve**,
**Reject**, **Defer**, and **Reopen** are companion-only decisions. A decision
does not choose, invalidate, or change a competing candidate. Before it records
any decision, the companion re-reads every exact Actual parent and rejects the
decision as stale if a parent is missing, reconciled, changed, a child, or a
starting balance. An approval provides manual guidance only: open each matching
parent in Actual and make any split or category changes there. The companion
never changes Actual through this workflow.

## Synthetic generation-zero backup and integrity check

Do not use the following lifecycle procedure on a real budget or after any
write-era state. It is a synthetic, companion-only validation path. It neither
backs up nor restores Actual, cannot undo an Actual import or manual edit, and
has no paired remote recovery fence.

With the companion and any scheduler stopped, create a unique temporary backup
directory. This command creates only an empty directory under the current
user's temp location. The same exact directory holds the backup used by the
synthetic restore check.

```powershell
$syntheticBackupDirectory = Join-Path $env:TEMP "finance-companion-generation-zero-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $syntheticBackupDirectory | Out-Null
$syntheticBackupPath = Join-Path $syntheticBackupDirectory 'generation-zero.backup.json'
```

Create, verify, and restore the synthetic encrypted companion backup, then
verify the matching database and integrity anchor. Each command prints one JSON
result on success. Do not run `backup:restore` against a real companion
directory.

```powershell
corepack yarn workspace @actual-app/finance-companion backup:create -- --backup-path $syntheticBackupPath
if ($LASTEXITCODE -ne 0) { throw 'Synthetic backup creation failed; preserve the artifacts.' }
corepack yarn workspace @actual-app/finance-companion backup:verify -- --backup-path $syntheticBackupPath
if ($LASTEXITCODE -ne 0) { throw 'Synthetic backup verification failed; preserve the artifacts.' }
corepack yarn workspace @actual-app/finance-companion backup:restore -- --backup-path $syntheticBackupPath
if ($LASTEXITCODE -ne 0) { throw 'Synthetic restore failed; preserve the artifacts.' }
corepack yarn workspace @actual-app/finance-companion integrity:verify
if ($LASTEXITCODE -ne 0) { throw 'Synthetic integrity verification failed; preserve the artifacts.' }

# Cleanup is allowed only after every preceding command succeeded.
Remove-Item -LiteralPath $syntheticBackupPath
if ((Get-ChildItem -LiteralPath $syntheticBackupDirectory -Force).Count -ne 0) { throw 'Synthetic backup directory is not empty.' }
Remove-Item -LiteralPath $syntheticBackupDirectory
```

A missing, stale, mismatched, or unauthenticated anchor/backup is
`recovery_required`. Stop normal operations; leave the database, anchor, and
restore artifacts in place; preserve the exact terminal JSON; and obtain a
manual recovery decision. Never delete restore-named files merely to make the
service start. The cleanup commands above remove only the one verified
synthetic backup file and its now-empty exact temporary directory; they do not
use a wildcard or remove restore artifacts.

## Troubleshooting and recovery posture

| Symptom                                  | Safe response                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser cannot connect                   | Confirm the companion is still running in its own window, then visit the exact loopback URL. Do not change the bind address or add a public port.                                           |
| Sign-in fails or is rate-limited         | Wait for the retry window, verify the local owner credential source privately, and try again. Do not log or paste the credential.                                                           |
| `database_lifecycle_failed`              | Stop the companion, verify the distinct data/API/anchor paths and file sources, then run `integrity:verify`. Do not edit SQLite or the anchor manually.                                     |
| `recovery_required` or integrity failure | Stop all companion and scheduled work, preserve the database, anchor, backup, and JSON evidence, and escalate for manual recovery.                                                          |
| `/health` returns HTTP 503               | Stop companion jobs and maintenance. A terminal adapter safety check failed; preserve the redacted result and restart only after the local cause is reviewed.                               |
| Review decision conflicts                | Reload the candidate. It changed while you were viewing it, so recheck the current Actual evidence before deciding again.                                                                   |
| Bank-sync exit `76`                      | Treat the result as unknown. Do not retry with the same or a new key until the offline procedure resolves it.                                                                               |
| An Actual change needs undo              | Undo it in Actual's UI using its normal transaction, rule, category, split, or schedule workflow. Then reopen or refresh the companion candidate if its local decision also needs revision. |
| Port `4100` is already in use            | Stop the known local process that owns it, then start the companion again. Do not change the companion to a public bind address.                                                            |
| Node or Yarn version is rejected         | Run `node --version` and `corepack yarn --version`; use Node 22.18 or newer and the repository-pinned Yarn via Corepack, then rerun `corepack yarn install --immutable`.                    |
| A required setting is missing            | Rerun the read-only configuration check above. Set only the named missing `FINANCE_COMPANION_*` value in the current process; never paste a secret into a log or issue.                     |
| An import looks duplicated               | In Actual, review the import preview, identifier/date/amount/payee match, and **Reimport deleted transactions** before accepting it. Do not use the companion to change the ledger.         |
| Native Windows and WSL disagree          | Use the PowerShell commands in this guide on native Windows. In WSL, follow the Linux file-secret rules above and use Linux paths; do not mix the two secret-storage models.                |
| You need diagnostic output               | Keep only redacted terminal JSON in protected local storage. Do not retain SQL, command lines, paths, raw imports, credentials, or browser network captures.                                |

## Ticketed development workflow

Work from a ticketed branch based on `integration/finance-app`. In a checkout
whose path has spaces, start with the same `Push-Location -LiteralPath`
command shown above. Keep each change focused, use a FIN ticket identifier in
the branch and commit, run the relevant checks, then open a pull request into
`integration/finance-app` for review and squash merge. Do not force-push that
integration branch.

```powershell
git fetch origin
git switch integration/finance-app
git pull --ff-only origin integration/finance-app
git switch -c feature/FIN-123-short-description

# Make the scoped change, then run the focused checks below.
git status
git add -- <changed-paths>
git commit -m "[AI] Short English change summary [FIN-123]"
git push -u origin feature/FIN-123-short-description
```

For an upstream Actual update, create a separate ticketed branch from
`integration/finance-app`, merge the reviewed upstream revision into that
branch, run the relevant checks, and open the same kind of pull request. Never
edit an already-merged migration; add the next numbered migration instead.

## Development checks

These commands are for a local source checkout. They do not import statements,
run bank sync, create a backup, or restore data.

```powershell
# Type-check the companion package.
corepack yarn workspace @actual-app/finance-companion typecheck

# Run its focused unit and integration tests with synthetic fixtures.
corepack yarn workspace @actual-app/finance-companion test

# Build the companion UI and service artifacts.
corepack yarn workspace @actual-app/finance-companion build

# Run the synthetic Playwright acceptance suite. It builds the UI and uses
# intercepted loopback API responses; it does not contact Actual or use data.
corepack yarn workspace @actual-app/finance-companion test:e2e

# Check the full monorepo types when changing shared Actual code.
corepack yarn typecheck
```

Use `Ctrl+C` to stop a development server. Build output is disposable and can
be regenerated by rerunning the build command; do not delete user data to fix a
build or test failure. The companion `test:e2e` command is operational and
tests the read-only review workflows with synthetic data. It is not a
substitute for a real-budget test or authorization to enable writes.

## Deferred work

Remote access, a production deployment, scheduled real-bank operation,
companion-led Actual writes, paired Actual/companion backup and restore,
write-era recovery, and owner credential rotation remain deferred. Until a
later reviewed release changes those boundaries, use the local loopback UI,
Actual's own UI for writes and undo, and synthetic-only lifecycle testing.
