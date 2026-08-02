# FIN-66 one-command local launcher

FIN-66 adds `corepack yarn start:finance`. The Node launcher uses the committed
Yarn release directly, so it does not require Bash, `sh`, or Windows command
resolution for Corepack. It builds and watches the loot-core worker, watches
plugins, starts Vite, Actual, and Finance Companion, and opens the two
loopback URLs only after bounded readiness checks pass.

It creates no secrets and stores none. The launcher validates the existing
companion configuration in a child with a copy of the environment, checks the
required local URL and readable secret-file sources before service processes
start, and sends `FINANCE_COMPANION_*` settings only to that validator and the
companion. Actual's development proxy now targets `127.0.0.1:3001`, matching
the explicit Vite bind.

Persistent state defaults under the user's local data directory and is never
reset or removed. Shutdown records only launched child process IDs. On Windows,
the launcher first asks the companion over Node IPC to close its server and
SQLite database; it uses `taskkill /PID ... /T` for the other owned trees and
escalates remaining children with `/F` after the grace period. On POSIX it
signals only the owned process groups.

The one-time `db:migrate` lifecycle now creates or verifies the protected
Actual API `owner.json` marker under its existing maintenance lock. A fresh
root must be empty; an existing marker is canonical, single-link, and bound to
the companion instance and budget hash before it is accepted. Daily launcher
preflight requires the database, marker, and integrity anchor before it starts
any child. Owner creation revalidates the directory identity and contents at
the write boundary. A competing change rolls back only identity-matched
artifacts from that failed fresh initialization; existing databases are never
deleted.

Focused synthetic coverage is in `scripts/start-finance.test.mjs`. It covers
Windows launch selection, stable paths, startup order, readiness and browser
opening, worker and port failures, secret configuration isolation, unexpected
child exits, readiness cleanup, owned-child shutdown, and owner races. A real
synthetic Windows acceptance also passed a fresh launch, graceful shutdown,
and restart against the same persistent database. No test accesses real
credentials or financial data.
