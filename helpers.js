import { config, getHeaders } from "./authentication.js";

export function getFileExtension(filePath) {
  const parts = filePath.split(".");
  if (parts.length > 1) {
    return parts.pop().toLowerCase();
  }
  return "no-extension";
}

export function isBinaryExtension(extension) {
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

export function showError(message) {
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

// API rate limit handling
export async function checkRateLimit() {
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
export async function updateRateLimitDisplay() {
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
