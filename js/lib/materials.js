import { materialsDB, requestPersist } from './idb.js';
import { apiURL, requestAPI, useSqlite } from './storage.js';

const materialPath = id => 'materials/' + encodeURIComponent(id);
let migration;

function vttTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor(ms / 60000) % 60;
  const secs = Math.floor(ms / 1000) % 60;
  return [hours, minutes, secs].map(part => String(part).padStart(2, '0')).join(':') +
    '.' + String(ms % 1000).padStart(3, '0');
}

function reconstructSubtitles(sentences) {
  const lines = sentences.map(s => {
    const text = [s.en, s.zh].filter(Boolean).join('\n').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return vttTime(s.t0) + ' --> ' + vttTime(s.t1) + '\n' + text;
  });
  return new Blob(['WEBVTT\n\n' + lines.join('\n\n') + '\n'], { type: 'text/vtt' });
}

async function upload(meta, audio, subtitle) {
  const form = new FormData();
  form.set('metadata', JSON.stringify(meta));
  form.set('audio', audio, meta.audioName || audio.name || 'audio.mp3');
  form.set('subtitle', subtitle, meta.subtitleName || subtitle.name || 'subtitles.vtt');
  return requestAPI('materials', { method: 'POST', body: form });
}

async function migrateLegacyMaterials() {
  const legacy = await materialsDB.list().catch(error => {
    console.warn('无法读取浏览器中的旧素材', error);
    return [];
  });
  if (!legacy.length) return;
  const { importedIds } = await requestAPI('materials');
  const knownIds = new Set(importedIds);
  for (const meta of legacy) {
    if (knownIds.has(meta.id)) continue;
    try {
      const audio = await materialsDB.getAudio(meta.id);
      if (!audio) throw new Error('音频缺失');
      const original = await materialsDB.getSubtitle(meta.id);
      const subtitle = original || reconstructSubtitles(meta.sentences);
      const data = original ? meta : { ...meta, subtitleName: 'subtitles.vtt' };
      await upload(data, audio, subtitle);
    } catch (error) {
      console.warn('无法迁移旧素材', meta.id, error);
    }
  }
}

export const materials = {
  async list() {
    if (!useSqlite) return materialsDB.list();
    migration ??= migrateLegacyMaterials().catch(error => {
      migration = null;
      throw error;
    });
    await migration;
    return (await requestAPI('materials')).materials;
  },
  get(id) {
    return useSqlite ? requestAPI(materialPath(id)) : materialsDB.get(id);
  },
  async audioURL(id, revision = '') {
    if (useSqlite) return apiURL(materialPath(id) + '/audio' + (revision ? '?v=' + encodeURIComponent(revision) : ''));
    const blob = await materialsDB.getAudio(id);
    return blob ? URL.createObjectURL(blob) : '';
  },
  async put(meta, audio, subtitle) {
    if (useSqlite) return upload(meta, audio, subtitle);
    await materialsDB.put(meta, audio, subtitle);
    requestPersist();
  },
  remove(id) {
    return useSqlite ? requestAPI(materialPath(id), { method: 'DELETE' }) : materialsDB.remove(id);
  },
};
