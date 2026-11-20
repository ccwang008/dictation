const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { createApp } = require('../server/index.cjs');
const { validationRunner } = require('./fixtures/audio-validation.cjs');
const voa = require('../data/listening/episodes/voa-8002695.json');

test('听写收藏跨素材去重、重启持久化及移除', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lh-favorites-'));
  const dbPath = join(directory, 'test.sqlite3');
  const options = { dbPath, mediaDir: join(directory, 'media'), validationRunner };
  const favoritesPath = 'dictation/favorites';
  const local = { id: 'local-favorite-test', title: '测试素材', createdAt: Date.now(), duration: 2, wpm: 60, sentences: [
    { id: 1, en: 'First sentence.', zh: '', t0: 0, t1: 1 },
    { id: 2, en: 'Second sentence.', zh: '', t0: 1, t1: 2 },
  ] };
  const voaSentence = voa.sentences[0];
  const voaPath = `${favoritesPath}/${voa.id}/${voaSentence.id}`;
  const localPath = `${favoritesPath}/${local.id}/1`;
  let server;

  async function start() {
    server = createApp(options);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }

  async function request(path, options, status = 200) {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/api/${path}`, options);
    assert.equal(result.status, status, path);
    return result.json();
  }

  try {
    const oldDb = new DatabaseSync(dbPath);
    try {
      oldDb.exec(`CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL);
        INSERT INTO app_state VALUES ('lh_saved_progress', '{}', 1);`);
    } finally {
      oldDb.close();
    }
    await start();
    assert.deepEqual(await request(favoritesPath), { favorites: [] });
    const [first, duplicate] = await Promise.all([
      request(voaPath, { method: 'PUT' }),
      request(voaPath, { method: 'PUT' }),
    ]);
    assert.deepEqual(duplicate, first);
    assert.equal(first.title, voa.title);
    assert.equal(first.sentence, voaSentence.en);
    assert.ok(Number.isSafeInteger(first.savedAt) && first.savedAt > 0);
    await request(`${favoritesPath}/${voa.id}/9007199254740991`, { method: 'PUT' }, 404);

    const form = new FormData();
    form.set('metadata', JSON.stringify(local));
    form.set('audio', new Blob(['audio']), 'audio.mp3');
    form.set('subtitle', new Blob(['subtitle']), 'subtitles.lrc');
    await request('materials', { method: 'POST', body: form }, 201);
    const second = await request(localPath, { method: 'PUT' });
    assert.equal(second.title, local.title);
    assert.equal(second.sentence, local.sentences[0].en);
    assert.deepEqual(await request(voaPath, { method: 'PUT' }), first);
    assert.deepEqual((await request(favoritesPath)).favorites, [second, first]);
    await request(`materials/${local.id}`, { method: 'DELETE' });

    server.close();
    await once(server, 'close');
    await start();
    assert.deepEqual((await request(favoritesPath)).favorites, [second, first]);
    assert.equal((await request('state')).entries.lh_saved_progress.value, '{}');
    assert.deepEqual(await request(localPath, { method: 'DELETE' }), { ok: true });
    assert.deepEqual(await request(localPath, { method: 'DELETE' }), { ok: true });
    assert.deepEqual((await request(favoritesPath)).favorites, [first]);
    await request(localPath, { method: 'PUT' }, 404);
  } finally {
    if (server?.listening) {
      server.close();
      await once(server, 'close');
    }
    await rm(directory, { recursive: true, force: true });
  }
});
