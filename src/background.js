import { detectExtensionFromLanguage, sanitizeTitleForPath, base64Encode, base64Decode } from './utils.js';

// Background service worker: receive commit requests and push to GitHub
const DEBUG = true; // Set to false in production
function log(...args){ if (DEBUG) console.log('[lc-auto-commit-bg]', ...args); }
console.log('[lc-auto-commit-bg] service worker started');

async function getGithubConfig(){
  return new Promise(resolve => {
    chrome.storage.sync.get(['github'], (items)=>{
      const cfg = items.github || {};
      if (!cfg.owner || !cfg.repo || !cfg.token) console.log('[lc-auto-commit-bg] github config incomplete or missing in storage');
      resolve(cfg);
    });
  });
}

async function githubRequest(path, method='GET', token, body){
  const url = `https://api.github.com${path}`;
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (token) headers['Authorization'] = `token ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try{ json = text ? JSON.parse(text) : null; }catch(e){ json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

async function getFile(owner, repo, path, branch, token){
  const q = encodeURIComponent(branch || 'main');
  const p = `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${q}`;
  return githubRequest(p, 'GET', token);
}

async function putFile(owner, repo, path, branch, token, contentB64, message, sha){
  const p = `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const body = { message, content: contentB64, branch: branch || 'main' };
  if (sha) body.sha = sha;
  return githubRequest(p, 'PUT', token, body);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'commit_solution'){
    (async ()=>{
      try{
        const cfg = await getGithubConfig();
        const { owner, repo, token, branch } = cfg;
        if (!owner || !repo || !token) return sendResponse({ error: 'Missing GitHub config (owner/repo/token) in extension options' });
        const payload = msg.payload || {};
        console.log('[lc-auto-commit-bg] received commit request', { 
          title: payload.title, 
          language: payload.language, 
          codeLength: payload.code ? payload.code.length : 0 
        });
        
        // Validate we have code
        if (!payload.code || payload.code.trim().length < 20){
          console.error('[lc-auto-commit-bg] Code insufficient, aborting. Length:', payload.code ? payload.code.length : 0);
          return sendResponse({ error: 'Code too short or empty' });
        }
        
        const titleRaw = payload.title || payload.slug || 'unknown';
        const title = sanitizeTitleForPath(titleRaw);
        const ext = detectExtensionFromLanguage(payload.language);
        // Place solution file under top-level LeetCode folder and keep a single README.md in that folder
        let solutionFilename = `${title}.${ext}`;
        let solutionPath = `LeetCode/${solutionFilename}`;
        const readmePath = `LeetCode/README.md`;

        // Prepare contents
        const solutionB64 = base64Encode(payload.code || '');
        const entryLine = `- **${payload.title || titleRaw}** ([solution](${solutionFilename})) - ${payload.language||'Unknown'} - ${payload.difficulty||'Unknown'} - ${new Date(payload.ts||Date.now()).toISOString()}`;

        console.log('[lc-auto-commit-bg] preparing to push solution', { owner, repo, path: solutionPath, language: payload.language, extension: ext, title });
        // Check existing solution
        let existingSol = await getFile(owner, repo, solutionPath, branch, token);
        // If path exists but is a directory (GitHub returns array), pick alternate filename using slug to avoid collision
        if (existingSol && existingSol.ok && (Array.isArray(existingSol.json) || (existingSol.json && existingSol.json.type === 'dir'))){
          console.log('[lc-auto-commit-bg] solution path is a directory — choosing alternate filename using slug');
          const altName = `${title}-${(payload.slug||'solution')}.${ext}`;
          const altPath = `LeetCode/${altName}`;
          // update solution path vars
          solutionFilename = altName;
          solutionPath = altPath;
          // reassign
          existingSol = await getFile(owner, repo, altPath, branch, token);
        }
        
        // Always update the solution file with retry logic for 409 conflicts
        let updateAttempts = 0;
        let updateSuccess = false;
        while (updateAttempts < 3 && !updateSuccess){
          updateAttempts++;
          
          if (existingSol.ok && existingSol.json && existingSol.json.content){
            // Update existing file
            const commitMsg = `Update LeetCode solution: ${payload.title} (${payload.language})`;
            const res = await putFile(owner, repo, solutionPath, branch, token, solutionB64, commitMsg, existingSol.json.sha);
            if (res.ok){
              console.log('[lc-auto-commit-bg] Solution updated', { path: solutionPath });
              updateSuccess = true;
            } else if (res.status === 409 && updateAttempts < 3){
              // Conflict - refetch and retry
              console.log('[lc-auto-commit-bg] 409 conflict on attempt', updateAttempts, '- refetching SHA and retrying...');
              await new Promise(r => setTimeout(r, 500)); // brief delay
              existingSol = await getFile(owner, repo, solutionPath, branch, token);
              if (!existingSol.ok || !existingSol.json){
                return sendResponse({ error: `Failed to refetch file after conflict: ${existingSol.status}` });
              }
            } else {
              return sendResponse({ error: `Failed to update solution: ${res.status} ${JSON.stringify(res.json)}` });
            }
          } else {
            // Create new solution file
            const commitMsg = `Add LeetCode solution: ${payload.title} (${payload.language})`;
            const res = await putFile(owner, repo, solutionPath, branch, token, solutionB64, commitMsg, undefined);
            if (res.ok){
              console.log('[lc-auto-commit-bg] Solution created', { path: solutionPath });
              updateSuccess = true;
            } else {
              return sendResponse({ error: `Failed to create solution: ${res.status} ${JSON.stringify(res.json)}` });
            }
          }
        }
        
        if (!updateSuccess){
          return sendResponse({ error: 'Failed to update solution after 3 attempts (conflicts)' });
        }
          // create new solution file
          const commitMsg = `Add LeetCode solution: ${payload.title} (${payload.language})`;
          const res = await putFile(owner, repo, solutionPath, branch, token, solutionB64, commitMsg, undefined);
          if (!res.ok) return sendResponse({ error: `Failed to create solution: ${res.status} ${JSON.stringify(res.json)}` });
          console.log('[lc-auto-commit-bg] Solution created', { path: solutionPath });
        }

        // Update single README.md under LeetCode/ — append entry if not present
        const existingReadme = await getFile(owner, repo, readmePath, branch, token);
        if (existingReadme.ok && existingReadme.json && existingReadme.json.content){
          const existingMd = base64Decode(existingReadme.json.content);
          if (existingMd.includes(solutionFilename) || existingMd.includes(payload.title || titleRaw)){
            console.log('[lc-auto-commit-bg] README already contains entry, skipping');
            return sendResponse({ ok: true, message: 'No changes' });
          }
          const updatedMd = existingMd + '\n' + entryLine + '\n';
          const updatedB64 = base64Encode(updatedMd);
          const commitMsg = `Update LeetCode README: add ${payload.title}`;
          const res = await putFile(owner, repo, readmePath, branch, token, updatedB64, commitMsg, existingReadme.json.sha);
          if (!res.ok) return sendResponse({ error: `Failed to update README: ${res.status} ${JSON.stringify(res.json)}` });
          console.log('[lc-auto-commit-bg] README updated (appended)', { path: readmePath });
          return sendResponse({ ok: true });
        } else {
          // create README with header and first entry
          const initial = `# LeetCode Solutions\n\n${entryLine}\n`;
          const initialB64 = base64Encode(initial);
          const commitMsg = `Create LeetCode README and add ${payload.title}`;
          const res = await putFile(owner, repo, readmePath, branch, token, initialB64, commitMsg, undefined);
          if (!res.ok) return sendResponse({ error: `Failed to create README: ${res.status} ${JSON.stringify(res.json)}` });
          console.log('[lc-auto-commit-bg] README created with first entry', { path: readmePath });
          return sendResponse({ ok: true });
        }

      }catch(err){
        console.error('[lc-auto-commit-bg] unexpected', err);
        return sendResponse({ error: String(err) });
      }
    })();
    // Return true to indicate we will respond asynchronously
    return true;
  }
  // handle probe request from content script to access page-scoped Monaco via scripting.executeScript
  if (msg && msg.type === 'probe_monaco'){
    (async ()=>{
      try{
        const tabId = sender.tab && sender.tab.id;
        if (!tabId) return sendResponse({ ok: false, error: 'no-tab' });
        // execute in page context and return simple payload
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: false },
          world: 'MAIN',
          func: () => {
            try{
              let allAttempts = [];
              
              // Method 1: Monaco editor models
              const mon = window.monaco && window.monaco.editor;
              if (mon && mon.getModels){
                const models = mon.getModels();
                if (models && models.length > 0){
                  for (const m of models){
                    try{
                      const code = m.getValue ? m.getValue() : '';
                      const language = (m.getLanguageId && m.getLanguageId()) || (m.getModeId && m.getModeId()) || null;
                      if (code && code.trim().length > 0){
                        allAttempts.push({ method: 'monaco-model', code, language, length: code.length });
                      }
                    }catch(e){/* ignore */}
                  }
                }
              }
              
              // Method 2: window.editor
              if (window.editor){
                try{
                  if (typeof window.editor.getValue === 'function'){
                    const code = window.editor.getValue();
                    if (code && code.trim().length > 0){
                      allAttempts.push({ method: 'window.editor.getValue', code, length: code.length });
                    }
                  }
                  if (typeof window.editor.getModel === 'function'){
                    const em = window.editor.getModel();
                    const code = (em && em.getValue && em.getValue()) || '';
                    const language = (em && em.getLanguageId && em.getLanguageId()) || null;
                    if (code && code.trim().length > 0){
                      allAttempts.push({ method: 'window.editor.getModel', code, language, length: code.length });
                    }
                  }
                }catch(e){/* ignore */}
              }
              
              // Method 3: Check for React component state (LeetCode sometimes stores code here)
              try{
                const editorDom = document.querySelector('.monaco-editor, [class*="editor"], [data-track-load="description_content"]');
                if (editorDom){
                  // Try to find React fiber
                  for (const key in editorDom){
                    if (key.startsWith('__react')){
                      const fiber = editorDom[key];
                      // Navigate fiber tree looking for code state
                      let current = fiber;
                      let depth = 0;
                      while (current && depth < 20){
                        if (current.memoizedState && current.memoizedState.value){
                          const val = current.memoizedState.value;
                          if (typeof val === 'string' && val.length > 50){
                            allAttempts.push({ method: 'react-state', code: val, length: val.length });
                          }
                        }
                        current = current.return;
                        depth++;
                      }
                      break;
                    }
                  }
                }
              }catch(e){/* ignore */}
              
              // Pick the longest code (likely the most complete)
              if (allAttempts.length > 0){
                allAttempts.sort((a, b) => b.length - a.length);
                const best = allAttempts[0];
                console.log('[probe] Found', allAttempts.length, 'attempts, using', best.method, 'with length', best.length);
                return { ok: true, payload: { code: best.code, language: best.language || null } };
              }
              
              return { ok: true, payload: { code: '', language: null } };
            }catch(err){ return { ok: false, error: String(err) }; }
          }
        });
        // chrome.scripting.executeScript returns array of InjectionResult; pick first successful payload
        let found = null;
        if (Array.isArray(results)){
          for (const item of results){
            if (item && item.result && item.result.ok){
              const p = item.result;
              if (p.payload && p.payload.code && p.payload.code.length>0){ found = p; break; }
              if (!found) found = p; // keep last ok
            }
          }
        }
        const r = found || ((results && results[0] && results[0].result) || null);
        console.log('[lc-auto-commit-bg] probe_monaco results count', results && results.length, 'selected', !!r);
        return sendResponse(r);
      }catch(err){
        return sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true; // will respond asynchronously
  }
});

// No action.onClicked handler: action uses default_popup in manifest.
