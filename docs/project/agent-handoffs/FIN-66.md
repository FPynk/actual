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
reset or removed. Shutdown records only launched child process IDs: on Windows
it uses `taskkill /PID ... /T`, escalating to `/F` after the grace period; on
POSIX it signals only the owned process groups.

Focused synthetic coverage is in `scripts/start-finance.test.mjs`. It covers
Windows launch selection, stable paths, startup order, readiness and browser
opening, worker and port failures, secret configuration isolation, unexpected
child exits, readiness cleanup, and owned-child shutdown. No test starts an
Actual server or accesses credentials or financial data.
