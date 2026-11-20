const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { access, mkdir, readFile, writeFile, rename, rm } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const readline = require('node:readline');

const root = resolve(__dirname, '..');
const pending = new Set(['queued', 'running']);
const requestError = (status, message) => Object.assign(new Error(message), { status });

async function validateAudio({ audio, metadata, directory, signal, onProgress }) {
  const python = process.env.LISTENINGHUB_AUDIO_PYTHON || join(root, '.venv', 'bin', 'python');
  try { await access(python); } catch { throw new Error('语音校验组件未安装，请运行 npm run setup:audio-check 后重试。'); }
  const model = process.env.LISTENINGHUB_WHISPER_MODEL || join(root, 'scripts', '.cache', 'audio-check', 'base.en');
  const input = join(directory, 'input.json');
  await writeFile(input, JSON.stringify(metadata));
  await new Promise((resolve, reject) => {
    const child = spawn(python, [join(root, 'scripts/audio/validate.py'), '--audio', audio,
      '--metadata', input, '--output', directory, '--model', model], {
      signal, env: { ...process.env, HF_HUB_OFFLINE: '1', PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errors = '';
    let timedOut = false;
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-5000); });
    readline.createInterface({ input: child.stdout }).on('line', line => {
      try { const update = JSON.parse(line); onProgress(update); } catch { /* Non-JSON library output. */ }
    });
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 30 * 60 * 1000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(timedOut ? '音文校验超时，请将音频拆分后重试。' :
        /ModuleNotFoundError/.test(errors) ? '语音校验组件不完整，请运行 npm run setup:audio-check 后重试。' :
        errors.trim().split('\n').at(-1) || '语音校验未完成，请重试。'));
    });
  });
  return JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
}

function createAudioValidation({ db, mediaDir, readMaterial, runner = validateAudio }) {
  db.exec(`CREATE TABLE IF NOT EXISTS material_validation (
    material_id TEXT PRIMARY KEY, status TEXT NOT NULL, revision TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '',
    report TEXT, source_audio TEXT NOT NULL, preview_audio TEXT, updated_at INTEGER NOT NULL
  )`);
  const read = db.prepare('SELECT * FROM material_validation WHERE material_id = ?');
  const save = db.prepare(`INSERT INTO material_validation
    (material_id,status,revision,progress,message,report,source_audio,preview_audio,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(material_id) DO UPDATE SET
    status=excluded.status,revision=excluded.revision,progress=excluded.progress,message=excluded.message,
    report=excluded.report,source_audio=excluded.source_audio,preview_audio=excluded.preview_audio,updated_at=excluded.updated_at`);
  const queue = [];
  const confirming = new Set();
  let active = null;
  let closed = false;

  function summary(id, full = false) {
    const check = read.get(id);
    if (!check) return { status: 'unchecked', progress: 0, message: '尚未校验声音与字幕' };
    const result = { status: check.status, revision: check.revision, progress: check.progress,
      message: check.message, updatedAt: check.updated_at };
    if (check.report) {
      const report = JSON.parse(check.report);
      result.total = report.rows.length;
      result.remaining = report.rows.filter(row => row.status === 'review').length;
      result.excluded = report.rows.filter(row => row.status === 'excluded').length;
      result.ready = report.rows.filter(row => ['verified', 'repaired', 'confirmed'].includes(row.status)).length;
      result.corrected = report.rows.filter(row => row.changed && row.status !== 'excluded').length;
      if (full) result.report = report;
    }
    return result;
  }
  function put(check) {
    save.run(check.material_id, check.status, check.revision, check.progress, check.message,
      check.report, check.source_audio, check.preview_audio, Date.now());
  }
  function alive(id, revision) {
    if (closed) return false;
    const material = readMaterial.get(id);
    return material && !material.deleted && read.get(id)?.revision === revision;
  }
  function assertReport(report, metadata) {
    if (!Number.isFinite(report?.duration) || report.duration <= 0 || !Array.isArray(report.rows) ||
        report.rows.length !== metadata.sentences.length) throw new Error('校验结果不完整，请重新校验。');
    report.rows.forEach((row, index) => {
      if (row.id !== metadata.sentences[index].id || row.en !== metadata.sentences[index].en ||
          !['verified', 'repaired', 'excluded', 'review', 'confirmed'].includes(row.status)) throw new Error('校验结果与字幕不一致，请重新校验。');
    });
  }
  function validateBounds(report, partial = false) {
    let previous = -1;
    const ids = new Set();
    for (const row of report.rows) {
      if (row.status === 'excluded') continue;
      if (partial && row.status === 'review') continue;
      if (!Number.isFinite(row.t0) || !Number.isFinite(row.t1) || row.t0 < 0 || row.t1 <= row.t0 ||
          row.t1 > report.duration + .05 || row.t0 < previous || ids.has(row.id)) {
        throw requestError(400, '请检查每句的起止时间：不得倒序、为空或超出音频时长。');
      }
      previous = row.t0;
      ids.add(row.id);
    }
  }
  async function publish(check, report) {
    validateBounds(report);
    const row = readMaterial.get(check.material_id);
    if (!alive(check.material_id, check.revision)) return;
    const metadata = JSON.parse(row.metadata);
    assertReport(report, metadata);
    const byId = new Map(report.rows.map(item => [item.id, item]));
    metadata.sentences = metadata.sentences.map(sentence => {
      const timing = byId.get(sentence.id);
      if (timing.status === 'excluded') return sentence;
      return { ...sentence, t0: timing.t0, t1: timing.t1 };
    });
    metadata.dictationExcluded = report.rows.filter(item => item.status === 'excluded').map(item => item.id);
    metadata.duration = report.duration;
    metadata.timingRevision = check.revision;
    const folder = join(mediaDir, row.folder);
    const subtitle = 'subtitles-validated-' + check.revision + '.vtt';
    const time = value => {
      const ms = Math.round(value * 1000);
      return [Math.floor(ms/3600000), Math.floor(ms/60000)%60, Math.floor(ms/1000)%60]
        .map(v => String(v).padStart(2, '0')).join(':') + '.' + String(ms%1000).padStart(3, '0');
    };
    const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const content = 'WEBVTT\n\n' + metadata.sentences.filter(s => !metadata.dictationExcluded.includes(s.id))
      .map(s => `${time(s.t0)} --> ${time(s.t1)}\n${escape(s.en)}${s.zh ? '\n'+escape(s.zh) : ''}`).join('\n\n') + '\n';
    await writeFile(join(folder, subtitle), content);
    if (!alive(check.material_id, check.revision)) { await rm(join(folder, subtitle), { force: true }); return; }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE materials SET metadata=?,audio_file=?,subtitle_file=? WHERE id=? AND deleted=0')
        .run(JSON.stringify(metadata), check.preview_audio || row.audio_file, subtitle, check.material_id);
      const excluded = metadata.dictationExcluded.length;
      check.status = 'passed'; check.progress = 100;
      check.message = excluded ? `已自动修复，可听写 ${report.rows.length-excluded} 句；${excluded} 句无法可靠修复，已暂时跳过` : '音文自动修正已完成，可以开始听写';
      check.report = JSON.stringify(report);
      put(check);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async function drain() {
    if (closed || active || !queue.length) return;
    const id = queue.shift();
    let check = read.get(id);
    const material = readMaterial.get(id);
    if (!check || check.status !== 'queued' || !material || material.deleted) return drain();
    const controller = new AbortController();
    active = { id, controller };
    const revision = check.revision;
    const folder = join(mediaDir, material.folder);
    const directory = join(folder, '.validation', revision);
    try {
      check.status = 'running'; check.message = '正在准备音文校验'; put(check);
      await mkdir(directory, { recursive: true });
      const metadata = JSON.parse(material.metadata);
      const report = await runner({ audio: join(folder, check.source_audio), metadata, directory,
        signal: controller.signal, onProgress(update) {
          if (!alive(id, revision)) return;
          check.progress = Math.max(check.progress, Math.min(99, Number(update.progress) || 0));
          if (typeof update.message === 'string') check.message = update.message;
          put(check);
        } });
      if (!alive(id, revision)) return;
      assertReport(report, metadata);
      const playback = join(directory, 'playback.wav');
      try {
        await access(playback);
        const filename = 'audio-validated-' + revision + '.wav';
        await rename(playback, join(folder, filename));
        check.preview_audio = filename;
      } catch (error) {
        if (error.code !== 'ENOENT' || runner === validateAudio) throw error;
        check.preview_audio = check.source_audio;
      }
      check.report = JSON.stringify(report); check.progress = 100;
      const remaining = report.rows.filter(row => row.status === 'review').length;
      const ready = report.rows.filter(row => ['verified', 'repaired', 'confirmed'].includes(row.status)).length;
      if (!remaining && (ready < 2 || ready/report.rows.length < .6)) {
        check.status = 'failed'; check.message = '音频与字幕匹配程度过低，自动修复未成功，请检查是否选择了对应的音频与字幕。';
        put(check);
      } else
      if (remaining) {
        check.status = 'review'; check.message = `${remaining} 句需要试听复核，通过前暂不开启听写`;
        put(check);
      } else await publish(check, report);
    } catch (error) {
      if (alive(id, revision) && !controller.signal.aborted) {
        check = read.get(id);
        check.status = 'failed'; check.message = error.message || '校验失败，请重试'; put(check);
      }
    } finally { active = null; drain(); }
  }
  function enqueue(id) {
    const material = readMaterial.get(id);
    if (!material || material.deleted) throw requestError(404, '素材不存在');
    const existing = read.get(id);
    if (existing && pending.has(existing.status)) return summary(id, true);
    const check = { material_id: id, status: 'queued', revision: randomUUID(), progress: 0,
      message: '等待音文校验', report: null, source_audio: existing?.source_audio || material.audio_file, preview_audio: null };
    put(check); queue.push(id); setImmediate(drain);
    return summary(id, true);
  }
  async function performConfirm(id, body) {
    const check = read.get(id);
    if (!check || !['review', 'passed'].includes(check.status) || check.revision !== body?.revision) throw requestError(409, '校验结果已更新，请刷新后再确认。');
    const report = JSON.parse(check.report);
    const row = report.rows.find(row => row.id === body.sentenceId);
    if (!row || !['review','excluded'].includes(row.status)) throw requestError(400, '该句无需复核或不存在。');
    if (body.confirmed !== true) throw requestError(400, '请试听后确认该句与原文同步。');
    row.t0 = body.t0; row.t1 = body.t1;
    row.status = 'confirmed'; row.changed = row.t0 !== row.original.t0 || row.t1 !== row.original.t1;
    validateBounds(report, true);
    if (!report.rows.some(row => row.status === 'review')) await publish(check, report);
    else {
      check.report = JSON.stringify(report);
      check.message = `${report.rows.filter(row => row.status === 'review').length} 句需要试听复核，通过前暂不开启听写`;
      put(check);
    }
    return summary(id, true);
  }
  async function confirm(id, body) {
    if (confirming.has(id)) throw requestError(409, '正在保存复核结果，请稍后重试。');
    confirming.add(id);
    try { return await performConfirm(id, body); }
    finally { confirming.delete(id); }
  }
  function preview(id) {
    const check = read.get(id);
    if (!check?.preview_audio) throw requestError(409, '校验音频尚未准备好');
    return check.preview_audio;
  }
  function cancel(id) {
    db.prepare('DELETE FROM material_validation WHERE material_id=?').run(id);
    if (active?.id === id) active.controller.abort();
  }
  function close() { closed = true; active?.controller.abort(); }
  // A stopped process never leaves a material permanently "running".
  db.prepare("UPDATE material_validation SET status='queued',message='服务重启，等待继续校验' WHERE status='running'").run();
  for (const check of db.prepare("SELECT material_id,report FROM material_validation WHERE status='review'").all()) {
    if ((JSON.parse(check.report || '{}').schema || 1) < 2) {
      db.prepare("UPDATE material_validation SET status='queued',progress=0,message='正在自动修复此前未对齐的句子' WHERE material_id=?").run(check.material_id);
    }
  }
  for (const row of db.prepare("SELECT material_id FROM material_validation WHERE status='queued'").all()) queue.push(row.material_id);
  setImmediate(drain);
  return { summary, enqueue, confirm, preview, cancel, close };
}
module.exports = { createAudioValidation, validateAudio };
