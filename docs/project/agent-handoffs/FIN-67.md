# FIN-67 first-run bootstrap

FIN-67 makes the local startup path usable before a companion has been
configured. `corepack yarn start:actual` starts only the browser worker,
plugins, Vite, and Actual server, waits for the loopback Actual page, and opens
`http://127.0.0.1:5006`. It never reads companion configuration, starts the
companion, binds port 4100, or creates companion state.

Use it to create or open a budget. In the open budget, select **Settings** >
**Advanced** and copy its non-secret **Budget ID** into protected local
configuration before completing the documented companion setup. The launcher
does not guess a budget or write configuration.

`start:finance` now defaults a missing
`FINANCE_COMPANION_ACTUAL_SERVER_URL` to its only supported local address,
`http://127.0.0.1:5006`. An explicitly supplied different URL is preserved so
the existing preflight rejects it. No secrets or configuration files are
created or stored by either command.
