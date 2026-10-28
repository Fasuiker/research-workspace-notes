const { marked, DOMPurify } = window;

const vendorBase = window.gitNoteBackend ? './vendor/' : '/static/vendor/';
const vendorLoads = new Map();
let mathReady = null;
let mermaidReady = null;
let previewVersion = 0;

function loadVendor(path, type = 'script') {
  const key = `${type}:${path}`;
  if (vendorLoads.has(key)) return vendorLoads.get(key);
  const promise = new Promise((resolve, reject) => {
    const node = document.createElement(type === 'style' ? 'link' : 'script');
    if (type === 'style') { node.rel = 'stylesheet'; node.href = vendorBase + path; }
    else node.src = vendorBase + path;
    node.onload = resolve;
    node.onerror = () => { node.remove(); reject(new Error(`无法加载 ${path}`)); };
    document.head.append(node);
  }).catch(error => { vendorLoads.delete(key); throw error; });
  vendorLoads.set(key, promise);
  return promise;
}

function ensureMath() {
  if (!mathReady) mathReady = Promise.all([
    loadVendor('katex/katex.min.css', 'style'), loadVendor('katex/katex.min.js')
  ]).then(() => loadVendor('katex/contrib/auto-render.min.js'))
    .catch(error => { mathReady = null; throw error; });
  return mathReady;
}

function ensureMermaid() {
  if (!mermaidReady) mermaidReady = loadVendor('mermaid.min.js').then(() => {
    window.mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'neutral'});
    return window.mermaid;
  }).catch(error => { mermaidReady = null; throw error; });
  return mermaidReady;
}

let csrf = '';
let items = [];
let contexts = { project: [], paper: [] };
let selected = null;
let draft = null;
let tab = 'all';
let search = '';
let viewMode = 'preview';
let focusMode = false;
let saveTimer = null;
let previewTimer = null;
let dirty = false;
let savePromise = null;
const app = document.getElementById('app');
const labels = { all:'全部', general:'普通笔记', project:'项目笔记', paper:'文献笔记', idea:'想法', inbox:'Inbox' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function api(path, options = {}) {
  if (window.gitNoteBackend) return window.gitNoteBackend.api(path, options);
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const res = await fetch(`/api${path}`, { credentials:'same-origin', ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(typeof data.detail === 'string' ? data.detail : `HTTP ${res.status}`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

function toast(message, danger = false) {
  let node = document.getElementById('toast');
  if (!node) { node = document.createElement('div'); node.id = 'toast'; document.body.append(node); }
  node.textContent = message;
  node.className = danger ? 'toast danger' : 'toast';
  node.hidden = false;
  clearTimeout(node._timer);
  node._timer = setTimeout(() => { node.hidden = true; }, 4200);
}

function loginView() {
  if (window.gitNoteBackend) {
    app.innerHTML = `<main class="login-page"><form class="login-card" id="login-form">
      <div class="brand-mark">札</div><p class="eyebrow">RESEARCH WORKSPACE</p>
      <h1>连接私有仓库</h1><p>札记保存在你的 Gitee 私有仓库中，不需要自购云服务器。</p>
      <label for="repo-url">私有仓库地址</label><input id="repo-url" type="url" required placeholder="https://gitee.com/用户名/私有仓库" autocomplete="url">
      <label for="repo-token">Gitee 私人访问令牌</label><input id="repo-token" type="password" required autocomplete="off">
      <p class="repo-security-hint">仅存于当前浏览器标签会话。请使用专门的私有仓库；不要在公用电脑输入令牌。</p>
      <button class="primary" type="submit">打开札记 <span aria-hidden="true">→</span></button>
      <small id="login-error" role="alert"></small></form></main>`;
    document.getElementById('login-form').onsubmit = async event => {
      event.preventDefault();
      try {
        const snapshot = await api('/auth/login',{method:'POST',body:JSON.stringify({repo:document.getElementById('repo-url').value,
          token:document.getElementById('repo-token').value})});
        await load(snapshot);
      } catch(error) { document.getElementById('login-error').textContent=error.message; }
    };
    return;
  }
  app.innerHTML = `<main class="login-page"><form class="login-card" id="login-form">
    <div class="brand-mark">札</div><p class="eyebrow">RESEARCH WORKSPACE</p>
    <h1>在线札记</h1><p>把想法随手记下，回到工作台继续整理。</p>
    <label for="password">登录密码</label><input id="password" type="password" required autocomplete="current-password" autofocus>
    <button class="primary" type="submit">进入札记 <span aria-hidden="true">→</span></button>
    <small id="login-error" role="alert"></small></form></main>`;
  document.getElementById('login-form').onsubmit = async event => {
    event.preventDefault();
    try {
      const result = await api('/auth/login', { method:'POST', body:JSON.stringify({password:document.getElementById('password').value}) });
      csrf = result.csrf;
      await load();
    } catch (error) { document.getElementById('login-error').textContent = error.message; }
  };
}

function prettyDate(value) {
  return value ? new Date(value * 1000).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
}

function headline(item) {
  return item.title || (item.body || '').replace(/^#+\s*/, '').split('\n')[0].slice(0, 40) || '未命名';
}

function contextTitle(item) {
  const meta = item.meta || {};
  if (item.kind === 'project') return contexts.project.find(x => x.local_id === meta.project_id)?.title || '项目';
  if (item.kind === 'paper') return contexts.paper.find(x => x.local_id === meta.paper_id)?.title || '文献';
  if (meta.project_id) return contexts.project.find(x => x.local_id === meta.project_id)?.title || '';
  return '';
}

function listHtml() {
  const query = search.trim().toLowerCase();
  const filtered = items.filter(x => (tab === 'all' || x.kind === tab) &&
    (!query || `${x.title} ${x.body} ${x.tags} ${contextTitle(x)}`.toLowerCase().includes(query)));
  return filtered.length ? filtered.map(item => `<button class="note-card ${item.id === selected ? 'active' : ''}" data-id="${item.id}">
    <span class="note-card-type">${labels[item.kind]}</span><span class="note-card-date">${prettyDate(item.updated_at)}</span>
    <strong>${escapeHtml(headline(item))}</strong>
    <span class="note-card-excerpt">${escapeHtml((item.body || '').replace(/[#*`\[\]]/g,'').slice(0, 90))}</span>
    ${contextTitle(item) ? `<span class="context-chip">${escapeHtml(contextTitle(item))}</span>` : ''}
  </button>`).join('') : '<div class="empty-list">这里还没有内容</div>';
}

function renderShell() {
  app.innerHTML = `<div class="shell">
    <header class="topbar"><div class="brand"><div class="brand-mark">札</div><div><strong>在线札记</strong><small>Research Workspace</small></div></div>
      <div class="top-actions"><span id="save-state" class="save-state">已同步</span><button class="icon-btn" id="refresh-btn" title="刷新">↻</button>${window.gitNoteBackend?'':'<button class="icon-btn" id="devices-btn" title="设备连接">⌘</button>'}<button class="icon-btn" id="logout-btn" title="退出">⇥</button></div></header>
    <div class="workspace ${focusMode?'focus-editor':''}"><aside class="sidebar"><div class="sidebar-head"><h2>我的札记</h2><button class="primary small" id="new-btn">＋ 新建</button></div>
      <div class="search-wrap"><input id="search" type="search" placeholder="搜索笔记、想法…" value="${escapeHtml(search)}"></div>
      <nav class="tabs">${Object.entries(labels).map(([key,label]) => `<button class="tab ${key === tab ? 'active' : ''}" data-tab="${key}">${label}</button>`).join('')}</nav>
      <div class="note-list" id="note-list">${listHtml()}</div></aside>
      <main class="editor" id="editor"></main></div></div>`;
  app.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => { tab = button.dataset.tab; renderTabsAndList(); });
  document.getElementById('search').oninput = event => { search = event.target.value; renderList(); };
  document.getElementById('new-btn').onclick = newMenu;
  document.getElementById('refresh-btn').onclick = async () => { if (dirty) await save(); await load(); toast('已刷新'); };
  if (document.getElementById('devices-btn')) document.getElementById('devices-btn').onclick = deviceDialog;
  document.getElementById('logout-btn').onclick = async () => { await api('/auth/logout',{method:'POST'}); csrf=''; selected=null; draft=null; loginView(); };
  renderList();
  renderEditor();
}

function renderTabsAndList() {
  app.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  renderList();
}

function renderList() {
  const list = document.getElementById('note-list');
  if (!list) return;
  const scroll = list.scrollTop;
  list.innerHTML = listHtml();
  list.scrollTop = scroll;
  list.querySelectorAll('[data-id]').forEach(button => button.onclick = async () => {
    if (dirty && !(await save())) return;
    selected = button.dataset.id;
    draft = structuredClone(items.find(x => x.id === selected));
    viewMode = 'preview';
    dirty = false;
    renderList(); renderEditor();
    document.querySelector('.sidebar')?.classList.add('mobile-hidden');
  });
}

function normalizeImplicitInlineMath(source) {
  const protectedSegment = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$(?!\s)[^\n$]*?\S\$)/g;
  return String(source || '').split(protectedSegment).map((part, index) => {
    if (index % 2) return part;
    let result = '';
    for (let i = 0; i < part.length; i += 1) {
      if (part[i] !== '(' || part[i - 1] === ']' || part[i - 1] === '\\') {
        result += part[i];
        continue;
      }
      let depth = 1;
      let end = i + 1;
      for (; end < part.length && depth && part[end] !== '\n'; end += 1) {
        if (part[end] === '(') depth += 1;
        else if (part[end] === ')') depth -= 1;
      }
      const expression = depth ? '' : part.slice(i + 1, end - 1);
      if (/(?:\\[A-Za-z]+|[_^]\s*(?:\{[^}]+\}|\d))/.test(expression)) {
        result += `\\(${part.slice(i, end)}\\)`;
        i = end - 1;
      } else result += part[i];
    }
    return result;
  }).join('');
}

function markdownFragment(content) {
  const normalized = normalizeImplicitInlineMath(String(content || '').replace(/(^|\n)[ \t]*\[[ \t]*\n([\s\S]*?)\n[ \t]*\][ \t]*(?=\n|$)/g,
    (whole, prefix, body) => /\\[A-Za-z]+|[_^]\s*(?:\{|[A-Za-z0-9])/.test(body) ? `${prefix}$$\n${body.trim()}\n$$` : whole));
  // Keep TeX intact until after Markdown parsing: e.g. '*' inside $$...$$ is not emphasis.
  const formulas = [];
  const marker = `ZXQMATH${Math.random().toString(36).slice(2).toUpperCase()}X`;
  const protectedText = normalized.replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$[^\n$]+\$/g,
    formula => `${marker}${formulas.push(formula) - 1}Z`);
  const fragment = document.createElement('div');
  fragment.innerHTML = DOMPurify.sanitize(marked.parse(protectedText, { gfm:true, breaks:false }),
    { USE_PROFILES:{ html:true } });
  if (formulas.length) {
    const token = new RegExp(`${marker}(\\d+)Z`, 'g');
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) if (walker.currentNode.textContent.includes(marker)) nodes.push(walker.currentNode);
    nodes.forEach(node => {
      const value = node.textContent;
      const replacement = document.createDocumentFragment();
      let start = 0;
      for (const match of value.matchAll(token)) {
        replacement.append(document.createTextNode(value.slice(start, match.index)));
        replacement.append(document.createTextNode(formulas[Number(match[1])]));
        start = match.index + match[0].length;
      }
      replacement.append(document.createTextNode(value.slice(start)));
      node.replaceWith(replacement);
    });
  }
  return fragment;
}

function imageMatches(text) {
  return [...String(text || '').matchAll(/!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)|<img\b[^>]*>/gi)];
}

function setImageMarkup(index, width, align) {
  const match = imageMatches(draft.body)[index];
  if (!match || match.index == null) return false;
  const raw = match[0];
  let next;
  if (/^<img\b/i.test(raw)) {
    next = raw.replace(/\swidth\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '')
      .replace(/\sdata-align\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '');
    next = next.replace(/\/?>(\s*)$/, '');
    next += `${width ? ` width="${width}%"` : ''}${align ? ` data-align="${align}"` : ''}>`;
  } else {
    const alt = (match[1] || '').replace(/\\([\[\]])/g,'$1');
    const url = match[2] || match[3] || '';
    const title = match[4] || match[5] || '';
    next = `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"${title?` title="${escapeHtml(title)}"`:''}${width?` width="${width}%"`:''}${align?` data-align="${align}"`:''}>`;
  }
  draft.body = draft.body.slice(0, match.index) + next + draft.body.slice(match.index + raw.length);
  document.getElementById('markdown-source').value = draft.body;
  setDirty();
  return true;
}

function openImageTools(image, index) {
  const preview = document.getElementById('markdown-preview');
  if (!preview || !imageMatches(draft.body)[index]) return;
  preview.querySelector('.image-tools')?.remove();
  const rawWidth = image.getAttribute('width') || '';
  let width = rawWidth.endsWith('%') ? Math.max(20, Math.min(100, parseInt(rawWidth,10)||100)) : null;
  let align = ['left','center','right'].includes(image.dataset.align) ? image.dataset.align : 'center';
  const tools = document.createElement('div'); tools.className='image-tools';
  tools.innerHTML=`<span>图片宽度</span><input type="range" min="20" max="100" step="5" value="${width||100}" aria-label="图片宽度百分比"><output>${width||100}%</output>
    <div class="image-preset">${[30,50,75,100].map(x=>`<button data-width="${x}">${x}%</button>`).join('')}<button data-width="auto">原始</button></div>
    <span>对齐</span><div class="image-preset">${[['left','左'],['center','居中'],['right','右']].map(([value,label])=>`<button data-align="${value}">${label}</button>`).join('')}</div>`;
  (image.closest('p,figure') || image).before(tools);
  const range = tools.querySelector('input[type="range"]');
  const output = tools.querySelector('output');
  range.oninput = () => { image.style.width=`${range.value}%`; image.style.height='auto'; output.textContent=`${range.value}%`; };
  async function persist() {
    if (setImageMarkup(index,width,align)) {
      await refreshPreview();
      const next=document.querySelectorAll('#markdown-preview img')[index];
      if(next) openImageTools(next,index);
    }
  }
  range.onchange = () => { width=Number(range.value); persist(); };
  tools.querySelectorAll('[data-width]').forEach(button => button.onclick=()=>{width=button.dataset.width==='auto'?null:Number(button.dataset.width);persist();});
  tools.querySelectorAll('[data-align]').forEach(button => button.onclick=()=>{align=button.dataset.align;persist();});
}

async function refreshPreview() {
  const preview = document.getElementById('markdown-preview');
  if (!preview || !draft) return;
  const version = ++previewVersion;
  if (viewMode === 'source') return;
  if (window.gitNoteBackend) {
    const staging=document.createElement('div');
    staging.replaceChildren(...markdownFragment(draft.body).childNodes);
    staging.querySelectorAll('img[src^="/api/note-assets/"]').forEach(image=>{
      image.dataset.noteAsset=image.getAttribute('src').split('/').pop();
      image.src='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
    });
    preview.replaceChildren(...staging.childNodes);
  } else preview.replaceChildren(...markdownFragment(draft.body).childNodes);
  if (window.gitNoteBackend) window.gitNoteBackend.resolveImages(preview).catch(error=>console.warn('Note image:',error));
  preview.querySelectorAll('img').forEach((image,index)=>{
    image.tabIndex=0; image.setAttribute('role','button'); image.title='点击调整大小与对齐';
    image.onclick=()=>openImageTools(image,index);
    image.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openImageTools(image,index);}};
  });
  const diagrams = Array.from(preview.querySelectorAll('pre code.language-mermaid'));
  const current = () => version === previewVersion && document.getElementById('markdown-preview') === preview;
  const jobs = [];
  if (/\$|\\\[|\\\(/.test(preview.textContent)) jobs.push(ensureMath().then(() => {
    if (current()) window.renderMathInElement(preview, { delimiters:[
      {left:'$$',right:'$$',display:true}, {left:'\\[',right:'\\]',display:true},
      {left:'$',right:'$',display:false}, {left:'\\(',right:'\\)',display:false}
    ], throwOnError:false });
  }).catch(error => console.warn('Math rendering:', error)));
  if (diagrams.length) jobs.push(ensureMermaid().then(async mermaid => {
    if (!current()) return;
    diagrams.forEach(code => { const div=document.createElement('div'); div.className='mermaid'; div.textContent=code.textContent; code.parentElement.replaceWith(div); });
    await mermaid.run({ nodes:preview.querySelectorAll('.mermaid') });
  }).catch(error => console.warn('Mermaid diagram:', error)));
  await Promise.all(jobs);
}

function metaControls(item) {
  const meta = item.meta || {};
  if (item.kind === 'general' || item.kind === 'project' || item.kind === 'inbox') {
    const id = meta.project_id || '';
    return `<label class="field compact">关联项目<select id="project-context"><option value="">不关联</option>${contexts.project.map(p => `<option value="${p.local_id}" ${String(id) === String(p.local_id) ? 'selected':''}>${escapeHtml(p.title)}</option>`).join('')}</select></label>${item.kind === 'inbox' ? `<label class="field compact">处理状态<select id="inbox-processed"><option value="0" ${!meta.processed?'selected':''}>待整理</option><option value="1" ${meta.processed?'selected':''}>已处理</option></select></label>` : ''}`;
  }
  if (item.kind === 'paper') return `<span class="context-chip">${escapeHtml(contextTitle(item))}</span>`;
  if (item.kind === 'idea') return `<label class="field compact">状态<select id="idea-status">${['open','landed','discarded'].map((x,i)=>`<option value="${x}" ${meta.status===x?'selected':''}>${['进行中','已落地','已放下'][i]}</option>`).join('')}</select></label>`;
  return '';
}

function renderEditor() {
  const editor = document.getElementById('editor');
  if (!editor) return;
  if (!draft) {
    editor.innerHTML = `<div class="welcome"><div class="welcome-icon">✦</div><h2>让每个想法都有去处</h2><p>选一篇札记继续写，或新建笔记、想法与 Inbox。</p><button class="primary" id="welcome-new">新建札记</button></div>`;
    document.getElementById('welcome-new').onclick = newMenu;
    return;
  }
  const editableTitle = !['paper','inbox'].includes(draft.kind);
  editor.innerHTML = `<div class="editor-bar"><button class="mobile-back" id="back-btn">← 列表</button><div class="crumb">${labels[draft.kind]}${contextTitle(draft) ? ` · ${escapeHtml(contextTitle(draft))}` : ''}</div>
    <div class="editor-actions"><button class="ghost" id="focus-btn" aria-pressed="${focusMode}" title="隐藏列表，专注编辑">${focusMode?'退出全屏':'全屏'}</button><button class="ghost" id="print-btn">导出 PDF</button><button class="ghost danger-text" id="delete-btn">删除</button><button class="primary small" id="save-btn">保存</button></div></div>
    <div class="document"><input id="title" class="title-input" placeholder="标题" value="${escapeHtml(draft.title)}" ${editableTitle?'':'readonly'}>
      <div class="metadata">${metaControls(draft)}${!['paper','inbox','project'].includes(draft.kind) ? `<label class="field compact">标签<input id="tags" value="${escapeHtml(draft.tags)}" placeholder="用逗号分隔"></label>` : ''}</div>
      <div class="modebar"><div class="segment">${['source','split','preview'].map((mode,i)=>`<button data-mode="${mode}" class="${viewMode===mode?'active':''}">${['源码','分栏','预览'][i]}</button>`).join('')}</div>
        <div class="image-entry"><span>可拖入或粘贴图片</span><label class="upload-button">插入图片<input type="file" id="image-file" accept="image/png,image/jpeg,image/gif,image/webp" hidden></label></div></div>
      <div class="markdown-layout ${viewMode}"><textarea id="markdown-source" spellcheck="false" placeholder="用 Markdown 记录你的想法…"></textarea><article class="markdown-preview" id="markdown-preview"></article></div>
      <div class="document-foot">Markdown · Ctrl+S 保存 · 可粘贴图片</div></div>`;
  const source = document.getElementById('markdown-source');
  source.value = draft.body || '';
  source.oninput = () => { draft.body=source.value; setDirty(); clearTimeout(previewTimer); previewTimer=setTimeout(refreshPreview,220); };
  const layout = document.querySelector('.markdown-layout');
  layout.onpaste = async event => {
    const file = Array.from(event.clipboardData?.files || []).find(x => x.type.startsWith('image/'));
    if (file) { event.preventDefault(); await uploadImage(file); }
  };
  layout.ondragover = event => {
    if (Array.from(event.dataTransfer?.items || []).some(item => item.kind === 'file')) {
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; layout.classList.add('drag-over');
    }
  };
  layout.ondragleave = event => { if (!layout.contains(event.relatedTarget)) layout.classList.remove('drag-over'); };
  layout.ondrop = async event => {
    layout.classList.remove('drag-over');
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;
    event.preventDefault();
    const file = files.find(x => x.type.startsWith('image/'));
    if (file) await uploadImage(file);
    else toast('请拖入 PNG、JPEG、GIF 或 WebP 图片',true);
  };
  document.getElementById('title').oninput = event => { draft.title=event.target.value; setDirty(); };
  document.getElementById('tags')?.addEventListener('input', event => { draft.tags=event.target.value; setDirty(); });
  document.getElementById('project-context')?.addEventListener('change', event => { draft.meta.project_id = event.target.value ? Number(event.target.value) : null; setDirty(); });
  document.getElementById('idea-status')?.addEventListener('change', event => { draft.meta.status=event.target.value; setDirty(); });
  document.getElementById('inbox-processed')?.addEventListener('change', event => { draft.meta.processed=event.target.value==='1'; setDirty(); });
  document.querySelectorAll('[data-mode]').forEach(button => button.onclick = () => { viewMode=button.dataset.mode; document.querySelector('.markdown-layout').className=`markdown-layout ${viewMode}`; document.querySelectorAll('[data-mode]').forEach(x=>x.classList.toggle('active',x===button)); clearTimeout(previewTimer); refreshPreview(); });
  document.getElementById('save-btn').onclick = save;
  document.getElementById('focus-btn').onclick = () => { focusMode=!focusMode; document.querySelector('.workspace')?.classList.toggle('focus-editor',focusMode); renderEditor(); };
  document.getElementById('delete-btn').onclick = remove;
  document.getElementById('print-btn').onclick = async () => { viewMode='preview'; document.querySelector('.markdown-layout').className='markdown-layout preview'; await refreshPreview(); if(window.gitNoteBackend) await window.gitNoteBackend.resolveImages(document.getElementById('markdown-preview')); window.print(); };
  document.getElementById('image-file').onchange = async event => { if (event.target.files[0]) await uploadImage(event.target.files[0]); event.target.value=''; };
  document.getElementById('back-btn').onclick = () => { focusMode=false; document.querySelector('.workspace')?.classList.remove('focus-editor'); document.querySelector('.sidebar')?.classList.remove('mobile-hidden'); };
  refreshPreview();
}

function setDirty() {
  dirty = true;
  const indicator = document.getElementById('save-state');
  if (indicator) indicator.textContent = '未保存';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1800);
}

async function save() {
  if (savePromise) return savePromise;
  savePromise = performSave();
  try { return await savePromise; }
  finally { savePromise = null; }
}

async function performSave() {
  clearTimeout(saveTimer);
  if (!draft || !dirty) return true;
  try {
    const payload = {kind:draft.kind,title:draft.title,body:draft.body,tags:draft.tags,meta:draft.meta,
      base_revision:draft.revision,deleted:false};
    const savingId = draft.id;
    const submitted = JSON.stringify(payload);
    const updated = await api(`/items/${savingId}`, {method:'PUT',body:JSON.stringify(payload)});
    const sameDraft = draft?.id === savingId;
    const latest = sameDraft && JSON.stringify({kind:draft.kind,title:draft.title,body:draft.body,tags:draft.tags,meta:draft.meta,
      base_revision:draft.revision,deleted:false});
    const changedDuringSave = sameDraft && latest !== submitted;
    if (changedDuringSave) {
      draft.revision = updated.revision;
      dirty = true;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 300);
    } else if (sameDraft) { draft = updated; dirty = false; }
    if (sameDraft) selected = updated.id;
    const idx = items.findIndex(x=>x.id===updated.id);
    if (idx >= 0) items[idx]=updated; else items.unshift(updated);
    items.sort((a,b)=>b.updated_at-a.updated_at);
    document.getElementById('save-state').textContent = changedDuringSave || !sameDraft ? '正在保存…' : '已同步';
    renderList(); return true;
  } catch (error) {
    if (error.status === 409) {
      clearTimeout(saveTimer);
      document.getElementById('save-state').textContent='有冲突';
      showConflict(error.data.current);
    } else { toast(`保存失败：${error.message}`, true); document.getElementById('save-state').textContent='保存失败'; }
    return false;
  }
}

function showConflict(remote) {
  const dialog = document.createElement('div');
  dialog.className='modal-scrim';
  dialog.innerHTML=`<div class="modal-card"><h2>这篇札记在别处有更新</h2><p>为了避免覆盖，你可以重新载入云端版本，或将当前内容另存为一篇新札记。</p>
    <div class="modal-actions"><button id="keep-local">另存为新札记</button><button id="use-cloud" class="primary">载入云端版本</button></div></div>`;
  document.body.append(dialog);
  dialog.querySelector('#keep-local').onclick = () => { draft={...draft,id:crypto.randomUUID(),revision:0}; selected=draft.id; dialog.remove(); setDirty(); save(); };
  dialog.querySelector('#use-cloud').onclick = () => { draft=remote; selected=remote.id; dirty=false; dialog.remove(); renderEditor(); toast('已载入云端版本'); };
}

async function remove() {
  if (!draft || !confirm('确定删除这篇札记？本地工作台同步后也会删除。')) return;
  clearTimeout(saveTimer);
  try {
    await api(`/items/${draft.id}`, {method:'PUT',body:JSON.stringify({kind:draft.kind,title:draft.title,body:draft.body,tags:draft.tags,meta:draft.meta,base_revision:draft.revision,deleted:true})});
    items=items.filter(x=>x.id!==draft.id); draft=null; selected=null; dirty=false; renderList(); renderEditor(); toast('已删除');
  } catch(error) { toast(`删除失败：${error.message}`,true); }
}

function newMenu() {
  const dialog=document.createElement('div'); dialog.className='modal-scrim';
  dialog.innerHTML=`<div class="modal-card"><div class="modal-head"><h2>新建札记</h2><button id="close-new" class="icon-btn">×</button></div><div class="create-grid">
    ${['general','idea','inbox','project','paper'].map(kind=>`<button class="create-option" data-create="${kind}"><strong>${labels[kind]}</strong><small>${({general:'自由记录与整理',idea:'捕捉灵感与问题',inbox:'先收进来，稍后整理',project:'记录项目推进',paper:'记录文献阅读'})[kind]}</small></button>`).join('')}
    </div><div id="new-context"></div></div>`;
  document.body.append(dialog);
  dialog.onclick=event=>{if(event.target===dialog) dialog.remove();};
  dialog.querySelector('#close-new').onclick=()=>dialog.remove();
  dialog.querySelectorAll('[data-create]').forEach(button=>button.onclick=()=>{
    const kind=button.dataset.create;
    if (kind==='project'||kind==='paper') {
      const rows=contexts[kind];
      dialog.querySelector('#new-context').innerHTML=`<p>选择关联${kind==='paper'?'文献':'项目'}</p><input id="context-filter" type="search" placeholder="输入标题筛选"><select id="create-context"><option value="">请选择</option>${rows.slice(0,100).map(x=>`<option value="${x.local_id}">${escapeHtml(x.title)}</option>`).join('')}</select><button class="primary" id="confirm-create">创建</button>`;
      dialog.querySelector('#context-filter').oninput=event=>{
        const query=event.target.value.trim().toLowerCase();
        const found=rows.filter(x=>x.title.toLowerCase().includes(query)).slice(0,100);
        dialog.querySelector('#create-context').innerHTML=`<option value="">${found.length?'请选择':'没有匹配的标题'}</option>${found.map(x=>`<option value="${x.local_id}">${escapeHtml(x.title)}</option>`).join('')}`;
      };
      dialog.querySelector('#confirm-create').onclick=()=>{const id=Number(dialog.querySelector('#create-context').value);if(!id)return toast('请先选择关联对象',true);create(kind,id);dialog.remove();};
    } else { create(kind); dialog.remove(); }
  });
}

function create(kind, contextId) {
  const meta = kind==='project' ? {project_id:contextId} : kind==='paper' ? {paper_id:contextId} :
    kind==='idea' ? {category:'inspiration',status:'open',linked_paper_ids:'',linked_project_ids:'',linked_submission_ids:''} :
    kind==='inbox' ? {item_type:'note',processed:false,project_id:null} : {project_id:null};
  if (kind==='paper' && items.some(x=>x.kind==='paper' && x.meta.paper_id===contextId)) return toast('这篇文献已有笔记',true);
  draft={id:crypto.randomUUID(),kind,title:kind==='paper'?(contexts.paper.find(x=>x.local_id===contextId)?.title||'文献笔记'):'',body:'',tags:'',meta,revision:0,updated_at:Date.now()/1000};
  viewMode = 'source';
  selected=draft.id; dirty=true; renderList(); renderEditor(); document.getElementById('save-state').textContent='未保存';
  document.querySelector('.sidebar')?.classList.add('mobile-hidden');
}

async function uploadImage(file) {
  try {
    const form=new FormData(); form.append('file',file);
    const asset=await api('/note-assets',{method:'POST',body:form});
    const source=document.getElementById('markdown-source');
    const start=viewMode==='preview' ? source.value.length : source.selectionStart;
    const end=viewMode==='preview' ? start : source.selectionEnd;
    const markdown=`![${file.name.replace(/[\[\]]/g,'')}](${asset.url})`;
    const before=source.value.slice(0,start), after=source.value.slice(end);
    const insertion=`${before && !before.endsWith('\n\n') ? before.endsWith('\n') ? '\n' : '\n\n' : ''}${markdown}${after && !after.startsWith('\n\n') ? after.startsWith('\n') ? '\n' : '\n\n' : ''}`;
    source.value=before+insertion+after;
    if (viewMode!=='preview') source.focus();
    source.selectionStart=source.selectionEnd=start+insertion.length;
    draft.body=source.value; setDirty(); refreshPreview();
  } catch(error) { toast(`图片上传失败：${error.message}`,true); }
}

async function deviceDialog() {
  const dialog=document.createElement('div'); dialog.className='modal-scrim';
  dialog.innerHTML=`<div class="modal-card"><div class="modal-head"><h2>连接本地科研工作台</h2><button id="close-devices" class="icon-btn">×</button></div>
    <p>生成设备令牌，复制到本地工作台「设置 → 在线札记」。令牌只显示一次。</p><div id="device-list">读取中…</div>
    <div class="modal-actions"><input id="device-name" placeholder="设备名称" value="我的科研工作台"><button class="primary" id="create-device">生成令牌</button></div>
    <div id="new-token" class="token-box" hidden></div></div>`;
  document.body.append(dialog);
  dialog.onclick=event=>{if(event.target===dialog) dialog.remove();};
  dialog.querySelector('#close-devices').onclick=()=>dialog.remove();
  async function refresh() {
    const rows=await api('/devices');
    dialog.querySelector('#device-list').innerHTML=rows.filter(x=>!x.revoked_at).map(x=>`<div class="device-row"><span>${escapeHtml(x.name)}</span><button data-revoke="${x.id}" class="ghost danger-text">撤销</button></div>`).join('')||'<p>尚无连接设备</p>';
    dialog.querySelectorAll('[data-revoke]').forEach(button=>button.onclick=async()=>{if(confirm('撤销后本地工作台将无法继续同步，确定吗？')){await api(`/devices/${button.dataset.revoke}`,{method:'DELETE'});refresh();}});
  }
  dialog.querySelector('#create-device').onclick=async()=>{
    const result=await api('/devices',{method:'POST',body:JSON.stringify({name:dialog.querySelector('#device-name').value||'科研工作台'})});
    const box=dialog.querySelector('#new-token');box.hidden=false;box.innerHTML=`<p>请立即复制并妥善保存：</p><code>${escapeHtml(result.token)}</code><button id="copy-token" class="primary small">复制</button>`;
    box.querySelector('#copy-token').onclick=async()=>{await navigator.clipboard.writeText(result.token);toast('令牌已复制');};
    refresh();
  };
  refresh().catch(error=>toast(error.message,true));
}

async function load(snapshot = null) {
  let me, list, availableContexts;
  if (window.gitNoteBackend) {
    const data = snapshot || await api('/snapshot');
    me = data; list = data.items; availableContexts = data.contexts;
  } else [me, list, availableContexts]=await Promise.all([api('/auth/me'),api('/items'),api('/contexts')]);
  csrf=me.csrf||csrf; items=list; contexts=availableContexts;
  if (selected) draft=structuredClone(items.find(x=>x.id===selected)||null);
  dirty=false; renderShell();
}

async function pollRepository() {
  if (!window.gitNoteBackend || dirty || savePromise || !document.querySelector('.shell')) return;
  try {
    const {items:fresh, contexts:newContexts}=await api('/snapshot');
    const current=fresh.find(x=>x.id===selected);
    const changed=!!draft && (!current || current.revision!==draft.revision);
    items=fresh;contexts=newContexts;
    if (changed) { draft=current?structuredClone(current):null;renderEditor();toast('札记已从其他设备更新'); }
    renderList();
  } catch(error) { console.warn('Repository refresh:',error.message); }
}

document.addEventListener('keydown', event=>{
  if ((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s') { event.preventDefault(); save(); }
});
window.addEventListener('beforeunload', event=>{ if(dirty){event.preventDefault();event.returnValue='';} });
marked.setOptions({ gfm:true, breaks:false });
if (window.gitNoteBackend) load().catch(()=>loginView());
else api('/auth/me').then(result=>{csrf=result.csrf||'';return load();}).catch(()=>loginView());
if (window.gitNoteBackend) {
  setInterval(pollRepository,60_000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)pollRepository();});
}
