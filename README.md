# LeetCode Auto Commit (Chrome Extension)

This extension automatically commits Accepted LeetCode solutions to a GitHub repository.

**Folder structure created on GitHub**

LeetCode/
  {Problem-Title}/
    solution.{ext}
    README.md

README.md content includes Problem name, Difficulty, Language, and Date solved.

Setup

1. Load extension in Chrome (Developer mode) from this folder.
2. Open Options (right-click extension → Options) and set:
   - Owner: GitHub username or org
   - Repository: repo name
   - Branch: branch name (default: main)
   - Personal Access Token: token with `repo` scope (for private repos) or `public_repo` for public repos.

Usage

- The extension runs on LeetCode problem pages and listens for submission results.
- When it detects an Accepted result it waits for the Monaco editor to be ready, extracts the code and metadata, and sends it to the background worker which pushes to GitHub.

Notes

- The extension avoids duplicate commits by checking file contents in GitHub before creating/updating files.
- Network requests are performed in the background service worker; the content script only extracts data and forwards it.

Chrome Web Store readiness checklist

- [ ] Use a meaningful icon and screenshots.
- [ ] Provide a privacy policy linking how tokens are stored and used.
- [ ] Ensure PAT handling instructions are clear; consider implementing OAuth for production.
- [ ] Confirm minimal permissions (storage, host permission for GitHub API only).
- [ ] Test on modern Chrome versions and handle error reporting gracefully.
# leetcode_extention

## Quick Install

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this repository folder.

## Usage

- Open the extension Options and set your GitHub `Owner`, `Repository`, `Branch`, and `Personal Access Token` (PAT). The PAT requires `public_repo` for public repos or `repo` for private repos.
- On LeetCode, when a submission shows **Accepted**, the extension will extract the solution and metadata and commit it to `LeetCode/{slug}.{ext}` and append an entry to `LeetCode/README.md`.

## Notes

- Tokens are stored in `chrome.storage.sync` for convenience; treat PATs carefully and consider using an OAuth flow for public distribution.
- If language detection mislabels an extension, open an issue and include the page & console logs for debugging.

---
