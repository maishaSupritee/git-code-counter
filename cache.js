//CACHING
export const cacheManager = {
  // Cache expiration time (1 hour in milliseconds)
  expirationMs: 3600000,

  // Get data from cache
  get: function (key) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => {
        if (!result[key]) {
          resolve(null); // Return null if no cache found
          return;
        }

        const cachedItem = result[key];

        // Check if cache has expired
        if (Date.now() - cachedItem.timestamp > this.expirationMs) {
          this.remove(key);
          resolve(null);
          return;
        }

        console.log(`Cache hit: ${key}`);
        resolve(cachedItem.data);
      });
    });
  },

  // Save data to cache
  set: function (key, data) {
    const cacheItem = {
      timestamp: Date.now(),
      data: data,
    };

    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: cacheItem }, () => {
        console.log(`Cached: ${key}`);
        resolve();
      });
    });
  },

  // Remove item from cache
  remove: function (key) {
    return new Promise((resolve) => {
      chrome.storage.local.remove([key], () => {
        console.log(`Cache removed: ${key}`);
        resolve();
      });
    });
  },

  // Clear entire cache
  clear: function () {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (items) => {
        // Filter only cache items
        const cacheKeys = Object.keys(items).filter(
          (key) => key.startsWith("cache_") //prefix for cache keys
        );

        if (cacheKeys.length > 0) {
          chrome.storage.local.remove(cacheKeys, () => {
            console.log("Cache cleared");
            resolve();
          });
        } else {
          resolve(); // No cache items to clear
        }
      });
    });
  },
};
