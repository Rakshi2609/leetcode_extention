document.addEventListener('DOMContentLoaded', ()=>{
  const owner = document.getElementById('owner');
  const repo = document.getElementById('repo');
  const token = document.getElementById('token');
  const branch = document.getElementById('branch');
  const status = document.getElementById('status');
  const saveBtn = document.getElementById('save');
  const testBtn = document.getElementById('test');
  const form = document.getElementById('settings');

  function setStatus(msg, isError){
    status.textContent = msg || '';
    status.style.color = isError ? '#b00020' : '#0a6';
  }

  chrome.storage.sync.get(['github'], (items)=>{
    const cfg = items.github || {};
    owner.value = cfg.owner || '';
    repo.value = cfg.repo || '';
    token.value = cfg.token || '';
    branch.value = cfg.branch || 'main';
  });

  form.addEventListener('submit', (e)=>{
    e.preventDefault();
    const cfg = { owner: owner.value.trim(), repo: repo.value.trim(), token: token.value.trim(), branch: branch.value.trim() || 'main' };
    if (!cfg.owner || !cfg.repo) return setStatus('Owner and repo are required', true);
    // Save config (do not log the token)
    console.log('[lc-auto-commit-options] saving config', { owner: cfg.owner, repo: cfg.repo, branch: cfg.branch });
    chrome.storage.sync.set({ github: cfg }, ()=>{
      setStatus('Saved');
      setTimeout(()=> setStatus(''), 2500);
    });
  });

  testBtn.addEventListener('click', async ()=>{
    setStatus('Testing token...');
    const tok = token.value.trim();
    if (!tok) return setStatus('Please enter a token to test', true);
    try{
      console.log('[lc-auto-commit-options] testing token');
      const r = await fetch('https://api.github.com/user', { headers: { Authorization: `token ${tok}`, Accept: 'application/vnd.github+json' } });
      if (!r.ok) {
        console.log('[lc-auto-commit-options] token test failed', r.status);
        return setStatus('Invalid token or network error: ' + r.status, true);
      }
      const user = await r.json();
      console.log('[lc-auto-commit-options] token OK for user', user.login || user.name || 'unknown');
      setStatus('Token OK — user: ' + (user.login||user.name||'unknown'));
    }catch(err){
      console.log('[lc-auto-commit-options] token test error', String(err));
      setStatus('Network or CORS error: ' + String(err), true);
    }
  });
  // token visibility toggle
  const toggle = document.getElementById('toggleToken');
  toggle.addEventListener('click', ()=>{
    if (token.type === 'password'){
      token.type = 'text';
      toggle.textContent = 'Hide';
    } else {
      token.type = 'password';
      toggle.textContent = 'Show';
    }
  });
});
