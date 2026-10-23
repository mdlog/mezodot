// Pieces injected into the recorded pages: the app's zoom and a visible cursor (the recording has no OS cursor), the
// intro's lower third, the terminal shown in the proof beat, and the closing card. All are designed at 1920x1080 and
// live outside <body> so the app's zoom does not scale them.

import { readFileSync } from 'node:fs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Init script for app pages: 125% zoom for legible text, and a cursor that follows the mouse. */
export const APP_INIT = `(() => {
  const style = document.createElement('style');
  style.textContent = 'body { zoom: 1.25 } ::-webkit-scrollbar { display: none }';
  const cursor = document.createElement('div');
  cursor.id = '__cursor';
  cursor.innerHTML = '<svg width="34" height="34" viewBox="0 0 24 24"><path d="M4 2.5 L4 19 L8.6 14.9 L11.6 21.4 L14.4 20.1 L11.4 13.7 L17.6 13.7 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  cursor.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(-4px,-2px);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35));';
  const mount = () => {
    document.head.appendChild(style);
    document.documentElement.appendChild(cursor);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  addEventListener('mousemove', (e) => { cursor.style.left = e.clientX + 'px'; cursor.style.top = e.clientY + 'px'; }, true);
})();`;

/** Lower third for the opening shot; fades out by itself. */
export const lowerThird = ({ title, sub }) => `(() => {
  const el = document.createElement('div');
  el.innerHTML = '<div style="font:700 44px Inter Display, Inter, sans-serif;letter-spacing:-0.5px">${esc(title)}</div>' +
    '<div style="margin-top:8px;font:500 26px Inter, sans-serif;color:#C9F27C">${esc(sub)}</div>';
  el.style.cssText = 'position:fixed;right:252px;bottom:228px;z-index:2147483646;color:#fff;padding:26px 34px;border-radius:18px;' +
    'background:rgba(12,13,29,.82);border:1px solid rgba(201,242,124,.35);box-shadow:0 12px 40px rgba(0,0,0,.45);' +
    'opacity:0;animation:lt 5.2s ease forwards';
  const kf = document.createElement('style');
  kf.textContent = '@keyframes lt{0%{opacity:0;transform:translateY(16px)}8%{opacity:1;transform:none}86%{opacity:1}100%{opacity:0}}';
  document.documentElement.append(kf, el);
})();`;

/** The proof beat's terminal: verbatim commands and output from take.json, revealed group by group, then the
 *  Sourcify page captured off camera. */
export function terminalPage(take, shotPath) {
  const shot = `data:image/png;base64,${readFileSync(shotPath).toString('base64')}`;
  const groups = take.terminal
    .map(
      (g, i) =>
        `<div class="g" id="g${i + 1}"><div class="cmd"><span class="p">mezodot $</span> <span class="t" data-text="${esc(g.cmd)}"></span></div>` +
        `<div class="out">${g.out.map((l) => `<div class="${/exact_match|passed, 0 failed/.test(l) ? 'ok' : ''}">${esc(l)}</div>`).join('')}</div></div>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:1920px;height:1080px;background:#0b0c18;overflow:hidden}
    .win{position:absolute;inset:56px 120px;border-radius:18px;background:#11131f;border:1px solid #2a2d45;box-shadow:0 30px 80px rgba(0,0,0,.5)}
    .bar{height:52px;border-bottom:1px solid #23263b;display:flex;align-items:center;gap:10px;padding:0 22px;font:500 20px Inter,sans-serif;color:#8a8fb3}
    .bar i{width:14px;height:14px;border-radius:50%;background:#3a3e5c;display:inline-block}
    .bar span{margin-left:14px}
    .body{padding:22px 34px;font:24px/1.5 'DejaVu Sans Mono',monospace;color:#d6d9ef}
    .g{display:none;margin-bottom:14px}.g.on{display:block}
    .p{color:#8b7cf6}.cmd{color:#fff}.out{color:#b7bbd8;white-space:pre}.ok{color:#C9F27C}
    /* 1% opaque from the start so Chrome has already rasterised the capture when it fades in (no blank frame). */
    #shot{position:fixed;inset:0;opacity:.01;transition:opacity .4s ease;background:#f3f4f6}
    #shot img{width:100%;height:100%;object-fit:contain;display:block}
    #shot.on{opacity:1}
  </style></head><body>
    <div class="win"><div class="bar"><i></i><i></i><i></i><span>mdlog/mezodot · live checks against Mezo testnet</span></div><div class="body">${groups}</div></div>
    <div id="shot"><img src="${shot}" alt=""></div>
    <script>
      window.reveal = async (n) => {
        const g = document.getElementById('g' + n); g.classList.add('on');
        const t = g.querySelector('.t'); const out = g.querySelector('.out'); out.style.visibility = 'hidden';
        for (const ch of t.dataset.text) { t.textContent += ch; await new Promise((r) => setTimeout(r, 22)); }
        out.style.visibility = 'visible';
      };
      window.showShot = () => document.getElementById('shot').classList.add('on');
    </script></body></html>`;
}

/** Closing card in the landing page's palette: the app's three-bar mark, the name, and where to find it. */
export const outroPage = () => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1920px;height:1080px;overflow:hidden;color:#fff;font-family:Inter,sans-serif;
    background:radial-gradient(1100px 700px at 75% 40%,#2a2470 0%,rgba(42,36,112,0) 60%),#0c0d1d}
  .wrap{position:absolute;left:220px;top:250px;animation:in .9s cubic-bezier(.2,.8,.2,1) both}
  @keyframes in{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}
  .lock{display:flex;align-items:center;gap:30px}
  .mark{width:136px;height:136px;border-radius:40px;background:#4338CA;position:relative;display:flex;align-items:center;justify-content:center;gap:9px;
    box-shadow:0 18px 50px rgba(67,56,202,.55)}
  .mark span{display:block;width:16px;border-radius:16px;background:#f6f4ef;transform:skew(-15deg)}
  .mark span:nth-child(1){height:44px}.mark span:nth-child(2){height:72px}.mark span:nth-child(3){height:48px}
  .mark i{position:absolute;right:20px;top:20px;width:20px;height:20px;border-radius:50%;background:#cef080}
  .name{font:800 112px 'Inter Display',Inter,sans-serif;letter-spacing:-4px}
  .tag{margin-top:56px;font:600 58px 'Inter Display',Inter,sans-serif;letter-spacing:-1.5px}
  .tag b{color:#C9F27C;font-weight:600}
  .sub{margin-top:26px;font:400 30px Inter,sans-serif;color:#b9bce0}
  .row{margin-top:64px;display:flex;gap:18px;font:500 26px 'DejaVu Sans Mono',monospace}
  .pill{padding:14px 24px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.05)}
  .pill.lime{border-color:rgba(201,242,124,.5);color:#C9F27C}
</style></head><body><div class="wrap">
  <div class="lock"><div class="mark"><span></span><span></span><span></span><i></i></div><div class="name">mezodot</div></div>
  <div class="tag">Productive MUSD and MEZO, <b>across chains.</b></div>
  <div class="sub">Live on Mezo testnet · spokes on Base Sepolia and Ethereum Sepolia · Wormhole · Pyth · Supra · Tigris</div>
  <div class="row"><div class="pill lime">github.com/mdlog/mezodot</div><div class="pill">Mezo Buildathon · Track 1 · DeFi</div></div>
</div></body></html>`;
