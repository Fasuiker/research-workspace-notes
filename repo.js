/* Static, single-owner Gitee private-repository adapter for the note editor. */
(() => {
  'use strict';
  const KEY = 'research-workbench-gitee-session';
  const INDEX = '.research-workbench/notes.json';
  const KINDS = new Set(['general','project','paper','idea','inbox']);
  const imageCache = new Map();
  let account = null;
  let repositoryVerified = false;
  let indexCache = null;
  try { account = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { account = null; }

  function failure(message, status = 400, current = null) {
    const error = new Error(message); error.status = status; error.data = { detail:message, current }; return error;
  }
  function parseRepo(value) {
    let url;
    try { url = new URL(value); } catch { throw failure('请输入完整的 Gitee 私有仓库地址'); }
    const parts = url.pathname.replace(/\/$/,'').split('/').filter(Boolean);
    if (parts.length===2 && parts[1].toLowerCase().endsWith('.git')) parts[1]=parts[1].slice(0,-4);
    if (url.protocol !== 'https:' || url.hostname !== 'gitee.com' || url.port || url.username || url.password ||
        url.search || url.hash || parts.length !== 2 || parts.some(x => !/^[\w.-]+$/.test(x))) {
      throw failure('仓库地址格式应为 https://gitee.com/用户名/私有仓库');
    }
    return { owner:parts[0], repo:parts[1] };
  }
  function credentials() {
    if (!account?.token) throw failure('请先连接 Gitee 私有仓库', 401);
    return account;
  }
  async function remote(method, path, payload = null, query = {}) {
    const {owner,repo,token} = credentials();
    const url = new URL(`https://gitee.com/api/v5/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`);
    url.searchParams.set('access_token', token);
    Object.entries(query).forEach(([key,value]) => url.searchParams.set(key,value));
    let response;
    try {
      response = await fetch(url, {method, referrerPolicy:'no-referrer', cache:'no-store',
        headers:{'Accept':'application/json',...(method==='GET'?{}:{'Content-Type':'application/json'})},
        body:method==='GET'?undefined:JSON.stringify({...payload,access_token:token})});
    } catch { throw failure('连接 Gitee 失败，请检查网络和浏览器跨域设置', 503); }
    if (!response.ok) throw failure(`Gitee HTTP ${response.status}；请检查私有仓库及令牌权限`, response.status);
    return response.json();
  }
  function decodeBase64(encoded) {
    const binary = atob(encoded.replace(/\s/g,''));
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }
  function encodeBase64(bytes) {
    let result='';
    for (let offset=0;offset<bytes.length;offset+=0x8000) result+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));
    return btoa(result);
  }
  async function getFile(path, optional = false) {
    try {
      const file=await remote('GET',`/contents/${path.split('/').map(encodeURIComponent).join('/')}`,null,{ref:account.branch});
      if (Array.isArray(file) && file.length===0) {
        if (optional) return null;
        throw failure('Gitee 文件不存在',404);
      }
      if (file.encoding !== 'base64' || !file.sha) throw failure('Gitee 文件格式异常');
      return {bytes:decodeBase64(file.content),sha:file.sha};
    } catch (error) { if (optional && error.status===404) return null; throw error; }
  }
  async function putFile(path, bytes, sha, message) {
    return remote(sha?'PUT':'POST',`/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
      {branch:account.branch,message,content:encodeBase64(bytes),...(sha?{sha}:{})});
  }
  function emptyIndex() { return {schema:1,seq:0,items:{},changes:[],contexts:{project:[],paper:[]},assets:{}}; }
  async function getIndex() {
    const file=await getFile(INDEX,true);
    if (!file) { const data=emptyIndex(); indexCache=data; return {data,sha:null}; }
    let data;
    try { data=JSON.parse(new TextDecoder().decode(file.bytes)); } catch { throw failure('私有仓库的札记索引不是有效 JSON'); }
    if (data.schema!==1 || !data.items || !Array.isArray(data.changes)) throw failure('私有仓库的札记索引格式不兼容');
    data.contexts ||= {project:[],paper:[]}; data.assets ||= {};
    indexCache=data;
    return {data,sha:file.sha};
  }
  async function putIndex(data, sha, message) {
    const bytes=new TextEncoder().encode(JSON.stringify(data));
    if (bytes.length>8*1024*1024) throw failure('札记索引超过 8 MB，已停止写入');
    await putFile(INDEX,bytes,sha,message);
    indexCache=data;
  }
  async function verify() {
    if (!repositoryVerified) {
      const repo=await remote('GET','');
      if (repo.private!==true) throw failure('只允许连接私有仓库，请先将 Gitee 仓库设为私有');
      if (!/^[\w.-]+$/.test(repo.default_branch||'')) throw failure('默认分支名称不受支持');
      account.branch=repo.default_branch;
      repositoryVerified=true;
    }
    const {data}=await getIndex();
    sessionStorage.setItem(KEY,JSON.stringify(account));
    return {ok:true,mode:'gitee',items:Object.values(data.items).filter(item=>!item.deleted)
      .sort((a,b)=>b.updated_at-a.updated_at),contexts:data.contexts};
  }
  function assetPath(id) {
    if (!/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(id)) throw failure('无效图片 ID');
    return `.research-workbench/assets/${id}.bin`;
  }
  async function uploadImage(file) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type) || !file.size || file.size>12*1024*1024)
      throw failure('仅支持小于 12 MB 的 PNG、JPEG、GIF、WebP 图片');
    const id=crypto.randomUUID(), path=assetPath(id);
    await putFile(path,new Uint8Array(await file.arrayBuffer()),null,'notes: add image');
    for(let attempt=0;attempt<3;attempt++) {
      const {data,sha}=await getIndex();
      data.assets[id]={path,media_type:file.type};
      try { await putIndex(data,sha,'notes: index image'); return {id,url:`/api/note-assets/${id}`}; }
      catch(error) { if (![400,409].includes(error.status) || attempt===2) throw error; }
    }
  }
  async function putItem(id,payload) {
    if (!KINDS.has(payload.kind) || !/^[a-f0-9-]{36}$/i.test(id) || (payload.body||'').length>2_000_000)
      throw failure('札记类型、ID 或长度无效');
    for(let attempt=0;attempt<3;attempt++) {
      const {data,sha}=await getIndex();
      const current=data.items[id]||null, revision=current?.revision||0;
      if (revision!==payload.base_revision) throw failure('这篇札记在别处已有更新',409,current);
      if (current && current.kind!==payload.kind) throw failure('不能更改札记类型');
      const item={id,kind:payload.kind,title:payload.title||'',body:payload.body||'',tags:payload.tags||'',
        meta:payload.meta||{},revision:revision+1,deleted:!!payload.deleted,updated_at:Date.now()/1000};
      data.items[id]=item; data.seq+=1; data.changes.push({seq:data.seq,id});
      try { await putIndex(data,sha,'notes: update item'); return item; }
      catch(error) { if (![400,409].includes(error.status) || attempt===2) throw error; }
    }
  }
  async function resolveImages(root) {
    const images=[...root.querySelectorAll('img[data-note-asset]')];
    if (!images.length) return;
    const data=indexCache || (await getIndex()).data;
    await Promise.all(images.map(async image=>{
      const id=image.dataset.noteAsset;
      const asset=data.assets[id];
      if (!asset) { image.alt='图片尚未同步'; return; }
      try {
        if (!imageCache.has(id)) {
          const file=await getFile(asset.path);
          imageCache.set(id,URL.createObjectURL(new Blob([file.bytes],{type:asset.media_type})));
        }
        image.src=imageCache.get(id);
      } catch { image.alt='图片加载失败'; }
    }));
  }
  async function api(path, options={}) {
    const method=options.method||'GET';
    if (path==='/auth/login') {
      if (location.protocol!=='https:' && !['127.0.0.1','localhost'].includes(location.hostname))
        throw failure('请通过 HTTPS 打开网页，避免访问令牌被窃取');
      const input=JSON.parse(options.body||'{}');
      const repo=parseRepo(input.repo);
      if (!input.token || /\s/.test(input.token)) throw failure('请输入 Gitee 私人访问令牌');
      account={...repo,token:input.token.trim()};
      repositoryVerified=false; indexCache=null;
      try { return await verify(); }
      catch(error) { account=null; repositoryVerified=false; indexCache=null; sessionStorage.removeItem(KEY); throw error; }
    }
    if (path==='/auth/logout') { account=null;repositoryVerified=false;indexCache=null;sessionStorage.removeItem(KEY);imageCache.forEach(URL.revokeObjectURL);imageCache.clear();return {ok:true}; }
    if (path==='/auth/me') return verify();
    if (path==='/snapshot') return verify();
    if (path==='/items') {
      const {data}=await getIndex();
      return Object.values(data.items).filter(item=>!item.deleted).sort((a,b)=>b.updated_at-a.updated_at);
    }
    if (path==='/contexts') return (await getIndex()).data.contexts;
    if (path==='/note-assets' && method==='POST') return uploadImage(options.body.get('file'));
    if (path.startsWith('/items/') && method==='PUT') return putItem(path.slice('/items/'.length),JSON.parse(options.body));
    throw failure('此模式不支持该操作');
  }
  window.gitNoteBackend={api,resolveImages};
})();
