/**
 * PWA 客户端的静态资产（内嵌为字符串常量）。
 *
 * ## 为什么内嵌而不是读文件
 *
 * 打包成 asar 之后，非 TS 的散装静态文件既不会被 electron-vite 自动搬进 dist，
 * 路径解析在 asar 里也另有一套坑。把应用壳内嵌成字符串，服务时零 fs 读——既
 * 免了打包搬运，也让 `main/remote` 顶层目录一条 readFile 都不出现（drift 权限
 * 对账因此不因服务静态壳而多出 workspace.read）。本文件在 `pwa-assets/` 子目录，
 * capabilitySource 只扫顶层，本目录不参与权限对账；但为诚实起见这里本就无任何
 * 敏感调用。
 *
 * ## 客户端安全约定（与服务端呼应）
 *
 *   - **token 存 localStorage，绝不进 SW 缓存**：sw.js 只 cache-first 应用壳
 *     （html/js/css/manifest），/api、/pair、/events 一律 network-only，Cache API
 *     里永远不会出现任何一次带 token 的响应。
 *   - **鉴权走 Authorization: Bearer**（HTTP）与 Sec-WebSocket-Protocol 副协议
 *     （WS），不用 cookie——因此不存在可被 CSRF 利用的环境凭据。
 *   - 渲染一律 textContent / createElement，不拼 innerHTML：远端消息即便含
 *     `<script>` 也只会作为文本显示。
 */

export const MANIFEST_JSON = JSON.stringify({
  name: "PiBuddy Remote",
  short_name: "PiBuddy",
  start_url: "/",
  display: "standalone",
  background_color: "#f7f7f8",
  theme_color: "#3b5bdb",
  icons: [],
});

export const STYLE_CSS = [
  ":root{--bg:#f7f7f8;--fg:#1a1a1a;--muted:#6b7280;--accent:#3b5bdb;--card:#fff;--danger:#c92a2a;--ok:#2b8a3e}",
  "*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}",
  "header{padding:12px 16px;background:var(--card);border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:8px;position:sticky;top:0}",
  "header h1{font-size:16px;margin:0;flex:1}",
  ".dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}.dot.on{background:var(--ok)}.dot.off{background:var(--danger)}",
  "main{padding:12px 16px;max-width:720px;margin:0 auto}",
  ".card{background:var(--card);border:1px solid #e5e7eb;border-radius:10px;padding:12px;margin-bottom:12px}",
  ".sess{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #f0f0f0}",
  ".sess:last-child{border-bottom:none}.sess .id{flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".badge{font-size:11px;padding:2px 6px;border-radius:6px;background:#eef;color:var(--accent)}",
  "button{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid #d1d5db;background:#fff;cursor:pointer}",
  "button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}button.danger{color:var(--danger);border-color:var(--danger)}",
  "button:disabled{opacity:.5;cursor:not-allowed}",
  "textarea,input{width:100%;font:inherit;padding:8px;border:1px solid #d1d5db;border-radius:8px;margin:4px 0}",
  ".row{display:flex;gap:8px;align-items:center}.muted{color:var(--muted);font-size:12px}",
  ".inbox{border-left:3px solid var(--danger);padding-left:8px;margin:8px 0}",
  ".msg{padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:13px;white-space:pre-wrap;word-break:break-word}",
  ".msg .who{font-weight:600;color:var(--accent);font-size:11px}",
].join("\n");

/** 主应用壳。 */
export const INDEX_HTML = [
  "<!doctype html><html lang='zh'><head><meta charset='utf-8'>",
  "<meta name='viewport' content='width=device-width,initial-scale=1,viewport-fit=cover'>",
  "<title>PiBuddy Remote</title>",
  "<link rel='manifest' href='/manifest.webmanifest'>",
  "<link rel='stylesheet' href='/style.css'>",
  "</head><body>",
  "<header><span id='conn' class='dot off'></span><h1>PiBuddy Remote</h1>",
  "<button id='unpair' class='danger' style='display:none'>解绑</button></header>",
  "<main id='app'></main>",
  "<script src='/app.js'></script>",
  "</body></html>",
].join("");

/** 配对落地页（设备扫码 / 打开配对 URL 后到这）。 */
export const PAIR_HTML = [
  "<!doctype html><html lang='zh'><head><meta charset='utf-8'>",
  "<meta name='viewport' content='width=device-width,initial-scale=1'>",
  "<title>配对 · PiBuddy Remote</title><link rel='stylesheet' href='/style.css'></head><body>",
  "<header><h1>配对到 PiBuddy</h1></header>",
  "<main><div class='card'>",
  "<p class='muted'>为这台设备起个名字，然后完成配对。配对码为一次性、短时有效。</p>",
  "<input id='name' placeholder='设备名（如：我的手机）'>",
  "<input id='code' placeholder='配对码'>",
  "<div class='row'><button id='go' class='primary'>配对</button></div>",
  "<p id='msg' class='muted'></p>",
  "</div></main>",
  "<script src='/pair.js'></script></body></html>",
].join("");

/** service worker：只缓存应用壳，绝不缓存 API / 配对 / 事件流（不含任何 secret）。 */
export const SW_JS = [
  "const SHELL='pibuddy-remote-shell-v1';",
  "const ASSETS=['/','/index.html','/app.js','/pair.html','/pair.js','/style.css','/manifest.webmanifest'];",
  "self.addEventListener('install',e=>{e.waitUntil(caches.open(SHELL).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()))});",
  "self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==SHELL).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});",
  "self.addEventListener('fetch',e=>{",
  " const u=new URL(e.request.url);",
  // network-only：任何数据 / 鉴权路径都不进缓存（防 token 落 Cache API）
  " if(u.pathname.startsWith('/api')||u.pathname==='/pair'||u.pathname==='/upload'||u.pathname.startsWith('/files')||u.pathname==='/events'){return;}",
  " if(e.request.method!=='GET'){return;}",
  // 应用壳：cache-first，回退网络
  " e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));",
  "});",
].join("\n");

/** 配对页脚本（无 backtick / 无 ${}）。 */
export const PAIR_JS = [
  "(function(){",
  "var params=new URLSearchParams(location.search);",
  "var code=params.get('c')||'';",
  "document.getElementById('code').value=code;",
  "var msg=document.getElementById('msg');",
  "document.getElementById('go').addEventListener('click',function(){",
  " var name=document.getElementById('name').value||'未命名设备';",
  " var c=document.getElementById('code').value.trim();",
  " if(!c){msg.textContent='请填写配对码';return;}",
  " msg.textContent='配对中...';",
  " fetch('/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:c,name:name})})",
  "  .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})",
  "  .then(function(o){",
  "    if(!o.ok){msg.textContent='配对失败：'+(o.j.error||'未知');return;}",
  "    localStorage.setItem('pibuddy.remote.token',o.j.token);",
  "    localStorage.setItem('pibuddy.remote.deviceId',o.j.deviceId);",
  "    localStorage.setItem('pibuddy.remote.scopes',JSON.stringify(o.j.scopes||[]));",
  "    location.href='/';",
  "  })",
  "  .catch(function(){msg.textContent='网络错误';});",
  "});",
  "})();",
].join("\n");

/** 主应用脚本（无 backtick / 无 ${}，渲染一律 textContent/createElement）。 */
export const APP_JS = [
  "(function(){",
  "var token=localStorage.getItem('pibuddy.remote.token');",
  "var scopes=[];try{scopes=JSON.parse(localStorage.getItem('pibuddy.remote.scopes')||'[]');}catch(e){}",
  "var app=document.getElementById('app');",
  "var connDot=document.getElementById('conn');",
  "var unpairBtn=document.getElementById('unpair');",
  "function has(s){return scopes.indexOf(s)>=0;}",
  "function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e;}",
  "if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(function(){});}",
  "if(!token){",
  "  var c=el('div','card');c.appendChild(el('p',null,'本设备尚未配对。'));",
  "  c.appendChild(el('p','muted','请在主机上生成配对码，然后打开配对链接（或到 /pair.html 手动输入配对码）。'));",
  "  var b=el('button','primary','去配对');b.addEventListener('click',function(){location.href='/pair.html';});c.appendChild(b);",
  "  app.appendChild(c);return;",
  "}",
  "unpairBtn.style.display='';",
  "unpairBtn.addEventListener('click',function(){localStorage.clear();location.reload();});",
  "var lastInbox=0;",
  "function authHeaders(extra){var h=extra||{};h['authorization']='Bearer '+token;return h;}",
  // 发 prompt
  "var targetSession=null;",
  "function sendPrompt(text){return fetch('/api/prompt',{method:'POST',headers:authHeaders({'content-type':'application/json'}),body:JSON.stringify({sessionId:targetSession,text:text})}).then(function(r){return r.json();});}",
  "function stopSession(id){return fetch('/api/stop',{method:'POST',headers:authHeaders({'content-type':'application/json'}),body:JSON.stringify({sessionId:id})});}",
  "function decide(id,allow){return fetch('/api/permission/decide',{method:'POST',headers:authHeaders({'content-type':'application/json'}),body:JSON.stringify({inboxId:id,allow:allow})});}",
  // 渲染快照
  "function render(snap){",
  "  if(!targetSession&&snap.sessions&&snap.sessions.length)targetSession=snap.sessions[0].sessionId;",
  "  app.innerHTML='';",
  "  var composer=el('div','card');",
  "  composer.appendChild(el('div','muted','发送目标会话：'+(targetSession||'（点下方会话选择）')));",
  "  var ta=el('textarea');ta.placeholder='发送 prompt 到选中会话...';ta.rows=2;composer.appendChild(ta);",
  "  var row=el('div','row');",
  "  var sendBtn=el('button','primary','发送');sendBtn.disabled=!has('prompt.send')||!targetSession;",
  "  sendBtn.addEventListener('click',function(){var t=ta.value.trim();if(!t)return;sendBtn.disabled=true;sendPrompt(t).then(function(){ta.value='';sendBtn.disabled=false;}).catch(function(){sendBtn.disabled=false;});});",
  "  row.appendChild(sendBtn);",
  "  if(!has('prompt.send')){row.appendChild(el('span','muted','（无发送权限）'));}",
  "  composer.appendChild(row);app.appendChild(composer);",
  // permission inbox
  "  if(snap.inbox&&snap.inbox.length){",
  "    var ic=el('div','card');ic.appendChild(el('div','who','待批准权限 ('+snap.inbox.length+')'));",
  "    snap.inbox.forEach(function(it){",
  "      var box=el('div','inbox');",
  "      box.appendChild(el('div',null,it.capabilityId+' · '+it.permission+(it.resource?(' · '+it.resource):'')));",
  "      box.appendChild(el('div','muted','会话 '+it.sessionId));",
  "      if(has('permission.approve')){",
  "        var r2=el('div','row');",
  "        var okb=el('button','primary','允许');okb.addEventListener('click',function(){decide(it.id,true);});",
  "        var nob=el('button','danger','拒绝');nob.addEventListener('click',function(){decide(it.id,false);});",
  "        r2.appendChild(okb);r2.appendChild(nob);box.appendChild(r2);",
  "      }else{box.appendChild(el('div','muted','（只读：无审批权限）'));}",
  "      ic.appendChild(box);",
  "    });",
  "    app.appendChild(ic);",
  "    if(snap.inbox.length>lastInbox){notify('有新的权限请求待批准');}",
  "  }",
  "  lastInbox=snap.inbox?snap.inbox.length:0;",
  // sessions
  "  var sc=el('div','card');sc.appendChild(el('div','who','会话 ('+(snap.sessions?snap.sessions.length:0)+')'));",
  "  (snap.sessions||[]).forEach(function(s){",
  "    var d=el('div','sess');",
  "    var idw=el('div','id',s.sessionId);idw.style.cursor='pointer';idw.title='点击选为发送目标';idw.addEventListener('click',function(){targetSession=s.sessionId;render(snap);});d.appendChild(idw);",
  "    if(s.sessionId===targetSession)d.appendChild(el('span','badge','目标'));",
  "    d.appendChild(el('span','badge',s.runState||''));",
  "    if(s.unread)d.appendChild(el('span','badge','未读'));",
  "    if(has('session.stop')){var sb=el('button','danger','停止');sb.addEventListener('click',function(){stopSession(s.sessionId);});d.appendChild(sb);}",
  "    if(has('sessions.read')){var hb=el('button',null,'历史');hb.addEventListener('click',function(){loadHistory(s);});d.appendChild(hb);}",
  "    sc.appendChild(d);",
  "  });",
  "  app.appendChild(sc);",
  "}",
  "function loadHistory(s){",
  "  fetch('/api/sessions/'+encodeURIComponent(s.sessionId)+'/history?ws='+encodeURIComponent(s.workspaceId||'')+'&limit=30',{headers:authHeaders()})",
  "   .then(function(r){return r.json();}).then(function(p){",
  "     var c=el('div','card');c.appendChild(el('div','who','历史 · '+s.sessionId));",
  "     (p.entries||[]).forEach(function(e){var m=el('div','msg');m.textContent=JSON.stringify(e).slice(0,2000);c.appendChild(m);});",
  "     app.insertBefore(c,app.firstChild);",
  "   });",
  "}",
  "function notify(text){if(!has('notify'))return;if(!('Notification' in window))return;if(Notification.permission==='granted'){new Notification('PiBuddy',{body:text});}else if(Notification.permission!=='denied'){Notification.requestPermission();}}",
  // WS 连接（token 走副协议，不进 URL）
  "function connect(){",
  "  var proto=location.protocol==='https:'?'wss:':'ws:';",
  "  var ws;try{ws=new WebSocket(proto+'//'+location.host+'/ws',['pibuddy.remote',token]);}catch(e){pollFallback();return;}",
  "  ws.onopen=function(){connDot.className='dot on';};",
  "  ws.onclose=function(){connDot.className='dot off';setTimeout(connect,3000);};",
  "  ws.onerror=function(){try{ws.close();}catch(e){}};",
  "  ws.onmessage=function(ev){try{var m=JSON.parse(ev.data);if(m.type==='pool'&&m.snapshot)render(m.snapshot);}catch(e){}};",
  "}",
  // 无 WS 时退回轮询 /api/pool
  "function pollFallback(){fetch('/api/pool',{headers:authHeaders()}).then(function(r){if(r.status===401){localStorage.clear();location.reload();return null;}return r.json();}).then(function(s){if(s)render(s);setTimeout(pollFallback,4000);}).catch(function(){setTimeout(pollFallback,5000);});}",
  // 先拉一次，再连 WS
  "fetch('/api/pool',{headers:authHeaders()}).then(function(r){if(r.status===401){localStorage.clear();location.reload();return null;}return r.json();}).then(function(s){if(s){render(s);connect();}}).catch(function(){pollFallback();});",
  "})();",
].join("\n");
