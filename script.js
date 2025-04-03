// Configuration for authentication and caching
const config = {
  // GitHub authentication tokens
  github: {
    token: "", // Personal access token
    useAuth: false, // Set to true when token is provided
  },
  // Cache configuration
  cache: {
    enabled: true,
    expirationMs: 3600000, // Cache expiration time (1 hour)
    storage: {}, // In-memory cache storage
  },
};

// Utility for cache management
const cacheManager = {
  get: function (key) {
    if (!config.cache.enabled) return null;

    const cachedItem = config.cache.storage[key];
    if (!cachedItem) return null;

    // Check if cache has expired
    if (Date.now() - cachedItem.timestamp > config.cache.expirationMs) {
      delete config.cache.storage[key];
      return null;
    }

    console.log(`Cache hit: ${key}`);
    return cachedItem.data;
  },

  set: function (key, data) {
    if (!config.cache.enabled) return;

    config.cache.storage[key] = {
      timestamp: Date.now(),
      data: data,
    };
    console.log(`Cached: ${key}`);
  },
};

// Configure authentication for fetch requests
function getHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
  };

  if (config.github.useAuth && config.github.token) {
    headers["Authorization"] = `token ${config.github.token}`;
  }

  return headers;
}

// Save token to Chrome storage
function saveToken(token) {
  chrome.storage.local.set({ github_token: token }, function () {
    console.log("Token saved");
    updateAuthStatus(true);
  });
}

// Load token from Chrome storage
function loadToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["github_token"], function (result) {
      if (result.github_token) {
        setGitHubToken(result.github_token);
        updateAuthStatus(true);
        resolve(true);
      } else {
        updateAuthStatus(false);
        resolve(false);
      }
    });
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

// Clear token from storage
function clearToken() {
  chrome.storage.local.remove(["github_token"], function () {
    console.log("Token cleared");
    setGitHubToken("");
    updateAuthStatus(false);
  });
}

// Function to fetch repository data from GitHub API
async function fetchGithubRepoData(owner, repo) {
  // Check cache first
  const cacheKey = `repo_${owner}_${repo}`;
  const cachedData = cacheManager.get(cacheKey);
  if (cachedData) return cachedData;

  // Make API request if not in cache
  const url = `https://api.github.com/repos/${owner}/${repo}`;
  const response = await fetch(url, { headers: getHeaders() });

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
  cacheManager.set(cacheKey, data);

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
    const treeCacheKey = `tree_${owner}_${repo}_${defaultBranch}`;
    let treeData = cacheManager.get(treeCacheKey);

    if (!treeData) {
      const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`;
      const treeResponse = await fetch(url, { headers: getHeaders() });

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
      cacheManager.set(treeCacheKey, treeData);

      if (treeData.truncated) {
        showError("Repository is too large. Response will be partial.");
      }
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

      // Dynamic delay based on authentication
      const delay = config.github.useAuth ? 50 : 100; // Less delay if authenticated
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    displayStats(stats);
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
    let fileContent = cacheManager.get(fileContentCacheKey);

    if (!fileContent) {
      fileContent = await getFileContent(owner, repo, file.sha);
      cacheManager.set(fileContentCacheKey, fileContent);
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
    "dylib",
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

// Clear cache function (useful for debugging or forcing fresh data)
function clearCache() {
  config.cache.storage = {};
  console.log("Cache cleared");
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

function updateProgress(processedFiles, totalFiles) {
  console.log(`Processing: ${processedFiles}/${totalFiles} files`);

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
  console.log("Total Lines of Code:", stats.totalLines);
  console.log("Total Files Processed:", stats.totalFiles);
  console.log("Number of Files Skipped:", stats.numFilesSkipped);
  console.log("Lines by Extension:");

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
      row.innerHTML = `
          <span>${ext}</span>
          <span>${data.files.toLocaleString()} files, ${data.lines.toLocaleString()} lines (${percentage}%)</span>
        `;

      extensionsDiv.appendChild(row);
    });
  }

  // Show results and hide loading
  if (loadingDiv) loadingDiv.style.display = "none";
  if (resultsDiv) resultsDiv.style.display = "block";
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

  // Load token from storage
  loadToken();

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

      console.log("Current URL:", tab.url); // Debug log

      // Extract owner/repo from GitHub URL
      const match = tab.url.match(/^https:\/\/github\.com\/([^\/]+)\/([^\/]+)/);

      if (match) {
        const [_, owner, repo] = match;
        console.log(`Detected repo: ${owner}/${repo}`); // Debug log

        // Update UI
        if (currentRepoDiv)
          currentRepoDiv.textContent = `Repository: ${owner}/${repo}`;
        if (button) {
          button.disabled = false;

          // Add click handler
          button.addEventListener("click", () => {
            // Show loading state
            if (loadingDiv) loadingDiv.style.display = "block";
            if (resultsDiv) resultsDiv.style.display = "none";
            if (errorDiv) errorDiv.style.display = "none";

            // Analyze the repository
            analyzeRepository(owner, repo);
          });
        }
      } else {
        console.log("No GitHub repository detected in URL"); // Debug log
      }
    } catch (error) {
      console.error("Error detecting repository:", error);
      if (errorDiv) {
        errorDiv.style.display = "block";
        errorDiv.textContent = `Error: ${error.message}`;
      }
    }
  };

  // Start the detection process
  detectGitHubRepo();
});

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

// Example usage:
// Without authentication (public repos only, lower rate limits)
//analyzeRepository("maishaSupritee", "Cinebon");

// With authentication (higher rate limits)
/* analyzeRepository(
  "maishaSupritee",
  "inferix-ui",
  ""
); */
