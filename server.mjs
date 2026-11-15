import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const model = 'gemini-4-argon-web';
const catalog = ['Argon', 'Hydrogen'].map(label => ({
  name: `models/gemini-4-${label.toLowerCase()}-web`,
  displayName: `Gemini 4 ${label} (Web)`,
  supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
  inputTokenLimit: 32000, outputTokenLimit: 8192,
}));
const toolPrefix = 'LOCAL_TOOL_CALL ';
const maxBytes = 2 * 1024 * 1024;
const finish = (parts, reason = 'STOP') => ({
  candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: reason }],
});

function compile(request) {
  if (!Array.isArray(request.contents) || !request.contents.length) throw new Error('Missing contents.');
  const tools = request.tools ?? [];
  if (!Array.isArray(tools) || tools.some(tool => Object.keys(tool).some(key => key !== 'functionDeclarations'))) {
    throw new Error('This provider supports local function declarations only.');
  }
  const functions = tools.flatMap(tool => tool.functionDeclarations ?? []);
  const config = request.toolConfig?.functionCallingConfig;
  const permitted = config?.mode === 'NONE' ? [] : functions.filter(
    fn => !config?.allowedFunctionNames?.length || config.allowedFunctionNames.includes(fn.name),
  );
  const history = [request.systemInstruction, ...request.contents].filter(Boolean);
  for (const message of history) {
    if (!Array.isArray(message.parts) || message.parts.some(part =>
      ![part.text, part.functionCall, part.functionResponse].some(value => value !== undefined))) {
      throw new Error('This provider supports text and local tool history only.');
    }
  }
  const prompt = [
    'Continue the supplied Antigravity coding conversation. Conversation history includes instructions, user input and local tool results. You cannot execute local tools yourself.',
    permitted.length
      ? 'To request a listed local tool, return one plain-text line starting with LOCAL_TOOL_CALL followed by a JSON object with "name" and "args". Return only that line, without Markdown. The harness handles permissions and sends tool results in a later request.'
      : 'Respond with text.',
    JSON.stringify({ permittedFunctions: permitted, systemInstruction: request.systemInstruction, contents: request.contents }),
  ].join('\n\n');
  if (Buffer.byteLength(prompt) > maxBytes) throw new Error('Prompt exceeds the bridge text limit.');
  return { prompt, permitted: new Set(permitted.map(fn => fn.name)), required: config?.mode === 'ANY' };
}

function partsFromAnswer(answer, { permitted, required }) {
  if (!answer.startsWith(toolPrefix)) {
    if (required) throw new Error('Gemini Web returned text when a tool call was required.');
    return [{ text: answer }];
  }
  const call = JSON.parse(answer.slice(toolPrefix.length));
  if (!permitted.has(call?.name) || !call.args || Array.isArray(call.args) || typeof call.args !== 'object') {
    throw new Error('Gemini Web returned an invalid or undeclared tool call.');
  }
  return [{ functionCall: { name: call.name, args: call.args } }];
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function createBridge({ token, turn, tls, timeoutMs = 300_000 }) {
  if (!token) throw new Error('Set ARGON_BRIDGE_TOKEN.');
  const secret = Buffer.from(token);
  let busy = false;
  const handler = async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      return json(res, 400, { error: { message: 'Invalid request URL.' } });
    }
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const key = Buffer.from(bearer ?? req.headers['x-goog-api-key'] ?? url.searchParams.get('key') ?? '');
    if (req.headers.origin || key.length !== secret.length || !timingSafeEqual(key, secret)) {
      return json(res, 401, { error: { message: 'Invalid local bridge token.' } });
    }
    const path = url.pathname.replace(/^\/v1(?:alpha|beta)?(?=\/)/, '');
    if (req.method === 'GET' && path === '/models') return json(res, 200, { models: catalog });
    const [name, method, extra] = path.slice(1).split(':');
    const selected = catalog.find(entry => entry.name === name);
    if (req.method === 'GET' && selected && path === `/${name}`) return json(res, 200, selected);
    if (req.method !== 'POST' || !path.startsWith('/models/') || !selected || extra !== undefined ||
        !['generateContent', 'streamGenerateContent', 'countTokens'].includes(method)) {
      return json(res, 404, { error: { message: 'Unknown Gemini Web route.' } });
    }

    let input;
    let bytes = 0;
    const chunks = [];
    try {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          res.setHeader('connection', 'close');
          return json(res, 413, { error: { message: 'Payload too large.' } });
        }
        chunks.push(chunk);
      }
      input = compile(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch (error) {
      if (!res.destroyed) json(res, 400, { error: { message: error.message } });
      return;
    }
    if (method === 'countTokens') {
      return json(res, 200, { totalTokens: Math.ceil(Buffer.byteLength(input.prompt) / 2) });
    }
    if (busy) return json(res, 429, { error: { message: 'The browser is handling another turn.' } });

    busy = true;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    res.once('close', () => abort.abort());
    try {
      const family = name.slice('models/gemini-4-'.length, -'-web'.length);
      const answer = await turn(input.prompt, abort.signal, family);
      const response = finish(partsFromAnswer(answer, input));
      if (method === 'streamGenerateContent' && url.searchParams.get('alt') === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end(`data: ${JSON.stringify(response)}\n\n`);
      } else {
        json(res, 200, method === 'streamGenerateContent' ? [response] : response);
      }
    } catch (error) {
      const detail = /^Gemini Web failed while [a-zA-Z ]+\.$/.test(error?.message)
        ? error.message
        : 'Gemini Web returned an invalid or unavailable tool response.';
      if (!res.destroyed) json(res, abort.signal.aborted ? 504 : 502, {
        error: { message: abort.signal.aborted ? 'Gemini Web turn timed out.' : detail },
      });
    } finally {
      clearTimeout(timer);
      busy = false;
    }
  };
  return tls ? createSecureServer(tls, handler) : createServer(handler);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { openBrowser, runTurn } = await import('./browser.mjs');
  const token = process.env.ARGON_BRIDGE_TOKEN;
  const port = Number(process.env.ARGON_BRIDGE_PORT ?? '50006');
  if (!token || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Set ARGON_BRIDGE_TOKEN and a valid port.');
  }
  const keyPath = process.env.ARGON_BRIDGE_TLS_KEY;
  const certPath = process.env.ARGON_BRIDGE_TLS_CERT;
  if (Boolean(keyPath) !== Boolean(certPath)) throw new Error('Set both bridge TLS paths.');
  const tls = keyPath ? { key: await readFile(keyPath), cert: await readFile(certPath) } : undefined;
  const profile = process.env.ARGON_CHROME_PROFILE ?? join(homedir(), '.gemini', 'argon-chrome-profile');
  const browser = await openBrowser(profile);
  const server = createBridge({ token, tls, turn: (prompt, signal, family) => runTurn(browser, prompt, signal, family) });
  server.on('error', async (error) => {
    console.error(error.message);
    process.exitCode = 1;
    await browser.close();
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, async () => {
      server.close();
      server.closeAllConnections();
      await browser.close();
    });
  }
  server.listen(port, '127.0.0.1', () => console.log(`Gemini Web bridge on http${tls ? 's' : ''}://127.0.0.1:${port}`));
}
