import { once } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openBrowser } from './browser.mjs';

const profile = process.env.ARGON_CHROME_PROFILE ?? join(homedir(), '.gemini', 'argon-chrome-profile');
const browser = await openBrowser(profile);
const close = () => void browser.close().catch(() => {});
process.once('SIGTERM', close);
process.once('SIGINT', close);
try {
  const closed = once(browser, 'close');
  const page = browser.pages()[0] ?? await browser.newPage();
  await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
  console.log('Sign in in the dedicated Chrome window, then close it before starting Antigravity.');
  await closed;
} finally {
  process.removeListener('SIGTERM', close);
  process.removeListener('SIGINT', close);
  await browser.close().catch(() => {});
}
