/* ============================================================
 * TurtleMark 去水印
 * 图片：智能填充(Telea) / 马赛克 / 边缘裁剪
 * 视频：裁剪 / 马赛克 / 智能填充（MediaRecorder 本地录制）
 * 全部本地处理，不上传服务器
 * ============================================================ */
'use strict';

/* ---------------- 工具函数 ---------------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

let toastTimer = null;
function toast(msg, ms) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2800);
}

function fmtTime(s) {
  if (!isFinite(s)) s = 0;
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, '0');
  return `${m}:${sec}`;
}

function isIOS() {
  return /iP(hone|od|ad)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
}

async function saveResult(blob, filename) {
  // Android App（WebView）内：通过原生桥接保存到系统下载目录
  if (window.AndroidBridge && typeof AndroidBridge.startSave === 'function') {
    toast('正在保存到系统下载目录…');
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const CHUNK = 160 * 1024;
      const STEP = 0x4000;
      AndroidBridge.startSave(filename, bytes.length);
      for (let off = 0; off < bytes.length; off += CHUNK) {
        const part = bytes.subarray(off, Math.min(off + CHUNK, bytes.length));
        let bin = '';
        for (let j = 0; j < part.length; j += STEP) {
          bin += String.fromCharCode.apply(null, part.subarray(j, Math.min(j + STEP, part.length)));
        }
        AndroidBridge.appendChunk(btoa(bin));
      }
      AndroidBridge.finishSave();
      toast('✅ 已保存到「下载」文件夹', 3500);
      return true;
    } catch (e) {
      toast('保存失败：' + e.message);
      return false;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast('✅ 已开始下载，请在浏览器「下载」或「文件」中查看', 3500);
  return true;
}

async function shareResult(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (e) {
      if (e && e.name === 'AbortError') return true;
    }
  }
  return saveResult(blob, filename);
}

/* ============================================================
 * Telea 图像修复算法（智能填充）
 * 基于 OpenCV inpaint 的经典实现：快速行进法 + 邻域加权 + 梯度修正
 * ============================================================ */
class MinHeap {
  constructor(cap) {
    cap = Math.max(64, cap | 0);
    this.vals = new Float64Array(cap);
    this.ids = new Int32Array(cap);
    this.size = 0;
  }
  _grow() {
    const nv = new Float64Array(this.vals.length * 2); nv.set(this.vals); this.vals = nv;
    const ni = new Int32Array(this.ids.length * 2); ni.set(this.ids); this.ids = ni;
  }
  _swap(a, b) {
    let t = this.vals[a]; this.vals[a] = this.vals[b]; this.vals[b] = t;
    t = this.ids[a]; this.ids[a] = this.ids[b]; this.ids[b] = t;
  }
  push(id, val) {
    if (this.size === this.vals.length) this._grow();
    let i = this.size++;
    this.vals[i] = val; this.ids[i] = id;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.vals[p] <= this.vals[i]) break;
      this._swap(i, p); i = p;
    }
  }
  pop() {
    if (!this.size) return null;
    const out = { id: this.ids[0], val: this.vals[0] };
    this.size--;
    this._swap(0, this.size);
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let s = i;
      if (l < this.size && this.vals[l] < this.vals[s]) s = l;
      if (r < this.size && this.vals[r] < this.vals[s]) s = r;
      if (s === i) break;
      this._swap(i, s); i = s;
    }
    return out;
  }
}

/**
 * @param {Uint8ClampedArray} pixels RGBA 区域像素
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} mask  1=需要修复（水印），0=保留
 */
function teleaInpaint(pixels, width, height, mask) {
  const n = width * height;
  const INF = 1e30;
  const T = new Float32Array(n).fill(INF);
  const state = new Uint8Array(n); // 0 未知 1 窄带 2 已知
  const heap = new MinHeap(n);

  // 灰度图 + 梯度（用于边缘修正）
  const gray = new Float32Array(n);
  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const o = i * 4;
      gray[i] = 0.299 * pixels[o] + 0.587 * pixels[o + 1] + 0.114 * pixels[o + 2];
    }
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const yp = y > 0 ? row - width : row;
    const yn = y < height - 1 ? row + width : row;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const xm = x > 0 ? gray[i - 1] : gray[i];
      const xp = x < width - 1 ? gray[i + 1] : gray[i];
      gx[i] = (xp - xm) * 0.5;
      gy[i] = (gray[yn + x] - gray[yp + x]) * 0.5;
    }
  }

  // 初始化已知点
  let maskCount = 0;
  for (let i = 0; i < n; i++) {
    if (mask[i]) maskCount++;
    else { state[i] = 2; T[i] = 0; }
  }
  if (!maskCount) return false;
  if (maskCount === n) return false; // 没有可用的已知像素

  // Eikonal 方程求解
  const solveT = (i) => {
    const x = i % width;
    const y = (i / width) | 0;
    let t1 = INF, t2 = INF, v;
    if (x > 0) { v = T[i - 1]; if (v < t1) t1 = v; }
    if (x < width - 1) { v = T[i + 1]; if (v < t1) t1 = v; }
    if (y > 0) { v = T[i - width]; if (v < t2) t2 = v; }
    if (y < height - 1) { v = T[i + width]; if (v < t2) t2 = v; }
    const m = Math.min(t1, t2), M = Math.max(t1, t2);
    if (M - m >= 1) return m + 1;
    return (t1 + t2 + Math.sqrt(2 - (t1 - t2) * (t1 - t2))) / 2;
  };

  // 初始化窄带
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const x = i % width;
    const y = (i / width) | 0;
    if ((x > 0 && state[i - 1] === 2) ||
        (x < width - 1 && state[i + 1] === 2) ||
        (y > 0 && state[i - width] === 2) ||
        (y < height - 1 && state[i + width] === 2)) {
      state[i] = 1;
      T[i] = solveT(i);
      heap.push(i, T[i]);
    }
  }
  if (!heap.size) return false;

  // 快速行进 + 插值修复（按 T 升序，使用已修复像素）
  const R = 2;
  while (heap.size) {
    const { id: i, val } = heap.pop();
    if (state[i] === 2) continue;
    if (val > T[i] + 1e-3) continue; // 过期条目
    state[i] = 2;

    const x = i % width;
    const y = (i / width) | 0;
    let r = 0, g = 0, b = 0, den = 0;
    for (let dy = -R; dy <= R; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= height) continue;
      for (let dx = -R; dx <= R; dx++) {
        if (dx === 0 && dy === 0) continue;
        const xx = x + dx;
        if (xx < 0 || xx >= width) continue;
        const j = yy * width + xx;
        if (state[j] !== 2) continue;
        const dst = dx * dx + dy * dy;
        if (dst > R * R) continue;
        const lev = T[i] - T[j];
        const w = 1 / (dst * lev * lev + 1e-4);
        const ddx = x - xx, ddy = y - yy;
        const corr = gx[j] * ddx + gy[j] * ddy;
        const o = j * 4;
        r += w * (pixels[o] + corr);
        g += w * (pixels[o + 1] + corr);
        b += w * (pixels[o + 2] + corr);
        den += w;
      }
    }
    const o = i * 4;
    if (den > 1e-8) {
      pixels[o] = r / den;
      pixels[o + 1] = g / den;
      pixels[o + 2] = b / den;
    } else {
      // 兜底：取已知四邻域均值
      let rr = 0, gg = 0, bb = 0, c = 0;
      const nb = [];
      if (x > 0) nb.push(i - 1);
      if (x < width - 1) nb.push(i + 1);
      if (y > 0) nb.push(i - width);
      if (y < height - 1) nb.push(i + width);
      for (const j of nb) {
        if (state[j] === 2) {
          const jo = j * 4;
          rr += pixels[jo]; gg += pixels[jo + 1]; bb += pixels[jo + 2]; c++;
        }
      }
      if (c > 0) { pixels[o] = rr / c; pixels[o + 1] = gg / c; pixels[o + 2] = bb / c; }
    }

    // 更新四邻域
    const nbs = [];
    if (x > 0) nbs.push(i - 1);
    if (x < width - 1) nbs.push(i + 1);
    if (y > 0) nbs.push(i - width);
    if (y < height - 1) nbs.push(i + width);
    for (const j of nbs) {
      if (state[j] === 0) {
        state[j] = 1;
        T[j] = solveT(j);
        heap.push(j, T[j]);
      } else if (state[j] === 1) {
        const t = solveT(j);
        if (t < T[j] - 1e-4) {
          T[j] = t;
          heap.push(j, t);
        }
      }
    }
  }
  return true;
}

/* ---------------- 马赛克 ---------------- */
function mosaicRect(pixels, width, height, rect, block) {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  if (x1 <= x0 || y1 <= y0) return;
  block = Math.max(2, block | 0);
  const sum = new Float64Array(4);
  for (let by = y0; by < y1; by += block) {
    const by1 = Math.min(by + block, y1);
    for (let bx = x0; bx < x1; bx += block) {
      const bx1 = Math.min(bx + block, x1);
      sum[0] = sum[1] = sum[2] = sum[3] = 0;
      let cnt = 0;
      for (let y = by; y < by1; y++) {
        for (let x = bx; x < bx1; x++) {
          const o = (y * width + x) * 4;
          sum[0] += pixels[o]; sum[1] += pixels[o + 1];
          sum[2] += pixels[o + 2]; sum[3] += pixels[o + 3];
          cnt++;
        }
      }
      const inv = 1 / cnt;
      for (let y = by; y < by1; y++) {
        for (let x = bx; x < bx1; x++) {
          const o = (y * width + x) * 4;
          pixels[o] = sum[0] * inv;
          pixels[o + 1] = sum[1] * inv;
          pixels[o + 2] = sum[2] * inv;
          pixels[o + 3] = sum[3] * inv;
        }
      }
    }
  }
}

/* ---------------- 边缘裁剪计算 ---------------- */
// 选区离哪条边最近，就剪掉那条边一侧的整条，去掉水印所在的一条
function stripCropFor(w, h, r) {
  const rx = Math.max(0, Math.min(w, r.x));
  const ry = Math.max(0, Math.min(h, r.y));
  const rw = Math.max(1, Math.min(w - rx, r.w));
  const rh = Math.max(1, Math.min(h - ry, r.h));
  const cands = [
    { x: 0, y: ry + rh, w: w, h: h - ry - rh },   // 剪掉顶部一条
    { x: 0, y: 0, w: w, h: ry },                   // 剪掉底部一条
    { x: rx + rw, y: 0, w: w - rx - rw, h: h },   // 剪掉左侧一条
    { x: 0, y: 0, w: rx, h: h },                  // 剪掉右侧一条
  ];
  cands.sort((a, b) => b.w * b.h - a.w * a.h);
  const best = cands[0];
  if (best.w < 8 || best.h < 8) return null;
  return best;
}

/* ============================================================
 * AI 修复：内置 LaMa 模型 + onnxruntime-web（纯本地推理，不上传）
 * ============================================================ */
class AiInpaint {
  constructor() {
    this.session = null;
    this.loading = null;
    this.modelUrl = 'assets/model/lama-int8-convonly.onnx';
    this.modelSize = 512;
  }

  isAvailable() {
    return typeof window.ort !== 'undefined';
  }

  ensureSession(onProgress) {
    if (this.session) return Promise.resolve(this.session);
    if (this.loading) return this.loading;
    const ort = window.ort;
    if (!ort) return Promise.reject(new Error('AI 运行库加载失败'));
    this.loading = (async () => {
      const ortScript = document.querySelector('script[src$="ort.min.js"]');
      ort.env.wasm.wasmPaths = ortScript && ortScript.src
        ? ortScript.src.slice(0, ortScript.src.lastIndexOf('/') + 1)
        : new URL('assets/onnx/', document.baseURI).href;
      ort.env.wasm.numThreads = 1;
      if (onProgress) onProgress('正在加载 AI 模型（约 60MB，仅首次下载）…');
      this.session = await ort.InferenceSession.create(this.modelUrl, {
        executionProviders: ['wasm'],
      });
      return this.session;
    })().catch(e => { this.loading = null; throw e; });
    return this.loading;
  }

  /**
   * 把整张图缩放到 512×512 送进 LaMa，输出再放回原图尺寸，
   * 只在水印区域（bbox + 软边羽化）内替换，保留原图其余细节。
   * @returns {Promise<HTMLCanvasElement>} 与输入同尺寸的合成结果
   */
  async inpaint(imageCanvas, maskCanvas, bbox, onProgress) {
    const ort = window.ort;
    const session = await this.ensureSession(onProgress);
    const S = this.modelSize;
    const n = S * S;

    const ic = document.createElement('canvas');
    ic.width = S; ic.height = S;
    const ictx = ic.getContext('2d', { willReadFrequently: true });
    ictx.imageSmoothingEnabled = true;
    ictx.imageSmoothingQuality = 'high';
    ictx.drawImage(imageCanvas, 0, 0, S, S);
    const id = ictx.getImageData(0, 0, S, S).data;

    const mc = document.createElement('canvas');
    mc.width = S; mc.height = S;
    const mctx = mc.getContext('2d', { willReadFrequently: true });
    mctx.imageSmoothingEnabled = true;
    mctx.imageSmoothingQuality = 'high';
    mctx.drawImage(maskCanvas, 0, 0, S, S);
    const md = mctx.getImageData(0, 0, S, S).data;

    const imgIn = new Float32Array(3 * n);
    const maskIn = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      imgIn[i] = id[i * 4] / 255;
      imgIn[n + i] = id[i * 4 + 1] / 255;
      imgIn[2 * n + i] = id[i * 4 + 2] / 255;
      maskIn[i] = (md[i * 4] + md[i * 4 + 1] + md[i * 4 + 2]) > 0 ? 1 : 0;
    }

    if (onProgress) onProgress('AI 正在修复…（约 1–3 分钟，请保持页面在前台）');
    const feeds = {
      image: new ort.Tensor('float32', imgIn, [1, 3, S, S]),
      mask: new ort.Tensor('float32', maskIn, [1, 1, S, S]),
    };
    const results = await session.run(feeds);
    const out = results[session.outputNames[0]].data;

    // 512 结果 → 原图尺寸
    const full = document.createElement('canvas');
    full.width = imageCanvas.width;
    full.height = imageCanvas.height;
    const fctx = full.getContext('2d', { willReadFrequently: true });
    const od = fctx.createImageData(S, S);
    for (let i = 0; i < n; i++) {
      od.data[i * 4] = Math.max(0, Math.min(255, out[i]));
      od.data[i * 4 + 1] = Math.max(0, Math.min(255, out[n + i]));
      od.data[i * 4 + 2] = Math.max(0, Math.min(255, out[2 * n + i]));
      od.data[i * 4 + 3] = 255;
    }
    const tmp = document.createElement('canvas');
    tmp.width = S; tmp.height = S;
    tmp.getContext('2d').putImageData(od, 0, 0);
    fctx.imageSmoothingEnabled = true;
    fctx.imageSmoothingQuality = 'high';
    fctx.drawImage(tmp, 0, 0, full.width, full.height);

    // 以原图为底，只在 bbox 附近用模糊后的遮罩 alpha 做软边合成
    const blend = document.createElement('canvas');
    blend.width = imageCanvas.width;
    blend.height = imageCanvas.height;
    const bctx = blend.getContext('2d', { willReadFrequently: true });
    bctx.drawImage(imageCanvas, 0, 0);

    const pad = 16;
    const rx = Math.max(0, Math.floor(bbox.x - pad));
    const ry = Math.max(0, Math.floor(bbox.y - pad));
    const rx2 = Math.min(imageCanvas.width, Math.ceil(bbox.x + bbox.w + pad));
    const ry2 = Math.min(imageCanvas.height, Math.ceil(bbox.y + bbox.h + pad));
    const rw = rx2 - rx, rh = ry2 - ry;
    if (rw <= 0 || rh <= 0) return blend;

    const mFull = maskCanvas.getContext('2d', { willReadFrequently: true });
    const mdFull = mFull.getImageData(rx, ry, rw, rh).data;
    const alpha = new Float32Array(rw * rh);
    for (let i = 0; i < rw * rh; i++) {
      alpha[i] = (mdFull[i * 4] + mdFull[i * 4 + 1] + mdFull[i * 4 + 2]) > 0 ? 1 : 0;
    }
    // 盒式模糊做羽化（半径 8，步长 2 提速）
    const blurred = new Float32Array(rw * rh);
    const R = 8;
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        let s = 0, cnt = 0;
        for (let dy = -R; dy <= R; dy += 2) {
          const yy = y + dy;
          if (yy < 0 || yy >= rh) continue;
          for (let dx = -R; dx <= R; dx += 2) {
            const xx = x + dx;
            if (xx < 0 || xx >= rw) continue;
            s += alpha[yy * rw + xx]; cnt++;
          }
        }
        blurred[y * rw + x] = s / cnt;
      }
    }
    const orig = bctx.getImageData(rx, ry, rw, rh).data;
    const ai = fctx.getImageData(rx, ry, rw, rh).data;
    const merged = new Uint8ClampedArray(orig.length);
    for (let i = 0, j = 0; i < rw * rh; i++, j += 4) {
      const a = blurred[i];
      merged[j] = orig[j] + (ai[j] - orig[j]) * a;
      merged[j + 1] = orig[j + 1] + (ai[j + 1] - orig[j + 1]) * a;
      merged[j + 2] = orig[j + 2] + (ai[j + 2] - orig[j + 2]) * a;
      merged[j + 3] = 255;
    }
    bctx.putImageData(new ImageData(merged, rw, rh), rx, ry);
    return blend;
  }
}

/* ============================================================
 * 图片编辑器
 * ============================================================ */
class ImageEditor {
  constructor() {
    this.canvas = $('#imgCanvas');
    this.maskCanvas = $('#maskCanvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.mctx = this.maskCanvas.getContext('2d', { willReadFrequently: true });
    this.strokes = [];
    this.tool = 'brush';
    this.brushSize = 32;
    this.current = null; // 当前进行中的笔画
    this.loaded = false;
    this.busy = false;
    this.history = [];
    this.aiRunId = 0;
    this.ai = new AiInpaint();

    this.bindTools();
    this.bindStage();
    this.bindButtons();
    this.bindDropZone();
    this.bindCompare();
  }

  bindTools() {
    $$('#imgToolbar .tool[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.tool = btn.dataset.tool;
        $$('#imgToolbar .tool[data-tool]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        $('#imgBrushGroup').classList.toggle('hidden', this.tool === 'rect');
        this.updateHint();
      });
    });
    $('#imgBrushSize').addEventListener('input', e => {
      this.brushSize = +e.target.value;
    });
    $('#imgUndoBtn').addEventListener('click', () => { this.undo(); });
    $('#imgClearBtn').addEventListener('click', () => {
      this.strokes = [];
      this.redrawMask();
    });
    $$('input[name="imgMode"]').forEach(r => r.addEventListener('change', () => {
      $('#imgMosaicGroup').classList.toggle('hidden', $('input[name="imgMode"]:checked').value !== 'mosaic');
    }));
  }

  updateHint() {
    const hints = {
      brush: '用画笔涂抹水印所在区域，涂抹越贴合水印轮廓效果越好',
      eraser: '用橡皮擦掉多余的区域标记',
      rect: '拖出一个矩形框住水印区域（裁剪模式将沿最近边缘剪掉整条）',
    };
    $('#imgHint').textContent = hints[this.tool];
  }

  bindStage() {
    const stage = $('#imgStage');
    const toLocal = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) / rect.width * this.canvas.width,
        y: (e.clientY - rect.top) / rect.height * this.canvas.height,
      };
    };

    stage.addEventListener('pointerdown', e => {
      if (!this.loaded || this.busy || e.button > 0) return;
      const p = toLocal(e);
      if (this.tool === 'rect') {
        this.strokes = this.strokes.filter(s => s.tool !== 'rect');
        this.current = { tool: 'rect', x: p.x, y: p.y, w: 0, h: 0 };
      } else {
        this.current = { tool: this.tool, size: this.brushSize, points: [p] };
      }
      stage.setPointerCapture(e.pointerId);
    });

    stage.addEventListener('pointermove', e => {
      if (!this.current) return;
      const p = toLocal(e);
      if (this.current.tool === 'rect') {
        const c = this.current;
        c.w = p.x - c.x; c.h = p.y - c.y;
        this.redrawMask(this.current);
      } else {
        const c = this.current;
        const last = c.points[c.points.length - 1];
        const m = this.mctx;
        m.save();
        m.globalCompositeOperation = c.tool === 'eraser' ? 'destination-out' : 'source-over';
        m.strokeStyle = 'rgb(255, 90, 90)';
        m.lineWidth = c.size;
        m.lineCap = 'round';
        m.lineJoin = 'round';
        m.beginPath();
        m.moveTo(last.x, last.y);
        m.lineTo(p.x, p.y);
        m.stroke();
        m.restore();
        c.points.push(p);
      }
    });

    const endStroke = e => {
      if (!this.current) return;
      const c = this.current;
      if (c.tool === 'rect') {
        if (Math.abs(c.w) > 6 && Math.abs(c.h) > 6) {
          this.strokes.push({
            tool: 'rect',
            x: Math.min(c.x, c.x + c.w),
            y: Math.min(c.y, c.y + c.h),
            w: Math.abs(c.w),
            h: Math.abs(c.h),
          });
        }
        this.redrawMask();
      } else if (c.points.length >= 1) {
        this.strokes.push(c);
        this.redrawMask();
      }
      this.current = null;
      try { stage.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    stage.addEventListener('pointerup', endStroke);
    stage.addEventListener('pointercancel', endStroke);
  }

  redrawMask(preview) {
    const m = this.mctx;
    m.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
    const draw = (s) => {
      if (s.tool === 'rect') {
        m.globalCompositeOperation = 'source-over';
        m.fillStyle = 'rgb(255, 90, 90)';
        m.strokeStyle = 'rgb(255, 90, 90)';
        m.lineWidth = 2;
        const x = Math.min(s.x, s.x + s.w);
        const y = Math.min(s.y, s.y + s.h);
        const w = Math.abs(s.w);
        const h = Math.abs(s.h);
        m.fillRect(x, y, w, h);
        m.strokeRect(x, y, w, h);
      } else {
        m.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
        m.strokeStyle = 'rgb(255, 90, 90)';
        m.lineWidth = s.size;
        m.lineCap = 'round';
        m.lineJoin = 'round';
        m.beginPath();
        m.moveTo(s.points[0].x, s.points[0].y);
        if (s.points.length === 1) m.lineTo(s.points[0].x, s.points[0].y);
        for (let i = 1; i < s.points.length; i++) m.lineTo(s.points[i].x, s.points[i].y);
        m.stroke();
      }
    };
    this.strokes.forEach(draw);
    if (preview) draw(preview);
  }

  pushHistory() {
    const snap = {
      dataURL: this.canvas.toDataURL('image/png'),
      width: this.canvas.width,
      height: this.canvas.height,
      strokes: this.strokes.map(s => s.tool === 'rect'
        ? { ...s }
        : { ...s, points: s.points.map(p => ({ ...p })) }),
    };
    this.history.push(snap);
    if (this.history.length > 20) this.history.shift();
  }

  async restoreState(snap) {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('撤销恢复失败'));
      i.src = snap.dataURL;
    });
    this.canvas.width = snap.width;
    this.canvas.height = snap.height;
    this.ctx.drawImage(img, 0, 0);
    this.maskCanvas.width = snap.width;
    this.maskCanvas.height = snap.height;
    this.strokes = snap.strokes.map(s => s.tool === 'rect'
      ? { ...s }
      : { ...s, points: s.points.map(p => ({ ...p })) });
    this.redrawMask();
    this.fitCanvasSize();
  }

  async undo() {
    this.aiRunId++;
    if (this.current) {
      this.current = null;
      this.redrawMask();
      return;
    }
    if (this.history.length) {
      const snap = this.history.pop();
      try {
        await this.restoreState(snap);
        $('#imgResult').classList.add('hidden');
        $('#imgStage').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (e) {
        toast(e.message);
      }
      return;
    }
    this.strokes.pop();
    this.redrawMask();
  }

  maskBBox() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of this.strokes) {
      let x0, y0, x1, y1;
      if (s.tool === 'rect') {
        x0 = Math.min(s.x, s.x + s.w); x1 = Math.max(s.x, s.x + s.w);
        y0 = Math.min(s.y, s.y + s.h); y1 = Math.max(s.y, s.y + s.h);
      } else {
        for (const p of s.points) {
          x0 = Math.min(p.x - s.size, x0 === undefined ? p.x - s.size : x0);
          x1 = Math.max(p.x + s.size, x1 === undefined ? p.x + s.size : x1);
          y0 = Math.min(p.y - s.size, y0 === undefined ? p.y - s.size : y0);
          y1 = Math.max(p.y + s.size, y1 === undefined ? p.y + s.size : y1);
        }
      }
      minX = Math.min(minX, x0); maxX = Math.max(maxX, x1);
      minY = Math.min(minY, y0); maxY = Math.max(maxY, y1);
    }
    if (!isFinite(minX)) return null;
    const pad = 10;
    minX = Math.max(0, Math.floor(minX - pad));
    minY = Math.max(0, Math.floor(minY - pad));
    maxX = Math.min(this.canvas.width, Math.ceil(maxX + pad));
    maxY = Math.min(this.canvas.height, Math.ceil(maxY + pad));
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  async loadFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      toast('请选择图片文件（JPG / PNG / WebP）');
      return;
    }
    const MAX = 2800;
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(file, { resizeQuality: 'high' });
      const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
      if (scale < 1) {
        const w = Math.round(bitmap.width * scale);
        const h = Math.round(bitmap.height * scale);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(bitmap, 0, 0, w, h);
        bitmap.close();
        bitmap = await createImageBitmap(c);
      }
    } catch (e) {
      // Safari 旧版本兜底
      const url = URL.createObjectURL(file);
      bitmap = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
          const c = document.createElement('canvas');
          c.width = Math.round(img.naturalWidth * scale);
          c.height = Math.round(img.naturalHeight * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          createImageBitmap(c).then(res).catch(() => res(c));
        };
        img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('图片加载失败')); };
        img.src = url;
      });
    }

    this.canvas.width = bitmap.width;
    this.canvas.height = bitmap.height;
    this.maskCanvas.width = bitmap.width;
    this.maskCanvas.height = bitmap.height;
    this.ctx.drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();
    this.strokes = [];
    this.history = [];
    this.aiRunId++;
    this.redrawMask();
    this.loaded = true;

    $('#imgDropZone').classList.add('hidden');
    $('#imgEditor').classList.remove('hidden');
    $('#imgResult').classList.add('hidden');
    this.fitCanvasSize();
    this.updateHint();
  }

  fitCanvasSize() {
    const stage = $('#imgStage');
    const availW = stage.clientWidth - 2;
    const availH = Math.min(window.innerHeight * 0.55, 620);
    const scale = Math.min(1, availW / this.canvas.width, availH / this.canvas.height);
    const w = Math.floor(this.canvas.width * scale);
    const h = Math.floor(this.canvas.height * scale);
    for (const c of [this.canvas, this.maskCanvas]) {
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    }
    stage.style.minHeight = h + 'px';
  }

  getRectStroke() {
    return this.strokes.find(s => s.tool === 'rect');
  }

  async apply() {
    if (!this.loaded || this.busy) return;
    const mode = $('input[name="imgMode"]:checked').value;

    if (mode === 'crop') {
      const rect = this.getRectStroke();
      if (!rect) { toast('请先用「框选」工具框住水印区域'); return; }
      const norm = { x: Math.min(rect.x, rect.x + rect.w), y: Math.min(rect.y, rect.y + rect.h), w: Math.abs(rect.w), h: Math.abs(rect.h) };
      const keep = stripCropFor(this.canvas.width, this.canvas.height, norm);
      if (!keep) { toast('选区过大，请缩小选区或改用其他模式'); return; }
      this.pushHistory();
      this.runCrop(keep);
      return;
    }

    const bbox = this.maskBBox();
    if (!bbox) { toast('请先涂抹或框选水印区域'); return; }
    const area = bbox.w * bbox.h;
    if (mode === 'inpaint' && area > 420000 && !confirm(`标记区域较大（${bbox.w}×${bbox.h}），智能填充可能需要较长时间，是否继续？`)) return;

    const before = document.createElement('canvas');
    before.width = this.canvas.width;
    before.height = this.canvas.height;
    before.getContext('2d').drawImage(this.canvas, 0, 0);

    const busy = $('#imgBusy');
    busy.classList.remove('hidden');
    this.busy = true;
    await new Promise(r => setTimeout(r, 30)); // 让 loading 先渲染

    this.pushHistory();

    let maskSnap = null;
    if (mode === 'inpaint') {
      maskSnap = document.createElement('canvas');
      maskSnap.width = this.maskCanvas.width;
      maskSnap.height = this.maskCanvas.height;
      maskSnap.getContext('2d').drawImage(this.maskCanvas, 0, 0);
    }

    const busyText = $('#imgBusyText');
    try {
      if (mode === 'inpaint') {
        if (busyText) busyText.textContent = '正在快速修复…';
        await this.runInpaint(bbox);
        this.showResult(before, this.canvas);
        const skipAi = new URLSearchParams(location.search).has('noai') || window.__skipAi === true;
        if (skipAi) {
          toast('✅ 处理完成（测试模式，已跳过 AI）', 2600);
        } else {
          if (busyText) busyText.textContent = '🧠 正在加载内置 AI 模型（首次需下载约 60MB）…';
          const ok = await this.aiRefine(maskSnap, bbox);
          if (busyText) busyText.textContent = ok ? '✅ AI 修复完成' : '已保留快速修复结果';
        }
      } else {
        this.runMosaic(bbox, +$('#imgMosaicSize').value);
        this.showResult(before, this.canvas);
      }
    } catch (e) {
      console.error(e);
      toast('处理失败：' + e.message);
    } finally {
      this.busy = false;
      busy.classList.add('hidden');
    }
  }

  runInpaint(bbox) {
    return new Promise((resolve, reject) => {
      const w = bbox.w, h = bbox.h;
      // 从遮罩层读取 mask
      const maskData = this.mctx.getImageData(bbox.x, bbox.y, w, h).data;
      const mask = new Uint8Array(w * h);
      for (let i = 0, j = 3; i < w * h; i++, j += 4) mask[i] = maskData[j] > 128 ? 1 : 0;
      const img = this.ctx.getImageData(bbox.x, bbox.y, w, h);
      const ok = teleaInpaint(img.data, w, h, mask);
      if (!ok) { reject(new Error('标记区域没有可用的周围像素')); return; }
      this.ctx.putImageData(img, bbox.x, bbox.y);
      this.strokes = [];
      this.redrawMask();
      resolve();
    });
  }

  runMosaic(bbox, block) {
    const img = this.ctx.getImageData(bbox.x, bbox.y, bbox.w, bbox.h);
    mosaicRect(img.data, bbox.w, bbox.h, { x: 0, y: 0, w: bbox.w, h: bbox.h }, block);
    this.ctx.putImageData(img, bbox.x, bbox.y);
    this.strokes = [];
    this.redrawMask();
  }

  runCrop(keep) {
    const out = document.createElement('canvas');
    out.width = Math.round(keep.w);
    out.height = Math.round(keep.h);
    out.getContext('2d').drawImage(this.canvas, Math.round(keep.x), Math.round(keep.y), out.width, out.height, 0, 0, out.width, out.height);
    const before = document.createElement('canvas');
    before.width = this.canvas.width;
    before.height = this.canvas.height;
    before.getContext('2d').drawImage(this.canvas, 0, 0);
    this.canvas.width = out.width;
    this.canvas.height = out.height;
    this.ctx.drawImage(out, 0, 0);
    this.maskCanvas.width = out.width;
    this.maskCanvas.height = out.height;
    this.strokes = [];
    this.redrawMask();
    this.fitCanvasSize();
    this.showResult(before, this.canvas);
  }

  async aiRefine(maskSnap, bbox) {
    const busyText = $('#imgBusyText');
    const setMsg = m => { if (busyText) busyText.textContent = m; };
    const runId = ++this.aiRunId;
    if (!this.ai || !this.ai.isAvailable()) {
      window.__aiDone = false;
      toast('AI 运行库未加载，已保留快速修复结果', 4000);
      return false;
    }
    try {
      const out = await this.ai.inpaint(this.canvas, maskSnap, bbox, setMsg);
      window.__aiDone = true;
      if (this.aiRunId !== runId) return false;
      this.ctx.drawImage(out, 0, 0);
      const av = $('#imgAfterView');
      if (av && av.width) av.getContext('2d').drawImage(this.canvas, 0, 0);
      toast('✨ AI 修复完成', 3200);
      return true;
    } catch (e) {
      console.error('AI 修复失败', e);
      window.__aiDone = false;
      toast('AI 修复失败，已保留快速修复结果：' + (e && e.message ? String(e.message).slice(0, 90) : e), 5000);
      return false;
    }
  }

  showResult(beforeCanvas, afterCanvas) {
    const bv = $('#imgBeforeView');
    const av = $('#imgAfterView');
    bv.width = afterCanvas.width;
    bv.height = afterCanvas.height;
    av.width = afterCanvas.width;
    av.height = afterCanvas.height;
    // before 以 cover 方式铺满，保证对比对齐
    const bctx = bv.getContext('2d');
    const s = Math.max(bv.width / beforeCanvas.width, bv.height / beforeCanvas.height);
    const sw = beforeCanvas.width * s, sh = beforeCanvas.height * s;
    bctx.drawImage(beforeCanvas, (bv.width - sw) / 2, (bv.height - sh) / 2, sw, sh);
    av.getContext('2d').drawImage(afterCanvas, 0, 0);
    this.updateCompare(+$('#imgCompareRange').value);
    $('#imgResult').classList.remove('hidden');
    $('#imgResult').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  bindCompare() {
    const range = $('#imgCompareRange');
    range.addEventListener('input', () => this.updateCompare(+range.value));
  }

  updateCompare(v) {
    const top = $('#imgAfterView');
    const divider = $('#imgDivider');
    top.style.clipPath = `inset(0 ${100 - v}% 0 0)`;
    divider.style.left = v + '%';
  }

  bindButtons() {
    $('#imgApplyBtn').addEventListener('click', () => this.apply());
    $('#imgResetBtn').addEventListener('click', () => {
      this.loaded = false;
      this.strokes = [];
      this.history = [];
      this.current = null;
      this.aiRunId++;
      $('#imgEditor').classList.add('hidden');
      $('#imgResult').classList.add('hidden');
      $('#imgDropZone').classList.remove('hidden');
    });
    $('#imgPickBtn').addEventListener('click', () => $('#imgInput').click());
    $('#imgCameraBtn').addEventListener('click', () => $('#imgCameraInput').click());
    $('#imgInput').addEventListener('change', e => {
      if (e.target.files[0]) this.loadFile(e.target.files[0]);
      e.target.value = '';
    });
    $('#imgCameraInput').addEventListener('change', e => {
      if (e.target.files[0]) this.loadFile(e.target.files[0]);
      e.target.value = '';
    });
    $('#imgDownloadBtn').addEventListener('click', async () => {
      const blob = await new Promise(r => this.canvas.toBlob(r, 'image/png'));
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      saveResult(blob, `去水印图片-${ts}.png`);
    });
    $('#imgShareBtn').addEventListener('click', async () => {
      const blob = await new Promise(r => this.canvas.toBlob(r, 'image/png'));
      shareResult(blob, `去水印图片.png`);
    });
    $('#imgEditAgainBtn').addEventListener('click', () => {
      $('#imgResult').classList.add('hidden');
      $('#imgStage').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  bindDropZone() {
    const zone = $('#imgDropZone');
    ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => {
      e.preventDefault();
      zone.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => {
      e.preventDefault();
      zone.classList.remove('dragover');
    }));
    zone.addEventListener('drop', e => {
      const f = e.dataTransfer.files[0];
      if (f) this.loadFile(f);
    });
    zone.addEventListener('click', e => {
      if (e.target.closest('button, input')) return;
      $('#imgInput').click();
    });
  }
}

/* ============================================================
 * 可拖拽缩放选框（视频）
 * ============================================================ */
class RegionBox {
  constructor(boxEl, containerEl) {
    this.box = boxEl;
    this.container = containerEl;
    this.rect = { x: 0, y: 0, w: 100, h: 60 };
    this.drag = null;
    this.bind();
  }

  videoBounds() {
    const video = $('#video');
    const vr = video.getBoundingClientRect();
    const cr = this.container.getBoundingClientRect();
    return { x: vr.left - cr.left, y: vr.top - cr.top, w: vr.width, h: vr.height };
  }

  setFromVideoRect(videoW, videoH, vRect) {
    const b = this.videoBounds();
    const sx = b.w / videoW, sy = b.h / videoH;
    this.rect = {
      x: vRect.x * sx,
      y: vRect.y * sy,
      w: vRect.w * sx,
      h: vRect.h * sy,
    };
    this.render();
  }

  defaultRect() {
    const b = this.videoBounds();
    const w = b.w * 0.3, h = b.h * 0.18;
    this.rect = { x: b.w - w - 12, y: b.h - h - 12, w, h };
    this.render();
  }

  render() {
    const r = this.rect;
    this.box.style.left = r.x + 'px';
    this.box.style.top = r.y + 'px';
    this.box.style.width = r.w + 'px';
    this.box.style.height = r.h + 'px';
  }

  clamp() {
    const b = this.videoBounds();
    if (!b.w) return;
    const r = this.rect;
    r.w = Math.min(r.w, b.w);
    r.h = Math.min(r.h, b.h);
    r.x = Math.max(0, Math.min(r.x, b.w - r.w));
    r.y = Math.max(0, Math.min(r.y, b.h - r.h));
  }

  bind() {
    const box = this.box;
    box.addEventListener('pointerdown', e => {
      e.preventDefault();
      const dir = e.target.dataset ? e.target.dataset.dir : null;
      this.drag = {
        dir: dir || 'move',
        startX: e.clientX,
        startY: e.clientY,
        rect: { ...this.rect },
      };
      box.setPointerCapture(e.pointerId);
    });
    box.addEventListener('pointermove', e => {
      if (!this.drag) return;
      e.preventDefault();
      const b = this.videoBounds();
      const dx = e.clientX - this.drag.startX;
      const dy = e.clientY - this.drag.startY;
      let r = { ...this.drag.rect };
      const d = this.drag.dir;
      if (d === 'move') {
        r.x += dx; r.y += dy;
      } else {
        if (d.includes('e')) { r.w = Math.max(24, this.drag.rect.w + dx); }
        if (d.includes('s')) { r.h = Math.max(24, this.drag.rect.h + dy); }
        if (d.includes('w')) { r.w = Math.max(24, this.drag.rect.w - dx); r.x = this.drag.rect.x + (this.drag.rect.w - r.w); }
        if (d.includes('n')) { r.h = Math.max(24, this.drag.rect.h - dy); r.y = this.drag.rect.y + (this.drag.rect.h - r.h); }
      }
      r.x = Math.max(0, Math.min(r.x, b.w - r.w));
      r.y = Math.max(0, Math.min(r.y, b.h - r.h));
      r.w = Math.min(r.w, b.w);
      r.h = Math.min(r.h, b.h);
      this.rect = r;
      this.render();
    });
    const end = e => {
      this.drag = null;
      try { box.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
  }

  /** 返回视频像素坐标系下的选区 */
  videoRect() {
    const video = $('#video');
    const b = this.videoBounds();
    if (!b.w || !video.videoWidth) return null;
    const sx = video.videoWidth / b.w;
    const sy = video.videoHeight / b.h;
    const r = this.rect;
    return {
      x: Math.max(0, Math.floor(r.x * sx)),
      y: Math.max(0, Math.floor(r.y * sy)),
      w: Math.min(video.videoWidth, Math.ceil(r.w * sx)),
      h: Math.min(video.videoHeight, Math.ceil(r.h * sy)),
    };
  }
}

/* ============================================================
 * 视频编辑器
 * ============================================================ */
class VideoEditor {
  constructor() {
    this.video = $('#video');
    this.stage = $('#vidStage');
    this.box = new RegionBox($('#vidBox'), this.stage);
    this.recorder = null;
    this.chunks = [];
    this.rafId = null;
    this.processing = false;
    this.audioCtx = null;
    this.streamDest = null;
    this.noAudio = false;
    this.loaded = false;

    this.bindButtons();
    this.bindDropZone();
    this.bindMode();
    window.addEventListener('resize', () => {
      if (this.loaded && this.video.videoWidth) this.box.clamp();
    });
  }

  bindMode() {
    $$('input[name="vidMode"]').forEach(r => r.addEventListener('change', () => {
      $('#vidMosaicGroup').classList.toggle('hidden', $('input[name="vidMode"]:checked').value !== 'mosaic');
    }));
  }

  loadFile(file) {
    if (!file || !file.type.startsWith('video/')) {
      toast('请选择视频文件（MP4 / MOV / WebM）');
      return;
    }
    if (this.video.src) URL.revokeObjectURL(this.video.src);
    this.video.src = URL.createObjectURL(file);
    this.video.onloadedmetadata = () => {
      this.loaded = true;
      $('#vidDropZone').classList.add('hidden');
      $('#vidEditor').classList.remove('hidden');
      $('#vidResult').classList.add('hidden');
      this.box.defaultRect();
    };
    this.video.onerror = () => {
      toast('视频格式无法解析，请尝试 MP4 (H.264) 格式');
    };
  }

  pickMime() {
    const cands = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    for (const m of cands) {
      try {
        if (MediaRecorder.isTypeSupported(m)) return m;
      } catch (_) {}
    }
    return '';
  }

  setupAudio() {
    if (this.noAudio) return null;
    try {
      if (!this.audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { this.noAudio = true; return null; }
        this.audioCtx = new AC();
        const src = this.audioCtx.createMediaElementSource(this.video);
        this.streamDest = this.audioCtx.createMediaStreamDestination();
        src.connect(this.streamDest);
      }
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
      return this.streamDest.stream.getAudioTracks()[0] || null;
    } catch (e) {
      this.noAudio = true;
      return null;
    }
  }

  start() {
    if (!this.loaded || this.processing) return;
    const v = this.video;
    if (!v.duration || v.readyState < 2) { toast('视频还没准备好，请稍等'); return; }
    const mode = $('input[name="vidMode"]:checked').value;
    const region = this.box.videoRect();
    if (!region) { toast('无法获取选区，请调整后重试'); return; }

    // ---- 准备画布 ----
    const vw = v.videoWidth, vh = v.videoHeight;
    let outW, outH, sx, sy, sw, sh;
    if (mode === 'crop') {
      const keep = stripCropFor(vw, vh, region);
      if (!keep) { toast('裁剪选区过大或位置不对，请调整水印框'); return; }
      outW = Math.round(keep.w); outH = Math.round(keep.h);
      sx = Math.round(keep.x); sy = Math.round(keep.y); sw = outW; sh = outH;
    } else {
      const scale = Math.min(1, 1280 / Math.max(vw, vh));
      outW = Math.round(vw * scale);
      outH = Math.round(vh * scale);
      sx = 0; sy = 0; sw = vw; sh = vh;
    }
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d', { willReadFrequently: mode === 'inpaint' });

    // 非裁剪模式下的处理区域
    let procRegion = null;
    if (mode !== 'crop') {
      const scaleX = outW / vw, scaleY = outH / vh;
      procRegion = {
        x: Math.max(0, Math.floor(region.x * scaleX)),
        y: Math.max(0, Math.floor(region.y * scaleY)),
        w: Math.min(outW, Math.ceil(region.w * scaleX)),
        h: Math.min(outH, Math.ceil(region.h * scaleY)),
      };
    }

    // ---- 音频（必须在手势中同步创建）----
    const audioTrack = this.setupAudio();

    // ---- 流与录制器 ----
    let canvasStream;
    try {
      canvasStream = canvas.captureStream(0);
    } catch (e) {
      toast('当前浏览器不支持视频处理，请使用最新版 Chrome / Safari');
      return;
    }
    const track = canvasStream.getVideoTracks()[0];
    const tracks = [track];
    if (audioTrack) tracks.push(audioTrack);
    const stream = new MediaStream(tracks);
    const mime = this.pickMime();
    try {
      this.recorder = mime ? new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 }) : new MediaRecorder(stream);
    } catch (e) {
      toast('录制初始化失败：' + e.message);
      tracks.forEach(t => t.stop());
      return;
    }
    this.chunks = [];
    this.recorder.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recorder.onstop = () => this.onRecordDone(mime);
    this.recorder.start(500);

    // ---- 开始播放并逐帧处理 ----
    this.processing = true;
    $('#vidBusy').classList.remove('hidden');
    $('#vidBusyText').textContent = `正在处理 0:00 / ${fmtTime(v.duration)}`;
    v.currentTime = 0;
    v.play().catch(e => {
      toast('视频播放失败：' + e.message);
      this.finish();
    });

    const mosaicBlock = +$('#vidMosaicSize').value;
    const margin = mode === 'inpaint' ? 24 : 0;
    let lastT = -1;
    const loop = () => {
      if (!this.processing) return;
      if (Math.abs(v.currentTime - lastT) > 1 / 120 || (v.ended && lastT < 0)) {
        lastT = v.currentTime;
        ctx.drawImage(v, sx, sy, sw, sh, 0, 0, outW, outH);
        if (mode === 'mosaic' && procRegion) {
          const img = ctx.getImageData(procRegion.x, procRegion.y, procRegion.w, procRegion.h);
          mosaicRect(img.data, procRegion.w, procRegion.h, { x: 0, y: 0, w: procRegion.w, h: procRegion.h }, mosaicBlock);
          ctx.putImageData(img, procRegion.x, procRegion.y);
        } else if (mode === 'inpaint' && procRegion) {
          const rx = Math.max(0, procRegion.x - margin);
          const ry = Math.max(0, procRegion.y - margin);
          const rw = Math.min(outW - rx, procRegion.w + margin * 2);
          const rh = Math.min(outH - ry, procRegion.h + margin * 2);
          const img = ctx.getImageData(rx, ry, rw, rh);
          const mask = new Uint8Array(rw * rh);
          const bx0 = Math.max(0, procRegion.x - rx);
          const by0 = Math.max(0, procRegion.y - ry);
          const bx1 = Math.min(rw, bx0 + procRegion.w);
          const by1 = Math.min(rh, by0 + procRegion.h);
          for (let y = by0; y < by1; y++) {
            for (let x = bx0; x < bx1; x++) mask[y * rw + x] = 1;
          }
          teleaInpaint(img.data, rw, rh, mask);
          ctx.putImageData(img, rx, ry);
        }
        if (track.requestFrame) track.requestFrame();
        $('#vidBusyText').textContent = `正在处理 ${fmtTime(v.currentTime)} / ${fmtTime(v.duration)}`;
      }
      if (v.ended) {
        this.finish();
        return;
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);

    this.video.onended = () => {
      if (this.processing) this.finish();
    };
  }

  finish() {
    if (!this.processing) return;
    this.processing = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.video.pause();
    try {
      const track = this.recorder.stream.getVideoTracks()[0];
      if (track && track.requestFrame) track.requestFrame();
    } catch (_) {}
    setTimeout(() => {
      try { if (this.recorder.state !== 'inactive') this.recorder.stop(); } catch (_) {}
    }, 60);
  }

  onRecordDone(mime) {
    try {
      this.recorder.stream.getTracks().forEach(t => t.stop());
    } catch (_) {}
    const blob = new Blob(this.chunks, { type: mime || 'video/mp4' });
    const ext = (mime || '').includes('webm') ? 'webm' : 'mp4';
    this.resultBlob = blob;
    this.resultExt = ext;
    const url = URL.createObjectURL(blob);
    const out = $('#vidOut');
    if (out.src) URL.revokeObjectURL(out.src);
    out.src = url;
    $('#vidBusy').classList.add('hidden');
    $('#vidResult').classList.remove('hidden');
    $('#vidResult').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (!this.chunks.length) toast('未录制到数据，请重试');
  }

  bindButtons() {
    $('#vidPickBtn').addEventListener('click', () => $('#vidInput').click());
    $('#vidCameraBtn').addEventListener('click', () => $('#vidCameraInput').click());
    $('#vidInput').addEventListener('change', e => {
      if (e.target.files[0]) this.loadFile(e.target.files[0]);
      e.target.value = '';
    });
    $('#vidCameraInput').addEventListener('change', e => {
      if (e.target.files[0]) this.loadFile(e.target.files[0]);
      e.target.value = '';
    });
    $('#vidStartBtn').addEventListener('click', () => this.start());
    $('#vidStopBtn').addEventListener('click', () => {
      if (this.processing) { toast('已停止，正在保存已处理的部分…'); this.finish(); }
    });
    $('#vidResetBtn').addEventListener('click', () => {
      this.loaded = false;
      this.video.pause();
      if (this.video.src) URL.revokeObjectURL(this.video.src);
      this.video.removeAttribute('src');
      $('#vidEditor').classList.add('hidden');
      $('#vidResult').classList.add('hidden');
      $('#vidDropZone').classList.remove('hidden');
    });
    $('#vidDownloadBtn').addEventListener('click', () => {
      if (!this.resultBlob) return;
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      saveResult(this.resultBlob, `去水印视频-${ts}.${this.resultExt}`);
    });
    $('#vidShareBtn').addEventListener('click', () => {
      if (!this.resultBlob) return;
      shareResult(this.resultBlob, `去水印视频.${this.resultExt}`);
    });
  }

  bindDropZone() {
    const zone = $('#vidDropZone');
    ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => {
      e.preventDefault();
      zone.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => {
      e.preventDefault();
      zone.classList.remove('dragover');
    }));
    zone.addEventListener('drop', e => {
      const f = e.dataTransfer.files[0];
      if (f) this.loadFile(f);
    });
    zone.addEventListener('click', e => {
      if (e.target.closest('button, input')) return;
      $('#vidInput').click();
    });
  }
}

/* ============================================================
 * PWA 与初始化
 * ============================================================ */
function initPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.warn('SW 注册失败', err);
    });
  }

  const btn = $('#installBtn');
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    if (!isStandalone()) btn.hidden = false;
  });
  btn.addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') { btn.hidden = true; deferredPrompt = null; }
      return;
    }
    if (isIOS()) {
      toast('iPhone：点 Safari 底部「分享」按钮 → 选择「添加到主屏幕」，即可像 App 一样使用', 6000);
    } else {
      toast('请使用 Chrome / Edge 浏览器菜单中的「安装应用」', 4000);
    }
  });
  if (isIOS() && !isStandalone()) btn.hidden = false;
  if (isStandalone()) btn.hidden = true;
}

function initTabs() {
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      $('#panel-' + tab.dataset.tab).classList.add('active');
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initPWA();
  initTabs();
  window.imgEditor = new ImageEditor();
  window.videoEditor = new VideoEditor();
});
