const EXTENSIONLESS_TEXT_FILES = new Set([
  "dockerfile",
  "makefile",
  "jenkinsfile",
  "procfile",
  "gemfile",
  "rakefile",
  "license",
  "readme",
]);

const BINARY_EXTENSIONS = new Set([
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
]);

export function getFileExtension(filePath) {
  const fileName = filePath.split("/").pop()?.toLowerCase() ?? "";

  if (EXTENSIONLESS_TEXT_FILES.has(fileName)) {
    return fileName;
  }

  const lastDot = fileName.lastIndexOf(".");

  // Treat dotfiles such as .gitignore and .env as text categories.
  if (lastDot === 0 && fileName.indexOf(".", 1) === -1) {
    return fileName.slice(1) || "no-extension";
  }

  if (lastDot < 0 || lastDot === fileName.length - 1) {
    return "no-extension";
  }

  return fileName.slice(lastDot + 1);
}

export function isBinaryExtension(extension) {
  return BINARY_EXTENSIONS.has(extension);
}

export function countPhysicalLines(content) {
  if (typeof content !== "string" || content.length === 0) {
    return 0;
  }

  const lines = content.split(/\r\n|\n|\r/);
  return /(?:\r\n|\n|\r)$/.test(content) ? lines.length - 1 : lines.length;
}
