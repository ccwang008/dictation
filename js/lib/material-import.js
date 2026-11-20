import { parseSubtitles } from './subtitles.js';

const audioExtensions = new Set('mp3 m4a m4b wav flac aac ogg oga opus webm weba mp4 aif aiff caf amr wma mka 3gp mov mpeg mpga'.split(' '));
const subtitleExtensions = new Set(['lrc', 'srt', 'vtt']);
const lessonOrder = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export const compareLessonNames = (a, b) => lessonOrder.compare(a, b);
export const unclassified = '未分类';
export function normalizeTextbook(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name === unclassified ? '' : name;
}

export const fileTitle = name => name.replace(/\.[^.]+$/, '');

export function scanMaterialFolder(files) {
  const groups = new Map();
  let name = '';
  for (const file of files) {
    const parts = file.webkitRelativePath.split('/');
    if (parts.length < 2) continue;
    const root = parts.shift();
    name ||= root;
    const extension = file.name.match(/\.([^.]+)$/)?.[1].toLowerCase();
    const kind = audioExtensions.has(extension) ? 'audio' : subtitleExtensions.has(extension) ? 'subtitle' : null;
    if (!kind) continue;

    const path = fileTitle(parts.join('/'));
    const key = path.toLowerCase();
    if (!groups.has(key)) groups.set(key, { path, audio: [], subtitle: [] });
    groups.get(key)[kind].push(file);
  }
  return { name, groups: [...groups.values()].sort((a, b) => compareLessonNames(a.path, b.path)) };
}

async function readSubtitle(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const hasUtf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    return new TextDecoder('gb18030').decode(hasUtf8Bom ? bytes.subarray(3) : bytes);
  }
}

function audioDuration(file) {
  return new Promise(resolve => {
    const audio = new Audio();
    const url = URL.createObjectURL(file);
    function finish(duration) {
      audio.onloadedmetadata = audio.onerror = null;
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(duration) ? duration : 0);
    }
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => finish(audio.duration);
    audio.onerror = () => finish(0);
    audio.src = url;
  });
}

export async function prepareMaterial(audio, subtitle, { title, textbook }) {
  if (!audio.size || !subtitle.size) throw new Error('音频或字幕文件为空');
  const [duration, text] = await Promise.all([audioDuration(audio), readSubtitle(subtitle)]);
  const sentences = parseSubtitles(text, subtitle.name, duration);
  if (sentences.length < 2) throw new Error('字幕至少需要两句带时间轴的内容（LRC / SRT / VTT）');
  const words = sentences.reduce((count, sentence) => count + sentence.en.split(/\s+/).length, 0);
  const speech = sentences.reduce((total, sentence) => total + sentence.t1 - sentence.t0, 0) || 1;
  return {
    id: `local-${crypto.randomUUID()}`, title: title.trim() || fileTitle(audio.name) || audio.name,
    ...(textbook ? { textbook } : {}), createdAt: Date.now(), duration, wpm: Math.round(words / speech * 60),
    sentences, audioName: audio.name, subtitleName: subtitle.name,
  };
}
