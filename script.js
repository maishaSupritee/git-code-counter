async function fetchGithubRepoData(owner, repo) {
  const url = `https://api.github.com/repos/${owner}/${repo}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Error fetching data: ${response.statusText}`);
  }
  const data = await response.json();
  console.log(data);
  return data;
}

async function countLinesOfCode(owner, repo, repoData) {
  const stats = {
    totalLines: 0,
    totalFiles: 0,
    byExtension: {},
    filesSkipped: 0,
  };
  try {
    const defaultBranch = repoData.default_branch;

    //getting root tree
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`; //can change recursive to get more nested
    const treeResponse = await fetch(url);
    if (!treeResponse.ok) {
      throw new Error(`Error fetching tree: ${treeResponse.statusText}`);
    }
    if (treeResponse.truncated) {
      showError("Repository is too large. Response will be partial.");
    }
    const treeData = await treeResponse.json();
    const files = treeData.tree.filter((item) => item.type === "blob"); // filter for files only
    const fileCount = files.length;

    let processedFiles = 0;
    const batchSize = 4; // number of files to process in each batch
    for (let i = 0; i < files.length; i++) {
      const batch = files.slice(i, i + batchSize);
      await Promise.all(
        batch.map((file) => {
          countLinesInFile(owner, repo, file, stats);
        })
      ); // process files in parallel but in batches to avoid overwhelming the API
      processedFiles += batch.length;
      updateProgress(processedFiles, fileCount);

      await new Promise((resolve) => setTimeout(resolve, 100)); // wait for 100ms to avoid hitting the rate limit
    }

    displayStats(stats);
  } catch (error) {
    showError(`Error counting lines of code: ${error.message}`);
  } finally {
    console.log("Finished counting lines of code.");
  }
}

async function countLinesInFile(owner, repo, file, stats) {
  filePath = file.path;
  fileExtension = getFileExtension(filePath);
  // skip binary files and large files
  if (isBinaryExtension(fileExtension) || file.size > 1000000) {
    stats.filesSkipped++;
    return;
  }

  try {
    const fileContent = await getFileContent(owner, repo, file.sha);
    const lines = fileContent.split("\n").length;
    stats.totalLines += lines;
    stats.totalFiles++;
    if (!stats.byExtension[extension]) {
      stats.byExtension[extension] = {
        // initialize if not present
        files: 0,
        lines: 0,
      };
    }

    // update stats for the file extension
    stats.byExtension[extension].files++;
    stats.byExtension[extension].lines += lines;
  } catch (error) {
    console.warn(`Could not process file ${filePath}: ${error.message}`);
    stats.filesSkipped++;
  }
}

function updateProgress(processedFiles, totalFiles) {}

function displayStats(stats) {}

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
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Error fetching file content: ${response.statusText}`);
  }
  const data = await response.json();
  const decodedContent = atob(fileContent); // decode base64 content
  return decodedContent;
}
//fetchGithubRepoData("maishaSupritee", "inferix-ui");
