import { cacheManager } from "./cache.js"; // Import cache manager
import {
  config,
  getHeaders,
  saveToken,
  loadToken,
  clearToken,
  setGitHubToken,
  initializeAuthChecks,
  updateAuthStatus,
} from "./authentication.js"; // Import authentication functions
import {
  isBinaryExtension,
  getFileExtension,
  showError,
  updateRateLimitDisplay,
} from "./helpers.js"; // Import helper functions

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

  // Get exclusions from storage
  const exclusionsResult = await new Promise((resolve) => {
    chrome.storage.local.get("fileExclusions", (result) => {
      resolve(result.fileExclusions || []);
    });
  });

  // Skip if the file extension is in the exclusions list
  if (exclusionsResult.includes(fileExtension)) {
    stats.totalFiles++;
    stats.numFilesSkipped++;
    stats.filesSkipped.push(`${filePath} (excluded by user)`);
    return;
  }

  // Skip binary files and large files
  if (
    isBinaryExtension(fileExtension) ||
    file.size > 1000000 ||
    fileExtension === "no-extension"
  ) {
    stats.totalFiles++;
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
    stats.totalFiles++;
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

document.addEventListener("DOMContentLoaded", () => {
  // Get UI elements for token management
  const tokenInput = document.getElementById("githubToken");
  const saveTokenButton = document.getElementById("saveToken");

  const button = document.getElementById("countLoc");
  const currentRepoDiv = document.getElementById("currentRepo");
  const loadingDiv = document.getElementById("loading");
  const resultsDiv = document.getElementById("results");
  const errorDiv = document.getElementById("error");

  const exclusionInput = document.getElementById("exclusionInput");
  const addExclusionButton = document.getElementById("addExclusion");
  const exclusionsList =
    document.getElementById("exclusionsList") || createExclusionsList();

  // Add token help link handler
  const tokenHelpLink = document.getElementById("tokenHelpLink");
  if (tokenHelpLink) {
    tokenHelpLink.addEventListener("click", (e) => {
      e.preventDefault();
      // Open GitHub token creation page in a new tab
      chrome.tabs.create({
        url: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token",
      });
    });
  }

  // Initialize exclusions array from storage
  let fileExclusions = [];

  // Load saved exclusions when popup opens
  chrome.storage.local.get("fileExclusions", (result) => {
    if (result.fileExclusions) {
      fileExclusions = result.fileExclusions;
      renderExclusions();
    }
  });

  // Add exclusion when button is clicked
  if (addExclusionButton) {
    addExclusionButton.addEventListener("click", () => {
      if (exclusionInput && exclusionInput.value.trim()) {
        const extension = exclusionInput.value.trim().toLowerCase();
        // Remove dot if user included it
        const cleanExtension = extension.startsWith(".")
          ? extension.substring(1)
          : extension;

        if (!fileExclusions.includes(cleanExtension)) {
          fileExclusions.push(cleanExtension); // Add new exclusion if not already present
          saveExclusions();
          renderExclusions();
        }
        exclusionInput.value = "";
      }
    });
  }

  // Create exclusions list element if it doesn't exist
  function createExclusionsList() {
    const container = document.getElementById("exclusions-section");
    if (container) {
      const list = document.createElement("ul");
      list.id = "exclusionsList";
      container.appendChild(list);
      return list;
    }
    return null;
  }

  // Save exclusions to storage
  function saveExclusions() {
    chrome.storage.local.set({ fileExclusions });
  }

  // Render the list of exclusions
  function renderExclusions() {
    if (!exclusionsList) return;

    exclusionsList.innerHTML = "";
    if (fileExclusions.length === 0) {
      const emptyItem = document.createElement("li");
      emptyItem.textContent = "No exclusions added";
      exclusionsList.appendChild(emptyItem);
    } else {
      fileExclusions.forEach((extension) => {
        const item = document.createElement("li");
        item.textContent = `.${extension}`;

        // Add remove button
        const removeBtn = document.createElement("button");
        removeBtn.textContent = "×";
        removeBtn.className = "remove-exclusion";
        removeBtn.addEventListener("click", () => {
          fileExclusions = fileExclusions.filter((ext) => ext !== extension);
          saveExclusions();
          renderExclusions();
        });

        item.appendChild(removeBtn);
        exclusionsList.appendChild(item);
      });
    }
  }

  // Initially hide results and loading
  if (loadingDiv) loadingDiv.style.display = "none";
  if (resultsDiv) resultsDiv.style.display = "none";
  if (errorDiv) errorDiv.style.display = "none";

  updateRateLimitDisplay();

  // Load token from storage and update API rate limit display
  loadToken().then(() => {
    // Initial rate limit check after token is loaded
    updateRateLimitDisplay();
  });

  initializeAuthChecks(); // Initialize authentication checks

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
