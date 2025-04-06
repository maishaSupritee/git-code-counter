const config = {
  github: {
    token: "",
    useAuth: false,
  },
  cache: {
    enabled: true,
  },
};

//CACHING
const cacheManager = {
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

//AUTHENTICATION
// Configure authentication for fetch requests
function getHeaders() {
  const headers = {
    Accept: "application/vnd.github+json", // Set the Accept header for GitHub API
  };

  if (config.github.useAuth && config.github.token) {
    headers["Authorization"] = `token ${config.github.token}`; // Add token if available
  }

  return headers;
}

// Save token to Chrome storage
function saveToken(token) {
  chrome.storage.local.set({ github_token: token }, function () {
    console.log("Token saved");
    setGitHubToken(token);
    updateAuthStatus(true);
    // Update rate limit display after authentication changes
    updateRateLimitDisplay();
  });
}

// Load token from Chrome storage
function loadToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["github_token"], function (result) {
      if (result.github_token) {
        setGitHubToken(result.github_token);
        updateAuthStatus(true);
        // Update rate limit display after authentication is loaded
        updateRateLimitDisplay();
        resolve(true);
      } else {
        updateAuthStatus(false);
        // Update rate limit display even if not authenticated
        updateRateLimitDisplay();
        resolve(false);
      }
    });
  });
}
// Function to set authentication token
function setGitHubToken(token) {
  if (token && token.trim() !== "") {
    config.github.token = token;
    config.github.useAuth = true;
    console.log("GitHub authentication enabled");
    return true;
  } else {
    config.github.useAuth = false;
    console.log("GitHub authentication disabled");
    return false;
  }
}

// Clear token from storage
function clearToken() {
  chrome.storage.local.remove(["github_token"], function () {
    console.log("Token cleared");
    setGitHubToken("");
    updateAuthStatus(false);
    // Update rate limit display after authentication is removed
    updateRateLimitDisplay();
  });
}

// Update UI to show authentication status
function updateAuthStatus(isAuthenticated) {
  const statusCircle = document.querySelector(".status-circle");
  const authText = document.getElementById("auth-text");

  if (isAuthenticated) {
    statusCircle.classList.remove("unauthenticated");
    statusCircle.classList.add("authenticated");
    authText.textContent = "Authenticated";
  } else {
    statusCircle.classList.remove("authenticated");
    statusCircle.classList.add("unauthenticated");
    authText.textContent = "Not authenticated";
  }
}

// FETCHING REPO DATA AND COUNTING LINES OF CODE
async function fetchGithubRepoData(owner, repo) {
  // all cache keys will be prefixed with "cache_"
  const cacheKey = `cache_repo_${owner}_${repo}`;

  // Check cache first
  const cachedData = await cacheManager.get(cacheKey);
  if (cachedData) return cachedData;

  // Make API request if not in cache
  const url = `https://api.github.com/repos/${owner}/${repo}`;
  const response = await fetch(url, { headers: getHeaders() });

  // Update rate limit display after API call
  updateRateLimitDisplay();

  if (!response.ok) {
    // Handle rate limiting specifically
    if (
      response.status === 403 &&
      response.headers.get("X-RateLimit-Remaining") === "0"
    ) {
      const resetTime = new Date(
        parseInt(response.headers.get("X-RateLimit-Reset")) * 1000
      );
      throw new Error(
        `GitHub API rate limit exceeded. Resets at ${resetTime.toLocaleTimeString()}`
      );
    }
    throw new Error(`Error fetching data: ${response.statusText}`);
  }

  const data = await response.json();

  // Cache the result
  await cacheManager.set(cacheKey, data);

  return data;
}

async function countLinesOfCode(owner, repo) {
  const stats = {
    totalLines: 0,
    totalFiles: 0,
    byExtension: {},
    numFilesSkipped: 0,
    filesSkipped: [],
  };
  try {
    const repoData = await fetchGithubRepoData(owner, repo);
    const defaultBranch = repoData.default_branch;

    // Getting root tree - check cache first
    const treeCacheKey = `cache_tree_${owner}_${repo}_${defaultBranch}`;
    let treeData = await cacheManager.get(treeCacheKey);
    try {
      if (!treeData) {
        const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`;
        const treeResponse = await fetch(url, { headers: getHeaders() });

        // Update rate limit display after API call
        updateRateLimitDisplay();

        if (!treeResponse.ok) {
          // Handle rate limiting
          if (
            treeResponse.status === 403 &&
            treeResponse.headers.get("X-RateLimit-Remaining") === "0"
          ) {
            const resetTime = new Date(
              parseInt(treeResponse.headers.get("X-RateLimit-Reset")) * 1000
            );
            throw new Error(
              `GitHub API rate limit exceeded. Resets at ${resetTime.toLocaleTimeString()}`
            );
          }
          throw new Error(`Error fetching tree: ${treeResponse.statusText}`);
        }

        treeData = await treeResponse.json();
        await cacheManager.set(treeCacheKey, treeData);

        if (treeData.truncated) {
          showError("Repository is too large. Response will be partial.");
        }
      }
    } catch (error) {
      showError("Error fetching tree data. Please try again later.");
      return;
    }

    const files = treeData.tree.filter((item) => item.type === "blob");
    const fileCount = files.length;

    let processedFiles = 0;
    const batchSize = 4; // number of files to process in each batch
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      await Promise.all(
        batch.map((file) => {
          return countLinesInFile(owner, repo, file, stats);
        })
      );
      processedFiles += batch.length;
      updateProgress(processedFiles, fileCount);

      // Update rate limit every few batches to avoid too many requests
      if (i % (batchSize * 5) === 0) {
        updateRateLimitDisplay();
      }

      const delay = config.github.useAuth ? 50 : 100; // Less delay if authenticated
      await new Promise((resolve) => setTimeout(resolve, delay)); // Delay to avoid hitting rate limits
    }

    displayStats(stats);
    // Final rate limit update when finished
    updateRateLimitDisplay();
  } catch (error) {
    showError(`Error counting lines of code: ${error.message}`);
  } finally {
    console.log("Finished counting lines of code.");
  }
}

async function countLinesInFile(owner, repo, file, stats) {
  const filePath = file.path;
  const fileExtension = getFileExtension(filePath);

  // Skip binary files and large files
  if (
    isBinaryExtension(fileExtension) ||
    file.size > 1000000 ||
    fileExtension === "no-extension"
  ) {
    stats.numFilesSkipped++;
    stats.filesSkipped.push(filePath);
    return;
  }

  try {
    // Check cache for file content
    const fileContentCacheKey = `content_${owner}_${repo}_${file.sha}`;
    let fileContent = await cacheManager.get(fileContentCacheKey);

    if (!fileContent) {
      fileContent = await getFileContent(owner, repo, file.sha);
      await cacheManager.set(fileContentCacheKey, fileContent);
    }

    const lines = fileContent.split("\n").length;
    stats.totalLines += lines;
    stats.totalFiles++;

    if (!stats.byExtension[fileExtension]) {
      stats.byExtension[fileExtension] = {
        files: 0,
        lines: 0,
      };
    }

    // Update stats for the file extension
    stats.byExtension[fileExtension].files++;
    stats.byExtension[fileExtension].lines += lines;
  } catch (error) {
    console.warn(`Could not process file ${filePath}: ${error.message}`);
    stats.numFilesSkipped++;
    stats.filesSkipped.push(filePath);
  }
}

async function getFileContent(owner, repo, sha) {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/blobs/${sha}`;
  const response = await fetch(url, { headers: getHeaders() });

  if (!response.ok) {
    // Handle rate limiting
    if (
      response.status === 403 &&
      response.headers.get("X-RateLimit-Remaining") === "0"
    ) {
      const resetTime = new Date(
        parseInt(response.headers.get("X-RateLimit-Reset")) * 1000
      );
      throw new Error(
        `GitHub API rate limit exceeded. Resets at ${resetTime.toLocaleTimeString()}`
      );
    }
    throw new Error(`Error fetching file content: ${response.statusText}`);
  }

  const data = await response.json();
  const decodedContent = atob(data.content); // decode base64 content
  return decodedContent;
}

//helper functions
function getFileExtension(filePath) {
  const parts = filePath.split(".");
  if (parts.length > 1) {
    return parts.pop().toLowerCase();
  }
  return "no-extension";
}

function isBinaryExtension(extension) {
  const binaryExtensions = [
    "svg",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "bmp",
    "ico",
    "webp",
    "mp3",
    "wav",
    "ogg",
    "mp4",
    "webm",
    "mov",
    "zip",
    "tar",
    "gz",
    "rar",
    "7z",
    "jar",
    "exe",
    "dll",
    "so",
    "bin",
    "dat",
    "pdf",
    "doc",
    "docx",
    "xls",
    "xlsx",
    "ppt",
    "pptx",
  ];

  return binaryExtensions.includes(extension);
}

// Main execution function with authentication option
function analyzeRepository(owner, repo, token = null) {
  if (token) {
    setGitHubToken(token);
  }

  fetchGithubRepoData(owner, repo)
    .then(() => {
      countLinesOfCode(owner, repo);
    })
    .catch((error) => {
      showError(`Error fetching repository data: ${error.message}`);
    });
}

// API rate limit handling
async function checkRateLimit() {
  const url = "https://api.github.com/rate_limit";
  const response = await fetch(url, { headers: getHeaders() });
  if (!response.ok) {
    throw new Error(`Error fetching rate limit: ${response.statusText}`);
  }
  const data = await response.json();

  // Get the appropriate rate limit data based on authentication status
  const rateData = config.github.useAuth ? data.rate : data.rate;
  const rateRemaining = rateData.remaining;
  const rateReset = new Date(rateData.reset * 1000).toLocaleTimeString();
  const rateLimit = rateData.limit;

  const apiData = {
    remaining: rateRemaining,
    reset: rateReset,
    limit: rateLimit,
  };
  return apiData;
}

// New function to update the rate limit display
async function updateRateLimitDisplay() {
  const apiRemainingSpan = document.getElementById("api-remaining");
  const apiResetSpan = document.getElementById("api-resetTime");

  try {
    const data = await checkRateLimit();
    if (apiRemainingSpan) {
      apiRemainingSpan.textContent = `${data.remaining}/${data.limit}`;
    }
    if (apiResetSpan) apiResetSpan.textContent = data.reset;
  } catch (error) {
    console.error("Error fetching rate limit:", error);
    if (apiRemainingSpan) apiRemainingSpan.textContent = "Error";
    if (apiResetSpan) apiResetSpan.textContent = "Error";
  }
}

// UI updates
function updateProgress(processedFiles, totalFiles) {
  const progressBar = document.getElementById("progress-bar");
  const progressText = document.getElementById("progress-text");

  if (progressBar && progressText) {
    const percentage = Math.round((processedFiles / totalFiles) * 100);
    progressBar.style.width = `${percentage}%`;
    progressText.textContent = `${percentage}% (${processedFiles}/${totalFiles} files)`;
  }
}

// Fix the display stats function
function displayStats(stats) {
  // Get UI elements
  const resultsDiv = document.getElementById("results");
  const loadingDiv = document.getElementById("loading");
  const totalLinesSpan = document.getElementById("totalLines");
  const totalFilesSpan = document.getElementById("totalFiles");
  const totalSkippedFilesSpan = document.getElementById("totalSkippedFiles");
  const skippedFilesList = document.getElementById("skippedFiles");
  const extensionsDiv = document.getElementById("extensions");

  // Update UI with stats
  if (totalLinesSpan)
    totalLinesSpan.textContent = stats.totalLines.toLocaleString();
  if (totalFilesSpan)
    totalFilesSpan.textContent = stats.totalFiles.toLocaleString();
  if (totalSkippedFilesSpan)
    totalSkippedFilesSpan.textContent = stats.numFilesSkipped.toLocaleString();

  // Update skipped files list
  if (skippedFilesList) {
    skippedFilesList.innerHTML = "";
    if (stats.filesSkipped.length > 0) {
      // Only show first 10 skipped files to avoid overflow
      const filesToShow = stats.filesSkipped.slice(0, 10);
      filesToShow.forEach((file) => {
        const li = document.createElement("li");
        li.textContent = file;
        skippedFilesList.appendChild(li);
      });

      // Add indicator if there are more skipped files
      if (stats.filesSkipped.length > 10) {
        const li = document.createElement("li");
        li.textContent = `...and ${stats.filesSkipped.length - 10} more`;
        skippedFilesList.appendChild(li);
      }
    } else {
      const li = document.createElement("li");
      li.textContent = "None";
      skippedFilesList.appendChild(li);
    }
  }

  // Update extensions breakdown
  if (extensionsDiv) {
    extensionsDiv.innerHTML = "";

    // Sort extensions by number of lines
    const sortedExtensions = Object.entries(stats.byExtension).sort(
      (a, b) => b[1].lines - a[1].lines
    );

    sortedExtensions.forEach(([ext, data]) => {
      const percentage = ((data.lines / stats.totalLines) * 100).toFixed(1);

      const row = document.createElement("div");
      row.className = "extension-row";
      const fileText = data.files === 1 ? "file" : "files";
      row.innerHTML = `
          <span>${ext}</span>
          <span>${data.files.toLocaleString()} ${fileText}, ${data.lines.toLocaleString()} lines (${percentage}%)</span> 
        `;

      extensionsDiv.appendChild(row);
    });
  }

  // Show results and hide loading
  if (loadingDiv) loadingDiv.style.display = "none";
  if (resultsDiv) resultsDiv.style.display = "block";
}
// Update showError function to use the UI
function showError(message) {
  console.error(message);

  const errorDiv = document.getElementById("error");
  const loadingDiv = document.getElementById("loading");

  if (errorDiv) {
    errorDiv.textContent = message;
    errorDiv.style.display = "block";
  }

  if (loadingDiv) {
    loadingDiv.style.display = "none";
  }
}

// Fix the main DOM loaded handler
document.addEventListener("DOMContentLoaded", () => {
  // Get UI elements for token management
  const tokenInput = document.getElementById("githubToken");
  const saveTokenButton = document.getElementById("saveToken");

  const button = document.getElementById("countLoc");
  const currentRepoDiv = document.getElementById("currentRepo");
  const loadingDiv = document.getElementById("loading");
  const resultsDiv = document.getElementById("results");
  const errorDiv = document.getElementById("error");

  // Initially hide results and loading
  if (loadingDiv) loadingDiv.style.display = "none";
  if (resultsDiv) resultsDiv.style.display = "none";
  if (errorDiv) errorDiv.style.display = "none";

  // Load token from storage and update API rate limit display
  loadToken().then(() => {
    // Initial rate limit check after token is loaded
    updateRateLimitDisplay();
  });

  // Add token save button handler
  if (saveTokenButton) {
    saveTokenButton.addEventListener("click", () => {
      const token = tokenInput.value.trim();
      if (token) {
        saveToken(token);
        tokenInput.value = ""; // Clear input field after saving
      } else {
        clearToken();
      }
    });
  }

  // Check if we're on a GitHub repository page
  const detectGitHubRepo = async () => {
    try {
      // Get current active tab
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });

      // Extract owner/repo from GitHub URL using regex
      const match = tab.url.match(/github\.com\/([^\/]+)\/([^\/]+)/);

      if (match) {
        const [_, owner, repo] = match;
        // Clean up repo name (remove any trailing slashes or query params)
        const cleanRepo = repo.split(/[\/\?#]/)[0];

        console.log(`Detected repo: ${owner}/${cleanRepo}`); // Debug log

        // Update UI
        if (currentRepoDiv)
          currentRepoDiv.textContent = `Repository: ${owner}/${cleanRepo}`;
        if (button) {
          button.disabled = false;

          button.replaceWith(button.cloneNode(true)); // Clone the button to remove old event listeners
          // Reassign the button to the new cloned button
          const newButton = document.getElementById("countLoc");

          // Add click handler
          newButton.addEventListener("click", () => {
            // Show loading state
            if (loadingDiv) loadingDiv.style.display = "block";
            if (resultsDiv) resultsDiv.style.display = "none";
            if (errorDiv) errorDiv.style.display = "none";

            // Analyze the repository
            analyzeRepository(owner, cleanRepo);
          });
        }
      } else {
        if (currentRepoDiv)
          currentRepoDiv.textContent = "No GitHub repository detected";
        if (button) button.disabled = true;
      }
    } catch (error) {
      if (errorDiv) {
        errorDiv.style.display = "block";
        errorDiv.textContent = `Error: ${error.message}`;
      }
    }
  };

  // Start the detection process
  detectGitHubRepo();
});
