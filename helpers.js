import { getHeaders } from "./authentication.js";

let rateLimitRequest = null;
let lastRateLimit = null;

export class RateLimitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RateLimitError";
    this.resetAt = details.resetAt ?? null;
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
  }
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

function parseIntegerHeader(headers, name) {
  const value = headers.get(name);
  if (value === null) return null;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function renderRateLimit(data) {
  const apiRemainingSpan = document.getElementById("api-remaining");
  const apiResetSpan = document.getElementById("api-resetTime");

  if (apiRemainingSpan && data.remaining !== null && data.limit !== null) {
    apiRemainingSpan.textContent = `${data.remaining}/${data.limit}`;
  }

  if (apiResetSpan && data.resetAt) {
    apiResetSpan.textContent = data.resetAt.toLocaleTimeString();
  }
}

export function updateRateLimitFromHeaders(headers) {
  const limit = parseIntegerHeader(headers, "X-RateLimit-Limit");
  const remaining = parseIntegerHeader(headers, "X-RateLimit-Remaining");
  const resetSeconds = parseIntegerHeader(headers, "X-RateLimit-Reset");

  if (limit === null || remaining === null || resetSeconds === null) {
    return lastRateLimit;
  }

  lastRateLimit = {
    limit,
    remaining,
    resetAt: new Date(resetSeconds * 1000),
  };

  renderRateLimit(lastRateLimit);
  return lastRateLimit;
}

export function getLastRateLimit() {
  return lastRateLimit;
}

async function getResponseMessage(response) {
  try {
    const body = await response.clone().json();
    return typeof body.message === "string" ? body.message : "";
  } catch {
    return "";
  }
}

export async function githubFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...getHeaders(),
      ...(options.headers ?? {}),
    },
  });

  updateRateLimitFromHeaders(response.headers);

  if (response.status === 401) {
    throw new Error(
      "GitHub rejected the saved token. Clear it and save a valid token.",
    );
  }

  if (response.status === 403 || response.status === 429) {
    const remaining = parseIntegerHeader(
      response.headers,
      "X-RateLimit-Remaining",
    );
    const resetSeconds = parseIntegerHeader(
      response.headers,
      "X-RateLimit-Reset",
    );
    const retryAfterSeconds = parseIntegerHeader(
      response.headers,
      "Retry-After",
    );
    const apiMessage = await getResponseMessage(response);
    const isRateLimited =
      remaining === 0 ||
      retryAfterSeconds !== null ||
      /rate limit|abuse detection/i.test(apiMessage);

    if (isRateLimited) {
      const resetAt = resetSeconds
        ? new Date(resetSeconds * 1000)
        : null;
      const waitMessage = retryAfterSeconds
        ? ` Retry after ${retryAfterSeconds} seconds.`
        : resetAt
          ? ` Resets at ${resetAt.toLocaleTimeString()}.`
          : " Try again later.";

      throw new RateLimitError(
        `GitHub API rate limit reached.${waitMessage}`,
        { resetAt, retryAfterSeconds },
      );
    }
  }

  return response;
}

export async function checkRateLimit() {
  const response = await fetch("https://api.github.com/rate_limit", {
    headers: getHeaders(),
  });

  if (!response.ok) {
    throw new Error(
      `Could not read the API rate limit (${response.status} ${response.statusText}).`,
    );
  }

  const data = await response.json();
  const core = data.resources?.core;
  if (!core) {
    throw new Error("GitHub returned an unexpected rate-limit response.");
  }

  lastRateLimit = {
    remaining: core.remaining,
    limit: core.limit,
    resetAt: new Date(core.reset * 1000),
  };
  renderRateLimit(lastRateLimit);
  return lastRateLimit;
}

export async function updateRateLimitDisplay() {
  if (rateLimitRequest) {
    return rateLimitRequest;
  }

  rateLimitRequest = checkRateLimit()
    .catch((error) => {
      console.error("Error fetching rate limit:", error);
      const apiRemainingSpan = document.getElementById("api-remaining");
      const apiResetSpan = document.getElementById("api-resetTime");
      if (apiRemainingSpan) apiRemainingSpan.textContent = "Error";
      if (apiResetSpan) apiResetSpan.textContent = "Error";
      return null;
    })
    .finally(() => {
      rateLimitRequest = null;
    });

  return rateLimitRequest;
}
