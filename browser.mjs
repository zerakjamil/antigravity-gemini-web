import { chromium } from 'playwright-core';

const web = 'https://gemini.google.com/app';
const models = {
  argon: {
    option: /^(?:Gemini )?4 Argon$/i,
    selected: /^(?:Gemini )?(?:4 )?Argon(?:\s*(?:Low|Medium|High|Max))?$/i,
  },
  hydrogen: {
    option: /^(?:Gemini )?4 Hydrogen$/i,
    selected: /^(?:Gemini )?(?:4 )?Hydrogen(?:\s*(?:Low|Medium|High|Max))?$/i,
  },
};

export async function openBrowser(profile) {
  return chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false });
}

export async function runTurn(browser, prompt, signal, model) {
  const mode = models[model];
  if (!mode) throw new Error('Unknown Gemini Web model.');
  const page = await browser.newPage();
  const close = () => void page.close().catch(() => {});
  let stage = 'opening the Gemini Web composer';
  signal.addEventListener('abort', close, { once: true });
  try {
    signal.throwIfAborted();
    await page.goto(web, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    const composer = page.locator('.ql-editor');
    await composer.waitFor({ timeout: 20_000 });
    stage = 'selecting the requested Web model';
    const picker = page.getByRole('button', { name: /^Open mode picker/i });
    if (!mode.selected.test((await picker.innerText({ timeout: 15_000 })).trim())) {
      await picker.click();
      await page.getByText(mode.option).filter({ visible: true }).click({ timeout: 5_000 });
    }
    await picker.filter({ hasText: mode.selected }).waitFor({ timeout: 5000 });

    const answers = page.locator('message-content');
    const baseline = await answers.count();
    stage = 'preparing the harness context';
    let message = prompt;
    if (Buffer.byteLength(prompt) > 24 * 1024) {
      await page.getByRole('button', { name: 'Upload & tools', exact: true }).click({ timeout: 5000 });
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 5000 }),
        page.getByText(/^Upload files?$/i).click({ timeout: 5000 }),
      ]);
      await chooser.setFiles({
        name: 'antigravity-context.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(prompt),
      });
      message = 'Read the attached Antigravity instructions, tool declarations and conversation. Continue the final user turn. Follow the local tool response format specified at the start of the attachment.';
    }
    await composer.click();
    await page.keyboard.insertText(message);
    stage = 'submitting the Gemini Web turn';
    await page.getByRole('button', { name: 'Send message', exact: true }).click({ timeout: 20_000 });

    // Wait for the final DOM snapshot because the site can rewrite previously rendered text.
    const stop = page.getByRole('button', { name: /^Stop(?:$|\s+(?:response|generating|generation))/i });
    let previous = '';
    let changedAt = Date.now();
    let sawGeneration = false;
    stage = 'waiting for a completed Gemini Web response';
    while (!signal.aborted) {
      const generating = await stop.isVisible();
      sawGeneration ||= generating;
      const text = await answers.count() > baseline ? (await answers.last().innerText()).trim() : '';
      if (text !== previous || generating) changedAt = Date.now();
      if (sawGeneration && !generating && text && Date.now() - changedAt >= 1200) return text;
      previous = text;
      await page.waitForTimeout(250);
    }
    signal.throwIfAborted();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(`Gemini Web failed while ${stage}.`, { cause: error });
  } finally {
    signal.removeEventListener('abort', close);
    await page.close().catch(() => {});
  }
}
