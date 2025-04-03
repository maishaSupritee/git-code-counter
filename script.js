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

async function countLinesOfCode(owner, repo, repoData) {
  const stats = {
    totalLines: 0,
    totalFiles: 0,
    byExtension: {},
    numFilesSkipped: 0,
    filesSkipped: [],
  };
  try {
    console.log(repoData);
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
  if (isBinaryExtension(fileExtension) || file.size > 1000000) {
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
    stats.filesSkipped++;
  }
}

function updateProgress(processedFiles, totalFiles) {
  // You can implement this function based on your UI needs
  console.log(`Processing: ${processedFiles}/${totalFiles} files`);
}

function displayStats(stats) {
  console.log("Total Lines of Code:", stats.totalLines);
  console.log("Total Files Processed:", stats.totalFiles);
  console.log("Number of Files Skipped:", stats.numFilesSkipped);
  console.log("Skipped Files:", stats.filesSkipped.join(", "));
  console.log("Lines by Extension:");
  for (const [extension, data] of Object.entries(stats.byExtension)) {
    console.log(`.${extension}: ${data.lines} lines in ${data.files} files`);
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

function showError(message) {
  console.error(message);
  alert(message);
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
    .then((repoData) => {
      countLinesOfCode(owner, repo, repoData);
    })
    .catch((error) => {
      showError(`Error fetching repository data: ${error.message}`);
    });
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
