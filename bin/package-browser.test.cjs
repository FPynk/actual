const assert = require('node:assert/strict');
const path = require('node:path');
// oxlint-disable-next-line actual/no-extraneous-dependencies -- node:test is a Node built-in used by this standalone script test.
const test = require('node:test');

const {
  buildBrowser,
  parseBuildBrowserArguments,
  runCommand,
} = require('./package-browser');

const spacedRepositoryRoot = path.join(
  path.parse(process.cwd()).root,
  'synthetic',
  'Actual Checkout',
);

test('runs the browser build from a repository path containing spaces', () => {
  const commands = [];

  buildBrowser({
    argumentsToParse: ['--skip-translations'],
    rootDirectory: spacedRepositoryRoot,
    run(command, argumentsToRun, options) {
      commands.push({ command, argumentsToRun, options });
    },
  });

  assert.deepEqual(commands, [
    {
      command: process.platform === 'win32' ? 'lage.cmd' : 'lage',
      argumentsToRun: ['build:browser', '--to=@actual-app/web'],
      options: { cwd: spacedRepositoryRoot },
    },
  ]);
});

test('forwards translation preparation and then the browser build', () => {
  const commands = [];

  buildBrowser({
    rootDirectory: spacedRepositoryRoot,
    directoryExists: () => false,
    run(command, argumentsToRun, options) {
      commands.push({ command, argumentsToRun, options });
    },
  });

  const localeDirectory = path.join(
    spacedRepositoryRoot,
    'packages',
    'desktop-client',
    'locale',
  );

  assert.deepEqual(commands, [
    {
      command: 'git',
      argumentsToRun: [
        'clone',
        'https://github.com/actualbudget/translations',
        path.join('packages', 'desktop-client', 'locale'),
      ],
      options: { cwd: spacedRepositoryRoot },
    },
    {
      command: 'git',
      argumentsToRun: ['checkout', '.'],
      options: { cwd: localeDirectory },
    },
    {
      command: 'git',
      argumentsToRun: ['pull'],
      options: { cwd: localeDirectory },
    },
    {
      command: process.execPath,
      argumentsToRun: [
        'packages/desktop-client/bin/remove-untranslated-languages',
      ],
      options: { cwd: spacedRepositoryRoot },
    },
    {
      command: process.platform === 'win32' ? 'lage.cmd' : 'lage',
      argumentsToRun: ['build:browser', '--to=@actual-app/web'],
      options: { cwd: spacedRepositoryRoot },
    },
  ]);
});

test('rejects unknown arguments and propagates child-process failures', () => {
  assert.throws(
    () => parseBuildBrowserArguments(['--unexpected']),
    /Unknown argument: --unexpected/,
  );
  assert.throws(
    () =>
      runCommand(process.execPath, ['-e', 'process.exit(7)'], {
        stdio: 'ignore',
      }),
    /exited with status 7/,
  );
});
