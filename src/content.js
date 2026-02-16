/* Content script: detects Accepted submissions on LeetCode, extracts problem info and code, sends to background worker */
(function (){
  if (window.__lcac_installed) return;
  window.__lcac_installed = true;

  const DEBUG = false;
  function log(...args){ if (DEBUG) console.log('[lc-auto-commit]', ...args); }
  console.log('[lc-auto-commit] content script loaded');

  // Minimal debounce helper
  function debounce(fn, wait){
    let t;
    return (...a)=>{ clearTimeout(t); t = setTimeout(()=>fn.apply(this,a), wait); };
  }

  // Retry logic for Monaco editor
  async function waitForMonacoEditor({retries=40, delay=300} = {}){
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
      // timeout fallback
      setTimeout(()=>{
        if (!settled) { settled = true; mo.disconnect(); resolve(null); }
      }, 12000);
    });
  }

  // Probe page context for Monaco by asking the background to execute a page-scoped script (avoids inline CSP issues)
  function probeMonacoViaPage(timeout=3000){
    return new Promise((resolve)=>{
      try{
        chrome.runtime.sendMessage({ type: 'probe_monaco' }, (resp)=>{
          if (!resp) return resolve(null);
          if (!resp.ok) return resolve(null);
          const p = resp.payload || {};
          const modelLike = {
            getValue: ()=>p.code || '',
            getLanguageId: ()=>p.language || null
          };
          resolve(modelLike);
        });
      }catch(e){ resolve(null); }
      // safety timeout
      setTimeout(()=>resolve(null), timeout+50);
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
      const normalized = ['c++','cpp','java','python','python3','javascript','js','typescript','ts','go','golang','ruby','c#','csharp','kotlin','swift'];
      // Look for language selectors but be conservative: only short text nodes (<=40 chars)
      const nodes = Array.from(document.querySelectorAll('button,span,div,li'));
      for (const el of nodes){
        if (!el) continue;
        // prefer explicit attributes
        const title = (el.getAttribute && (el.getAttribute('title') || el.getAttribute('aria-label'))) || '';
        const txt = (title || (el.textContent || '')).trim();
        if (!txt) continue;
        if (txt.length > 40) continue; // skip large blocks
        const low = txt.toLowerCase();
        for (const cand of normalized){
          // match exact or tokenized occurrences only
          if (low === cand || low === cand + 's' || low.startsWith(cand + ' ') || low.endsWith(' ' + cand) || low.includes(' ' + cand + ' ') ){
            return cand;
          }
          // also match common labels like 'C++' in mixed-case
          if (low.includes(cand) && txt.split(/\s+/).length <= 3) return cand;
        }
      }
    }catch(e){ /* ignore */ }
    return null;
  }

  // detect language heuristically from code contents
  function detectLanguageFromCode(code){
    if (!code || !code.trim()) return null;
    const c = code;
    // common python patterns
    if (/^\s*def\s+\w+\s*\(/m.test(c) || /\bimport\s+\w+/m.test(c) || /\bprint\(/m.test(c)) return 'python';
    // cpp patterns (look for vector<, std::, long long, include, class Solution)
    if (/#include\s+<|\bstd::\b|\busing\s+namespace\s+std\b|\bvector<|\blong\s+long\b|\bclass\s+Solution\b|\bpush_back\b/.test(c)) return 'cpp';
    // java patterns
    if (/public\s+class|System\.out\.println|import\s+java\./.test(c)) return 'java';
    // js patterns
    if (/console\.log\(|function\s+\(|=>|\bvar\s+\w+|\blet\s+\w+|\bconst\s+\w+/.test(c)) return 'javascript';
    // ts patterns
    if (/:\s*\w+\s*=|interface\s+\w+/.test(c)) return 'typescript';
    // go
    if (/package\s+main|fmt\.Println\(|func\s+main\(/.test(c)) return 'go';
    // c#
    if (/using\s+System;|Console\.WriteLine\(/.test(c)) return 'c#';
    return null;
  }

  // Process accepted submission
  async function processAccepted(){
    console.log('[lc-auto-commit] Accepted detected — extracting');
    let model = await waitForMonacoEditor();
    if (!model) console.log('[lc-auto-commit] Monaco editor not found after retries — trying in-page probe');
    if (!model) model = await probeMonacoViaPage(3000);
    if (!model) { console.log('[lc-auto-commit] Monaco still not found; aborting extraction'); log('Monaco editor not found'); return; }
    let code = model.getValue ? model.getValue() : (model.getText ? model.getText() : '');
    // If model yielded no code, try to extract visible code from DOM (Monaco renders lines in .view-line)
    async function extractCodeFromDOM(){
      try{
        // common Monaco render lines
        const viewLines = Array.from(document.querySelectorAll('.monaco-editor .view-line, .view-line'));
        if (viewLines && viewLines.length > 0){
          return viewLines.map(n => n.textContent || '').join('\n');
        }
        // fallback to any pre/code blocks
        const pre = document.querySelector('pre, code');
        if (pre && pre.textContent && pre.textContent.trim().length>0) return pre.textContent;
        // fallback to textarea (rare)
        const ta = document.querySelector('textarea');
        if (ta && ta.value && ta.value.trim().length>0) return ta.value;
      }catch(e){ /* ignore */ }
      return '';
    }
    if ((!code || !code.trim())){
      const domCode = await extractCodeFromDOM();
      if (domCode && domCode.trim()){
        console.log('[lc-auto-commit] extracted code from DOM fallback (length:', domCode.length, ')');
        code = domCode;
      } else {
        console.log('[lc-auto-commit] no code found in model or DOM');
      }
    }
    // prefer model language id, then code heuristics, then DOM-detected language, else 'text'
    const modelLang = detectLanguageFromModel(model);
    const domLang = detectLanguageFromDOM();
    const codeLang = detectLanguageFromCode(code);
    // prefer code-based detection when available (more reliable for choosing file extension)
    const language = modelLang || codeLang || domLang || 'text';
    console.log('[lc-auto-commit] language detection:', { modelLang, codeLang, domLang, final: language });
    console.log('[lc-auto-commit] code length:', code ? code.length : 0, 'snippet:', (code||'').slice(0,120).replace(/\n/g,' '));
    const { title, slug, difficulty } = extractProblemInfo();
    const payload = { title, slug, difficulty, language, code, url: location.href, ts: new Date().toISOString() };
    // send to background (do not log code contents)
    console.log('[lc-auto-commit] Sending payload to background', { title: payload.title, slug: payload.slug, language: payload.language });
    chrome.runtime.sendMessage({ type: 'commit_solution', payload }, (resp) => {
      if (resp && resp.error) console.log('[lc-auto-commit] Commit error', resp.error);
      else console.log('[lc-auto-commit] Commit response', resp && resp.ok);
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
            // process
            processAccepted();
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
