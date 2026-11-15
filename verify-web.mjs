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
const testBatch = process.argv.includes('--batch');
const workspace = await mkdtemp(join(tmpdir(), 'gemini-web-smoke-'));
const paths = testBatch ? ['first.txt', 'second.txt'] : ['sample.txt'];
const fixtures = new Map(paths.map(path => [path, 'BRIDGE_FILE_' + randomBytes(6).toString('hex')]));
let browser;
let bridge;
try {
  await Promise.all([...fixtures].map(([path, value]) => writeFile(join(workspace, path), value)));
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
    const user = { role: 'user', parts: [{ text: testBatch
      ? 'Request two independent read_file calls in one tool turn for first.txt and second.txt. After both calls finish, answer with the exact contents of first.txt followed by the exact contents of second.txt, separated by one newline.'
      : 'Use the read_file tool to read sample.txt and respond with only its exact contents.' }] };
    const toolUpdates = await send([user], tools);
    assert.equal(toolUpdates.length, 1, 'Expected one completed tool event.');
    const call = toolUpdates[0].candidate.content;
    const calls = call.parts.map(part => part.functionCall);
    assert.deepEqual(calls.map(fn => fn?.args?.path).sort(), paths);
    const results = await Promise.all(calls.map(async fn => {
      assert.deepEqual(fn, { name: 'read_file', args: { path: fn.args.path } });
      const text = await readFile(join(workspace, fn.args.path), 'utf8');
      return { functionResponse: { name: fn.name, response: { text } } };
    }));
    const answer = await send([user, call, { role: 'user', parts: results }], tools);
    assert.equal(answer.flatMap(update => update.candidate.content.parts).map(part => part.text).join(''), [...fixtures.values()].join('\n'));
    console.log(model, 'live file tool loop verified with', calls.length, 'call(s) in', Math.round((performance.now() - started) / 1000), 'seconds');
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
