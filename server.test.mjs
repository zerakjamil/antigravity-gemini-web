import assert from 'node:assert/strict';
import { get } from 'node:https';
import { test } from 'node:test';
import { createBridge, model } from './server.mjs';
import { createLoopbackCertificate } from './tls.mjs';

test('the Web provider converts calls and returns their results to the next turn', async (t) => {
  const prompts = [];
  const server = createBridge({
    token: 'test-token',
    async turn(prompt, _signal, family) {
      assert.equal(family, 'hydrogen');
      prompts.push(prompt);
      if (prompts.length === 1) return 'LOCAL_TOOL_CALL {"name":"read_file","args":{"path":"sample.txt"}}';
      if (prompts.length === 2) return 'The file says ARGON_OK.';
      return 'LOCAL_TOOL_CALL {"name":"undeclared","args":{}}';
    },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'x-goog-api-key': 'test-token' };
  assert.equal((await fetch(origin + '/v1beta/models')).status, 401);
  const discovery = await (await fetch(origin + '/v1beta/models', { headers })).json();
  assert.deepEqual(discovery.models.map(entry => entry.name), [
    `models/${model}`, 'models/gemini-4-hydrogen-web',
  ]);

  const input = {
    contents: [{ role: 'user', parts: [{ text: 'Read sample.txt.' }] }],
    tools: [{ functionDeclarations: [{ name: 'read_file', parameters: { type: 'object' } }] }],
  };
  async function request() {
    return fetch(`${origin}/v1beta/models/gemini-4-hydrogen-web:streamGenerateContent?alt=sse`, {
      method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify(input),
    });
  }
  const first = await request();
  assert.equal(first.headers.get('content-type'), 'text/event-stream');
  const event = JSON.parse((await first.text()).slice(6));
  const call = event.candidates[0].content.parts[0];
  assert.deepEqual(call, { functionCall: { name: 'read_file', args: { path: 'sample.txt' } } });

  input.contents.push(event.candidates[0].content, {
    role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { text: 'ARGON_OK' } } }],
  });
  const second = await request();
  assert.match(await second.text(), /The file says ARGON_OK/);
  assert.match(prompts[1], /"functionResponse":\{"name":"read_file","response":\{"text":"ARGON_OK"\}\}/);
  assert.equal((await request()).status, 502);
});

test('the desktop Gateway accepts a scoped certificate and bearer token', async (t) => {
  const { tls, dispose } = await createLoopbackCertificate();
  const server = createBridge({ token: 'gateway-token', tls, turn: () => 'unused' });
  t.after(async () => {
    server.close();
    server.closeAllConnections();
    await dispose();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const status = await new Promise((resolve, reject) => {
    get(`https://127.0.0.1:${server.address().port}/v1beta/models`, {
      ca: tls.cert, headers: { authorization: 'Bearer gateway-token' },
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
  assert.equal(status, 200);
});

test('streams stable text before browser completion without replaying it', async (t) => {
  let finishTurn;
  const pending = new Promise(resolve => { finishTurn = resolve; });
  const server = createBridge({
    token: 'stream-token',
    async turn(_prompt, signal, _family, _attachment, observe) {
      observe('First paragraph.\n\nSecond');
      observe('First paragraph.\n\nSecond paragraph.');
      await Promise.race([pending, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
      return 'First paragraph.\n\nSecond paragraph.';
    },
  });
  t.after(() => {
    finishTurn();
    server.close();
    server.closeAllConnections();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
    signal: AbortSignal.timeout(3000),
    method: 'POST',
    headers: { authorization: 'Bearer stream-token' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Write two paragraphs.' }] }] }),
  });
  const reader = response.body.getReader();
  const decode = bytes => JSON.parse(new TextDecoder().decode(bytes).trim().slice(6)).candidates[0];
  const first = decode((await reader.read()).value);
  assert.equal(first.content.parts[0].text, 'First paragraph.\n\n');
  assert.equal(first.finishReason, undefined);
  finishTurn();
  const last = decode((await reader.read()).value);
  assert.equal(last.content.parts[0].text, 'Second paragraph.');
  assert.equal(last.finishReason, 'STOP');
  assert.equal((await reader.read()).done, true);
});

test('queues overlapping turns and drops a disconnected waiter', async (t) => {
  let releaseFirst;
  let firstStarted;
  const first = new Promise(resolve => { firstStarted = resolve; });
  const held = new Promise(resolve => { releaseFirst = resolve; });
  const calls = [];
  const queued = [Promise.withResolvers(), Promise.withResolvers()];
  const removed = Promise.withResolvers();
  let nextWaiter = 0;
  const server = createBridge({
    token: 'queue-token',
    diagnose(message) {
      if (message === 'Browser turn queued.') queued[nextWaiter++].resolve();
      if (message === 'Gemini Web turn cancelled or timed out.') removed.resolve();
    },
    async turn(prompt) {
      const label = /turn-(?:first|cancelled|next)/.exec(prompt)[0];
      calls.push(label);
      if (label === 'turn-first') {
        firstStarted();
        await held;
      }
      return label;
    },
  });
  t.after(() => {
    releaseFirst();
    server.close();
    server.closeAllConnections();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  function send(text, signal = AbortSignal.timeout(3000)) {
    return fetch(`http://127.0.0.1:${server.address().port}/v1beta/models/${model}:generateContent`, {
      signal, method: 'POST', headers: { authorization: 'Bearer queue-token' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }] }),
    });
  }
  const active = send('turn-first');
  await first;
  const cancelled = new AbortController();
  const abandoned = assert.rejects(send('turn-cancelled', cancelled.signal), { name: 'AbortError' });
  await queued[0].promise;
  const following = send('turn-next');
  await queued[1].promise;
  cancelled.abort();
  await abandoned;
  await removed.promise;
  assert.deepEqual(calls, ['turn-first']);
  releaseFirst();
  assert.equal((await active).status, 200);
  assert.equal((await following).status, 200);
  assert.deepEqual(calls, ['turn-first', 'turn-next']);
});

test('terminates an incremental stream if Gemini revises text already sent', async (t) => {
  const revise = Promise.withResolvers();
  const server = createBridge({
    token: 'revision-token',
    async turn(_prompt, signal, _family, _attachment, observe) {
      observe('Initial paragraph.\n\nSecond');
      observe('Initial paragraph.\n\nSecond paragraph.');
      await Promise.race([revise.promise, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
      observe('Revised paragraph.\n\nSecond paragraph.');
      assert.fail('A revision to emitted text must interrupt the turn.');
    },
  });
  t.after(() => {
    revise.resolve();
    server.close();
    server.closeAllConnections();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
    signal: AbortSignal.timeout(3000),
    method: 'POST',
    headers: { authorization: 'Bearer revision-token' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Write two paragraphs.' }] }] }),
  });
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /Initial paragraph/);
  assert.doesNotMatch(first, /finishReason/);
  revise.resolve();
  await assert.rejects(reader.read(), TypeError);
});
