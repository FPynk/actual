# Finance companion container readiness

`packages/finance-companion/compose.yaml` is a first-release internal-only
contract: it publishes no companion port and runs as UID/GID `10001` with a
read-only root filesystem. The durable `/actual-api`, `/data`, and
`/integrity-anchor` mounts are distinct. `/tmp` is an owned tmpfs mount.

Set these distinct host environment variables before running Compose. Compose
uses them to create mounted secrets; it does not pass their values into the
container environment. The container receives only the corresponding
`FINANCE_COMPANION_*_FILE` paths.

| Host variable                                         | Required value                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `FINANCE_COMPANION_INTEGRITY_MAC_KEY_SECRET`          | Exactly 32 random ASCII bytes.                                                                        |
| `FINANCE_COMPANION_BACKUP_ENCRYPTION_KEY_SECRET`      | Exactly 32 random ASCII bytes.                                                                        |
| `FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL_SECRET` | A canonical unpadded base64url string decoding to 32-64 bytes (43 characters when encoding 32 bytes). |
| `FINANCE_COMPANION_ACTUAL_PASSWORD_SECRET`            | The Actual password; never use a production value for smoke testing.                                  |

The host also supplies the non-secret Actual URL, budget ID, and currency
variables required by Compose. `yarn workspace @actual-app/finance-companion
smoke:container` builds and runs synthetic checks when Docker is available; it
reports `container_engine_unavailable` when the local engine cannot be used.
