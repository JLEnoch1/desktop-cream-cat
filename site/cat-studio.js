/* 奶油猫 CreamCat · AI 毛发定制工坊 — 下载页前端逻辑（零依赖原生 JS，defer 加载）。
 *
 * 流程：上传照片/视频 →（视频自动抽帧挑参考帧）→ 按 idle→walk1→walk2→sleep→drag→pet→tap
 * 串行链式生成（非 idle 姿态附带已定稿形象图做参考，锁角色一致性）→ 卡片实时预览 →
 * 浏览器端打包 skin.json v2 + 七帧图为 zip → 附安装指引（解压进 skins 目录即被 app 热重载）。
 *
 * 依赖后端 /api/cat-skin/*（scripts/cat-skin-api.mjs，随 npm run site:dev 启动）；
 * 纯静态托管 / file:// 打开时 status 探测失败 → 展示「服务未接入」禁用态，不影响页面其余部分。
 */
(() => {
  'use strict';

  /* ─────────────── 常量 ─────────────── */

  const POSES = ['idle', 'walk1', 'walk2', 'sleep', 'drag', 'pet', 'tap'];
  const POSE_LABEL = {
    idle: '发呆', walk1: '散步 A', walk2: '散步 B', sleep: '打盹',
    drag: '被拎起', pet: '被摸头', tap: '敲键盘',
  };
  const MAX_REFS = 3;          // DashScope 图像编辑单次最多 3 图
  const IMG_MAX_BYTES = 12e6;  // 原图上限（缩放后远低于 API 10MB 限制）
  const VIDEO_MAX_BYTES = 100e6;
  const VIDEO_FRAME_N = 8;     // 抽帧候选数
  const REF_SIDE = 1280;       // 参考图最长边
  const API = {
    status: '/api/cat-skin/status',
    generate: '/api/cat-skin/generate',
  };

  const state = {
    enabled: false,
    mock: false,
    model: '',
    refs: [],            // [{dataURL, label}]
    videoFrames: null,   // [{dataURL, t}] 抽帧候选
    videoSel: new Set(), // 选中的候选下标
    results: {},         // pose → {image(dataURL), ms}
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
    name: $('#stu-name'), go: $('#stu-go'), cancel: $('#stu-cancel'),
    progress: $('#stu-progress'), barFill: $('#stu-bar-fill'), progressTxt: $('#stu-progress-txt'),
    grid: $('#stu-grid'),
    step2: $('#stu-step2'), step3: $('#stu-step3'),
    folderName: $('#stu-folder-name'), zipName: $('#stu-zip-name'),
    zip: $('#stu-zip'), again: $('#stu-again'),
  };

  /* ─────────────── 工具 ─────────────── */

  function setOff(reason) {
    state.enabled = false;
    el.offTxt.textContent = reason;
    el.off.hidden = false;
    el.panel.classList.add('is-off');
    syncGo();
  }

  function syncGo() {
    el.go.disabled = !state.enabled || state.busy || state.refs.length === 0;
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

  /** 组参考图：idle 用全部照片；walk2 附 walk1 定稿；其余附 idle 定稿（总 ≤3） */
  function imagesFor(pose) {
    const photos = state.refs.map((r) => r.dataURL);
    if (pose === 'idle') return photos.slice(0, MAX_REFS);
    const ref = pose === 'walk2' ? state.results.walk1?.image : state.results.idle?.image;
    const head = ref ? photos.slice(0, MAX_REFS - 1) : photos.slice(0, MAX_REFS);
    return ref ? [...head, ref] : head;
  }

  async function callGenerate(pose) {
    const ctl = new AbortController();
    state.abortCtl = ctl;
    try {
      const res = await fetch(API.generate, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pose, images: imagesFor(pose) }),
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

  function setCard(pose, status, errText) {
    const card = el.grid.querySelector(`[data-pose="${pose}"]`);
    if (!card) return;
    card.classList.remove('is-wait', 'is-gen', 'is-done', 'is-fail');
    card.classList.add(`is-${status}`);
    const err = card.querySelector('.stu-err');
    if (err) { err.querySelector('span').textContent = errText || '生成失败'; }
  }

  function updateProgress(doneN, txt) {
    el.barFill.style.width = `${Math.round((doneN / POSES.length) * 100)}%`;
    el.progressTxt.textContent = txt || '';
  }

  async function generate() {
    if (!state.enabled || state.busy || !state.refs.length) return;
    state.busy = true; state.aborted = false;
    state.results = {};
    el.step3.hidden = true;
    el.go.disabled = true; el.cancel.hidden = false;
    POSES.forEach((p) => setCard(p, 'wait'));
    el.progress.hidden = false;
    updateProgress(0, '排队中…');

    const t0 = Date.now();
    for (let i = 0; i < POSES.length; i++) {
      const pose = POSES[i];
      if (state.aborted) break;
      setCard(pose, 'gen');
      updateProgress(Object.keys(state.results).length,
        `正在画 ${i + 1}/${POSES.length} · ${POSE_LABEL[pose]}${state.mock ? '' : '（每张约 10–60 秒）'}`);
      try {
        const out = await callGenerate(pose);
        state.results[pose] = out;
        const card = el.grid.querySelector(`[data-pose="${pose}"] img`);
        if (card) { card.src = out.image; card.alt = `${POSE_LABEL[pose]}生成结果`; }
        setCard(pose, 'done');
      } catch (e) {
        if (state.aborted || e.name === 'AbortError') break;
        setCard(pose, 'fail', e.message || String(e));
      }
      updateProgress(Object.keys(state.results).length);
    }

    const doneN = Object.keys(state.results).length;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    state.busy = false;
    el.cancel.hidden = true;
    syncGo();
    if (state.aborted) {
      updateProgress(doneN, `已取消 · 完成 ${doneN}/${POSES.length}（可单张重试或整套重画）`);
    } else if (doneN === POSES.length) {
      updateProgress(doneN, `七种姿态全部画好 · 用时 ${secs}s`);
      showResult();
    } else {
      updateProgress(doneN, `完成 ${doneN}/${POSES.length} · 失败的姿态可点卡片上的「重试」`);
    }
  }

  async function retryPose(pose) {
    if (state.busy || !state.enabled) return;
    if (pose !== 'idle' && !state.results.idle && pose !== 'walk1') {
      /* 无定稿可参考也允许重试：imagesFor 自动退化为纯照片 */
    }
    state.busy = true;
    syncGo();
    setCard(pose, 'gen');
    try {
      const out = await callGenerate(pose);
      state.results[pose] = out;
      const img = el.grid.querySelector(`[data-pose="${pose}"] img`);
      if (img) img.src = out.image;
      setCard(pose, 'done');
      if (POSES.every((p) => state.results[p])) {
        updateProgress(POSES.length, `七种姿态全部画好`);
        showResult();
      }
    } catch (e) {
      if (e.name !== 'AbortError') setCard(pose, 'fail', e.message || String(e));
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

  function buildSkinJson(folder, extOfPose) {
    const f = (pose) => `${pose}${extOfPose[pose]}`;
    return JSON.stringify({
      version: 2,
      name: `${(el.name.value || '').trim() || '我的猫'} · AI 定制`,
      fps: 8,
      states: {
        idle: { frames: [f('idle')] },
        walk: {
          frames: [f('walk1'), f('walk2')],
          anim: {
            interval: [0.14, 0.22], refSpeed: 46, bobAmp: 3, swayAmp: 0.02, swayPhase: 1.57,
            squashAmp: 0.012, crossfade: 0.3, entryT: 0.25, exitT: 0.18, stateXfade: 0.12,
          },
        },
        sleep: { frames: [f('sleep')] },
        drag: { frames: [f('drag')] },
        thrown: { frames: [f('drag')] },
        pet: { frames: [f('pet')] },
        groom: { frames: [f('tap')] },
        tap: { frames: [f('tap')] },
      },
      expressions: {
        happy: { frames: [f('pet')], once: true, fps: 6, hold: 0.6 },
        surprise: { frames: [f('drag')], once: true, fps: 8, hold: 0.35 },
        tap: { frames: [f('tap')], once: true, fps: 8, hold: 0.12 },
      },
    }, null, 2);
  }

  function buildReadme(folder) {
    return [
      `奶油猫 CreamCat · AI 定制皮肤「${(el.name.value || '').trim() || '我的猫'}」`,
      '',
      '安装（约 1 分钟）：',
      `1. 把整个 ${folder} 文件夹放进皮肤目录：`,
      '   - macOS:   ~/Library/Application Support/CreamCat/skins/',
      '   - Windows: %APPDATA%\\CreamCat\\skins\\',
      '   （也可以在游戏里右键桌面猫 →「打开皮肤文件夹」直达）',
      '2. 把同目录下原来的 default 文件夹改名为 .default（点开头会被忽略），新皮肤即生效。',
      '3. 桌宠约 1 秒内自动热重载；也可右键 →「重新加载皮肤」。',
      '',
      '想换回内置奶油猫：把 .default 改回 default，删除或移走本文件夹即可。',
      '',
      '本皮肤由下载页「AI 毛发定制工坊」生成，素材仅保存在你的电脑上。',
    ].join('\r\n');
  }

  async function downloadZip() {
    if (!POSES.every((p) => state.results[p]?.image)) return;
    const folder = skinFolderSlug();
    const extOfPose = {};
    const files = [];
    for (const p of POSES) {
      extOfPose[p] = extOf(state.results[p].image);
      files.push({ path: `${folder}/${p}${extOfPose[p]}`, bytes: dataURLtoBytes(state.results[p].image) });
    }
    const enc = new TextEncoder();
    files.unshift({ path: `${folder}/skin.json`, bytes: enc.encode(buildSkinJson(folder, extOfPose)) });
    files.push({ path: `${folder}/README.txt`, bytes: enc.encode(buildReadme(folder)) });
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

  /* ─────────────── 姿态卡片 ─────────────── */

  function buildGrid() {
    el.grid.innerHTML = '';
    for (const pose of POSES) {
      const card = document.createElement('figure');
      card.className = 'stu-card is-wait';
      card.dataset.pose = pose;
      card.innerHTML =
        '<div class="stu-stage">' +
          '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="">' +
          '<span class="stu-ph"></span>' +
          '<span class="stu-spin"></span>' +
          '<span class="stu-err"><span>生成失败</span><button type="button">重试</button></span>' +
        '</div>' +
        `<figcaption>${POSE_LABEL[pose]} <b class="mono">${pose}</b></figcaption>`;
      card.querySelector('.stu-ph').textContent = POSE_LABEL[pose];
      card.querySelector('.stu-err button').addEventListener('click', () => retryPose(pose));
      el.grid.appendChild(card);
    }
  }

  /* ─────────────── 启动 ─────────────── */

  async function boot() {
    if (!el.grid) return; // 区块不存在（被裁剪的部署）直接退出
    buildGrid();

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

    // 服务探测：静态托管 / file:// / 未配 key → 禁用态
    try {
      const res = await fetch(API.status, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(`HTTP${res.status}`);
      if (!data.enabled) {
        setOff('生成服务未配置：在启动下载页服务时注入百炼 API Key（DASHSCOPE_API_KEY=sk-… npm run site:dev），刷新本页即可用。');
        return;
      }
      state.enabled = true;
      state.mock = !!data.mock;
      state.model = data.model || '';
      el.panel.classList.remove('is-off');
      el.off.hidden = true;
      if (state.mock) {
        el.progressTxt.textContent = '';
        el.drop.querySelector('.stu-drop-sub').textContent =
          '联调模式（CAT_SKIN_MOCK=1）：返回内置奶油猫素材，不调用真实 AI';
      }
      syncGo();
    } catch {
      setOff('生成服务未接入：本页需要配合本地服务运行（npm run site:dev，并配置 DASHSCOPE_API_KEY）；纯静态部署时此功能不可用，其余内容不受影响。');
    }
  }

  // 测试钩子（E2E harness 用；对普通访客无副作用）
  window.__catStudio = { state, generate, retryPose, buildZip: downloadZip, addRef, POSES };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
