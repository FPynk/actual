# Finance companion Ubuntu homelab guide

## Status and boundary

This is a preparation and synthetic-validation guide for the reviewed
container contract in
[`packages/finance-companion/compose.yaml`](../../packages/finance-companion/compose.yaml).
It is not a production deployment guide. Do not use a real budget, password,
anchor, key, or backup with the procedures in this document.

The current Compose service has no published port. The companion itself accepts
only `127.0.0.1:4100` and its exact same-origin requests. It is therefore
internal-only and does not provide browser access from the homelab host. Do not
add `ports:`, change the bind address, expose it through a reverse proxy, or
put it on Tailscale. Remote access requires a separately approved remote
authentication and session design.

The service uses the local owner credential only. On its first initialization,
the credential creates the local owner principal; later login creates an
`HttpOnly`, `SameSite=Strict` session and returns a CSRF token for state-changing
requests. The bootstrap credential is not a remote-access credential.

## What the container contract provides

- A Node 22.18 Debian-based image that runs as fixed UID/GID `10001:10001`.
- A read-only root filesystem, all Linux capabilities dropped, and
  `no-new-privileges`.
- Writable, separate named volumes at `/actual-api`, `/data`, and
  `/integrity-anchor`; each is owned by UID/GID `10001` in the image. The anchor
  is distinct from the companion database volume, although the current Compose
  file creates it as a named volume rather than a host bind mount.
- An owned `/tmp` tmpfs with no execute, setuid, or device permissions.
- Docker Compose secrets mounted as files under `/run/secrets`; the container
  receives only `*_FILE` paths, not the corresponding secret environment
  values.
- An internal health check that fetches `http://127.0.0.1:4100/health`.

The Compose contract expects these host environment variables before Compose
starts: the three non-secret Actual binding values
`FINANCE_COMPANION_ACTUAL_SERVER_URL`,
`FINANCE_COMPANION_ACTUAL_BUDGET_ID`, and
`FINANCE_COMPANION_ACTUAL_BUDGET_CURRENCY`; plus the four Compose-secret source
variables named in
[`finance-companion-container-readiness.md`](finance-companion-container-readiness.md).
Keep secret values in a permission-restricted deployment secret store or
environment file outside the checkout. Do not commit them, print them, pass
them on a command line, or copy the integrity MAC key into a backup.

The backup encryption key must be exactly 32 bytes. The integrity MAC key must
be exactly 32 random ASCII bytes. The owner bootstrap credential is canonical,
unpadded base64url decoding to 32-64 bytes. The Actual password is a secret;
no example value belongs in documentation or a smoke run.

## Ubuntu preparation

Prepare a private Ubuntu host with a supported Docker Engine, the Docker Compose
plugin, Docker Buildx, Node 22, and Corepack. Keep the checked-out repository,
the Docker daemon data directory, and any backup destination on protected local
storage. Restrict access to the operator account and Docker socket.

From the repository root, inspect the reviewed Compose contract before any
synthetic validation:

```sh
docker compose -f packages/finance-companion/compose.yaml config
```

Run that command only in an environment where the required variables have been
provided by the protected secret mechanism. Treat its output as potentially
sensitive operational configuration and do not publish it.

The readiness smoke command creates only synthetic credentials and a synthetic
budget identifier. It builds the image, exercises the default service command,
internal health check, named-volume persistence, and graceful restart, then
removes its scoped Compose project, volumes, and image:

```sh
corepack yarn workspace @actual-app/finance-companion smoke:container
```

This command is the only supported container readiness validation in the
current repository. Docker Buildx could not be used on the Windows development
host used for this work, so that host reported
`container_engine_unavailable`. The container contract was statically checked,
but no Docker runtime success is claimed from that Windows host. Run the smoke
on the Ubuntu host before treating the image contract as runtime-validated.

## Operation, health, logs, and scheduling

When the container is intentionally running in an approved synthetic
environment, inspect the container health and its standard output/error without
copying sensitive output elsewhere:

```sh
docker compose -f packages/finance-companion/compose.yaml ps
docker compose -f packages/finance-companion/compose.yaml logs --no-log-prefix finance-companion
docker compose -f packages/finance-companion/compose.yaml exec -T finance-companion node -e "fetch('http://127.0.0.1:4100/health').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
```

The service returns a minimal health object, currently `healthy` and a version.
It has no host-published health endpoint. Do not introduce a log forwarder,
shell transcript, or command-line logging that could retain passwords, raw
sources, cookies, CSRF values, transaction data, or local paths.

`job:bank-sync` is an implemented one-shot command. Actual adapter support
exists, but this guide and container contract provide no real provider
credentials. The repository installs no systemd unit, timer, container
scheduler, or remote automation. A future reviewed Ubuntu scheduler may invoke
this exact command with a fresh URL-safe idempotency key for every run:

```sh
synthetic_idempotency_key='synthetic-scheduler-run-20260801-a'
corepack yarn workspace @actual-app/finance-companion job:bank-sync -- --scheduler --idempotency-key "$synthetic_idempotency_key"
```

Until that review and deployment work exists, run no recurring job against a
real budget. A scheduler must generate a new key for each run; reuse
intentionally replays the prior result. See
[`finance-companion-bank-sync-scheduler.md`](finance-companion-bank-sync-scheduler.md)
for the implemented one-shot semantics, exit codes, and redacted-log boundary.

## Synthetic generation-zero backup, verification, and restore

Only the generation-zero companion-only protocol is implemented. It requires
all of the following:

- The companion write capability remains `disabled` at generation zero.
- There are no write-capability events, application receipts, or paired-backup
  manifest state.
- The database and external integrity anchor match the same companion instance,
  Actual budget binding, currency, and schema.
- The backup encryption key and integrity MAC key are supplied through their
  file paths.

The repository's focused synthetic test is the supported validation of staged
replacement and rollback artifacts. It creates temporary synthetic SQLite data
and keys, injects interruption at each restore phase, and verifies that a
prior database and anchor remain at a live or rollback path:

```sh
corepack yarn workspace @actual-app/finance-companion test:db
```

The implemented lifecycle commands use `--backup-path`. They print one JSON
result on success. Use them only with synthetic, disposable paths after the
companion service and any scheduler have been stopped. The creation and
migration paths must be new and unused:

```sh
synthetic_backup_directory="$(mktemp -d)"
synthetic_backup_path="$synthetic_backup_directory/generation-zero.backup.json"
corepack yarn workspace @actual-app/finance-companion backup:create -- --backup-path "$synthetic_backup_path"
corepack yarn workspace @actual-app/finance-companion backup:verify -- --backup-path "$synthetic_backup_path"
corepack yarn workspace @actual-app/finance-companion backup:restore -- --backup-path "$synthetic_backup_path"
corepack yarn workspace @actual-app/finance-companion integrity:verify
rm -- "$synthetic_backup_path"
rmdir -- "$synthetic_backup_directory"
```

Run the two cleanup commands only after the verification command succeeds. They
remove the one known synthetic backup file and its now-empty dedicated temporary
directory; they do not use a glob or touch the checkout.

Restore first verifies the encrypted backup, database integrity, binding,
currency, schema, and authenticated anchor. It stages a replacement database
and anchor, keeps rollback artifacts while replacing them, installs the anchor
last, and removes artifacts only after completion. Missing, stale, mismatched,
or unauthenticated anchor/restore state must be treated as
`recovery_required`: keep the database, anchor, and artifacts unchanged; stop
normal operations; preserve evidence; and escalate for manual recovery. Never
delete restore-named artifacts just to restart the service.

There is no implemented paired Actual backup or restore, remote write fence,
write-era manifest chain, or write-enabled rollback. A companion-only restore
must not be used after any write-era state exists. It cannot undo newer Actual
mutations and does not restore Actual data.

## Upgrade and rollback posture

Companion migrations are forward-only. For a synthetic generation-zero upgrade,
stop the service and scheduler, create and verify a companion-only backup, then
run the migration command with a new unused backup path:

```sh
synthetic_pre_migration_backup_directory="$(mktemp -d)"
synthetic_pre_migration_backup_path="$synthetic_pre_migration_backup_directory/pre-migration.backup.json"
corepack yarn workspace @actual-app/finance-companion db:migrate -- --backup-path "$synthetic_pre_migration_backup_path"
corepack yarn workspace @actual-app/finance-companion integrity:verify
rm -- "$synthetic_pre_migration_backup_path"
rmdir -- "$synthetic_pre_migration_backup_directory"
```

For a first initialization with no database yet, `db:migrate` takes no
arguments. After a synthetic migration, run the focused database test before
resuming the synthetic service. Run the cleanup commands only after integrity
verification succeeds; they remove only the named synthetic backup and its
empty dedicated temporary directory.

Generation-zero rollback is limited to restoring the matching verified
companion-only backup with the service and scheduler stopped, followed by
integrity verification. It remains write-disabled. Do not assume a later schema
is backward compatible or replace a database file manually. Write-era upgrade
and rollback remain unavailable until the separately gated paired
Actual/companion/anchor backup and restore protocol exists.

## Before any real deployment

This repository has not authorized a real homelab deployment. A later operator
must separately approve and validate: a remote-access/authentication design,
Actual service ownership and backup procedure, protected secret provisioning,
Ubuntu Docker runtime smoke results, scheduler design, retention, monitoring,
and a write-era paired backup/restore protocol. Until then, keep the companion
loopback-only, internal-only, and synthetic.
