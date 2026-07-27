import test from "node:test";
import assert from "node:assert/strict";
import {
  countPhysicalLines,
  getFileExtension,
  isBinaryExtension,
} from "../line-utils.js";

test("counts empty content as zero lines", () => {
  assert.equal(countPhysicalLines(""), 0);
});

test("does not add a phantom line for a final LF", () => {
  assert.equal(countPhysicalLines("hello\n"), 1);
});

test("counts a line without a final newline", () => {
  assert.equal(countPhysicalLines("hello"), 1);
});

test("supports LF, CRLF, and CR line endings", () => {
  assert.equal(countPhysicalLines("a\nb\nc\n"), 3);
  assert.equal(countPhysicalLines("a\r\nb\r\nc\r\n"), 3);
  assert.equal(countPhysicalLines("a\rb\rc\r"), 3);
});

test("counts internal blank lines", () => {
  assert.equal(countPhysicalLines("a\n\nb\n"), 3);
});

test("recognizes ordinary and extensionless text files", () => {
  assert.equal(getFileExtension("src/app.js"), "js");
  assert.equal(getFileExtension("Dockerfile"), "dockerfile");
  assert.equal(getFileExtension("folder/Makefile"), "makefile");
  assert.equal(getFileExtension(".gitignore"), "gitignore");
  assert.equal(getFileExtension(".env"), "env");
  assert.equal(getFileExtension("unknownfile"), "no-extension");
});

test("classifies common binaries", () => {
  assert.equal(isBinaryExtension("png"), true);
  assert.equal(isBinaryExtension("js"), false);
  assert.equal(isBinaryExtension("svg"), false);
});
