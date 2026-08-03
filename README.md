<p align="center">
  <img src="/demo.png" alt="Actualbudget" />
</p>

## Finance features in Actual

This branch is one Actual application: its finance tools use the normal Actual
login, budget, accounts, transactions, rules, schedules, reports, sync, and
persistence. There is no separate Finance Companion, database, or port.

### Windows quick start

Use PowerShell. You need Git, Node.js 22.18.0 or later, and Corepack (included
with supported Node releases). Clone the branch, then install the locked
dependencies from the repository root:

```powershell
git clone --branch integration/finance-app https://github.com/FPynk/actual.git actual-finance-app
Set-Location -LiteralPath '.\actual-finance-app'
corepack yarn install --immutable
```

Start the complete local app with this exact command:

```powershell
corepack yarn start:actual
```

On the first visit, complete Actual's on-screen server and budget setup. The
launcher builds the required browser workers, starts the local frontend and
Actual server, and opens `http://127.0.0.1:5006` when ready. That is the URL to
bookmark. Port `3001` is only the loopback Vite development server behind it.
To keep the launcher from opening a browser, use:

```powershell
corepack yarn start:actual --no-open
```

For normal daily use, run `corepack yarn start:actual`, wait for the ready
message, and open `http://127.0.0.1:5006` if necessary. Leave the PowerShell
window open while using the app. Press Ctrl+C in that window to stop all
launcher processes; do not close it by killing individual child processes.

### Data, backups, and first accounts

The local server keeps its state in `%LOCALAPPDATA%\ActualBudgetServer` by
default. To use a different location for the current PowerShell session, set it
before starting Actual:

```powershell
$env:ACTUAL_DATA_DIR = 'D:\ActualBudgetServer'
corepack yarn start:actual
```

Treat that directory as private financial data: it also holds server-managed
credentials. Make regular in-app backups with **Settings > Export Data** for
each budget, and keep the exported files somewhere protected. For a
machine-level backup, stop Actual first and copy the whole data directory to a
protected destination. Do not edit its databases directly. To restore an
export, use **Switch file > Import file > Actual**, then verify the imported
copy before removing anything.

Create a manual account with **+ Add account** in the sidebar. To add
transactions, open the account and use **Add New**. To import a statement, use
that account's **Import** button. CSV, OFX, QFX, and QIF are supported; OFX/QFX
is usually the best choice because a bank-provided transaction ID improves
matching. For CSV, map the date, payee, and amount (or debit/credit) columns in
the preview, check the interpreted date and signs, then import.

Actual tries to avoid duplicate imports by matching supplied IDs first and then
matching nearby date, amount, and payee evidence. After an import, use
**Review duplicates** in the account header. Read the evidence and explicitly
choose merge, keep both, or defer; no candidate is merged until you choose an
action. A merge can be undone in Actual. Review carefully when repeated
same-amount purchases are plausible.

### Bank sync and scheduled sync

To connect a provider, use **+ Add account** or an existing account's menu and
choose **Link account**. Actual supports its configured providers,
including SimpleFIN. For SimpleFIN, create a one-time setup token in
SimpleFIN Bridge, then enter it in Actual and map each discovered bank account
to an existing or new Actual account. The token/access credentials stay on the
server; do not put them in a budget, document, or source file. You can run a
manual sync from an account's **Bank Sync** button or from **All Accounts >
Bank Sync**.

The **Bank Sync** page also has a scheduled-sync setting, account selection,
and hourly, four-hour, twelve-hour, or daily interval. **Current limitation:**
this is a browser-side scheduler. It runs only while that copy of Actual is
open in a browser tab; it does not create a background server job. Use the
manual **Sync now** control after a failure and keep the app tab open for the
next scheduled attempt.

### Review and automation tools

Open **Settings > AI transaction categorization** to configure a model,
instructions, categories the AI may use, and optional category guidance. Enter
an API key there only for a local server you control, or have the server
operator provide `OPENAI_API_KEY` in the launch environment. The key is held
server-side, never returned to the browser, synchronized with the budget, or
included in the request. An environment key takes precedence over a key saved
through the settings UI.

Before each categorization preview, Actual tells you what it will send to
OpenAI: selected transaction descriptions, payees, dates, amounts, currency,
account names, the selected category names/guidance, and your instruction. It
does not send the API key, transaction IDs, notes, attachments, balances,
budget name, or unselected transactions, and requests disable provider-side
response storage. Suggestions are reviewed before applying; check them and use
Actual undo if needed.

After applying a suggestion, the review can offer **Create merchant rule**.
Use it to open Actual's normal Rule Editor and normalize an imported merchant
or reuse its category. A rule is created only after you review and save it.
You can later inspect or change rules from the Rules/Payees areas.

Open **Schedules > Review recurring payments** to scan ledger history for
recurring candidates. The review shows cadence, amount/date variance,
confidence, and whether a candidate is an optional subscription, household
bill, or financial bill. Approve only after reviewing the evidence; approval
creates or updates a normal Actual schedule. You can defer, reject, or reopen a
candidate without changing past transactions.

For an Amazon purchase, open its account and select **Amazon review**. Choose
one supported Amazon JSON export or a downloaded order, shipment, or refund
`.eml` message (10 MB or smaller). Actual discards the raw upload after
parsing and does not connect to your mailbox. It persists only normalized review
metadata so you can reopen the review; it does not retain the original JSON or
email. It displays possible charge matches and item/tax/shipping/refund
allocations. Set Actual's default currency to match the imported file. For an
eligible match, optionally choose categories and explicitly apply the review.
A selected category on a single allocation updates the transaction directly;
multiple allocations can create balanced native Actual splits. You can also
choose to append a concise Amazon note without replacing existing notes.
Actual rechecks the saved Amazon data and the current transaction on the server
before writing. Ambiguous, stale, reconciled, transfer, off-budget, and
existing-split transactions never change. The normal Actual **Undo** action
restores the ledger. Review history remains explicit: use **Reopen review**
before applying it again. This all happens in the normal Actual account view;
it does not start or connect to another app.

### Expenditure reports

Open **Reports**, then choose **New custom report**. Set the **Payment** view
and choose either a live range (for example, this month or last 30 days) or a
fixed **Static Date** start and end. The Summary includes total expenditure,
average per day/week/month, median expense, month-over-month change, and
category and merchant breakdowns, plus rolling 30-day expenditure for the
selected range.
Use filters and category exclusions to make the question precise; transfers,
refunds, and splits are handled as report data rather than separate finance
records.

### Troubleshooting and validation

- If startup says port `3001` or `5006` is in use, close the process using that
  port and run `corepack yarn start:actual` again.
- If a worker build fails, rerun `corepack yarn install --immutable` from the
  repository root and retry. Launcher output is prefixed with the component
  that produced it.
- If a browser does not open, visit `http://127.0.0.1:5006`; `--no-open` is
  intentional and does not disable the server.
- If OpenAI categorization is unavailable, check that Actual shows the server
  as online and that a valid key is configured. Restart the launcher after
  changing `OPENAI_API_KEY`.
- If an import does not look right, cancel from the preview when possible; if
  it was already applied, use Actual undo or restore a verified export rather
  than editing the data directory.

Developers can validate this checkout from its root with:

```powershell
corepack yarn test:actual-launcher
corepack yarn lint
corepack yarn typecheck
```

### Ubuntu homelab preparation (no deployment)

This guide does not deploy to Ubuntu. Before planning a homelab deployment,
choose an Ubuntu host, a dedicated non-root service account, a protected data
directory and backup destination, and an authentication/TLS/reverse-proxy
approach. Confirm that the host can run Node.js 22 with Corepack and Git, and
decide who may read the server data because bank and OpenAI credentials are
server-managed. Keep port exposure closed until the server authentication and
TLS plan are ready. When automation is later needed, use Actual's supported
CLI/API bank-sync path rather than provider routes or direct SQLite changes.

Technical decisions and implementation boundaries are in the
[native integration design](docs/project/native-finance-actual-integration.md)
and [native ticket migration](docs/project/native-finance-ticket-migration.md).

## Getting Started

Actual is a local-first personal finance tool. It is 100% free and open-source, written in NodeJS, it has a synchronization element so that all your changes can move between devices without any heavy lifting.

If you are interested in contributing, or want to know how development works, see our [contributing](https://actualbudget.org/docs/contributing/) document we would love to have you.

Want to say thanks? Click the ⭐ at the top of the page.

## Key Links

- Actual [discord](https://discord.gg/pRYNYr4W5A) community.
- Actual [Community Documentation](https://actualbudget.org/docs)
- [Frequently asked questions](https://actualbudget.org/docs/faq)

## Installation

There are four ways to deploy Actual:

1. One-click deployment [via PikaPods](https://www.pikapods.com/pods?run=actual) (~1.40 $/month) - recommended for non-technical users
1. Managed hosting [via Fly.io](https://actualbudget.org/docs/install/fly) (~1.50 $/month)
1. Self-hosted by using [a Docker image](https://actualbudget.org/docs/install/docker)
1. Local-only apps - [downloadable Windows, Mac and Linux apps](https://actualbudget.org/download/) you can run on your device

Learn more in the [installation instructions docs](https://actualbudget.org/docs/install/).

## Ready to Start Budgeting?

Read about [Envelope budgeting](https://actualbudget.org/docs/getting-started/envelope-budgeting) to know more about the idea behind Actual Budget.

### Are you new to budgeting or want to start fresh?

Check out the community's [Starting Fresh](https://actualbudget.org/docs/getting-started/starting-fresh) guide so you can quickly get up and running!

### Are you migrating from other budgeting apps?

Check out the community's [Migration](https://actualbudget.org/docs/migration/) guide to start jumping on the Actual Budget train!

## Documentation

We have a wide range of documentation on how to use Actual, this is all available in our [Community Documentation](https://actualbudget.org/docs), this includes topics on Budgeting, Account Management, Tips & Tricks and some documentation for developers.

## Contributing

Actual is a community driven product. Learn more about [contributing to Actual](https://actualbudget.org/docs/contributing/).

### Code structure

The Actual app is split up into a few packages:

- loot-core - The core application that runs on any platform
- desktop-client - The desktop UI
- desktop-electron - The desktop app

More information on the project structure is available in our [community documentation](https://actualbudget.org/docs/contributing/project-details).

### Feature Requests

Current feature requests can be seen [here](https://github.com/actualbudget/actual/issues?q=is%3Aissue+label%3A%22needs+votes%22+sort%3Areactions-%2B1-desc).
Vote for your favorite requests by reacting :+1: to the top comment of the request.

To add new feature requests, open a new Issue of the "Feature Request" type.

### Translation

Make Actual Budget accessible to more people by helping with the [Internationalization](https://actualbudget.org/docs/contributing/i18n/) of Actual. We are using a crowd sourcing tool to manage the translations, see our [Weblate Project](https://hosted.weblate.org/projects/actualbudget/). Weblate proudly supports open-source software projects through their [Libre plan](https://weblate.org/en/hosting/#libre).

<a href="https://hosted.weblate.org/engage/actualbudget/">
<img src="https://hosted.weblate.org/widget/actualbudget/actual/287x66-grey.png" alt="Translation status" />
</a>

## Repo Activity

![Alt](https://repobeats.axiom.co/api/embed/e20537dd8b74956f86736726ccfbc6f0565bec22.svg 'Repobeats analytics image')

## Sponsors

Thanks to our wonderful sponsors who make Actual Budget possible!

<a href="https://www.netlify.com"><img src="https://www.netlify.com/v3/img/components/netlify-color-accent.svg" alt="Deploys by Netlify" /></a>
<a href="https://depot.dev"><img src="https://depot.dev/badges/built-with-depot.svg" alt="Built with Depot" /></a>
<a href="https://www.docker.com"><img src="https://www.docker.com/app/uploads/2023/05/symbol_blue-docker-logo.png" alt="Docker" height="48" /></a>
<a href="https://github.com"><img src="https://avatars.githubusercontent.com/u/9919?s=200&v=4" alt="GitHub" height="48" /></a>
<a href="https://www.anthropic.com"><img src="https://avatars.githubusercontent.com/u/76263028?s=200&v=4" alt="Anthropic" height="48" /></a>
