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
