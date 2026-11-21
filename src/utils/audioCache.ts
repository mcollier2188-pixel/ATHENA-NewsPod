const DB_NAME = 'dispatch_audio_cache_v1';
const DB_VERSION = 1;
const STORE_NAME = 'segment_audio';

interface StoredAudioRecord {
  key: string;
  briefingId: string;
  segmentId: string;
  audioBase64: string;
  updatedAt: number;
}

function openAudioDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex('by_briefing', 'briefingId', { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveSegmentAudio(
  briefingId: string,
  segmentId: string,
  audioBase64: string
): Promise<void> {
  const db = await openAudioDb();
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const record: StoredAudioRecord = {
        key: `${briefingId}:${segmentId}`,
        briefingId,
        segmentId,
        audioBase64,
        updatedAt: Date.now(),
      };
      store.put(record);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

export async function loadBriefingAudio(
  briefingId: string
): Promise<Record<string, string>> {
  const db = await openAudioDb();
  if (!db) return {};

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('by_briefing');
      const request = index.getAll(briefingId);

      request.onsuccess = () => {
        const records = (request.result as StoredAudioRecord[]) || [];
        const map: Record<string, string> = {};
        for (const rec of records) {
          map[rec.segmentId] = rec.audioBase64;
        }
        db.close();
        resolve(map);
      };

      request.onerror = () => {
        db.close();
        resolve({});
      };
    } catch {
      db.close();
      resolve({});
    }
  });
}

export async function deleteBriefingAudio(briefingId: string): Promise<void> {
  const db = await openAudioDb();
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('by_briefing');
      const request = index.getAllKeys(briefingId);

      request.onsuccess = () => {
        const keys = request.result || [];
        for (const key of keys) {
          store.delete(key);
        }
      };

      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}
