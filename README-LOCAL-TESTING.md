# GitHub Code Counter — local testing

## 1. Run the automated line-count tests

From this folder:

```bash
npm test
```

No npm packages need to be installed; the tests use Node's built-in test runner.

## 2. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder (`github-code-counter-fixed`), not an individual file.
5. Pin the extension from Chrome's Extensions menu if useful.

After editing a file, return to `chrome://extensions`, click **Reload** on the extension card, and reopen the popup.

## 3. Open the popup developer tools

1. Open the extension popup.
2. Right-click inside it and choose **Inspect**.
3. Watch both **Console** and **Network**.
4. Filter Network requests by `api.github.com`.

Keep the popup open while analysis is running. This version still performs analysis in the popup page, so closing it stops the popup JavaScript context.

## 4. Public-repository checks

Use a small public repository first.

- With no token, the popup should show the unauthenticated rate bucket.
- Click **Count lines of code**.
- Verify the result includes total physical lines, files found, files counted, skipped files, extension totals, and individual file totals.
- Run it again within one hour. Repository metadata, tree data, and line counts should show `Cache hit` messages in the Console and should avoid blob requests.

## 5. Token persistence check

1. Save a valid token.
2. Confirm the status says **Authenticated**.
3. Close the popup.
4. Reopen it.
5. Confirm the status says **Token loaded** and the authenticated rate bucket is shown.

This specifically checks the old bug where the entire stored token object was passed to `.trim()`.

## 6. Private-repository check

Create a fine-grained token that:

- Has access to the chosen private repository.
- Has **Repository permissions → Contents → Read-only**.

Open the private repository in a normal GitHub tab, open the extension, save the token, and run the count. Clear the token afterward and verify the same private repository produces a clear not-found/access message rather than a partial result.

## 7. Accuracy fixture

For an exact manual comparison, create a small test repository containing:

- Empty file: expected `0` lines.
- `one-final-newline.txt` containing `hello\n`: expected `1` line.
- `one-no-final-newline.txt` containing `hello`: expected `1` line.
- A three-line CRLF file: expected `3` lines.
- `Dockerfile`: should be counted.
- `image.png`: should be skipped.
- A file larger than 1 MB: should be skipped.

Compare the extension's per-file output with the expected values.

## 8. Rate-limit behavior check

In the Network panel, inspect response headers for:

- `x-ratelimit-limit`
- `x-ratelimit-remaining`
- `x-ratelimit-reset`

The popup should update from ordinary GitHub responses. When GitHub returns a primary or secondary rate-limit response, analysis should stop with a visible error; it should not continue and classify all later files as skipped.

## 9. Storage/cache check

In popup DevTools, open **Application → Storage → Extension storage** if available, or inspect storage from the Console:

```js
chrome.storage.local.get(null).then(console.log)
```

Expected cache keys begin with `cache_`, including `cache_lines_<sha>`. There should be no `content_...` entries containing complete source files.

To clear all local extension data during testing:

```js
chrome.storage.local.clear()
```
