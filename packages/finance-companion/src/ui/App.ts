import './styles.css';

export function renderFinanceCompanionLoginShell(): string {
  return `<section aria-labelledby="finance-companion-title" class="login-shell">
    <h1 id="finance-companion-title">Finance Companion</h1>
    <p>Sign in to continue to your local finance companion.</p>
    <form aria-label="Sign in">
      <label for="owner-credential">Owner credential</label>
      <input id="owner-credential" name="credential" type="password" autocomplete="off" />
      <button type="button" disabled>Sign in</button>
    </form>
    <p role="status">Sign-in will be available in a later release.</p>
  </section>`;
}
