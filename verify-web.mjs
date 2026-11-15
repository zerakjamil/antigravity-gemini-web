import { createBridge } from './server.mjs';
import { openBrowser, runTurn } from './browser.mjs';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const token = randomBytes(32).toString('hex');
const testStreaming = process.argv.includes('--streaming');
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
    async function send(contents, tools) {
      const start = performance.now();
      const response = await fetch(endpoint, {
        method: 'POST',
        signal: AbortSignal.timeout(310_000),
        headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ contents, tools }),
      });
      if (!response.ok) throw new Error(`${model} returned HTTP ${response.status}.`);
      const updates = [];
      let buffer = '';
      for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
        buffer += chunk;
        for (let end; (end = buffer.indexOf('\n\n')) !== -1;) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          assert.ok(event.startsWith('data: '), 'Expected a gateway SSE event.');
          updates.push({ candidate: JSON.parse(event.slice(6)).candidates[0], elapsed: performance.now() - start });
        }
      }
      assert.equal(buffer, '', 'Incomplete gateway SSE event.');
      assert.equal(updates.at(-1)?.candidate.finishReason, 'STOP');
      return updates;
    }
    const tools = [{ functionDeclarations: [{ name: 'read_file', description: 'Read the entire local text file.', parameters: {
      type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
    } }] }];
    const started = performance.now();
    const user = { role: 'user', parts: [{ text: 'Use the read_file tool to read sample.txt and respond with only its exact contents.' }] };
    const toolUpdates = await send([user], tools);
    assert.equal(toolUpdates.length, 1, 'Expected one completed tool event.');
    const call = toolUpdates[0].candidate.content;
    assert.deepEqual(call.parts[0].functionCall, { name: 'read_file', args: { path: 'sample.txt' } });
    const text = await readFile(fixture, 'utf8');
    const answer = await send([user, call, { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { text } } }] }], tools);
    assert.equal(answer.flatMap(update => update.candidate.content.parts).map(part => part.text).join(''), nonce);
    console.log(model, 'live file tool loop verified in', Math.round((performance.now() - started) / 1000), 'seconds');
    if (testStreaming) {
      const events = await send([{ role: 'user', parts: [{
        text: 'Write eight paragraphs describing a fictional moon garden. Leave one blank line between paragraphs. Give each paragraph at least three sentences. End with a standalone paragraph reading STREAM_END.',
      }] }]);
      assert.ok(events.length > 1, `${model} did not deliver an incremental text event.`);
      assert.ok(!events[0].candidate.finishReason, 'First event should precede completion.');
      assert.ok(events.flatMap(update => update.candidate.content.parts).map(part => part.text).join('').endsWith('STREAM_END'));
      console.log(model, 'live streaming verified:', events.length, 'events, first at', Math.round(events[0].elapsed),
        'ms, final at', Math.round(events.at(-1).elapsed), 'ms');
    }
  }
} finally {
  bridge?.close();
  bridge?.closeAllConnections();
  await browser?.close();
  await rm(workspace, { recursive: true, force: true });
}
