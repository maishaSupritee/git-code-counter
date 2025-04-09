//CACHING
const STORAGE_LIMIT = 5 * 1024 * 1024; // 5MB limit by default
const CACHE_PREFIX = "cache_";

export const cacheManager = {
  // Cache expiration time (1 hour in milliseconds)
  expirationMs: 3600000,
  estimatedSize: 0,

  // Initialize cache manager and calculate size
  init: async function () {
    await this.calculateCacheSize();
    console.log(
      `Initial cache size: ${(this.estimatedSize / 1024 / 1024).toFixed(2)}MB`
    );
  },

  // Calculate approximate size of all cached items
  calculateCacheSize: async function () {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (items) => {
        let totalSize = 0;
        // Check all items with cache prefix
        for (const key in items) {
          if (key.startsWith(CACHE_PREFIX)) {
            const jsonString = JSON.stringify(items[key]);
            totalSize += jsonString.length * 2; // Rough estimate (2 bytes per char)
          }
        }
        this.estimatedSize = totalSize;
        resolve(totalSize);
      });
    });
  },

  // Get estimated size of a value in bytes
  getItemSize: function (value) {
    const jsonString = JSON.stringify({
      timestamp: Date.now(),
      data: value,
    });
    return jsonString.length * 2; // Rough estimate (2 bytes per char)
  },

  // Check if we're close to storage limit
  isStorageFull: function (additionalBytes = 0) {
    return this.estimatedSize + additionalBytes > STORAGE_LIMIT;
  },

  // Get data from cache
  get: function (key) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => {
        if (!result[key]) {
          resolve(null); // Return null if no cache found
          return;
        }

        const cachedItem = result[key];
        const cacheAge = Date.now() - cachedItem.timestamp;

        console.log(
          `Cache age for ${key}: ${Math.round(cacheAge / 60000)} minutes`
        );

        // Check if cache is expired
        if (cacheAge > this.expirationMs) {
          this.remove(key);
          resolve(null);
          return;
        }

        console.log(`Cache hit: ${key}`);
        resolve(cachedItem.data);
      });
    });
  },

  set: async function (key, data) {
    const itemSize = this.getItemSize(data);

    // Check if adding this would exceed storage limit
    if (this.isStorageFull(itemSize)) {
      console.warn(
        `Cache storage limit (${
          STORAGE_LIMIT / 1024 / 1024
        }MB) would be exceeded. Not caching: ${key}`
      );

      // Try to free up some space
      const success = await this.makeRoom(itemSize);
      if (!success) {
        console.warn("Could not free enough space in cache. Item not cached.");
        return false;
      }
    }

    const cacheItem = {
      timestamp: Date.now(),
      expires: Date.now() + this.expirationMs,
      data: data,
    };

    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: cacheItem }, () => {
        // Update our size tracking
        this.estimatedSize += itemSize;
        console.log(
          `Cached: ${key} (size: ${(itemSize / 1024).toFixed(
            2
          )}KB, expires: ${new Date(cacheItem.expires).toLocaleTimeString()})`
        );
        resolve(true);
      });
    });
  },

  // Try to free up space by removing oldest cache entries
  makeRoom: async function (neededBytes) {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (items) => {
        // Find cache items
        const cacheItems = [];
        for (const key in items) {
          if (key.startsWith(CACHE_PREFIX)) {
            cacheItems.push({
              key: key,
              timestamp: items[key].timestamp,
              size: JSON.stringify(items[key]).length * 2,
            });
          }
        }

        // Sort by oldest first
        cacheItems.sort((a, b) => a.timestamp - b.timestamp);

        let removedSize = 0;
        let keysToRemove = [];

        // Start removing oldest items until we have enough space
        for (const item of cacheItems) {
          keysToRemove.push(item.key);
          removedSize += item.size;

          // If we've freed enough space, stop
          if (removedSize >= neededBytes) {
            break;
          }
        }

        if (keysToRemove.length > 0) {
          chrome.storage.local.remove(keysToRemove, () => {
            console.log(
              `Evicted ${keysToRemove.length} oldest cache items to free up space`
            );
            this.estimatedSize -= removedSize;
            resolve(true);
          });
        } else {
          resolve(false);
        }
      });
    });
  },

  // Remove item from cache
  remove: function (key) {
    return new Promise((resolve) => {
      // First get the item to calculate its size
      chrome.storage.local.get([key], (result) => {
        if (result[key]) {
          const itemSize = JSON.stringify(result[key]).length * 2;

          chrome.storage.local.remove([key], () => {
            console.log(`Cache removed: ${key}`);
            this.estimatedSize -= itemSize;
            resolve(true);
          });
        } else {
          resolve(false);
        }
      });
    });
  },

  // Clear entire cache
  clear: function () {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (items) => {
        // Filter only cache items
        const cacheKeys = Object.keys(items).filter((key) =>
          key.startsWith(CACHE_PREFIX)
        );

        if (cacheKeys.length > 0) {
          chrome.storage.local.remove(cacheKeys, () => {
            console.log(`Cache cleared: ${cacheKeys.length} items removed`);
            this.estimatedSize = 0;
            resolve(true);
          });
        } else {
          resolve(false); // No cache items to clear
        }
      });
    });
  },

  // Periodically clean expired cache
  cleanExpiredCache: function () {
    chrome.storage.local.get(null, (items) => {
      const now = Date.now();
      const keysToRemove = [];

      for (const key in items) {
        if (key.startsWith(CACHE_PREFIX) && items[key].timestamp) {
          if (now - items[key].timestamp > this.expirationMs) {
            keysToRemove.push(key);
          }
        }
      }

      if (keysToRemove.length > 0) {
        chrome.storage.local.remove(keysToRemove, () => {
          console.log(
            `Auto-cleaned ${keysToRemove.length} expired cache items`
          );
        });
      }
    });
  },
};

// Initialize cache manager on load
cacheManager.init().then(() => {
  // Clean expired cache on startup
  cacheManager.cleanExpiredCache();

  // Set up periodic cache cleaning (every 15 minutes)
  setInterval(() => {
    cacheManager.cleanExpiredCache();
  }, 15 * 60 * 1000);
});
