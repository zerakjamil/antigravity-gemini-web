import { createBridge } from './server.mjs';
import { openBrowser, runTurn } from './browser.mjs';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const token = randomBytes(32).toString('hex');
const workspace = await mkdtemp(join(tmpdir(), 'gemini-web-smoke-'));
const fixture = join(workspace, 'sample.txt');
const nonce = 'BRIDGE_FILE_' + randomBytes(6).toString('hex');
await writeFile(fixture, nonce);
let browser;
let bridge;
try {
  const profile = process.env.ARGON_CHROME_PROFILE ?? join(homedir(), '.gemini', 'argon-chrome-profile');
  browser = await openBrowser(profile);
  bridge = createBridge({ token, turn: (...args) => runTurn(browser, ...args) });
  bridge.listen(0, '127.0.0.1');
  await once(bridge, 'listening');
  for (const model of ['hydrogen', 'argon']) {
    const endpoint = `http://127.0.0.1:${bridge.address().port}/v1beta/models/gemini-4-${model}-web:streamGenerateContent?alt=sse`;
    async function send(contents) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents,
          tools: [{ functionDeclarations: [{ name: 'read_file', description: 'Read the entire local text file.', parameters: {
            type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
          } }] }],
        }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return JSON.parse((await response.text()).slice(6)).candidates[0].content;
    }
    const started = performance.now();
    const user = { role: 'user', parts: [{ text: 'Use the read_file tool to read sample.txt and respond with only its exact contents.' }] };
    const call = await send([user]);
    assert.deepEqual(call.parts[0].functionCall, { name: 'read_file', args: { path: 'sample.txt' } });
    const text = await readFile(fixture, 'utf8');
    const answer = await send([user, call, { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { text } } }] }]);
    assert.equal(answer.parts[0].text, nonce);
    console.log(model, 'live file tool loop verified in', Math.round((performance.now() - started) / 1000), 'seconds');
  }
} finally {
  bridge?.close();
  bridge?.closeAllConnections();
  await browser?.close();
  await rm(workspace, { recursive: true, force: true });
}
