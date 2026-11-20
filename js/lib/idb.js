// 极简 IndexedDB 封装：保存用户导入的音频与字幕（文件不离开本机）
const DB_NAME = 'listeninghub';
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('materials')) db.createObjectStore('materials', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function transaction(stores, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const result = fn(t);
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function tx(store, mode, fn) {
  return transaction(store, mode, t => fn(t.objectStore(store)));
}

export const materialsDB = {
  list() {
    return tx('materials', 'readonly', s => s.getAll());
  },
  get(id) {
    return tx('materials', 'readonly', s => s.get(id));
  },
  put(meta, audio, subtitle) {
    return transaction(['materials', 'blobs'], 'readwrite', t => {
      const blobs = t.objectStore('blobs');
      blobs.put(audio, meta.id);
      if (subtitle) blobs.put(subtitle, 'subtitle:' + meta.id);
      t.objectStore('materials').put(meta);
    });
  },
  getAudio(id) {
    return tx('blobs', 'readonly', s => s.get(id));
  },
  getSubtitle(id) {
    return tx('blobs', 'readonly', s => s.get('subtitle:' + id));
  },
  remove(id) {
    return transaction(['materials', 'blobs'], 'readwrite', t => {
      const blobs = t.objectStore('blobs');
      blobs.delete(id);
      blobs.delete('subtitle:' + id);
      t.objectStore('materials').delete(id);
    });
  },
};

// 请求持久化存储，避免浏览器在空间紧张时清掉导入的素材
export function requestPersist() {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
