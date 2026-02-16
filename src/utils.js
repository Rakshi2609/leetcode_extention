// Utility functions: language mapping, sanitizers, base64 helpers
const LANG_TO_EXT = {
  cpp: ["cpp", "c++", "cpp11", "c++11"],
  py: ["python", "python3", "py3", "py"],
  java: ["java"],
  js: ["javascript", "nodejs", "js"],
  ts: ["typescript", "ts"],
  cs: ["c#", "csharp"],
  rb: ["ruby", "rb"],
  go: ["golang", "go"],
  kt: ["kotlin", "kt"],
  swift: ["swift"]
};

function detectExtensionFromLanguage(languageId) {
  if (!languageId) return 'txt';
  const key = String(languageId).toLowerCase();
  for (const ext in LANG_TO_EXT) {
    if (LANG_TO_EXT[ext].includes(key)) return ext;
  }
  // fallback common substrings
  if (key.includes('python')) return 'py';
  if (key.includes('cpp') || key.includes('c++')) return 'cpp';
  if (key.includes('java')) return 'java';
  if (key.includes('javascript') || key.includes('node')) return 'js';
  if (key.includes('typescript')) return 'ts';
  if (key.includes('csharp') || key === 'c#') return 'cs';
  if (key.includes('go')) return 'go';
  return 'txt';
}

function sanitizeTitleForPath(title) {
  return String(title)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s/g, '-');
}

function base64Encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function base64Decode(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

export { detectExtensionFromLanguage, sanitizeTitleForPath, base64Encode, base64Decode };
