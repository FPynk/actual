import { renderFinanceCompanionLoginShell } from './App.ts';

const applicationRoot = document.querySelector<HTMLElement>('#app');
if (applicationRoot === null) {
  throw new Error('Finance Companion application root is missing.');
}
applicationRoot.innerHTML = renderFinanceCompanionLoginShell();
