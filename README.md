<p align="center">
  <img src="/demo.png" alt="Actualbudget" />
</p>

## Finance features in Actual

The `integration/finance-app` branch is one modified Actual app. Expenditure
reports, transaction review, bank sync, recurring-payment review, Amazon
enrichment, and automated categorization live in Actual's normal interface and
use its existing login, budgets, rules, transactions, sync, and persistence.
There is no second finance app, login, database, browser tab, or service.

### Run locally on Windows

Use PowerShell to clone the integration branch, install its locked
dependencies, and start the complete app:

```powershell
git clone --branch integration/finance-app https://github.com/FPynk/actual.git actual-finance-app
Set-Location -LiteralPath '.\actual-finance-app'
corepack yarn install --immutable
corepack yarn start:actual
```

The launcher builds and watches the browser workers, starts the frontend and
Actual sync server, waits for the full app to respond, and opens
`http://127.0.0.1:5006`. Pass `--no-open` when a browser should not open:

```powershell
corepack yarn start:actual --no-open
```

Port `5006` is the supported Actual URL. Port `3001` is the loopback-only Vite
development server behind it. Press Ctrl+C in the launcher terminal to stop
all child processes.

### Data and API-key setup

Actual server state persists in `%LOCALAPPDATA%\ActualBudgetServer` by default.
Set `ACTUAL_DATA_DIR` before launch to use another directory. On Linux, the
default is `$XDG_DATA_HOME/ActualBudgetServer` or
`$HOME/.local/share/ActualBudgetServer`. Protect and back up this directory as
you would any other Actual server installation.

Configure automated categorization at **Settings > Integrations > OpenAI
categorization**. The recommended settings screen stores the key only in the
local Actual server data directory; an operator can instead supply
`OPENAI_API_KEY` in the launch environment. The key is not returned to the
browser, stored in a budget, or synchronized. Each run shows a privacy notice
before sending only the selected transactions' descriptions, payees, dates,
amounts, currency, account names, allowed category names and guidance, and the
custom instruction to OpenAI. Review suggestions before applying them.

The launcher never reads, migrates, or deletes an old
`%LOCALAPPDATA%\ActualFinanceCompanion` directory. If one exists, it can be
copied to an archive without changing the original:

```powershell
Copy-Item -LiteralPath "$env:LOCALAPPDATA\ActualFinanceCompanion" -Destination "$env:LOCALAPPDATA\ActualFinanceCompanion.archive" -Recurse
```

### Troubleshooting local startup

- If port `3001` or `5006` is occupied, stop the process using it and run
  `corepack yarn start:actual` again.
- If a worker build fails, confirm the repository-root install completed with
  `corepack yarn install --immutable`, then retry. Service output is prefixed
  with the component that produced it.
- If the page does not open automatically, visit `http://127.0.0.1:5006` or use
  `--no-open` intentionally.
- If automated categorization is unavailable, configure a valid OpenAI key in
  Actual settings or in `OPENAI_API_KEY`, then restart the launcher after an
  environment change.

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
