// TASK-004 UI-observable 回归探针：通过 CDP 驱动真实 Electron 进程做断言。
// 一次性验证脚本，不属于产品代码。
const PAGE_PORT = 9333;
const MAIN_PORT = 9334;

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  };
  return {
    send(method, params = {}) {
      const mid = ++id;
      return new Promise((res, rej) => {
        pending.set(mid, { res, rej });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

async function evalIn(cdp, expr) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

const targets = await (await fetch(`http://127.0.0.1:${PAGE_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
const mainTargets = await (await fetch(`http://127.0.0.1:${MAIN_PORT}/json/list`)).json();

const pageCdp = await connect(page.webSocketDebuggerUrl);
const mainCdp = null;

const results = {};
const ok = async (k, p) => {
  try {
    results[k] = await p;
  } catch (e) {
    results[k] = "ERROR: " + String(e.message).slice(0, 200);
  }
};

// ---- 0) 基线：sandbox 与 CSP meta 是否真的生效 ----
await ok(
  "sandbox_renderer_no_node",
  await evalIn(pageCdp, "typeof require === 'undefined' && typeof process === 'undefined'")
);
await ok(
  "csp_meta_present",
  await evalIn(
    pageCdp,
    "!!document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')"
  )
);
// 内联脚本注入必须被 script-src 'self' 拦掉
await ok(
  "csp_blocks_inline_script",
  await evalIn(
    pageCdp,
    `(() => { try { const s=document.createElement('script'); s.textContent='window.__pwn=1'; document.head.appendChild(s); s.remove(); } catch(e){} return window.__pwn === undefined; })()`
  )
);
// data: / blob: 图片必须仍可加载
await ok(
  "img_data_url_loads",
  await evalIn(
    pageCdp,
    `new Promise(r=>{const i=new Image();i.onload=()=>r(i.naturalWidth>0);i.onerror=()=>r(false);i.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';})`
  )
);
await ok(
  "img_blob_url_loads",
  await evalIn(
    pageCdp,
    `(async()=>{const bin=atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');const arr=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);const b=new Blob([arr],{type:'image/png'});const u=URL.createObjectURL(b);return await new Promise(r=>{const i=new Image();i.onload=()=>r(i.naturalWidth>0);i.onerror=()=>r(false);i.src=u;});})()`
  )
);

// ---- 1) 错误计数基线 ----
await evalIn(
  pageCdp,
  `(()=>{ if(!window.__errCount){ window.__errCount=0; const oe=console.error; console.error=(...a)=>{window.__errCount++;oe(...a);}; window.addEventListener('error',()=>window.__errCount++); } return true; })()`
);
const errBefore = await evalIn(pageCdp, "window.__errCount");

// ---- 2) 从主进程注入合成 agent 事件，驱动真实 Vue 渲染 ----
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const text = [
  "普通外链 [example](https://example.com/)",
  "危险外链 [calc](file:///C:/Windows/System32/calc.exe)",
  "脚本外链 [x](javascript:alert(1))",
  "",
  "```js",
  "const a = 1;",
  "```",
].join("\n");

const events = [
  {
    type: "message_end",
    message: {
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image", mimeType: "image/png", data: PNG },
      ],
    },
  },
  {
    type: "tool_execution_end",
    toolCallId: "t1",
    toolName: "bash",
    isError: false,
    result: { content: [{ type: "text", text: "工具输出内容\n" + "z".repeat(200) }] },
  },
  {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "我在思考这个问题的解法。" },
        { type: "text", text },
        { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls -la" } },
      ],
    },
  },
];

await ok(
  "inject_events",
  evalIn(
    pageCdp,
    `(()=>{const s=document.getElementById('app').__vue_app__.config.globalProperties.$pinia._s.get('app');
      const ev=${JSON.stringify(JSON.stringify(events))};const parsed=JSON.parse(ev);
      s.toolRuns['t1']={toolCallId:'t1',toolName:'bash',args:{command:'ls -la'},status:'done',output:parsed[1].result.content[0].text,images:[]};
      s.items.push({key:9001,message:parsed[0].message});
      s.items.push({key:9002,message:parsed[2].message});
      return s.items.length;})()`
  )
);
await new Promise((r) => setTimeout(r, 1200));

// ---- 3) DOM 断言 ----
await ok(
  "user_image_rendered",
  await evalIn(
    pageCdp,
    `(()=>{const i=document.querySelector('.msg-user-bubble img');return !!i && i.naturalWidth>0;})()`
  )
);
await ok(
  "hljs_rendered",
  await evalIn(pageCdp, "document.querySelectorAll('.markdown .hljs').length")
);
await ok(
  "anchor_hrefs",
  await evalIn(
    pageCdp,
    `Array.from(document.querySelectorAll('.markdown a')).map(a=>a.getAttribute('href'))`
  )
);
await ok(
  "no_dangerous_href",
  await evalIn(
    pageCdp,
    `Array.from(document.querySelectorAll('.markdown a')).every(a=>{const h=a.getAttribute('href')||'';return !h.includes('javascript:') && !h.includes('file:');})`
  )
);

// thinking 折叠
await ok(
  "thinking_expand_height",
  await evalIn(
    pageCdp,
    `(async()=>{const t=document.querySelector('.thinking-toggle');if(!t)return -1;t.click();await new Promise(r=>setTimeout(r,300));const c=document.querySelector('.thinking-content');return c?c.getBoundingClientRect().height:0;})()`
  )
);
// tool 卡片折叠
await ok(
  "tool_expand_height",
  await evalIn(
    pageCdp,
    `(async()=>{const t=document.querySelector('.tool-chip');if(!t)return -1;t.click();await new Promise(r=>setTimeout(r,300));const c=document.querySelector('.tool-expand');return c?c.getBoundingClientRect().height:0;})()`
  )
);

// ---- 4) 点击危险外链：不得开窗、不得报错 ----
const pageCount = async () =>
  (await (await fetch(`http://127.0.0.1:${PAGE_PORT}/json/list`)).json()).filter(
    (t) => t.type === "page"
  ).length;
const winBefore = await pageCount();
await evalIn(
  pageCdp,
  `(async()=>{for(const a of document.querySelectorAll('.markdown a')){if(!a.getAttribute('href')) a.click();}await new Promise(r=>setTimeout(r,500));return true;})()`
);
const winAfter = await pageCount();
const errAfter = await evalIn(pageCdp, "window.__errCount");
await ok("dangerous_click_window_delta", Promise.resolve(winAfter - winBefore));
await ok("dangerous_click_error_delta", Promise.resolve(errAfter - errBefore));

// ---- 5) 麦克风权限：不得被 permission handler 拒绝 ----
await ok(
  "getUserMedia_audio",
  await evalIn(
    pageCdp,
    `navigator.mediaDevices.getUserMedia({audio:true}).then(s=>{s.getTracks().forEach(t=>t.stop());return 'granted';}).catch(e=>e.name)`
  )
);
await ok(
  "getUserMedia_video_denied",
  await evalIn(
    pageCdp,
    `navigator.mediaDevices.getUserMedia({video:true}).then(()=>'GRANTED_UNEXPECTED').catch(e=>e.name)`
  )
);
await ok(
  "geolocation_denied",
  await evalIn(
    pageCdp,
    `new Promise(r=>navigator.geolocation.getCurrentPosition(()=>r('GRANTED_UNEXPECTED'),e=>r('code'+e.code),{timeout:4000}))`
  )
);

// ---- 6) 拖拽取路径 API 在 sandbox 下是否仍存在 ----
await ok(
  "webUtils_pathFor_available",
  await evalIn(pageCdp, "typeof window.piBuddy?.file?.pathFor")
);
await ok(
  "webUtils_pathFor_works",
  await evalIn(
    pageCdp,
    `(()=>{try{const f=new File(['x'],'a.png',{type:'image/png'});const p=window.piBuddy.file.pathFor(f);return JSON.stringify({type:typeof p,value:p});}catch(e){return 'THREW: '+e.message;}})()`
  )
);

// ---- 7) 真实拖拽落盘文件：图片走 FileReader，非图片走 webUtils.getPathForFile ----
const DROP_DIR = "D:/selftool/pi-ui/.workflow/scratch/20260802-plan-P0-pibuddy-m0-m5";
await ok(
  "drop_files",
  (async () => {
    const dragData = {
      items: [],
      files: [DROP_DIR + "/probe-drop.png", DROP_DIR + "/probe-drop.txt"],
      dragOperationsMask: 1,
    };
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await pageCdp.send("Input.dispatchDragEvent", { type, x: 400, y: 700, data: dragData });
    }
    await new Promise((r) => setTimeout(r, 800));
    return await evalIn(
      pageCdp,
      `(()=>{const chips=Array.from(document.querySelectorAll('.attach-chip')).map(c=>c.textContent.trim());const img=document.querySelector('.attach-chip img');return JSON.stringify({chips,imgLoaded: img? img.naturalWidth>0 : null});})()`
    );
  })()
);

console.log(JSON.stringify(results, null, 2));
pageCdp.close();

process.exit(0);
