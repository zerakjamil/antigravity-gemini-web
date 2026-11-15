import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openBrowser, runTurn } from './browser.mjs';
import { createBridge } from './server.mjs';
import { createLoopbackCertificate } from './tls.mjs';

const executable = '/Applications/Antigravity.app/Contents/MacOS/Antigravity';
try {
  execFileSync('/usr/bin/pgrep', ['-f', '^/Applications/Antigravity[.]app/Contents/MacOS/Antigravity( |$)']);
  throw new Error('Quit the existing Antigravity desktop app before starting a Gateway session.');
} catch (error) {
  if (error.status !== 1) throw error;
}

const { certPath, tls, dispose } = await createLoopbackCertificate();
let browser;
let server;
let desktop;
let stopping = false;
function stop() {
  stopping = true;
  desktop?.kill();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const token = randomBytes(32).toString('hex');
  const profile = process.env.ARGON_CHROME_PROFILE ?? join(homedir(), '.gemini', 'argon-chrome-profile');
  browser = await openBrowser(profile);
  if (stopping) throw new Error('Desktop launch cancelled.');
  server = createBridge({ token, tls, turn: (prompt, signal, model) => runTurn(browser, prompt, signal, model) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  desktop = spawn(executable, [], {
    env: {
      ...process.env,
      AGY_LLM_GATEWAY_URL: `https://127.0.0.1:${server.address().port}`,
      AGY_LLM_GATEWAY_API_KEY: token,
      AGY_LLM_GATEWAY_CA_CERT: certPath,
      AGY_LLM_GATEWAY_WIRE_PROTOCOL: 'genai',
      AGY_LLM_GATEWAY_MODELS: 'gemini-4-argon-web,gemini-4-hydrogen-web',
    },
    stdio: 'inherit',
  });
  const [code] = await once(desktop, 'exit');
  process.exitCode = code ?? 0;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  server?.close();
  server?.closeAllConnections();
  await browser?.close();
  await dispose();
}
