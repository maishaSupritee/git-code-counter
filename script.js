import { cacheManager } from "./cache.js";
import {
  clearToken,
  config,
  loadToken,
  saveToken,
} from "./authentication.js";
import {
  githubFetch,
  RateLimitError,
  showError,
  updateRateLimitDisplay,
} from "./helpers.js";
import {
  countPhysicalLines,
  getFileExtension,
  isBinaryExtension,
} from "./line-utils.js";

const MAX_FILE_SIZE_BYTES = 1_000_000;

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

async function fetchGithubRepoData(owner, repo) {
  const cacheKey = `cache_repo_${owner}_${repo}`;
  const cachedData = await cacheManager.get(cacheKey);
  if (cachedData) return cachedData;

  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}`,
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        "Repository not found. For a private repository, save a token with access to that repository.",
      );
    }
    throw new Error(
      `Could not read repository information (${response.status} ${response.statusText}).`,
    );
  }

  const data = await response.json();
  await cacheManager.set(cacheKey, data);
  return data;
}

async function fetchRepositoryTree(owner, repo, defaultBranch) {
  const cacheKey = `cache_tree_${owner}_${repo}_${defaultBranch}`;
  const cachedData = await cacheManager.get(cacheKey);
  if (cachedData) return cachedData;

  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
  );

  if (!response.ok) {
    throw new Error(
      `Could not read the repository tree (${response.status} ${response.statusText}).`,
    );
  }

  const data = await response.json();
  if (data.truncated) {
    throw new Error(
      "GitHub truncated this repository tree because the repository is too large. No partial result was shown.",
    );
  }

  await cacheManager.set(cacheKey, data);
  return data;
}

async function getFileExclusions() {
  const result = await storageGet(["fileExclusions"]);
  return new Set(result.fileExclusions ?? []);
}

function getSkipReason(file, extension, exclusions) {
  if (exclusions.has(extension)) return "excluded by user";
  if (isBinaryExtension(extension)) return "binary file";
  if (file.size > MAX_FILE_SIZE_BYTES) return "larger than 1 MB";
  if (extension === "no-extension") return "unknown extensionless file";
  return null;
}

async function getFileContent(owner, repo, sha) {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/git/blobs/${sha}`,
  );

  if (!response.ok) {
    throw new Error(
      `Could not fetch file content (${response.status} ${response.statusText}).`,
    );
  }

  const data = await response.json();
  if (data.encoding !== "base64" || typeof data.content !== "string") {
    throw new Error("GitHub returned an unsupported blob encoding.");
  }

  return atob(data.content.replace(/\n/g, ""));
}

async function countLinesInFile(owner, repo, file, extension) {
  const lineCacheKey = `cache_lines_${file.sha}`;
  const cachedLines = await cacheManager.get(lineCacheKey);

  if (Number.isInteger(cachedLines) && cachedLines >= 0) {
    return cachedLines;
  }

  const fileContent = await getFileContent(owner, repo, file.sha);
  const lines = countPhysicalLines(fileContent);
  await cacheManager.set(lineCacheKey, lines);
  return lines;
}

function addCountedFile(stats, file, extension, lines) {
  stats.totalLines += lines;
  stats.countedFiles += 1;
  stats.byFile.push({ path: file.path, lines });

  if (!stats.byExtension[extension]) {
    stats.byExtension[extension] = { files: 0, lines: 0 };
  }

  stats.byExtension[extension].files += 1;
  stats.byExtension[extension].lines += lines;
}

function addSkippedFile(stats, filePath, reason) {
  stats.numFilesSkipped += 1;
  stats.filesSkipped.push(`${filePath} (${reason})`);
}

async function countLinesOfCode(owner, repo) {
  const stats = {
    totalLines: 0,
    totalFiles: 0,
    countedFiles: 0,
    byExtension: {},
    byFile: [],
    numFilesSkipped: 0,
    filesSkipped: [],
  };

  const repoData = await fetchGithubRepoData(owner, repo);
  const treeData = await fetchRepositoryTree(
    owner,
    repo,
    repoData.default_branch,
  );
  const files = treeData.tree.filter((item) => item.type === "blob");
  const exclusions = await getFileExclusions();

  stats.totalFiles = files.length;
  let processedFiles = 0;
  const batchSize = config.github.useAuth ? 4 : 1;

  for (let index = 0; index < files.length; index += batchSize) {
    const batch = files.slice(index, index + batchSize);

    await Promise.all(
      batch.map(async (file) => {
        const extension = getFileExtension(file.path);
        const skipReason = getSkipReason(file, extension, exclusions);

        if (skipReason) {
          addSkippedFile(stats, file.path, skipReason);
          return;
        }

        try {
          const lines = await countLinesInFile(owner, repo, file, extension);
          addCountedFile(stats, file, extension, lines);
        } catch (error) {
          if (error instanceof RateLimitError || error.name === "RateLimitError") {
            throw error;
          }

          console.warn(`Could not process ${file.path}:`, error);
          addSkippedFile(stats, file.path, error.message);
        }
      }),
    );

    processedFiles += batch.length;
    updateProgress(processedFiles, files.length);
  }

  stats.byFile.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  displayStats(stats);
  return stats;
}

async function analyzeRepository(owner, repo) {
  try {
    return await countLinesOfCode(owner, repo);
  } catch (error) {
    if (error instanceof RateLimitError || error.name === "RateLimitError") {
      showError(error.message);
      return null;
    }

    showError(`Analysis failed: ${error.message}`);
    return null;
  } finally {
    console.log("Finished counting lines of code.");
  }
}

function updateProgress(processedFiles, totalFiles) {
  const progressBar = document.getElementById("progress-bar");
  const progressText = document.getElementById("progress-text");
  const percentage =
    totalFiles === 0
      ? processedFiles > 0
        ? 100
        : 0
      : Math.round((processedFiles / totalFiles) * 100);

  if (progressBar) progressBar.style.width = `${percentage}%`;
  if (progressText) {
    progressText.textContent = `${percentage}% (${processedFiles}/${totalFiles} files)`;
  }
}

function displayStats(stats) {
  const resultsDiv = document.getElementById("results");
  const loadingDiv = document.getElementById("loading");

  document.getElementById("totalLines").textContent =
    stats.totalLines.toLocaleString();
  document.getElementById("totalFiles").textContent =
    stats.totalFiles.toLocaleString();
  document.getElementById("countedFiles").textContent =
    stats.countedFiles.toLocaleString();
  document.getElementById("totalSkippedFiles").textContent =
    stats.numFilesSkipped.toLocaleString();

  const skippedFilesList = document.getElementById("skippedFiles");
  skippedFilesList.innerHTML = "";
  const skippedToShow = stats.filesSkipped.slice(0, 20);
  if (skippedToShow.length === 0) {
    const item = document.createElement("li");
    item.textContent = "None";
    skippedFilesList.appendChild(item);
  } else {
    for (const file of skippedToShow) {
      const item = document.createElement("li");
      item.textContent = file;
      skippedFilesList.appendChild(item);
    }
    if (stats.filesSkipped.length > skippedToShow.length) {
      const item = document.createElement("li");
      item.textContent = `...and ${stats.filesSkipped.length - skippedToShow.length} more`;
      skippedFilesList.appendChild(item);
    }
  }

  const extensionsDiv = document.getElementById("extensions");
  extensionsDiv.innerHTML = "";
  const sortedExtensions = Object.entries(stats.byExtension).sort(
    (a, b) => b[1].lines - a[1].lines,
  );

  for (const [extension, data] of sortedExtensions) {
    const percentage =
      stats.totalLines === 0
        ? "0.0"
        : ((data.lines / stats.totalLines) * 100).toFixed(1);
    const row = document.createElement("div");
    row.className = "extension-row";

    const name = document.createElement("span");
    name.textContent = extension;
    const values = document.createElement("span");
    values.textContent = `${data.files.toLocaleString()} ${data.files === 1 ? "file" : "files"}, ${data.lines.toLocaleString()} lines (${percentage}%)`;

    row.append(name, values);
    extensionsDiv.appendChild(row);
  }

  const filesDiv = document.getElementById("files");
  filesDiv.innerHTML = "";
  for (const file of stats.byFile) {
    const row = document.createElement("div");
    row.className = "file-row";

    const path = document.createElement("span");
    path.className = "file-path";
    path.textContent = file.path;
    path.title = file.path;

    const lineCount = document.createElement("span");
    lineCount.textContent = `${file.lines.toLocaleString()} lines`;

    row.append(path, lineCount);
    filesDiv.appendChild(row);
  }

  if (loadingDiv) loadingDiv.style.display = "none";
  if (resultsDiv) resultsDiv.style.display = "block";
}

function showLoadingState() {
  const loadingDiv = document.getElementById("loading");
  const resultsDiv = document.getElementById("results");
  const errorDiv = document.getElementById("error");

  if (loadingDiv) loadingDiv.style.display = "block";
  if (resultsDiv) resultsDiv.style.display = "none";
  if (errorDiv) errorDiv.style.display = "none";
  updateProgress(0, 0);
}

function renderExclusions(exclusions) {
  const list = document.getElementById("exclusionsList");
  list.innerHTML = "";

  if (exclusions.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No exclusions added";
    list.appendChild(item);
    return;
  }

  for (const extension of exclusions) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `.${extension}`;

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.textContent = "×";
    removeButton.className = "remove-exclusion";
    removeButton.setAttribute("aria-label", `Remove .${extension} exclusion`);
    removeButton.addEventListener("click", async () => {
      const updated = exclusions.filter((value) => value !== extension);
      await storageSet({ fileExclusions: updated });
      exclusions.splice(0, exclusions.length, ...updated);
      renderExclusions(exclusions);
    });

    item.append(label, removeButton);
    list.appendChild(item);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const tokenInput = document.getElementById("githubToken");
  const saveTokenButton = document.getElementById("saveToken");
  const clearTokenButton = document.getElementById("clearToken");
  const countButton = document.getElementById("countLoc");
  const currentRepoDiv = document.getElementById("currentRepo");
  const exclusionInput = document.getElementById("exclusionInput");
  const addExclusionButton = document.getElementById("addExclusion");
  const tokenHelpLink = document.getElementById("tokenHelpLink");

  let exclusions = [...(await getFileExclusions())];
  renderExclusions(exclusions);

  try {
    await loadToken();
  } catch (error) {
    showError(`Could not load the saved token: ${error.message}`);
  }
  await updateRateLimitDisplay();

  tokenHelpLink.addEventListener("click", (event) => {
    event.preventDefault();
    chrome.tabs.create({
      url: "https://docs.github.com/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
    });
  });

  saveTokenButton.addEventListener("click", async () => {
    try {
      saveTokenButton.disabled = true;
      await saveToken(tokenInput.value);
      tokenInput.value = "";
      await updateRateLimitDisplay();
    } catch (error) {
      showError(error.message);
    } finally {
      saveTokenButton.disabled = false;
    }
  });

  clearTokenButton.addEventListener("click", async () => {
    try {
      await clearToken();
      await cacheManager.clear();
      await updateRateLimitDisplay();
    } catch (error) {
      showError(`Could not clear token: ${error.message}`);
    }
  });

  addExclusionButton.addEventListener("click", async () => {
    const enteredValue = exclusionInput.value.trim().toLowerCase();
    const extension = enteredValue.startsWith(".")
      ? enteredValue.slice(1)
      : enteredValue;

    if (!extension || exclusions.includes(extension)) return;

    exclusions.push(extension);
    exclusions.sort();
    await storageSet({ fileExclusions: exclusions });
    renderExclusions(exclusions);
    exclusionInput.value = "";
  });

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const match = tab?.url?.match(
      /^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)(?:[/?#]|$)/,
    );

    if (!match) {
      currentRepoDiv.textContent = "No GitHub repository detected";
      countButton.disabled = true;
      return;
    }

    const owner = match[1];
    const repo = match[2].replace(/\.git$/, "");
    currentRepoDiv.textContent = `Repository: ${owner}/${repo}`;
    countButton.disabled = false;

    countButton.addEventListener("click", async () => {
      showLoadingState();
      countButton.disabled = true;
      const originalText = countButton.textContent;
      countButton.textContent = "Counting…";

      await analyzeRepository(owner, repo);

      countButton.textContent = originalText;
      countButton.disabled = false;
    });
  } catch (error) {
    showError(`Could not detect the current repository: ${error.message}`);
  }
});
