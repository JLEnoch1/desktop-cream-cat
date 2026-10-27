/* 精力桌宠 CreamCat · AI 毛发定制工坊 — 下载页前端逻辑（零依赖原生 JS，defer 加载）。
 *
 * 流程：上传照片/视频 →（视频自动抽帧挑参考帧）→ 选输出内容（动作序列帧七姿态 / Live2D 式
 * 部件拆层稿×12；画风固定像素游戏风）→ 按 idle 定稿 → 其余姿态 → 部件
 * 串行链式生成（非 idle 目标附带定稿形象图做参考，锁「统一画风、同一只猫」）→ 卡片实时预览 →
 * 浏览器端打包 skin.json v2 + 姿态帧 + parts/ 部件层为 zip → 附安装指引（解压进 skins 目录
 * 即被 app 热重载；parts/ 为素材稿，app 不直接消费）。
 *
 * 依赖后端 /api/cat-skin/*（scripts/cat-skin-api.mjs，随 npm run site:dev 启动）；
 * 纯静态托管 / file:// 打开时 status 探测失败 → 展示「服务未接入」禁用态，不影响页面其余部分。
 */
(() => {
  'use strict';

  /* ─────────────── 常量 ─────────────── */

  const POSES = ['idle', 'walk1', 'walk2', 'sleep', 'drag', 'pet', 'tap'];
  const PART_IDS = ['face', 'body', 'tail', 'paw-l', 'paw-r', 'mouth', 'eye-l', 'eye-r', 'brow-up', 'brow-low', 'fur-overlay', 'eye-light'];
  const LABELS = {
    idle: '发呆', walk1: '散步 A', walk2: '散步 B', sleep: '打盹',
    drag: '被拎起', pet: '被摸头', tap: '敲键盘',
    face: '脸/头轮廓', body: '身体', tail: '尾巴', 'paw-l': '前爪左', 'paw-r': '前爪右',
    mouth: '嘴巴', 'eye-l': '左眼', 'eye-r': '右眼', 'brow-up': '眉毛上', 'brow-low': '眉毛下',
    'fur-overlay': '毛发遮挡层', 'eye-light': '眼睛高光/阴影层',
  };
  const STYLE_LABEL = { pixel: '像素游戏风' };
  const MAX_REFS = 3;          // DashScope 图像编辑单次最多 3 图
  const IMG_MAX_BYTES = 12e6;  // 原图上限（缩放后远低于 API 10MB 限制）
  const VIDEO_MAX_BYTES = 100e6;
  const VIDEO_FRAME_N = 8;     // 抽帧候选数
  const REF_SIDE = 1280;       // 参考图最长边
  const API = {
    status: '/api/cat-skin/status',
    generate: '/api/cat-skin/generate',
    check: '/api/cat-skin/check',
    config: '/api/cat-skin/config',
  };
  const LS_CFG = 'creamcat.studio.cfg'; // 「记住在本浏览器」的 localStorage 键

  const state = {
    enabled: false,
    mock: false,
    model: '',
    refs: [],            // [{dataURL, label, fromVideo?}]
    videoFrames: null,   // [{dataURL, t}] 抽帧候选
    videoSel: new Set(), // 选中的候选下标
    style: 'pixel',      // 画风固定像素游戏风（2026-10-27 裁决，唯一画风）
    wantPoses: true,     // 输出：动作序列帧七姿态
    wantParts: true,     // 输出：部件拆层稿 ×12
    results: {},         // target → {image(dataURL), ms}
    curTargets: [],      // 本轮生成的目标列表
    busy: false,
    aborted: false,
    abortCtl: null,
  };

  const $ = (s) => document.querySelector(s);
  const el = {
    off: $('#stu-off'), offTxt: $('#stu-off-txt'),
    panel: $('#stu-panel'),
    drop: $('#stu-drop'), file: $('#stu-file'),
    refs: $('#stu-refs'), refsCount: $('#stu-refs-count'),
    vframes: $('#stu-vframes'), vframesTip: $('#stu-vframes-tip'),
    optPoses: $('#stu-opt-poses'), optParts: $('#stu-opt-parts'),
    name: $('#stu-name'), go: $('#stu-go'), cancel: $('#stu-cancel'),
    progress: $('#stu-progress'), barFill: $('#stu-bar-fill'), progressTxt: $('#stu-progress-txt'),
    grid: $('#stu-grid'),
    step2: $('#stu-step2'), step3: $('#stu-step3'),
    folderName: $('#stu-folder-name'), zipName: $('#stu-zip-name'),
    zip: $('#stu-zip'), again: $('#stu-again'),
    keyPanel: $('#stu-key'), keyInput: $('#stu-key-input'), keyRemember: $('#stu-key-remember'),
    keyTest: $('#stu-key-test'), keySave: $('#stu-key-save'), keyMsg: $('#stu-key-msg'),
    keyModel: $('#stu-key-model'), keyBase: $('#stu-key-base'),
    keyNote: $('#stu-keynote'), keyClear: $('#stu-key-clear'),
  };

  /* ─────────────── 目标清单 ─────────────── */

  /** 当前选择下的生成目标：idle 定稿永远在前（部件与姿态的风格锚点） */
  function currentTargets() {
    const t = [];
    if (state.wantPoses) t.push(...POSES);
    else if (state.wantParts) t.push('idle'); // 只要部件时也先定稿 idle 作锚点
    if (state.wantParts) t.push(...PART_IDS);
    return t;
  }

  const isPose = (t) => POSES.includes(t);

  /* ─────────────── 工具 ─────────────── */

  function setOff(reason) {
    state.enabled = false;
    el.offTxt.textContent = reason;
    el.off.hidden = false;
    el.panel.classList.add('is-off');
    el.keyPanel.hidden = true; // 无本地服务时填 Key 无意义
    syncGo();
  }

  function syncGo() {
    const n = currentTargets().length;
    el.go.disabled = !state.enabled || state.busy || state.refs.length === 0 || n === 0;
    el.go.textContent = n ? `开始生成 ${n} 件素材` : '请至少勾选一种输出';
  }

  function downscaleDataURL(src, maxSide, quality = 0.88) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round((img.naturalWidth || 1) * k));
        c.height = Math.max(1, Math.round((img.naturalHeight || 1) * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = src;
    });
  }

  function fileToRef(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = async () => {
        try { resolve(await downscaleDataURL(url, REF_SIDE)); }
        catch (e) { reject(e); }
        finally { URL.revokeObjectURL(url); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取图片')); };
      img.src = url;
    });
  }

  function seekTo(v, t) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('视频解码超时')), 9000);
      v.addEventListener('seeked', () => { clearTimeout(to); resolve(); }, { once: true });
      try { v.currentTime = t; } catch (e) { clearTimeout(to); reject(e); }
    });
  }

  /** 视频抽帧：均匀取 VIDEO_FRAME_N 个时间点，返回 jpeg dataURL 候选 */
  async function extractVideoFrames(file) {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    try {
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('视频读取超时')), 15000);
        v.addEventListener('loadedmetadata', () => { clearTimeout(to); resolve(); }, { once: true });
        v.addEventListener('error', () => { clearTimeout(to); reject(new Error('视频无法播放（仅支持浏览器可解码的 mp4/webm）')); }, { once: true });
      });
      let dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      if (!dur) { // 部分 webm 元数据缺时长：先 seek 到大值触发修正
        await seekTo(v, 1e6).catch(() => {});
        dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      }
      if (!dur) throw new Error('无法获取视频时长');
      const n = Math.min(VIDEO_FRAME_N, Math.max(3, Math.floor(dur * 2)));
      const side = 480;
      const k = Math.min(1, side / Math.max(v.videoWidth || 1, v.videoHeight || 1));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round((v.videoWidth || 1) * k));
      c.height = Math.max(1, Math.round((v.videoHeight || 1) * k));
      const ctx = c.getContext('2d');
      const frames = [];
      for (let i = 0; i < n; i++) {
        const t = dur * (0.06 + 0.88 * (i / (n - 1)));
        await seekTo(v, Math.min(t, dur - 0.05));
        ctx.drawImage(v, 0, 0, c.width, c.height);
        frames.push({ dataURL: c.toDataURL('image/jpeg', 0.85), t });
      }
      return frames;
    } finally {
      URL.revokeObjectURL(url);
      v.removeAttribute('src'); v.load();
    }
  }

  /* ─────────────── 上传 / 参考图 ─────────────── */

  async function handleFiles(list) {
    if (!state.enabled || state.busy) return;
    const files = [...list];
    for (const f of files) {
      try {
        if ((f.type || '').startsWith('video/')) {
          if (f.size > VIDEO_MAX_BYTES) throw new Error(`视频超过 ${VIDEO_MAX_BYTES / 1e6}MB`);
          el.drop.classList.add('is-busy');
          el.vframesTip.textContent = '正在抽帧…';
          el.vframes.hidden = false;
          const frames = await extractVideoFrames(f);
          state.videoFrames = frames;
          state.videoSel = new Set([0, Math.floor(frames.length / 2), frames.length - 1]);
          renderVideoFrames();
          applyRefsFromSelection();
        } else if ((f.type || '').startsWith('image/')) {
          if (f.size > IMG_MAX_BYTES) throw new Error(`图片超过 ${IMG_MAX_BYTES / 1e6}MB`);
          const dataURL = await fileToRef(f);
          addRef(dataURL, f.name || '照片');
        } else {
          throw new Error('只支持图片（jpg/png/webp）或视频（mp4/webm）');
        }
      } catch (e) {
        flashDropError(e.message || String(e));
      }
    }
    el.drop.classList.remove('is-busy');
    syncGo();
  }

  function flashDropError(msg) {
    el.drop.classList.add('is-err');
    const tip = el.drop.querySelector('.stu-drop-err');
    if (tip) { tip.textContent = msg; tip.hidden = false; }
    setTimeout(() => { el.drop.classList.remove('is-err'); if (tip) tip.hidden = true; }, 4200);
  }

  function addRef(dataURL, label) {
    if (state.refs.length >= MAX_REFS) {
      flashDropError(`参考图最多 ${MAX_REFS} 张，先移除一张再加`);
      return;
    }
    state.refs.push({ dataURL, label });
    renderRefs();
    syncGo();
  }

  function renderRefs() {
    el.refs.innerHTML = '';
    state.refs.forEach((r, i) => {
      const fig = document.createElement('figure');
      fig.className = 'stu-ref';
      const img = document.createElement('img');
      img.src = r.dataURL; img.alt = r.label || `参考图${i + 1}`;
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'stu-ref-x'; rm.title = '移除'; rm.textContent = '✕';
      rm.addEventListener('click', () => { state.refs.splice(i, 1); renderRefs(); syncGo(); });
      fig.append(img, rm);
      el.refs.appendChild(fig);
    });
    el.refsCount.textContent = state.refs.length ? `参考图 ${state.refs.length}/${MAX_REFS}` : '';
  }

  function renderVideoFrames() {
    const wrap = el.vframes.querySelector('.stu-vstrip');
    wrap.innerHTML = '';
    state.videoFrames.forEach((fr, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'stu-vframe' + (state.videoSel.has(i) ? ' is-sel' : '');
      const img = document.createElement('img');
      img.src = fr.dataURL; img.alt = `第 ${fr.t.toFixed(1)} 秒`;
      const tag = document.createElement('span');
      tag.textContent = `${fr.t.toFixed(1)}s`;
      b.append(img, tag);
      b.addEventListener('click', () => {
        if (state.videoSel.has(i)) state.videoSel.delete(i);
        else if (state.videoSel.size >= MAX_REFS) { flashDropError(`最多选 ${MAX_REFS} 帧`); return; }
        else state.videoSel.add(i);
        renderVideoFrames();
        applyRefsFromSelection();
      });
      wrap.appendChild(b);
    });
    el.vframesTip.textContent = `从视频抽了 ${state.videoFrames.length} 帧，点选 1-${MAX_REFS} 帧最像你家猫的作为参考（已默认选 3 帧）`;
  }

  /** 视频选中帧 → 参考图（与直接上传的照片合并，总量 ≤3） */
  async function applyRefsFromSelection() {
    if (!state.videoFrames) return;
    const picked = [...state.videoSel].sort((a, b) => a - b).map((i) => state.videoFrames[i]).filter(Boolean);
    const photoRefs = state.refs.filter((r) => !r.fromVideo);
    const videoRefs = [];
    for (const p of picked.slice(0, MAX_REFS - photoRefs.length)) {
      videoRefs.push({ dataURL: await downscaleDataURL(p.dataURL, REF_SIDE), label: `视频 ${p.t.toFixed(1)}s`, fromVideo: true });
    }
    state.refs = [...photoRefs, ...videoRefs].slice(0, MAX_REFS);
    renderRefs();
    syncGo();
  }

  /* ─────────────── 生成 ─────────────── */

  /** 组参考图：idle 用全部照片；walk2 附 walk1 定稿；其余姿态与全部部件附 idle 定稿（总 ≤3） */
  function imagesFor(target) {
    const photos = state.refs.map((r) => r.dataURL);
    if (target === 'idle') return photos.slice(0, MAX_REFS);
    const ref = (target === 'walk2' && state.results.walk1?.image) || state.results.idle?.image || null;
    const head = ref ? photos.slice(0, MAX_REFS - 1) : photos.slice(0, MAX_REFS);
    return ref ? [...head, ref] : head;
  }

  async function callGenerate(target) {
    const ctl = new AbortController();
    state.abortCtl = ctl;
    try {
      const res = await fetch(API.generate, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(isPose(target) ? { pose: target } : { part: target }),
          style: state.style,
          images: imagesFor(target),
        }),
        signal: ctl.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.ok) {
        throw new Error(data?.message || `生成服务返回 ${res.status}`);
      }
      return { image: data.image, ms: data.ms || 0 };
    } finally {
      state.abortCtl = null;
    }
  }

  function setCard(target, status, errText) {
    const card = el.grid.querySelector(`[data-target="${CSS.escape(target)}"]`);
    if (!card) return;
    card.classList.remove('is-wait', 'is-gen', 'is-done', 'is-fail');
    card.classList.add(`is-${status}`);
    const err = card.querySelector('.stu-err');
    if (err) { err.querySelector('span').textContent = errText || '生成失败'; }
  }

  function updateProgress(doneN, total, txt) {
    el.barFill.style.width = `${Math.round((doneN / Math.max(1, total)) * 100)}%`;
    el.progressTxt.textContent = txt || '';
  }

  async function generate() {
    const targets = currentTargets();
    if (!state.enabled || state.busy || !state.refs.length || !targets.length) return;
    state.busy = true; state.aborted = false;
    state.curTargets = targets;
    // 只保留仍在本轮目标里的旧结果（换画风时已整体清空）
    for (const k of Object.keys(state.results)) if (!targets.includes(k)) delete state.results[k];
    el.step3.hidden = true;
    el.go.disabled = true; el.cancel.hidden = false;
    targets.forEach((t) => { if (!state.results[t]) setCard(t, 'wait'); });
    el.progress.hidden = false;
    const styleNote = STYLE_LABEL[state.style] || state.style;
    const anchorNote = state.wantPoses ? '' : '（发呆 = 部件定稿锚点）';
    updateProgress(0, targets.length, `排队中… · ${styleNote}${anchorNote}`);

    const t0 = Date.now();
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      if (state.aborted) break;
      if (state.results[target]) continue; // 已完成的跳过（重试轮次）
      setCard(target, 'gen');
      updateProgress(targets.filter((t) => state.results[t]).length, targets.length,
        `正在画 ${i + 1}/${targets.length} · ${LABELS[target] || target}（${styleNote}）${state.mock ? '' : '，每件约 10–60 秒'}`);
      try {
        const out = await callGenerate(target);
        state.results[target] = out;
        const img = el.grid.querySelector(`[data-target="${CSS.escape(target)}"] img`);
        if (img) { img.src = out.image; img.alt = `${LABELS[target] || target}生成结果`; }
        setCard(target, 'done');
      } catch (e) {
        if (state.aborted || e.name === 'AbortError') break;
        setCard(target, 'fail', e.message || String(e));
      }
    }

    const doneN = targets.filter((t) => state.results[t]).length;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    state.busy = false;
    el.cancel.hidden = true;
    syncGo();
    if (state.aborted) {
      updateProgress(doneN, targets.length, `已取消 · 完成 ${doneN}/${targets.length}（可单张重试或整套重画）`);
    } else if (doneN === targets.length) {
      updateProgress(doneN, targets.length, `${targets.length} 件素材全部画好 · 用时 ${secs}s`);
      showResult();
    } else {
      updateProgress(doneN, targets.length, `完成 ${doneN}/${targets.length} · 失败的卡片可点「重试」`);
    }
  }

  async function retryTarget(target) {
    if (state.busy || !state.enabled) return;
    state.busy = true;
    syncGo();
    setCard(target, 'gen');
    try {
      const out = await callGenerate(target);
      state.results[target] = out;
      const img = el.grid.querySelector(`[data-target="${CSS.escape(target)}"] img`);
      if (img) img.src = out.image;
      setCard(target, 'done');
      const targets = state.curTargets.length ? state.curTargets : currentTargets();
      if (targets.length && targets.every((t) => state.results[t])) {
        updateProgress(targets.length, targets.length, `${targets.length} 件素材全部画好`);
        showResult();
      }
    } catch (e) {
      if (e.name !== 'AbortError') setCard(target, 'fail', e.message || String(e));
    } finally {
      state.busy = false;
      syncGo();
    }
  }

  /* ─────────────── 打包 zip ─────────────── */

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dataURLtoBytes(dataURL) {
    const b64 = dataURL.slice(dataURL.indexOf(',') + 1);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function extOf(dataURL) {
    const m = /^data:image\/(png|webp|jpe?g)/.exec(dataURL || '');
    return m ? (m[1] === 'jpeg' || m[1] === 'jpg' ? '.jpg' : `.${m[1]}`) : '.png';
  }

  function dosDateTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  /** 零依赖 zip 打包：deflate-raw（CompressionStream）优先，不支持/压不动时 store */
  async function zipFiles(files) {
    const enc = new TextEncoder();
    const { time, date } = dosDateTime(new Date());
    const canDeflate = typeof CompressionStream === 'function';
    const parts = [];
    const centrals = [];
    let offset = 0;
    for (const f of files) {
      const nameB = enc.encode(f.path);
      let data = f.bytes;
      let method = 0;
      if (canDeflate && f.bytes.length > 128) {
        try {
          const cs = new CompressionStream('deflate-raw');
          const comp = new Uint8Array(await new Response(new Blob([f.bytes]).stream().pipeThrough(cs)).arrayBuffer());
          if (comp.length < f.bytes.length) { data = comp; method = 8; }
        } catch { /* 回退 store */ }
      }
      const crc = crc32(f.bytes);
      const lh = new Uint8Array(30 + nameB.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, method, true); lv.setUint16(10, time, true); lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, f.bytes.length, true);
      lv.setUint16(26, nameB.length, true);
      lh.set(nameB, 30);
      parts.push(lh, data);
      const ch = new Uint8Array(46 + nameB.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, method, true); cv.setUint16(12, time, true); cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, f.bytes.length, true);
      cv.setUint16(28, nameB.length, true); cv.setUint32(42, offset, true);
      ch.set(nameB, 46);
      centrals.push(ch);
      offset += lh.length + data.length;
    }
    let cdSize = 0;
    for (const c of centrals) { parts.push(c); cdSize += c.length; }
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    parts.push(eocd);
    return new Blob(parts, { type: 'application/zip' });
  }

  function skinFolderSlug() {
    const raw = (el.name.value || '').trim().toLowerCase();
    const slug = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    return slug || 'my-cat';
  }

  /** skin.json v2：按实际生成的姿态组装（缺帧状态由渲染层回落 idle；idle 必须存在） */
  function buildSkinJson(extOf) {
    const has = (t) => !!state.results[t];
    const f = (t) => `${t}${extOf[t]}`;
    const states = {};
    states.idle = { frames: [f('idle')] };
    if (has('walk1') && has('walk2')) {
      states.walk = {
        frames: [f('walk1'), f('walk2')],
        anim: {
          interval: [0.14, 0.22], refSpeed: 46, bobAmp: 3, swayAmp: 0.02, swayPhase: 1.57,
          squashAmp: 0.012, crossfade: 0.3, entryT: 0.25, exitT: 0.18, stateXfade: 0.12,
        },
      };
    }
    if (has('sleep')) states.sleep = { frames: [f('sleep')] };
    if (has('drag')) { states.drag = { frames: [f('drag')] }; states.thrown = { frames: [f('drag')] }; }
    if (has('pet')) states.pet = { frames: [f('pet')] };
    if (has('tap')) { states.groom = { frames: [f('tap')] }; states.tap = { frames: [f('tap')] }; }
    const expressions = {};
    if (has('pet')) expressions.happy = { frames: [f('pet')], once: true, fps: 6, hold: 0.6 };
    if (has('drag')) expressions.surprise = { frames: [f('drag')], once: true, fps: 8, hold: 0.35 };
    if (has('tap')) expressions.tap = { frames: [f('tap')], once: true, fps: 8, hold: 0.12 };
    return JSON.stringify({
      version: 2,
      name: `${(el.name.value || '').trim() || '我的猫'} · AI 定制`,
      fps: 8,
      states,
      expressions,
    }, null, 2);
  }

  function buildReadme(folder, partCount) {
    const lines = [
      `精力桌宠 CreamCat · AI 定制皮肤「${(el.name.value || '').trim() || '我的猫'}」`,
      '',
      '安装（约 1 分钟）：',
      `1. 把整个 ${folder} 文件夹放进皮肤目录：`,
      '   - macOS:   ~/Library/Application Support/CreamCat/skins/',
      '   - Windows: %APPDATA%\\CreamCat\\skins\\',
      '   （也可以在游戏里右键桌面猫 →「打开皮肤文件夹」直达）',
      '2. 把同目录下原来的 default 文件夹改名为 .default（点开头会被忽略），新皮肤即生效。',
      '3. 桌宠约 1 秒内自动热重载；也可右键 →「重新加载皮肤」。',
      '',
      '想换回内置精力桌宠：把 .default 改回 default，删除或移走本文件夹即可。',
    ];
    if (partCount > 0) {
      lines.push(
        '',
        `parts/ 内为 ${partCount} 件 Live2D 式部件拆层稿（脸/头轮廓、左右眼、上下眉毛、嘴巴、`,
        '双前爪、身体、尾巴、毛发遮挡层、眼睛高光/阴影层），与姿态帧同一画风、同一只猫。',
        '桌宠 app 不直接消费 parts/，供分层动画制作与画师二创使用。'
      );
    }
    lines.push('', '本皮肤由下载页「AI 毛发定制工坊」生成，素材仅保存在你的电脑上。');
    return lines.join('\r\n');
  }

  async function downloadZip() {
    if (!state.results.idle?.image) return; // idle 是皮肤必需的锚点
    const folder = skinFolderSlug();
    const ext = {};
    const files = [];
    const poseTargets = POSES.filter((p) => state.results[p]?.image);
    const partTargets = PART_IDS.filter((p) => state.results[p]?.image);
    for (const t of [...poseTargets, ...partTargets]) ext[t] = extOf(state.results[t].image);
    for (const p of poseTargets) files.push({ path: `${folder}/${p}${ext[p]}`, bytes: dataURLtoBytes(state.results[p].image) });
    for (const p of partTargets) files.push({ path: `${folder}/parts/${p}${ext[p]}`, bytes: dataURLtoBytes(state.results[p].image) });
    const enc = new TextEncoder();
    files.unshift({ path: `${folder}/skin.json`, bytes: enc.encode(buildSkinJson(ext)) });
    files.push({ path: `${folder}/README.txt`, bytes: enc.encode(buildReadme(folder, partTargets.length)) });
    const blob = await zipFiles(files);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `creamcat-skin-${folder}.zip`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  /* ─────────────── 结果区 ─────────────── */

  function showResult() {
    const folder = skinFolderSlug();
    el.folderName.textContent = folder;
    el.zipName.textContent = `creamcat-skin-${folder}.zip`;
    el.step3.hidden = false;
    el.step3.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ─────────────── 目标卡片 ─────────────── */

  function buildGrid(targets) {
    el.grid.innerHTML = '';
    for (const target of targets) {
      const card = document.createElement('figure');
      card.className = 'stu-card is-wait' + (!state.wantPoses && state.wantParts && target === 'idle' ? ' is-anchor' : '');
      card.dataset.target = target;
      card.innerHTML =
        '<div class="stu-stage">' +
          '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="">' +
          '<span class="stu-ph"></span>' +
          '<span class="stu-spin"></span>' +
          '<span class="stu-err"><span>生成失败</span><button type="button">重试</button></span>' +
        '</div>' +
        `<figcaption>${LABELS[target] || target} <b class="mono">${target}</b></figcaption>`;
      card.querySelector('.stu-ph').textContent = LABELS[target] || target;
      card.querySelector('.stu-err button').addEventListener('click', () => retryTarget(target));
      el.grid.appendChild(card);
    }
    applyResultsToGrid();
  }

  /** 重建网格后把已有结果回填到卡片 */
  function applyResultsToGrid() {
    for (const [target, out] of Object.entries(state.results)) {
      const card = el.grid.querySelector(`[data-target="${CSS.escape(target)}"]`);
      if (!card || !out?.image) continue;
      const img = card.querySelector('img');
      img.src = out.image;
      img.alt = `${LABELS[target] || target}生成结果`;
      setCard(target, 'done');
    }
  }

  /* ─────────────── API Key 配置面板 ─────────────── */

  function readSavedCfg() {
    try {
      const v = JSON.parse(localStorage.getItem(LS_CFG) || 'null');
      return v && typeof v.key === 'string' && v.key ? v : null;
    } catch { return null; }
  }

  function formCfg() {
    return {
      key: el.keyInput.value.trim(),
      model: (el.keyModel?.value || '').trim(),
      baseUrl: (el.keyBase?.value || '').trim(),
    };
  }

  function setKeyMsg(kind, text) {
    el.keyMsg.dataset.kind = kind || '';
    el.keyMsg.textContent = text || '';
    el.keyMsg.hidden = !text;
  }

  async function postJson(pathname, body) {
    const res = await fetch(pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!data) throw new Error(`服务返回 ${res.status}（非 JSON）`);
    return data;
  }

  function setKeyBusy(on) {
    el.keyTest.disabled = on; el.keySave.disabled = on; el.keyInput.disabled = on;
  }

  /** 测试连接（save=false）/ 保存并启用（save=true）：同一枚零成本探针，只验鉴权不生成不计费 */
  async function testConnection(save) {
    const cfg = formCfg();
    if (!cfg.key) { setKeyMsg('err', '先粘贴 API Key（sk- 开头）'); return; }
    if (!/^sk-/.test(cfg.key)) { setKeyMsg('err', 'Key 格式不对：应以 sk- 开头（百炼控制台 → API-KEY 页获取）'); return; }
    setKeyBusy(true);
    setKeyMsg('run', save ? '验证并保存中…' : '测试连接中（仅探针，不产生费用）…');
    try {
      const data = await postJson(save ? API.config : API.check, cfg);
      if (!data.ok || data.valid === false) throw new Error(data.message || data.code || '验证失败');
      if (data.warning) setKeyMsg('warn', `Key 有效，但百炼返回提醒：${data.warning}`);
      else setKeyMsg('ok', save ? `✓ 已保存并启用 · 探针 ${data.ms}ms` : `✓ 连接成功 · 探针 ${data.ms}ms（未产生费用，未生成图片）`);
      if (save) {
        if (el.keyRemember.checked) localStorage.setItem(LS_CFG, JSON.stringify(cfg));
        else localStorage.removeItem(LS_CFG);
        el.keyInput.value = '';
        await refreshStatus(true); // 已保存成功，跳过自动注入直接刷新
      }
    } catch (e) {
      setKeyMsg('err', e.message || String(e));
    } finally {
      setKeyBusy(false);
    }
  }

  async function clearRuntimeKey() {
    try { await postJson(API.config, { key: null }); } catch { /* 服务不在也照常回禁用态 */ }
    localStorage.removeItem(LS_CFG);
    el.keyInput.value = '';
    setKeyMsg('', '');
    await refreshStatus();
  }

  async function fetchStatus() {
    const res = await fetch(API.status, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(`HTTP${res.status}`);
    return data;
  }

  function applyEnabled(data) {
    state.enabled = true;
    state.mock = !!data.mock;
    state.model = data.model || '';
    el.panel.classList.remove('is-off');
    el.off.hidden = true;
    el.keyPanel.hidden = true;
    el.keyNote.hidden = data.keySource !== 'runtime';
    if (state.mock) {
      el.drop.querySelector('.stu-drop-sub').textContent =
        '联调模式（CAT_SKIN_MOCK=1）：返回内置精力桌宠素材，不调用真实 AI';
    }
    syncGo();
  }

  function showKeyForm(msg) {
    state.enabled = false;
    el.offTxt.textContent = '尚未配置百炼 API Key——在下方填写并「测试连接」通过后「保存并启用」，即可开始生成。';
    el.off.hidden = false;
    el.panel.classList.add('is-off');
    el.keyPanel.hidden = false;
    el.keyNote.hidden = true;
    if (msg) setKeyMsg('warn', msg);
    syncGo();
  }

  /** 拉 status；未配置时尝试用「记住的 Key」自动注入（skipAutoInject=刚手动保存过） */
  async function refreshStatus(skipAutoInject) {
    try {
      let data = await fetchStatus();
      if (data.enabled) { applyEnabled(data); return; }
      const saved = skipAutoInject ? null : readSavedCfg();
      if (saved) {
        const r = await postJson(API.config, saved).catch(() => null);
        if (r?.ok) {
          data = await fetchStatus();
          if (data.enabled) { applyEnabled(data); return; }
        }
        localStorage.removeItem(LS_CFG);
        showKeyForm('之前记住的 Key 已失效，请重新填写');
        return;
      }
      showKeyForm();
    } catch {
      setOff('生成服务未接入：本页需要配合本地服务运行（npm run site:dev）；纯静态部署时此功能不可用，其余内容不受影响。');
    }
  }

  /* ─────────────── 启动 ─────────────── */

  async function boot() {
    if (!el.grid) return; // 区块不存在（被裁剪的部署）直接退出
    buildGrid(currentTargets());

    // 上传交互
    el.drop.addEventListener('click', () => { if (state.enabled && !state.busy) el.file.click(); });
    el.file.addEventListener('change', () => { handleFiles(el.file.files); el.file.value = ''; });
    for (const evName of ['dragenter', 'dragover']) {
      el.drop.addEventListener(evName, (e) => { e.preventDefault(); el.drop.classList.add('is-over'); });
    }
    for (const evName of ['dragleave', 'drop']) {
      el.drop.addEventListener(evName, (e) => { e.preventDefault(); el.drop.classList.remove('is-over'); });
    }
    el.drop.addEventListener('drop', (e) => {
      if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
    });

    // 输出内容勾选：重建卡片网格，丢弃不再需要的结果
    const onOutputToggle = () => {
      state.wantPoses = el.optPoses.checked;
      state.wantParts = el.optParts.checked;
      if (!state.busy) {
        const targets = currentTargets();
        for (const k of Object.keys(state.results)) if (!targets.includes(k)) delete state.results[k];
        buildGrid(targets);
        const complete = targets.length > 0 && targets.every((t) => state.results[t]);
        el.step3.hidden = !complete;
        if (complete) showResult();
      }
      syncGo();
    };
    el.optPoses.addEventListener('change', onOutputToggle);
    el.optParts.addEventListener('change', onOutputToggle);

    // 生成 / 取消 / 重画 / 下载
    el.go.addEventListener('click', generate);
    el.cancel.addEventListener('click', () => {
      state.aborted = true;
      state.abortCtl?.abort();
    });
    el.again.addEventListener('click', generate);
    el.zip.addEventListener('click', downloadZip);
    el.name.addEventListener('input', () => {
      if (!el.step3.hidden) showResult(); // 实时同步 zip 名/文件夹名
    });

    // API Key 面板交互
    el.keyTest.addEventListener('click', () => testConnection(false));
    el.keySave.addEventListener('click', () => testConnection(true));
    el.keyClear.addEventListener('click', clearRuntimeKey);
    el.keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') testConnection(true); });

    syncGo();
    await refreshStatus(); // 服务探测 + 记住的 Key 自动注入；失败/未配置 → 禁用态或 Key 表单
  }

  // 测试钩子（E2E harness 用；对普通访客无副作用）
  window.__catStudio = { state, generate, retryTarget, buildZip: downloadZip, addRef, currentTargets, POSES, PART_IDS };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
