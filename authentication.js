import { updateRateLimitDisplay } from "./helpers.js";

export const config = {
  github: {
    token: "",
    useAuth: false,
    tokenExpirationMs: 3600000, // 1 hour in milliseconds
  },
  cache: {
    enabled: true,
  },
};
//AUTHENTICATION
// Configure authentication for fetch requests
export function getHeaders() {
  const headers = {
    Accept: "application/vnd.github+json", // Set the Accept header for GitHub API
  };

  if (config.github.useAuth && config.github.token) {
    headers["Authorization"] = `token ${config.github.token}`; // Add token if available
  }

  return headers;
}

// Save token to Chrome storage
export function saveToken(token) {
  const tokenData = {
    value: token,
    timestamp: Date.now(),
    expires: Date.now() + config.github.tokenExpirationMs,
  };

  chrome.storage.local.set({ github_token: tokenData }, function () {
    console.log("Token saved");
    setGitHubToken(token);
    updateAuthStatus(true);
    // Update rate limit display after authentication changes
    updateRateLimitDisplay();
  });
}

// Load token from Chrome storage
export function loadToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["github_token"], function (result) {
      if (result.github_token && result.github_token.value) {
        const tokenData = result.github_token;
        const currentTime = Date.now();

        // Check if token is expired
        if (currentTime > tokenData.expires) {
          console.log("Token expired, clearing...");
          clearToken();
          resolve(false);
          return;
        }

        // Token is valid
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
export function setGitHubToken(token) {
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
export function clearToken() {
  chrome.storage.local.remove(["github_token"], function () {
    console.log("Token cleared");
    setGitHubToken("");
    updateAuthStatus(false);
    // Update rate limit display after authentication is removed
    updateRateLimitDisplay();
  });
}

// Update UI to show authentication status
export function updateAuthStatus(isAuthenticated) {
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

export function checkTokenExpiration() {
  chrome.storage.local.get(["github_token"], function (result) {
    if (result.github_token && result.github_token.expires) {
      const now = Date.now();
      if (now > result.github_token.expires) {
        console.log("Token expired during session check");
        clearToken();
      }
    }
  });
}

// Periodic token expiration check (every 15 minutes)
export function initializeAuthChecks() {
  // Initial check
  checkTokenExpiration();

  // Set interval for regular checks
  setInterval(() => {
    checkTokenExpiration();
  }, 15 * 60 * 1000); // Check every 15 minutes
}
