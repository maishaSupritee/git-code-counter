const STORAGE_LIMIT = 8 * 1024 * 1024;
const CACHE_PREFIX = "cache_";

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function getBytesInUse(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.getBytesInUse(keys, (bytes) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(bytes);
    });
  });
}

async function getCacheKeys() {
  const items = await storageGet(null);
  return Object.keys(items).filter((key) => key.startsWith(CACHE_PREFIX));
}

export const cacheManager = {
  expirationMs: 60 * 60 * 1000,
  estimatedSize: 0,

  async init() {
    await this.cleanExpiredCache();
    await this.calculateCacheSize();
    console.log(
      `Initial cache size: ${(this.estimatedSize / 1024 / 1024).toFixed(2)}MB`,
    );
  },

  async calculateCacheSize() {
    const keys = await getCacheKeys();
    this.estimatedSize = keys.length > 0 ? await getBytesInUse(keys) : 0;
    return this.estimatedSize;
  },

  async get(key) {
    if (!key.startsWith(CACHE_PREFIX)) {
      throw new Error(`Invalid cache key: ${key}`);
    }

    const result = await storageGet([key]);
    const cachedItem = result[key];
    if (!cachedItem) return null;

    const isExpired =
      !cachedItem.timestamp ||
      Date.now() - cachedItem.timestamp > this.expirationMs;

    if (isExpired) {
      await this.remove(key);
      return null;
    }

    console.log(`Cache hit: ${key}`);
    return cachedItem.data;
  },

  async set(key, data) {
    if (!key.startsWith(CACHE_PREFIX)) {
      throw new Error(`Invalid cache key: ${key}`);
    }

    const cacheItem = {
      timestamp: Date.now(),
      data,
    };

    const oldSize = await getBytesInUse([key]);
    const estimatedNewSize = JSON.stringify({ [key]: cacheItem }).length * 2;
    const additionalBytes = Math.max(0, estimatedNewSize - oldSize);

    if (this.estimatedSize + additionalBytes > STORAGE_LIMIT) {
      const madeRoom = await this.makeRoom(additionalBytes);
      if (!madeRoom) {
        console.warn(`Cache is full. Not caching ${key}.`);
        return false;
      }
    }

    await storageSet({ [key]: cacheItem });
    const newSize = await getBytesInUse([key]);
    this.estimatedSize = Math.max(0, this.estimatedSize - oldSize + newSize);
    return true;
  },

  async makeRoom(neededBytes) {
    const items = await storageGet(null);
    const cacheItems = Object.entries(items)
      .filter(([key]) => key.startsWith(CACHE_PREFIX))
      .map(([key, value]) => ({
        key,
        timestamp: value.timestamp ?? 0,
        approximateSize: JSON.stringify({ [key]: value }).length * 2,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    const keysToRemove = [];
    let removedBytes = 0;

    for (const item of cacheItems) {
      keysToRemove.push(item.key);
      removedBytes += item.approximateSize;
      if (removedBytes >= neededBytes) break;
    }

    if (keysToRemove.length === 0) return false;

    await storageRemove(keysToRemove);
    await this.calculateCacheSize();
    return true;
  },

  async remove(key) {
    const oldSize = await getBytesInUse([key]);
    await storageRemove([key]);
    this.estimatedSize = Math.max(0, this.estimatedSize - oldSize);
    return oldSize > 0;
  },

  async clear() {
    const keys = await getCacheKeys();
    if (keys.length === 0) return false;

    await storageRemove(keys);
    this.estimatedSize = 0;
    return true;
  },

  async cleanExpiredCache() {
    const items = await storageGet(null);
    const now = Date.now();
    const keysToRemove = Object.entries(items)
      .filter(([key, value]) => {
        return (
          key.startsWith(CACHE_PREFIX) &&
          (!value.timestamp || now - value.timestamp > this.expirationMs)
        );
      })
      .map(([key]) => key);

    if (keysToRemove.length > 0) {
      await storageRemove(keysToRemove);
      console.log(`Removed ${keysToRemove.length} expired cache entries.`);
    }

    await this.calculateCacheSize();
    return keysToRemove.length;
  },
};

cacheManager.init().catch((error) => {
  console.error("Cache initialization failed:", error);
});

setInterval(() => {
  cacheManager.cleanExpiredCache().catch((error) => {
    console.error("Cache cleanup failed:", error);
  });
}, 15 * 60 * 1000);
