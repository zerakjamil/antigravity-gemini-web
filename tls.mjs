import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function createLoopbackCertificate() {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-web-gateway-'));
  const dispose = () => rm(dir, { recursive: true, force: true });
  try {
    const keyPath = join(dir, 'gateway.key');
    const certPath = join(dir, 'gateway.crt');
    const config = join(dir, 'openssl.cnf');
    await writeFile(config, [
      '[req]', 'distinguished_name=dn', 'prompt=no', 'x509_extensions=extensions',
      '[dn]', 'CN=Gemini Web Bridge', '[extensions]', 'subjectAltName=IP:127.0.0.1',
      'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
    ].join('\n'));
    execFileSync('/usr/bin/openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-config', config, '-keyout', keyPath, '-out', certPath,
    ], { stdio: 'ignore' });
    return { certPath, tls: { key: await readFile(keyPath), cert: await readFile(certPath) }, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
