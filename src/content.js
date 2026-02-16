/* Content script: detects Accepted submissions on LeetCode, extracts problem info and code, sends to background worker */
(function (){
  if (window.__lcac_installed) return;
  window.__lcac_installed = true;

  const DEBUG = true; // Set to false in production
  function log(...args){ if (DEBUG) console.log('[lc-auto-commit]', ...args); }
  console.log('[lc-auto-commit] content script loaded');

  // Minimal debounce helper
  function debounce(fn, wait){
    let t;
    return (...a)=>{ clearTimeout(t); t = setTimeout(()=>fn.apply(this,a), wait); };
  }
  
  // Cache the last extracted code from before submission
  let cachedCodeBeforeSubmit = null;
  let cachedLanguageBeforeSubmit = null;
  
  // Try to capture code when Submit button is clicked (before it might be cleared)
  function captureCodeOnSubmit(){
    try{
      // Look for Submit button and add listener
      const submitButtons = document.querySelectorAll('button[data-e2e-locator="console-submit-button"], button:not([disabled])');
      for (const btn of submitButtons){
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text === 'submit' || text.includes('submit')){
          btn.addEventListener('click', async () => {
            console.log('[lc-auto-commit] Submit button clicked - capturing code now...');
            const captured = await probeMonacoViaPage(3000);
            if (captured){
              const code = captured.getValue ? captured.getValue() : '';
              const lang = captured.getLanguageId ? captured.getLanguageId() : null;
              if (code && code.trim().length > 100){
                cachedCodeBeforeSubmit = code;
                cachedLanguageBeforeSubmit = lang;
                console.log('[lc-auto-commit] Cached code before submit, length:', code.length, 'language:', lang);
              }
            }
          }, { once: false }); // Allow multiple clicks
        }
      }
    }catch(e){ console.log('[lc-auto-commit] Error setting up submit listener:', e); }
  }
  
  // Set up submit listener immediately and re-check periodically
  captureCodeOnSubmit();
  setInterval(captureCodeOnSubmit, 5000); // Re-check for new submit buttons

  // Retry logic for Monaco editor
  async function waitForMonacoEditor({retries=60, delay=500} = {}){
    console.log('[lc-auto-commit] waiting for monaco editor (retries:', retries, 'delay:', delay, ')');
    // quick checks
    for (let i=0;i<retries;i++){
      try{
        // direct monaco API
        if (window.monaco && window.monaco.editor) {
          const models = window.monaco.editor.getModels();
          if (models && models.length>0) {
            console.log('[lc-auto-commit] monaco models found');
            return models[0];
          }
        }
        // some pages expose editor variable
        if (window.editor && typeof window.editor.getModel === 'function'){
          const model = window.editor.getModel();
          if (model) { console.log('[lc-auto-commit] found model via window.editor'); return model; }
        }
        // fallback: look for monaco-editor DOM node which often indicates Monaco instantiation
        const dom = document.querySelector('.monaco-editor');
        if (dom) {
          // try to access models again after a short wait
          if (window.monaco && window.monaco.editor) {
            const models = window.monaco.editor.getModels();
            if (models && models.length>0) { console.log('[lc-auto-commit] monaco models found after dom detect'); return models[0]; }
          }
        }
      }catch(e){ /* ignore and retry */ }
      await new Promise(r => setTimeout(r, delay));
    }

    // If not found, attach a short-lived MutationObserver for '.monaco-editor' nodes
    console.log('[lc-auto-commit] attaching MutationObserver to wait for .monaco-editor nodes');
    return await new Promise(resolve => {
      let settled = false;
      const mo = new MutationObserver((mutations)=>{
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            try{
              if (!(node instanceof Element)) continue;
              if (node.matches && node.matches('.monaco-editor') ){
                console.log('[lc-auto-commit] .monaco-editor node added — trying to obtain model');
                if (window.monaco && window.monaco.editor) {
                  const models = window.monaco.editor.getModels();
                  if (models && models.length>0) {
                    if (!settled) { settled = true; mo.disconnect(); resolve(models[0]); }
                    return;
                  }
                }
                // try window.editor
                if (window.editor && typeof window.editor.getModel === 'function'){
                  const model = window.editor.getModel();
                  if (model) {
                    if (!settled) { settled = true; mo.disconnect(); resolve(model); }
                    return;
                  }
                }
              }
            }catch(e){/* ignore */}
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
      // timeout fallback - give more time
      setTimeout(()=>{
        if (!settled) { settled = true; mo.disconnect(); resolve(null); }
      }, 20000);
    });
  }

  // Probe page context for Monaco by asking the background to execute a page-scoped script (avoids inline CSP issues)
  function probeMonacoViaPage(timeout=8000){
    return new Promise((resolve)=>{
      try{
        chrome.runtime.sendMessage({ type: 'probe_monaco' }, (resp)=>{
          if (!resp) {
            console.log('[lc-auto-commit] probe got no response');
            return resolve(null);
          }
          if (!resp.ok) {
            console.log('[lc-auto-commit] probe returned not ok:', resp.error || 'unknown');
            return resolve(null);
          }
          const p = resp.payload || {};
          if (!p.code || p.code.trim().length === 0){
            console.log('[lc-auto-commit] probe returned empty code');
            return resolve(null);
          }
          const modelLike = {
            getValue: ()=>p.code || '',
            getLanguageId: ()=>p.language || null
          };
          console.log('[lc-auto-commit] probe SUCCESS - code length:', p.code.length);
          resolve(modelLike);
        });
      }catch(e){ console.log('[lc-auto-commit] probe error:', e); resolve(null); }
      // safety timeout
      setTimeout(()=>{
        console.log('[lc-auto-commit] probe timeout after', timeout, 'ms');
        resolve(null);
      }, timeout+50);
    });
  }

  function extractProblemInfo(){
    const urlParts = location.pathname.split('/').filter(Boolean);
    let slug = null;
    if (urlParts.length >= 2 && urlParts[0] === 'problems') slug = urlParts[1];
    // title - try to find h1
    let title = document.querySelector('h1');
    title = title ? title.textContent.trim() : (slug ? slug.replace(/-/g,' ') : 'unknown');
    // difficulty - find element containing Easy/Medium/Hard
    let difficulty = null;
    const candidates = Array.from(document.querySelectorAll('div, span, p'));
    for (const el of candidates){
      const t = (el.textContent||'').trim();
      if (['Easy','Medium','Hard'].includes(t)) { difficulty = t; break; }
    }
    return { title, slug, difficulty };
  }

  // detect language from Monaco model
  function detectLanguageFromModel(model){
    if (!model) return null;
    try{
      if (typeof model.getLanguageId === 'function') return model.getLanguageId();
      if (model.getModeId) return model.getModeId();
      // fallback: use first language from model's toString
      return model.language || model._language || null;
    }catch(e){ return null; }
  }

  // detect language from LeetCode page DOM (language selector/button text)
  function detectLanguageFromDOM(){
    try{
      const langMap = {
        'c++': ['c++', 'cpp', 'c++14', 'c++17', 'c++20'],
        'python': ['python', 'python3', 'py', 'python2'],
        'java': ['java'],
        'javascript': ['javascript', 'js', 'nodejs', 'node.js'],
        'typescript': ['typescript', 'ts'],
        'csharp': ['c#', 'csharp', 'cs'],
        'go': ['go', 'golang'],
        'ruby': ['ruby', 'rb'],
        'kotlin': ['kotlin', 'kt'],
        'swift': ['swift'],
        'rust': ['rust', 'rs'],
        'scala': ['scala'],
        'php': ['php'],
        'c': ['c']
      };
      
      // Try to find language selector button (often has data-lang or specific classes)
      const langSelectors = document.querySelectorAll('button[aria-haspopup], [class*="lang"], button[class*="language"], [data-cy*="lang"], [class*="editor-lang"]');
      for (const el of langSelectors){
        const txt = (el.textContent || '').trim().toLowerCase();
        if (txt && txt.length < 50){
          for (const [canonical, variants] of Object.entries(langMap)){
            if (variants.some(v => txt === v || txt.includes(v))){
              console.log('[lc-auto-commit] DOM detected language from selector:', canonical, 'via', txt);
              return canonical;
            }
          }
        }
      }
      
      // Broader search with stricter matching
      const nodes = Array.from(document.querySelectorAll('button,span,div[role="button"],li'));
      for (const el of nodes){
        if (!el) continue;
        const title = (el.getAttribute && (el.getAttribute('title') || el.getAttribute('aria-label') || el.getAttribute('data-value'))) || '';
        const txt = (title || (el.textContent || '')).trim().toLowerCase();
        if (!txt || txt.length > 60) continue;
        
        for (const [canonical, variants] of Object.entries(langMap)){
          for (const variant of variants){
            // Exact match first
            if (txt === variant){
              console.log('[lc-auto-commit] DOM detected language:', canonical, 'from exact match:', txt);
              return canonical;
            }
            // Word boundary match with escaped special chars
            const escapedVariant = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`\\b${escapedVariant}\\b`, 'i');
            if (regex.test(txt)){
              console.log('[lc-auto-commit] DOM detected language:', canonical, 'from text:', txt.substring(0, 30));
              return canonical;
            }
          }
        }
      }
    }catch(e){ console.log('[lc-auto-commit] DOM detection error:', e); }
    return null;
  }

  // detect language heuristically from code contents
  function detectLanguageFromCode(code){
    if (!code || !code.trim()) return null;
    const c = code;
    
    // C++ patterns (check first - includes, std::, vector, templates, pointers, bool, etc.)
    if (/#include\s*[<"]|\bstd::\b|\busing\s+namespace\s+std\b|\bvector<|\blong\s+long\b|\bpush_back\b|\bauto\b(?!\.)|\bcout\b|\bcin\b|->[a-zA-Z]|\bclass\s+Solution\b|\bbool\b|\bListNode\s*\*|\bTreeNode\s*\*|\bint\s+\w+\s*\(/.test(c)) {
      console.log('[lc-auto-commit] Code heuristics detected: c++');
      return 'c++';
    }
    
    // Python patterns (def, import, print, self, :)
    if (/^\s*def\s+\w+/m.test(c) || /\bimport\s+\w+/m.test(c) || /\bfrom\s+\w+\s+import/m.test(c) || /\bself\b/.test(c) || /:\s*$[\s\n]/m.test(c)) {
      console.log('[lc-auto-commit] Code heuristics detected: python');
      return 'python';
    }
    
    // Java patterns (public class, System, import java, etc.)
    if (/public\s+class|System\.(out|in)|import\s+java\.|private\s+\w+\s+\w+\s*\(|@Override/.test(c)) {
      console.log('[lc-auto-commit] Code heuristics detected: java');
      return 'java';
    }
    
    // TypeScript patterns (before JS to avoid false positives)
    if (/:\s*\w+\s*[=;)]|interface\s+\w+|type\s+\w+\s*=|<\w+>/.test(c) && /\b(const|let|var)\b/.test(c)) {
      console.log('[lc-auto-commit] Code heuristics detected: typescript');
      return 'typescript';
    }
    
    // JavaScript patterns
    if (/console\.log\(|function\s*\w*\s*\(|=>|\b(var|let|const)\s+\w+/.test(c)) {
      console.log('[lc-auto-commit] Code heuristics detected: javascript');
      return 'javascript';
    }
    
    // Go patterns
    if (/package\s+\w+|func\s+\w+\(|fmt\.[A-Z]|import\s+\(/.test(c)) {
      console.log('[lc-auto-commit] Code heuristics detected: go');
      return 'go';
    }
    
    // C# patterns
    if (/using\s+System|Console\.WriteLine|namespace\s+\w+|\[\w+\]|public\s+\w+\s+\w+\s*\{/.test(c)) {
      console.log('[lc-auto-commit] Code heuristics detected: c#');
      return 'csharp';
    }
    
    // Rust patterns
    if (/fn\s+\w+|use\s+std::|impl\s+\w+|let\s+mut\b|->\s*\w+\s*\{/.test(c)) {
      console.log('[lc-auto-commit] Code heuristics detected: rust');
      return 'rust';
    }
    
    // Ruby patterns
    if (/^\s*def\s+\w+|\bend\b|\bputs\b|@\w+|\bdo\s*\|/.test(c)) {
      console.log('[lc-auto-commit] Code heuristics detected: ruby');
      return 'ruby';
    }
    
    // Kotlin patterns
    if (/fun\s+\w+|val\s+\w+|var\s+\w+:\s*\w+|data\s+class/.test(c)) {
      console.log('[lc-auto-commit] Code heuristics detected: kotlin');
      return 'kotlin';
    }
    
    // Swift patterns
    if (/func\s+\w+|var\s+\w+:\s*\w+|let\s+\w+:\s*\w+|import\s+Foundation/.test(c)) {
      console.log('[lc-auto-commit] Code heuristics detected: swift');
      return 'swift';
    }
    
    console.log('[lc-auto-commit] Code heuristics: no language detected');
    return null;
  }

  // Process accepted submission
  async function processAccepted(){
    console.log('[lc-auto-commit] Accepted detected — extracting code (this may take a few seconds)...');
    let model = await waitForMonacoEditor();
    if (!model) console.log('[lc-auto-commit] Monaco editor not found after retries — trying in-page probe');
    if (!model) model = await probeMonacoViaPage(3000);
    if (!model) { console.log('[lc-auto-commit] Monaco still not found; aborting extraction'); log('Monaco editor not found'); return; }
    let code = model.getValue ? model.getValue() : (model.getText ? model.getText() : '');
    console.log('[lc-auto-commit] initial code from model, length:', code ? code.length : 0);
    
    // Check if we have a cached version from before submit (often more reliable)
    if (cachedCodeBeforeSubmit && cachedCodeBeforeSubmit.length > (code ? code.length : 0)){
      console.log('[lc-auto-commit] Using cached code from before submit (length:', cachedCodeBeforeSubmit.length, ')');
      code = cachedCodeBeforeSubmit;
      if (cachedLanguageBeforeSubmit){
        // Override language detection with cached value
        if (!model.getLanguageId) model.getLanguageId = () => cachedLanguageBeforeSubmit;
        else {
          const origGetLang = model.getLanguageId;
          model.getLanguageId = () => cachedLanguageBeforeSubmit || origGetLang();
        }
      }
    }
    
    // If model yielded no or insufficient code, try multiple retries with increasing delays
    if ((!code || code.trim().length < 100)){
      console.log('[lc-auto-commit] code insufficient (need >100 chars), trying multiple retries...');
      
      for (let attempt = 1; attempt <= 3; attempt++){
        console.log('[lc-auto-commit] retry attempt', attempt, '- waiting 2s...');
        await new Promise(r => setTimeout(r, 2000));
        
        const retryModel = await probeMonacoViaPage(8000);
        if (retryModel){
          const retryCode = retryModel.getValue ? retryModel.getValue() : '';
          console.log('[lc-auto-commit] retry', attempt, 'got code length:', retryCode.length);
          if (retryCode && retryCode.trim().length > (code ? code.length : 0)){
            code = retryCode;
            model = retryModel;
            if (code.trim().length >= 100) {
              console.log('[lc-auto-commit] Got sufficient code, stopping retries');
              break;
            }
          }
        }
      }
    }
    
    // If still no code, try DOM extraction as last resort
    async function extractCodeFromDOM(){
      try{
        // Try to find Monaco editor's textarea (has the actual code)
        const textarea = document.querySelector('.monaco-editor textarea.inputarea');
        if (textarea && textarea.value && textarea.value.trim().length > 0){
          console.log('[lc-auto-commit] found code in Monaco textarea');
          return textarea.value;
        }
        
        // Try getting from view lines but in correct order
        const editorContainer = document.querySelector('.monaco-editor .view-lines');
        if (editorContainer){
          const lines = Array.from(editorContainer.querySelectorAll('.view-line'));
          if (lines && lines.length > 0){
            const code = lines.map(line => {
              // Get text but try to preserve structure
              const spans = Array.from(line.querySelectorAll('span'));
              return spans.map(s => s.textContent || '').join('');
            }).join('\n');
            if (code.trim().length > 0){
              console.log('[lc-auto-commit] extracted from view-lines container');
              return code;
            }
          }
        }
        
        // Fallback to CodeMirror if present
        const cmEditor = document.querySelector('.CodeMirror');
        if (cmEditor && cmEditor.CodeMirror){
          try{
            const cmCode = cmEditor.CodeMirror.getValue();
            if (cmCode && cmCode.trim().length > 0){
              console.log('[lc-auto-commit] found code in CodeMirror');
              return cmCode;
            }
          }catch(e){/* ignore */}
        }
        
        console.log('[lc-auto-commit] DOM extraction failed');
      }catch(e){ console.log('[lc-auto-commit] DOM extraction error:', e); }
      return '';
    }
    
    if ((!code || code.trim().length < 50)){
      const domCode = await extractCodeFromDOM();
      if (domCode && domCode.trim().length > (code ? code.length : 0)){
        console.log('[lc-auto-commit] using DOM fallback code (length:', domCode.length, ')');
        code = domCode;
      } else {
        console.log('[lc-auto-commit] no sufficient code found anywhere');
      }
    }
    // Prefer code heuristics (most reliable), then DOM, then Monaco model, else 'text'
    const modelLang = detectLanguageFromModel(model);
    const domLang = detectLanguageFromDOM();
    const codeLang = detectLanguageFromCode(code);
    // Priority: code heuristics > DOM detection > model language > fallback
    const language = codeLang || domLang || modelLang || 'text';
    console.log('[lc-auto-commit] language detection results:', { codeLang, domLang, modelLang, final: language });
    if (language === 'text') console.warn('[lc-auto-commit] WARNING: Could not detect language, defaulting to text');
    console.log('[lc-auto-commit] final code length:', code ? code.length : 0, 'snippet:', (code||'').slice(0,120).replace(/\n/g,' '));
    
    // Validate code before sending - be more lenient but warn
    if (!code || code.trim().length < 20){
      console.error('[lc-auto-commit] Code too short or empty, aborting commit. Length:', code ? code.length : 0);
      alert('LeetCode Auto Commit: Could not extract your solution code. Please check the console for details.');
      return;
    }
    
    // Warn if code seems too short (likely just the stub)
    if (code.trim().length < 150){
      console.warn('[lc-auto-commit] WARNING: Code seems short (', code.length, 'chars). May be incomplete stub.');
      console.warn('[lc-auto-commit] Proceeding anyway, but check the result in GitHub.');
    }
    
    const { title, slug, difficulty } = extractProblemInfo();
    const payload = { title, slug, difficulty, language, code, url: location.href, ts: new Date().toISOString() };
    // send to background (do not log code contents)
    console.log('[lc-auto-commit] Sending payload to background', { title: payload.title, slug: payload.slug, language: payload.language });
    chrome.runtime.sendMessage({ type: 'commit_solution', payload }, (resp) => {
      if (resp && resp.error) console.log('[lc-auto-commit] Commit error', resp.error);
      else {
        console.log('[lc-auto-commit] Commit response', resp && resp.ok);
        // Clear cached code after successful commit
        cachedCodeBeforeSubmit = null;
        cachedLanguageBeforeSubmit = null;
        console.log('[lc-auto-commit] Cleared cached code');
      }
    });
  }

  // Observe DOM mutations for Accepted status
  let lastProcessedHash = null;
  const observer = new MutationObserver(debounce((mutations)=>{
    for (const m of mutations){
      for (const node of m.addedNodes){
        try{
          const txt = node.textContent || '';
          if (!txt) continue;
          // Look for exact word Accepted to avoid false positives
          if (/\bAccepted\b/i.test(txt)){
            // quick dedupe by hashing nearby code or timestamp
            const { title, slug } = extractProblemInfo();
            const hash = `${slug}::${title}::${location.href}`;
            if (hash === lastProcessedHash) { log('Duplicate accepted skip'); return; }
            lastProcessedHash = hash;
            // Wait longer for editor to fully load the submitted code
            console.log('[lc-auto-commit] Accepted detected, waiting 3s for editor to stabilize...');
            setTimeout(() => processAccepted(), 3000);
            return; // don't spam process for many added nodes
          }
        }catch(e){ /* ignore */ }
      }
    }
  }, 250));

  observer.observe(document.body, { childList: true, subtree: true });

  // also attempt to detect if the page already contains Accepted when loaded
  setTimeout(()=>{
    if (/\bAccepted\b/i.test(document.body.textContent||'')) processAccepted();
  }, 1000);

})();
