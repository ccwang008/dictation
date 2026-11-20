const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createApp } = require('../server/index.cjs');
const { validationRunner } = require('./fixtures/audio-validation.cjs');

async function runScripts(env) {
  for (const script of process.argv.slice(2)) {
    const child = spawn(process.execPath, [join(__dirname, script)], { stdio: 'inherit', env });
    const [code] = await once(child, 'exit');
    if (code !== 0) return code ?? 1;
  }
  return 0;
}

async function run() {
  if (process.env.BASE) return runScripts(process.env);
  const directory = await mkdtemp(join(tmpdir(), 'listeninghub-tests-'));
  const dbPath = join(directory, 'test.sqlite3');
  const mediaDir = join(directory, 'media');
  const server = createApp({ dbPath, mediaDir, validationRunner });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return await runScripts({
      ...process.env, BASE: 'http://localhost:' + server.address().port + '/index.html',
      LISTENINGHUB_TEST_MEDIA: mediaDir,
    });
  } finally {
    server.close();
    await once(server, 'close');
    await rm(directory, { recursive: true, force: true });
  }
}

run().then(code => { process.exitCode = code; }).catch(error => {
  console.error(error);
  process.exitCode = 2;
});
