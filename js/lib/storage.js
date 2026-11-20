const api = new URL('../../api/', import.meta.url);
const stateKey = /^(?:voa_|lh_|vt_)[a-z0-9_-]+$/;
const pendingPrefix = 'listeninghub.pending.';
const entries = new Map();
const pending = new Map();
const inFlight = new Map();
let lastRevision = 0;
let retryTimer = 0;

function readBrowser(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function browserKeys() {
  try { return Object.keys(localStorage); } catch { return []; }
}

function writeBrowser(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (error) {
    console.warn('浏览器存储写入失败', key, error);
  }
}

export function apiURL(path) {
  return new URL(path, api).href;
}

export async function requestAPI(path, options) {
  const response = await fetch(apiURL(path), options);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `本地服务请求失败（${response.status}）`);
  }
  return response.json();
}

async function connect() {
  try {
    const response = await fetch(apiURL('state'), { cache: 'no-store' });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // 公共静态站点可能把未知路由映射到 HTML。
    if (!response.headers.get('content-type')?.includes('application/json')) return false;
    let state = await response.json();
    if (state.backend !== 'sqlite') return false;
    const keys = browserKeys();
    const legacy = Object.fromEntries(keys.filter(key => stateKey.test(key) && !Object.hasOwn(state.entries, key))
      .map(key => [key, readBrowser(key)]));
    if (Object.keys(legacy).length) {
      state = await requestAPI('state/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(legacy),
      });
    }
    for (const [key, entry] of Object.entries(state.entries)) {
      entries.set(key, entry.value);
      lastRevision = Math.max(lastRevision, entry.revision);
    }
    for (const localKey of keys.filter(key => key.startsWith(pendingPrefix))) {
      const key = localKey.slice(pendingPrefix.length);
      const entry = JSON.parse(readBrowser(localKey) || 'null');
      if (!stateKey.test(key) || typeof entry?.value !== 'string' || !Number.isSafeInteger(entry.revision)) continue;
      if (entry.revision <= (state.entries[key]?.revision ?? 0)) {
        writeBrowser(localKey, null);
        continue;
      }
      pending.set(key, entry);
      entries.set(key, entry.value);
      lastRevision = Math.max(lastRevision, entry.revision);
    }
    if (pending.size) flush();
    window.addEventListener('pagehide', flush);
    window.addEventListener('online', flush);
    return true;
  } catch (error) {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return false;
    const message = document.createElement('p');
    message.setAttribute('role', 'alert');
    message.style.cssText = 'padding: 24px; font: 16px system-ui; color: #991b1b';
    message.textContent = '无法连接 ListeningHub 本地数据库。请启动本地服务后刷新页面。';
    document.body.prepend(message);
    throw error;
  }
}

function scheduleFlush(delay = 120) {
  if (!retryTimer) retryTimer = window.setTimeout(flush, delay);
}

function flush() {
  window.clearTimeout(retryTimer);
  retryTimer = 0;
  for (const [key, entry] of pending) {
    if (inFlight.get(key) === entry) continue;
    inFlight.set(key, entry);
    const body = JSON.stringify(entry);
    requestAPI('state/' + key, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: new TextEncoder().encode(body).length < 60 * 1024,
    }).then(() => {
      if (pending.get(key) !== entry) return;
      pending.delete(key);
      const stored = JSON.parse(readBrowser(pendingPrefix + key) || 'null');
      if (stored?.revision === entry.revision) writeBrowser(pendingPrefix + key, null);
    }).catch(error => {
      console.warn('等待重试写入 SQLite', key, error);
      scheduleFlush(1500);
    }).finally(() => {
      if (inFlight.get(key) === entry) inFlight.delete(key);
    });
  }
}

export const useSqlite = await connect();

export function readValue(key) {
  return useSqlite ? (entries.get(key) ?? null) : readBrowser(key);
}

export function writeValue(key, value) {
  if (!useSqlite) return writeBrowser(key, value);
  const revision = Math.max(lastRevision + 1, Math.floor((performance.timeOrigin + performance.now()) * 1000));
  lastRevision = revision;
  const entry = { value, revision };
  entries.set(key, value);
  pending.set(key, entry);
  writeBrowser(pendingPrefix + key, JSON.stringify(entry));
  scheduleFlush();
}
