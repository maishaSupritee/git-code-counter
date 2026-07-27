export const config = {
  github: {
    token: "",
    useAuth: false,
  },
  cache: {
    enabled: true,
  },
};

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

function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

export function getHeaders(tokenOverride = null) {
  const token = tokenOverride ?? config.github.token;
  const headers = {
    Accept: "application/vnd.github+json", // Set the Accept header for GitHub API
  };

  if (typeof token === "string" && token.trim() !== "") {
    headers.Authorization = `Bearer ${token.trim()}`;
  }

  return headers;
}

export function updateAuthStatus(isAuthenticated, text = null) {
  const statusCircle = document.querySelector(".status-circle");
  const authText = document.getElementById("auth-text");

  if (statusCircle) {
    statusCircle.classList.toggle("authenticated", isAuthenticated);
    statusCircle.classList.toggle("unauthenticated", !isAuthenticated);
  }

  if (authText) {
    authText.textContent =
      text ?? (isAuthenticated ? "Token loaded" : "Not authenticated");
  }
}

export function setGitHubToken(token) {
  if (typeof token !== "string" || token.trim() === "") {
    config.github.token = "";
    config.github.useAuth = false;
    updateAuthStatus(false);
    return false;
  }

  config.github.token = token.trim();
  config.github.useAuth = true;
  updateAuthStatus(true);
  return true;
}

async function validateToken(token) {
  const response = await fetch("https://api.github.com/user", {
    headers: getHeaders(token),
  });

  if (response.status === 401) {
    throw new Error("GitHub rejected this token. Check or recreate it.");
  }

  if (!response.ok) {
    throw new Error(
      `Could not validate the GitHub token (${response.status} ${response.statusText}).`,
    );
  }

  return response;
}

export async function saveToken(token) {
  const normalizedToken = typeof token === "string" ? token.trim() : "";
  if (!normalizedToken) {
    throw new Error("Enter a GitHub personal access token first.");
  }

  await validateToken(normalizedToken);
  await storageSet({ github_token: { value: normalizedToken } });
  setGitHubToken(normalizedToken);
  updateAuthStatus(true, "Authenticated");
  return true;
}

export async function loadToken() {
  const result = await storageGet(["github_token"]);
  const storedToken = result.github_token;

  // Supports both the new object and older saved formats.
  const tokenValue =
    typeof storedToken === "string" ? storedToken : storedToken?.value;

  if (typeof tokenValue !== "string" || tokenValue.trim() === "") {
    setGitHubToken("");
    return false;
  }

  setGitHubToken(tokenValue);
  return true;
}

export async function clearToken() {
  await storageRemove(["github_token"]);
  setGitHubToken("");
  return true;
}
