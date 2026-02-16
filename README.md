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
