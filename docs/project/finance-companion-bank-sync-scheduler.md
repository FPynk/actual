# Finance companion scheduled bank sync

`job:bank-sync` is a one-shot local command. A scheduler invokes it; the
companion owns account selection, retry policy, exclusive Actual access, and
the final process exit code. FIN-29 does not install a task, contact a
provider, open a listener, or deploy a service.

## Local configuration

Configure the task's run-as account with the existing `FINANCE_COMPANION_*`
variables. Do not put credentials, keys, URLs, command lines, or their values
in the scheduled task definition, task name, arguments, or logs.

Required non-secret variables are:

- `FINANCE_COMPANION_DATA_DIR`
- `FINANCE_COMPANION_ACTUAL_API_DIR`
- `FINANCE_COMPANION_INTEGRITY_ANCHOR_PATH`
- `FINANCE_COMPANION_ACTUAL_SERVER_URL`
- `FINANCE_COMPANION_ACTUAL_BUDGET_ID`
- `FINANCE_COMPANION_ACTUAL_BUDGET_CURRENCY`

Use the file-based secret variables for scheduled runs:

- `FINANCE_COMPANION_ACTUAL_PASSWORD_FILE`
- `FINANCE_COMPANION_ACTUAL_BUDGET_ENCRYPTION_PASSWORD_FILE` when the budget is
  encrypted
- `FINANCE_COMPANION_INTEGRITY_MAC_KEY_FILE`
- `FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL_FILE` only when it is needed

Keep those files outside the checkout and scheduler-log directory. Give the
task's run-as account read access and no broader access. Suitable descriptive
filenames are `actual-password.secret`, `actual-budget-password.secret`,
`integrity-mac-key.secret`, and `owner-bootstrap-credential.secret`; this
document intentionally provides no credential values.

The one-shot command must receive a new URL-safe idempotency key on each
scheduled run. Reusing a key intentionally replays the stored result and does
not start another sync.

## Windows Task Scheduler

Save this launcher as
`packages\finance-companion\scripts\run-scheduled-bank-sync.ps1` in a local
checkout. It resolves the checkout path before changing directories, so paths
containing spaces are supported.

```powershell
[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$CheckoutPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedCheckoutPath = (Resolve-Path -LiteralPath $CheckoutPath).Path
Set-Location -LiteralPath $resolvedCheckoutPath

$idempotencyKey = [Guid]::NewGuid().ToString('N')
& corepack yarn workspace @actual-app/finance-companion job:bank-sync -- --scheduler --idempotency-key $idempotencyKey

if ($null -eq $LASTEXITCODE) {
  exit 1
}

exit $LASTEXITCODE
```

Run the launcher once from an interactive PowerShell session under the same
account that will run the task. Confirm that it emits exactly one JSON summary
on standard output and that its exit code matches the table below. Resolve
configuration or integrity failures before registering a recurring task.

The following creates a daily task without embedding any configuration value or
credential. Replace only the checkout path and schedule time for the local
machine. `New-ScheduledTaskAction` passes quoted `-File` and
`-CheckoutPath` arguments, including when the checkout contains spaces.

```powershell
$checkoutPath = 'C:\Local Projects\Actual Checkout'
$launcherPath = Join-Path $checkoutPath 'packages\finance-companion\scripts\run-scheduled-bank-sync.ps1'
$taskAction = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument ('-NoProfile -NonInteractive -File "{0}" -CheckoutPath "{1}"' -f $launcherPath, $checkoutPath)
$taskTrigger = New-ScheduledTaskTrigger -Daily -At 03:15
Register-ScheduledTask `
  -TaskName 'Finance Companion Bank Sync' `
  -Action $taskAction `
  -Trigger $taskTrigger `
  -User (whoami) `
  -RunLevel Limited
```

In Task Scheduler, set **If the task is already running** to **Do not start a
new instance**. The companion still serializes Actual work and safely rejects
an in-progress exact replay or different-key bank-sync overlap before another
Actual call, but this setting avoids unnecessary local task processes.

|  Exit | Scheduler handling                                                                                         |
| ----: | ---------------------------------------------------------------------------------------------------------- |
|   `0` | Succeeded or all selected accounts were skipped.                                                           |
|   `1` | Partial result; inspect the redacted summary.                                                              |
|  `64` | Invalid command, account scope, or configuration; fix locally before retrying.                             |
|  `69` | Maintenance, recovery, queue, binding, or adapter unavailable; retry only after the condition is resolved. |
|  `70` | Terminal non-retryable failure; do not automatically retry.                                                |
|  `75` | Terminal retryable failure after the companion retry cap; a later scheduled run may use a new key.         |
|  `76` | Outcome unknown; stop automatic retries and follow the offline resolution flow.                            |
| `130` | Canceled without unknown effects; investigate the stop request before retrying.                            |

## Logs and retention

Keep only the terminal JSON summary and allowlisted JSON problem when a local
operator needs a record. Do not enable shell transcript logging for this task
or capture command lines. The allowed fields are timestamp, severity, stable
event code, job/worker ID, hashed budget scope, opaque account ID,
duration/count, and allowlisted error code. Account names, provider names or
payloads, credentials, account numbers, URLs, transactions, exception text,
SQL, command lines, and paths must never be retained.

Store any retained output in a protected local directory separate from secrets,
review it after failures, and delete it on a short fixed schedule (for example,
30 days). Retain unresolved `76` evidence only until the documented offline
resolution and required integrity verification are complete.

## Future-only Linux/container invocation

Systemd timers and container schedulers are future operations work. FIN-29
does not add a unit file, container schedule, remote automation, or deployment.
After a separate operations review, either may invoke the same one-shot command
from the checked-out repository with `--scheduler` and a newly generated key:

```sh
corepack yarn workspace @actual-app/finance-companion job:bank-sync -- --scheduler --idempotency-key <new-url-safe-key>
```
