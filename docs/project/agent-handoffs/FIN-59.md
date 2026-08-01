# FIN-59 Ubuntu companion CI handoff

- Agent/model: Codex / GPT-5
- Ticket: FIN-59 - Add GitHub CI and verified Ubuntu container smoke
- Branch: `ci/FIN-59-ubuntu-companion-validation`
- Start commit: `fc203f48e55d05dd861fb926d4104fac2a32442d`

## Scope

`finance-companion-ubuntu.yml` adds a least-privilege Ubuntu workflow for the
local Finance Companion. It has three isolated jobs:

1. a Playwright Ubuntu container runs companion formatting, typecheck, unit and
   integration tests, production build, and the production-build browser
   journey;
2. an Ubuntu runner invokes the existing synthetic Docker Compose smoke, which
   builds the image, verifies the fixed non-root user, checks loopback health,
   restarts the service, and confirms the three durable mounts persist; and
3. an advisory clean-checkout job runs both root `tsgo` and `yarn typecheck`.

The workflow uses read-only repository permissions, does not upload artifacts,
does not publish ports, and supplies no GitHub or operator secrets. The
container smoke creates its own short-lived synthetic fixtures internally and
removes its Compose project, volumes, and image in `finally` cleanup.

## Validation

The workflow was reviewed against the existing pinned-action convention in
`.github/workflows/check.yml`, the Playwright-container convention in
`.github/workflows/e2e-test.yml`, and the established
`scripts/finance-companion-container-smoke.mjs` contract.

Local execution cannot establish Ubuntu Docker evidence on the Windows host:
the smoke runner deliberately reports `container_engine_unavailable` when the
Docker daemon or Buildx is unavailable. The first GitHub Actions run is the
required verification for Ubuntu, Docker, and clean-checkout behavior.

## Typecheck disposition

The clean-checkout typecheck job is advisory (`continue-on-error`) so FIN-59
records the result without falsely claiming that the existing broader monorepo
check is clean. A failed job must be treated as release evidence against a
clean-monorepo claim and followed up with the exact log output. The companion
typecheck remains required in the main companion job.

## Limitations

- This is CI validation, not a production deployment or a real-bank test.
- The Compose file has no published ports; the health request stays inside the
  Compose network namespace.
- Synthetic secret values exist only in the smoke process environment and are
  not written to workflow YAML, logs, artifacts, or the repository.
- The workflow does not enable companion-authored Actual writes, remote
  exposure, paired Actual restore, retention, or credential rotation.
