const DB_NAME = "nanami-voice-labo";
const DB_VERSION = 1;
const CARD_STORE = "voiceCards";
const AUDIO_STORE = "audioBlobs";
const SETTINGS_KEY = "nanami-voice-labo-settings";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CARD_STORE)) {
        const cards = db.createObjectStore(CARD_STORE, { keyPath: "id" });
        cards.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        db.createObjectStore(AUDIO_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function tx(storeName, mode, operation) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const request = operation(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

export async function saveVoiceCard(card, audioBlob = null) {
  const normalized = {
    ...card,
    id: card.id || crypto.randomUUID(),
    createdAt: card.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hasAudio: Boolean(audioBlob || card.hasAudio),
    rating: Math.min(5, Math.max(0, Number(card.rating) || 0)),
  };
  await tx(CARD_STORE, "readwrite", (store) => store.put(normalized));
  if (audioBlob) {
    await tx(AUDIO_STORE, "readwrite", (store) =>
      store.put({
        id: normalized.id,
        blob: audioBlob,
        type: audioBlob.type || `audio/${normalized.format || "wav"}`,
        updatedAt: normalized.updatedAt,
      }),
    );
  }
  return normalized;
}

export async function listVoiceCards() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(CARD_STORE, "readonly");
    const store = transaction.objectStore(CARD_STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      db.close();
      resolve((request.result || []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

export async function getAudioBlob(cardId) {
  const record = await tx(AUDIO_STORE, "readonly", (store) => store.get(cardId));
  return record?.blob || null;
}

export async function deleteVoiceCard(cardId) {
  await tx(CARD_STORE, "readwrite", (store) => store.delete(cardId));
  await tx(AUDIO_STORE, "readwrite", (store) => store.delete(cardId));
}

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
