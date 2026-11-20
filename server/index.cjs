const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const { readFile, writeFile, rm } = require('node:fs/promises');
const { dirname, extname, join, posix, resolve } = require('node:path');
const { Readable } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');
const serveFiles = require('http-server/lib/core');
const { createAudioValidation } = require('./audio-validation.cjs');

const root = resolve(__dirname, '..');
const stateKey = /^(?:voa_|lh_|vt_)[a-z0-9_-]+$/;
const materialId = /^local-[a-z0-9-]{1,64}$/;
const favoritesPath = '/api/dictation/favorites';
const favoriteItemPath = /^\/api\/dictation\/favorites\/(voa-\d+|local-[a-z0-9-]{1,64})\/(-?\d+)$/;
const audioExtensions = new Set('.mp3 .m4a .m4b .wav .flac .aac .ogg .oga .opus .webm .weba .mp4 .aif .aiff .caf .amr .wma .mka .3gp .mov .mpeg .mpga'.split(' '));
const subtitleExtensions = new Set(['.lrc', '.srt', '.vtt', '.txt']);
const publicFiles = new Set(['/index.html', '/app.js', '/manifest.json', '/service-worker.js']);
const publicFolders = ['/js/', '/data/', '/audio/voa/', '/docs/images/'];

function respond(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function requestError(status, message) {
  return Object.assign(new Error(message), { status });
}

function readBody(req, type) {
  if (!req.headers['content-type']?.toLowerCase().startsWith(type)) throw requestError(415, '请求格式不受支持');
  return new Request('http://localhost', {
    method: 'POST', headers: { 'Content-Type': req.headers['content-type'] },
    body: Readable.toWeb(req), duplex: 'half',
  });
}

function parseMetadata(raw) {
  let meta;
  try { meta = JSON.parse(raw); } catch { throw requestError(400, '素材信息格式无效'); }
  const sentences = meta?.sentences;
  if (!materialId.test(meta?.id) || typeof meta.title !== 'string' || !meta.title.trim() ||
      !Number.isFinite(meta.createdAt) || !Number.isFinite(meta.duration) || !Number.isFinite(meta.wpm) ||
      !Array.isArray(sentences) || sentences.length < 2 || new Set(sentences.map(s => s?.id)).size !== sentences.length || !sentences.every(s =>
        s && Number.isSafeInteger(s.id) && typeof s.en === 'string' && typeof s.zh === 'string' &&
        Number.isFinite(s.t0) && Number.isFinite(s.t1) && s.t1 >= s.t0)) {
    throw requestError(400, '素材信息或字幕时间轴无效');
  }
  return meta;
}

function createApp({ dbPath = join(__dirname, 'data', 'listeninghub.sqlite3'), mediaDir = join(root, 'audio', 'my'), validationRunner } = {}) {
  mkdirSync(dirname(dbPath), { recursive: true });
  mkdirSync(mediaDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY, metadata TEXT NOT NULL, folder TEXT NOT NULL,
      audio_file TEXT NOT NULL, subtitle_file TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS dictation_favorites (
      episode_id TEXT NOT NULL, sentence_id INTEGER NOT NULL, title TEXT NOT NULL,
      sentence TEXT NOT NULL, saved_at INTEGER NOT NULL,
      PRIMARY KEY (episode_id, sentence_id)
    );
  `);
  const readState = db.prepare('SELECT key, value, revision FROM app_state');
  const seedState = db.prepare('INSERT OR IGNORE INTO app_state (key, value, revision) VALUES (?, ?, 0)');
  const writeState = db.prepare(`
    INSERT INTO app_state (key, value, revision) VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, revision = excluded.revision
    WHERE excluded.revision > app_state.revision
  `);
  const readMaterials = db.prepare('SELECT id, metadata, deleted FROM materials');
  const readMaterial = db.prepare('SELECT * FROM materials WHERE id = ?');
  const insertMaterial = db.prepare('INSERT OR IGNORE INTO materials (id, metadata, folder, audio_file, subtitle_file) VALUES (?, ?, ?, ?, ?)');
  const deleteMaterial = db.prepare("UPDATE materials SET deleted = 1, metadata = '{}' WHERE id = ?");
  const selectFavorites = `SELECT episode_id AS episodeId, sentence_id AS sentenceId,
    title, sentence, saved_at AS savedAt FROM dictation_favorites`;
  const listFavorites = db.prepare(selectFavorites + ' ORDER BY saved_at DESC, rowid DESC');
  const readFavorite = db.prepare(selectFavorites + ' WHERE episode_id = ? AND sentence_id = ?');
  const insertFavorite = db.prepare(`
    INSERT INTO dictation_favorites (episode_id, sentence_id, title, sentence, saved_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (episode_id, sentence_id) DO NOTHING
  `);
  const deleteFavorite = db.prepare('DELETE FROM dictation_favorites WHERE episode_id = ? AND sentence_id = ?');
  for (const { folder } of db.prepare('SELECT folder FROM materials WHERE deleted = 1').all()) {
    rm(join(mediaDir, folder), { recursive: true, force: true }).catch(console.error);
  }
  const files = serveFiles({ root, cache: '-1', showDir: false, autoIndex: false });
  const media = serveFiles({ root: mediaDir, cache: '-1', showDir: false, autoIndex: false });
  const validation = createAudioValidation({ db, mediaDir, readMaterial, runner: validationRunner });
  const materialMetadata = row => ({ ...JSON.parse(row.metadata), validation: validation.summary(row.id) });

  function state() {
    return { backend: 'sqlite', entries: Object.fromEntries(readState.all().map(({ key, ...entry }) => [key, entry])) };
  }

  async function saveFavorite(episodeId, sentenceId) {
    const existing = readFavorite.get(episodeId, sentenceId);
    if (existing) return existing;

    let episode;
    if (materialId.test(episodeId)) {
      const material = readMaterial.get(episodeId);
      if (!material || material.deleted) throw requestError(404, '素材不存在');
      episode = JSON.parse(material.metadata);
    } else {
      try {
        episode = JSON.parse(await readFile(join(root, 'data', 'listening', 'episodes', episodeId + '.json'), 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') throw requestError(404, '素材不存在');
        throw error;
      }
    }
    const sentence = episode.sentences.find(item => item.id === sentenceId);
    if (!sentence?.en?.trim()) throw requestError(404, '听写原句不存在');
    insertFavorite.run(episodeId, sentenceId, episode.title, sentence.en, Date.now());
    return readFavorite.get(episodeId, sentenceId);
  }

  async function uploadMaterial(req, res) {
    const form = await readBody(req, 'multipart/form-data').formData();
    const meta = parseMetadata(form.get('metadata'));
    delete meta.validation;
    const current = readMaterial.get(meta.id);
    if (current) return respond(res, 200, { id: meta.id, deleted: Boolean(current.deleted) });
    const audio = form.get('audio');
    const subtitle = form.get('subtitle');
    if (!(audio instanceof File) || !audio.size || !(subtitle instanceof File) || !subtitle.size) {
      throw requestError(400, '需要同时提交音频和字幕文件');
    }
    const audioExt = extname(audio.name).toLowerCase();
    const subtitleExt = extname(subtitle.name).toLowerCase();
    const audioFile = 'audio' + (audioExtensions.has(audioExt) ? audioExt : '.bin');
    const subtitleFile = 'subtitles' + (subtitleExtensions.has(subtitleExt) ? subtitleExt : '.txt');
    const folder = randomUUID();
    const directory = join(mediaDir, folder);
    mkdirSync(directory);
    let saved = false;
    try {
      await writeFile(join(directory, audioFile), audio.stream());
      await writeFile(join(directory, subtitleFile), subtitle.stream());
      saved = Boolean(insertMaterial.run(meta.id, JSON.stringify(meta), folder, audioFile, subtitleFile).changes);
    } finally {
      if (!saved) await rm(directory, { recursive: true, force: true });
    }
    if (saved) validation.enqueue(meta.id);
    respond(res, saved ? 201 : 200, { id: meta.id, deleted: Boolean(readMaterial.get(meta.id)?.deleted), validation: validation.summary(meta.id) });
  }

  async function handleApi(req, res, pathname) {
    if (pathname === favoritesPath && req.method === 'GET') {
      return respond(res, 200, { favorites: listFavorites.all() });
    }
    const favorite = pathname.match(favoriteItemPath);
    if (favorite) {
      const episodeId = favorite[1];
      const sentenceId = Number(favorite[2]);
      if (!Number.isSafeInteger(sentenceId)) throw requestError(400, '句子编号无效');
      if (req.method === 'PUT') return respond(res, 200, await saveFavorite(episodeId, sentenceId));
      if (req.method === 'DELETE') {
        deleteFavorite.run(episodeId, sentenceId);
        return respond(res, 200, { ok: true });
      }
      throw requestError(405, '请求方法不受支持');
    }
    if (req.method === 'GET' && pathname === '/api/state') return respond(res, 200, state());
    if (req.method === 'POST' && pathname === '/api/state/migrate') {
      const values = await readBody(req, 'application/json').json();
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw requestError(400, '存储数据格式无效');
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const [key, value] of Object.entries(values)) {
          if (stateKey.test(key) && typeof value === 'string') seedState.run(key, value);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return respond(res, 200, state());
    }
    if (req.method === 'PUT' && pathname.startsWith('/api/state/')) {
      const key = pathname.slice('/api/state/'.length);
      const entry = await readBody(req, 'application/json').json();
      if (!stateKey.test(key) || typeof entry?.value !== 'string' || !Number.isSafeInteger(entry.revision) || entry.revision <= 0) {
        throw requestError(400, '存储数据格式无效');
      }
      writeState.run(key, entry.value, entry.revision);
      return respond(res, 200, { ok: true });
    }
    if (pathname === '/api/materials') {
      if (req.method === 'POST') return uploadMaterial(req, res);
      if (req.method === 'GET') {
        const rows = readMaterials.all();
        return respond(res, 200, {
          materials: rows.filter(row => !row.deleted).map(materialMetadata),
          importedIds: rows.map(row => row.id),
        });
      }
    }
    const checkMatch = pathname.match(/^\/api\/materials\/(local-[a-z0-9-]+)\/validation(?:\/(audio|review))?$/);
    if (checkMatch) {
      const [, id, action] = checkMatch;
      const row = readMaterial.get(id);
      if (!row || row.deleted) throw requestError(404, '素材不存在');
      if (!action && req.method === 'GET') return respond(res, 200, validation.summary(id, true));
      if (!action && req.method === 'POST') return respond(res, 202, validation.enqueue(id));
      if (action === 'review' && req.method === 'POST') {
        return respond(res, 200, await validation.confirm(id, await readBody(req, 'application/json').json()));
      }
      if (action === 'audio' && ['GET', 'HEAD'].includes(req.method)) {
        return media({ url: '/' + row.folder + '/' + validation.preview(id), headers: req.headers, method: req.method }, res);
      }
      throw requestError(405, '请求方法不受支持');
    }
    const match = pathname.match(/^\/api\/materials\/(local-[a-z0-9-]+)(?:\/(audio|subtitle))?$/);
    if (!match) throw requestError(404, '请求的资源不存在');
    const [, id, asset] = match;
    const row = readMaterial.get(id);
    if (!asset && req.method === 'DELETE') {
      if (row && !row.deleted) {
        db.exec('BEGIN IMMEDIATE');
        try {
          deleteMaterial.run(id);
          validation.cancel(id);
          writeState.run('lh_dictation_' + id, '{}', Date.now() * 1000);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
      if (row) await rm(join(mediaDir, row.folder), { recursive: true, force: true });
      return respond(res, 200, { ok: true });
    }
    if (!row || row.deleted) throw requestError(404, '素材不存在');
    if (!asset && req.method === 'GET') return respond(res, 200, materialMetadata(row));
    if (asset && ['GET', 'HEAD'].includes(req.method)) {
      const file = asset === 'audio' ? row.audio_file : row.subtitle_file;
      return media({ url: '/' + row.folder + '/' + file, headers: req.headers, method: req.method }, res);
    }
    throw requestError(405, '请求方法不受支持');
  }

  const server = createServer((req, res) => {
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(req.headers.host ?? '') ||
        (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) {
      return respond(res, 403, { error: '仅支持从本机站点访问' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname.startsWith('/api/')) {
        if (req.headers['sec-fetch-site'] === 'cross-site') throw requestError(403, '仅支持从本机站点访问');
        return handleApi(req, res, pathname).catch(error => sendError(res, error));
      }
      const file = posix.normalize(decodeURIComponent(pathname).replaceAll('\\', '/'));
      const hasHiddenPart = file.split('/').some(part => part.startsWith('.'));
      if (hasHiddenPart || !(file === '/' || publicFiles.has(file) || publicFolders.some(prefix => file.startsWith(prefix) && !file.endsWith('/')))) {
        return respond(res, 404, { error: '请求的资源不存在' });
      }
      req.url = file === '/' ? '/index.html' : file.split('/').map(encodeURIComponent).join('/');
      files(req, res);
    } catch (error) {
      sendError(res, error);
    }
  });
  server.once('close', () => { validation.close(); db.close(); });
  return server;
}

function sendError(res, error) {
  const status = error.status ?? (error instanceof SyntaxError ? 400 : 500);
  if (status === 500) console.error(error);
  if (!res.headersSent) respond(res, status, { error: status === 500 ? '本地服务处理失败' : error.message });
  else res.destroy();
}

if (require.main === module) {
  const server = createApp({
    dbPath: process.env.LISTENINGHUB_DB,
    mediaDir: process.env.LISTENINGHUB_MEDIA_DIR,
  });
  server.listen(Number(process.env.PORT ?? 8080), '127.0.0.1', () => {
    console.log('ListeningHub http://localhost:' + server.address().port + ' (SQLite)');
  });
  process.once('SIGTERM', () => server.close());
  process.once('SIGINT', () => server.close());
}

module.exports = { createApp };
