document.addEventListener('DOMContentLoaded', ()=>{
  const owner = document.getElementById('owner');
  const repo = document.getElementById('repo');
  const token = document.getElementById('token');
  const branch = document.getElementById('branch');
  const saveBtn = document.getElementById('save');
  const testBtn = document.getElementById('test');
  const form = document.getElementById('popupForm');
  const status = document.getElementById('status');
  const toggle = document.getElementById('toggleToken');

  function setStatus(msg, isError){ status.textContent = msg || ''; status.style.color = isError ? '#b00020' : '#0a6'; }

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
    if (!cfg.owner || !cfg.repo) return setStatus('Owner and repo required', true);
    console.log('[lc-auto-commit-popup] saving config', { owner: cfg.owner, repo: cfg.repo, branch: cfg.branch });
    chrome.storage.sync.set({ github: cfg }, ()=>{
      setStatus('Saved');
      setTimeout(()=> setStatus(''), 2000);
    });
  });

  testBtn.addEventListener('click', async ()=>{
    setStatus('Testing token...');
    const tok = token.value.trim();
    if (!tok) return setStatus('Enter token', true);
    try{
      const r = await fetch('https://api.github.com/user', { headers: { Authorization: `token ${tok}`, Accept: 'application/vnd.github+json' } });
      if (!r.ok) return setStatus('Token invalid: ' + r.status, true);
      const u = await r.json();
      setStatus('Token OK — ' + (u.login||u.name||'unknown'));
    }catch(err){ setStatus('Network error', true); }
  });

  toggle.addEventListener('click', ()=>{
    if (token.type === 'password'){ token.type = 'text'; toggle.textContent = 'Hide'; }
    else { token.type = 'password'; toggle.textContent = 'Show'; }
  });
});
