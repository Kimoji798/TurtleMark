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
/* ============================================================
 * 模型下载引擎：并行分块 + 多镜像 + Cache API 缓存 + 进度回调
 * 部署在 GitHub Pages 时优先走 jsDelivr CDN（国内下载更快）
 * ============================================================ */
const MODEL_CDN = 'https://cdn.jsdelivr.net/gh/Kimoji798/TurtleMark@main/';
const MODEL_MIRRORS = [
  'https://cdn.jsdelivr.net/gh/Kimoji798/TurtleMark@main/',
  'https://fastly.jsdelivr.net/gh/Kimoji798/TurtleMark@main/',
  'https://gcore.jsdelivr.net/gh/Kimoji798/TurtleMark@main/',
  'https://ghfast.top/https://raw.githubusercontent.com/Kimoji798/TurtleMark/main/',
];

const MODEL_CACHE = 'turtlemark-models';
const LAMA_TOTAL = 62208604;
const LAMA_PARTS = 8;

function pad2(n) { return String(n).padStart(2, '0'); }

async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let idx = 0;
  const workers = [];
  const run = async () => {
    for (;;) {
      const i = idx++;
      if (i >= arr.length) return;
      out[i] = await fn(arr[i], i);
    }
  };
  for (let w = 0; w < Math.min(limit, arr.length); w++) workers.push(run());
  await Promise.all(workers);
  return out;
}

class ModelFetcher {
  static get preferCdn() {
    return /github\.io$/i.test(location.hostname) || new URLSearchParams(location.search).has('cdn');
  }

  static async openCache() {
    try { return await caches.open(MODEL_CACHE); } catch (e) { return null; }
  }

  /** 依次尝试多个候选地址：先并发探测所有镜像挑最快可用源，带超时保护与重试。返回 { blob, url }。 */
  static async fetchBlob(urls, onProgress, opts = {}) {
    const cands = Array.isArray(urls[0]) ? urls : [urls];
    const flat = [];
    for (const group of cands) for (const u of group) if (!flat.includes(u)) flat.push(u);
    const attempts = opts.attempts || 2;
    let lastErr = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const cache = await this.openCache();
      if (cache) {
        for (const url of flat) {
          try {
            const hit = await cache.match(url);
            if (hit) {
              const blob = await hit.blob();
              if (blob && blob.size > 0) {
                if (onProgress) onProgress(1, blob.size, blob.size, url);
                return { blob, url };
              }
            }
          } catch (_) {}
        }
      }
      const probes = await this.probeCandidates(flat, opts.probeMs || 6000);
      const order = probes.length ? probes : flat;
      for (const url of order) {
        try {
          const blob = await this.downloadOne(url, onProgress, opts);
          if (cache) {
            try {
              await cache.put(url, new Response(blob, { headers: { 'Content-Type': 'application/octet-stream' } }));
            } catch (_) {}
          }
          return { blob, url };
        } catch (e) {
          lastErr = e;
          if (opts.onUrlFail) opts.onUrlFail(url, e);
          console.warn('模型下载源失败，尝试下一个：', url, e && e.message);
        }
      }
      if (attempt < attempts - 1) await new Promise(r => setTimeout(r, 600));
    }
    throw lastErr || new Error('模型下载失败');
  }

  /** 并发探测所有候选地址（Range 探针），按响应速度排序返回可用 URL 列表 */
  static async probeCandidates(flat, ms) {
    const jobs = flat.map(async url => {
      const t0 = performance.now();
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), ms);
        const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store', signal: ctl.signal });
        clearTimeout(timer);
        if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
        return { url, ms: performance.now() - t0 };
      } catch (_) { return null; }
    });
    return (await Promise.all(jobs)).filter(Boolean).sort((a, b) => a.ms - b.ms).map(x => x.url);
  }

  /** 下载单个地址：无进展 20 秒自动切换下一个源，整体 90 秒上限 */
  static async downloadOne(url, onProgress, opts = {}) {
    const ctl = new AbortController();
    let timer = setTimeout(() => ctl.abort(), opts.stallMs || 20000);
    const totalTimer = setTimeout(() => ctl.abort(), opts.totalMs || 90000);
    const guard = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), opts.stallMs || 20000); };
    try {
      return await this.parallelDownload(url, (pct, done, total) => {
        guard();
        if (onProgress) onProgress(pct, done, total, url);
      }, Object.assign({}, opts, { signal: ctl.signal }));
    } finally {
      clearTimeout(timer); clearTimeout(totalTimer);
    }
  }

  /** 单地址下载：支持 Range 时 8 线程并行分块（慢网络可提速数倍） */
  static async parallelDownload(url, onProgress, opts = {}) {
    const chunkN = opts.chunks || 8;
    let total = 0;
    let canRange = false;
    let probe = null;
    try {
      probe = await fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store', signal: opts.signal });
      canRange = probe.status === 206;
      const cr = probe.headers.get('content-range') || '';
      total = +(cr.split('/').pop() || 0);
    } catch (_) {}
    if (probe && probe.status === 200) {
      const blob = await probe.blob();
      if (blob && blob.size > 0) {
        if (onProgress) onProgress(1, blob.size, blob.size, url);
        return blob;
      }
    }
    if (canRange && total >= 2 * 1024 * 1024) {
      const partSize = Math.ceil(total / chunkN);
      const parts = new Array(chunkN);
      const progress = new Float64Array(chunkN);
      await mapLimit(parts, Math.min(chunkN, 6), async (_, i) => {
        const start = i * partSize;
        if (start >= total) return;
        const end = Math.min(total, start + partSize) - 1;
        let lastErr = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await fetch(url, { headers: { Range: 'bytes=' + start + '-' + end }, cache: 'no-store', signal: opts.signal });
            if (res.status !== 206 || !res.body) throw new Error('HTTP ' + res.status);
            const reader = res.body.getReader();
            const chunks = [];
            let got = 0;
            for (;;) {
              const r = await reader.read();
              if (r.done) break;
              chunks.push(r.value);
              got += r.value.length;
              progress[i] = got;
              if (onProgress) {
                let sum = 0;
                for (let k = 0; k < chunkN; k++) sum += progress[k];
                onProgress(Math.min(1, sum / total), sum, total, url);
              }
            }
            const part = new Blob(chunks);
            if (part.size !== end - start + 1) throw new Error('分块大小不符');
            parts[i] = part;
            return;
          } catch (e) { lastErr = e; }
        }
        throw lastErr || new Error('分块下载失败');
      });
      const blob = new Blob(parts);
      if (blob.size !== total) throw new Error('模型大小校验失败');
      return blob;
    }
    const res = await fetch(url, { cache: 'no-store', signal: opts.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (!res.body) {
      const blob = await res.blob();
      if (onProgress) onProgress(1, blob.size, blob.size, url);
      return blob;
    }
    total = +(res.headers.get('content-length') || 0);
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
      got += r.value.length;
      if (onProgress && total) onProgress(Math.min(1, got / total), got, total, url);
    }
    const blob = new Blob(chunks);
    if (total && blob.size !== total) throw new Error('模型大小校验失败');
    if (onProgress) onProgress(1, blob.size, blob.size, url);
    return blob;
  }

  /** 预下载 onnxruntime 的 wasm 引擎并设置 wasmPaths（带进度）。
   * 使用 1.18 的非线程 SIMD 构建：不依赖 SharedArrayBuffer / 跨域隔离，
   * iPhone Safari 与安卓 WebView 均可用；推理放在代理 Worker 里，界面不卡死。 */
  static async prepareOrt(ort, onProgress) {
    const localDir = new URL('assets/onnx/', document.baseURI).href;
    const dirs = this.preferCdn
      ? MODEL_MIRRORS.map(m => m + 'assets/onnx/').concat([localDir])
      : [localDir].concat(MODEL_MIRRORS.map(m => m + 'assets/onnx/'));
    const files = ['ort-wasm-simd.wasm'];
    for (const f of files) {
      try {
        const res = await this.fetchBlob(dirs.map(d => d + f), (pct, done, total) => {
          if (onProgress) onProgress('正在下载 AI 引擎 ' + Math.round(pct * 100) + '%', pct, done, total);
        });
        // 同时写入同源地址的缓存：ORT 用同源地址加载 wasm，命中后离线可用
        if (res && res.blob && res.url !== localDir + f) {
          try {
            const cache = await this.openCache();
            if (cache) await cache.put(new Request(localDir + f), new Response(res.blob, { headers: { 'Content-Type': 'application/wasm' } }));
          } catch (e) {
            console.warn('写入同源引擎缓存失败（不影响使用）', e);
          }
        }
      } catch (e) {
        console.warn('AI 引擎预载失败，交给运行时处理', f, e);
      }
    }
    ort.env.wasm.wasmPaths = localDir;
    ort.env.wasm.numThreads = 1;
    // 1.18 的 proxy 使用 blob URL worker（同源），手机端安全；创建失败会自动回退主线程
    ort.env.wasm.proxy = true;
  }
}

/** 创建 ORT 会话：优先在代理 Worker 中推理（界面不卡）；手机端 Worker 失败时自动回退主线程推理 */
async function createOrtSession(ort, modelBuffer, opts) {
  let lastErr = null;
  for (const useProxy of [true, false]) {
    try {
      ort.env.wasm.proxy = useProxy;
      const session = await ort.InferenceSession.create(modelBuffer, opts);
      try { window.__ortProxyMode = useProxy ? 'worker' : 'main'; } catch (_) {}
      return session;
    } catch (e) {
      lastErr = e;
      console.warn('ORT 会话创建失败（proxy=' + useProxy + '），自动回退', e);
    }
  }
  throw lastErr || new Error('AI 运行库初始化失败');
}

/* ============================================================
 * AI 修复：内置 LaMa 模型 + onnxruntime-web（纯本地推理，不上传）
 * 模型分 8 片 CDN 并行下载，带百分比进度，下载后自动缓存
 * ============================================================ */
class AiInpaint {
  constructor() {
    this.session = null;
    this.loading = null;
    this.modelSize = 512;
    this.modelTotal = LAMA_TOTAL;
    this.modelParts = LAMA_PARTS;
  }

  isAvailable() {
    return typeof window.ort !== 'undefined';
  }

  modelUrls() {
    const localDir = new URL('assets/model/lama/', document.baseURI).href;
    const urls = [];
    for (let i = 1; i <= this.modelParts; i++) {
      const f = 'part-' + pad2(i) + '.bin';
      const mirrors = MODEL_MIRRORS.map(m => m + 'assets/model/lama/' + f);
      urls.push(ModelFetcher.preferCdn ? mirrors.concat([localDir + f]) : [localDir + f].concat(mirrors));
    }
    return urls;
  }

  ensureSession(onProgress) {
    if (this.session) return Promise.resolve(this.session);
    if (this.loading) return this.loading;
    const ort = window.ort;
    if (!ort) return Promise.reject(new Error('AI 运行库加载失败'));
    this.loading = (async () => {
      await ModelFetcher.prepareOrt(ort, onProgress);
      const urls = this.modelUrls();
      const progress = new Float64Array(urls.length);
      const parts = await mapLimit(urls, 6, async (cands, i) => {
        const res = await ModelFetcher.fetchBlob(cands, (pct, done) => {
          progress[i] = done;
          let sum = 0;
          for (let k = 0; k < progress.length; k++) sum += progress[k];
          const p = Math.min(1, sum / this.modelTotal);
          if (onProgress) onProgress('正在下载 AI 修复模型 ' + Math.round(p * 100) + '%', p, sum, this.modelTotal);
        });
        return res.blob;
      });
      const blob = new Blob(parts);
      if (blob.size !== this.modelTotal) throw new Error('AI 修复模型大小校验失败');
      if (onProgress) onProgress('正在加载 AI 模型…');
      this.session = await createOrtSession(ort, await blob.arrayBuffer(), {
        executionProviders: ['wasm'], // LaMa 为 int8 量化模型，走 wasm 更稳
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
 * 常见 AI 图片水印自动检测（豆包「豆包AI」/ Gemini 菱形角标）
 * 原理：在四角区域寻找高对比度、低饱和度的文字/图形像素，
 * 连通域过滤 + 形态学膨胀后输出遮罩与包围盒。
 * ============================================================ */
function lum(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

function dilateMask(mask, w, h, times) {
  let src = mask;
  for (let t = 0; t < times; t++) {
    const dst = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (src[y * w + x]) { dst[y * w + x] = 1; continue; }
        let hit = 0;
        for (let dy = -1; dy <= 1 && !hit; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            if (src[ny * w + nx]) { hit = 1; break; }
          }
        }
        dst[y * w + x] = hit;
      }
    }
    src = dst;
  }
  return src;
}

function analyzeWatermarkRegion(data, W, H, reg) {
  const rx = reg.x, ry = reg.y, w = reg.w, h = reg.h;
  if (w < 8 || h < 8) return null;
  const n = w * h;
  const integral = new Float64Array((w + 1) * (h + 1));
  let sum = 0;
  for (let y = 0; y < h; y++) {
    let o = ((ry + y) * W + rx) * 4;
    let row = 0;
    for (let x = 0; x < w; x++, o += 4) {
      const L = lum(data[o], data[o + 1], data[o + 2]);
      row += L;
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
      sum += L;
    }
  }
  const mean = sum / n;
  const R = Math.max(10, Math.min(28, Math.round(Math.min(w, h) * 0.02)));
  const mask = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - R), y1 = Math.min(h - 1, y + R);
    let o = ((ry + y) * W + rx) * 4;
    for (let x = 0; x < w; x++, o += 4) {
      const x0 = Math.max(0, x - R), x1 = Math.min(w - 1, x + R);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const local = (integral[(y1 + 1) * (w + 1) + x1 + 1] - integral[(y1 + 1) * (w + 1) + x0]
        - integral[y0 * (w + 1) + x1 + 1] + integral[y0 * (w + 1) + x0]) / area;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      const L = lum(r, g, b);
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      let hit = 0;
      if (L > Math.max(158, mean + 42) && sat < 78) hit = 1;
      else if (L < Math.min(92, mean - 42) && sat < 78) hit = 1;
      else if (L > 92 && L - local > 22 && sat < 92) hit = 1;
      if (hit) mask[y * w + x] = 1;
    }
  }
  // 连通域过滤：去掉零散噪声与超大纯色块
  const kept = new Uint8Array(n);
  const seen = new Uint8Array(n);
  let components = 0;
  let px = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (!mask[i] || seen[i]) continue;
    seen[i] = 1;
    const stack = [i];
    let area = 0;
    const cells = [];
    while (stack.length) {
      const j = stack.pop();
      area++;
      cells.push(j);
      const cx = j % w, cy = (j / w) | 0;
      if (cx > 0 && mask[j - 1] && !seen[j - 1]) { seen[j - 1] = 1; stack.push(j - 1); }
      if (cx < w - 1 && mask[j + 1] && !seen[j + 1]) { seen[j + 1] = 1; stack.push(j + 1); }
      if (cy > 0 && mask[j - w] && !seen[j - w]) { seen[j - w] = 1; stack.push(j - w); }
      if (cy < h - 1 && mask[j + w] && !seen[j + w]) { seen[j + w] = 1; stack.push(j + w); }
    }
    if (area < 10 || area > n * 0.5) continue;
    components++;
    px += area;
    for (const j of cells) {
      kept[j] = 1;
      const cx = j % w, cy = (j / w) | 0;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
    }
  }
  if (px < 40 || !isFinite(minX)) return null;
  const grown = dilateMask(kept, w, h, 4);
  let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grown[y * w + x]) {
        if (x < gx0) gx0 = x;
        if (x > gx1) gx1 = x;
        if (y < gy0) gy0 = y;
        if (y > gy1) gy1 = y;
      }
    }
  }
  if (!isFinite(gx0)) return null;
  // 只保留 bbox 内的遮罩，与 x/y/w/h 对齐
  const mw = gx1 - gx0 + 1;
  const mh = gy1 - gy0 + 1;
  const cropped = new Uint8Array(mw * mh);
  for (let y = gy0, o = 0; y <= gy1; y++) {
    for (let x = gx0; x <= gx1; x++, o++) cropped[o] = grown[y * w + x];
  }
  return {
    mask: cropped,
    px,
    components,
    x: rx + gx0,
    y: ry + gy0,
    w: mw,
    h: mh,
  };
}

function detectWatermark(imageCanvas, type) {
  const W = imageCanvas.width, H = imageCanvas.height;
  const data = imageCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const rw = Math.min(Math.max(140, Math.round(W * 0.44)), 1500);
  const rh = Math.min(Math.max(80, Math.round(H * 0.28)), 850);
  let regions;
  if (type === 'doubao' || type === 'gemini') {
    regions = [{ x: W - rw, y: H - rh, w: rw, h: rh, bonus: 1 }];
  } else {
    regions = [
      { x: W - rw, y: H - rh, w: rw, h: rh, bonus: 1.0 },
      { x: 0, y: H - rh, w: rw, h: rh, bonus: 0.85 },
      { x: W - rw, y: 0, w: rw, h: rh, bonus: 0.75 },
      { x: 0, y: 0, w: rw, h: rh, bonus: 0.65 },
    ];
  }
  let best = null;
  for (const reg of regions) {
    const r = analyzeWatermarkRegion(data, W, H, reg);
    if (!r) continue;
    const score = r.px * (1 + Math.min(r.components, 40) * 0.06) * reg.bonus;
    if (!best || score > best.score) best = Object.assign({}, r, { score });
  }
  if (!best || best.score < 220) return null;
  if (best.px > rw * rh * 0.35) return null;
  return best;
}

/* ============================================================
 * AI 抠图：内置 U²-Net 轻量模型（u2netp 约 4.6MB）
 * 自动识别画面主体 → 透明 PNG 导出 / 配合 LaMa 移除主体
 * ============================================================ */
function largestAlphaComponent(canvas) {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const bin = new Uint8Array(w * h);
  for (let i = 0, j = 3; i < w * h; i++, j += 4) if (d[j] > 64) bin[i] = 1;
  const labels = new Int32Array(w * h).fill(-1);
  const areas = [];
  let bestId = -1, bestArea = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!bin[i] || labels[i] >= 0) continue;
      const id = areas.length;
      areas.push(0);
      const stack = [i];
      labels[i] = id;
      while (stack.length) {
        const j = stack.pop();
        areas[id]++;
        const cx = j % w, cy = (j / w) | 0;
        if (cx > 0 && bin[j - 1] && labels[j - 1] < 0) { labels[j - 1] = id; stack.push(j - 1); }
        if (cx < w - 1 && bin[j + 1] && labels[j + 1] < 0) { labels[j + 1] = id; stack.push(j + 1); }
        if (cy > 0 && bin[j - w] && labels[j - w] < 0) { labels[j - w] = id; stack.push(j - w); }
        if (cy < h - 1 && bin[j + w] && labels[j + w] < 0) { labels[j + w] = id; stack.push(j + w); }
      }
      if (areas[id] > bestArea) { bestArea = areas[id]; bestId = id; }
    }
  }
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const od = out.getContext('2d').createImageData(w, h);
  for (let i = 0, j = 3; i < w * h; i++, j += 4) {
    const a = (bestId >= 0 && labels[i] === bestId) ? 255 : 0;
    od.data[j - 3] = 255; od.data[j - 2] = 255; od.data[j - 1] = 255;
    od.data[j] = a;
  }
  out.getContext('2d').putImageData(od, 0, 0);
  return out;
}

function softEdgeMask(canvas, radius) {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const a = new Uint8Array(w * h);
  for (let i = 0, j = 3; i < w * h; i++, j += 4) a[i] = d[j];
  const out = new Uint8Array(w * h);
  const R = Math.max(1, radius | 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, cnt = 0;
      for (let dy = -R; dy <= R; dy += 2) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -R; dx <= R; dx += 2) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          s += a[yy * w + xx]; cnt++;
        }
      }
      out[y * w + x] = s / cnt;
    }
  }
  const res = document.createElement('canvas');
  res.width = w; res.height = h;
  const rd = res.getContext('2d').createImageData(w, h);
  for (let i = 0, j = 3; i < w * h; i++, j += 4) {
    rd.data[j - 3] = 255; rd.data[j - 2] = 255; rd.data[j - 1] = 255;
    rd.data[j] = out[i];
  }
  res.getContext('2d').putImageData(rd, 0, 0);
  return res;
}

class AiCutout {
  constructor() {
    this.session = null;
    this.loading = null;
    this.size = 320;
  }

  urls() {
    const local = new URL('assets/model/u2netp.onnx', document.baseURI).href;
    const mirrors = MODEL_MIRRORS.map(m => m + 'assets/model/u2netp.onnx');
    return ModelFetcher.preferCdn ? mirrors.concat([local]) : [local].concat(mirrors);
  }

  ensureSession(onProgress) {
    if (this.session) return Promise.resolve(this.session);
    if (this.loading) return this.loading;
    const ort = window.ort;
    if (!ort) return Promise.reject(new Error('AI 运行库加载失败'));
    this.loading = (async () => {
      await ModelFetcher.prepareOrt(ort, onProgress);
      const res = await ModelFetcher.fetchBlob(this.urls(), (pct, done, total) => {
        if (onProgress) onProgress('正在下载抠图模型 ' + Math.round(pct * 100) + '%', pct, done, total);
      });
      if (onProgress) onProgress('正在加载抠图模型…');
      this.session = await createOrtSession(ort, await res.blob.arrayBuffer(), {
        executionProviders: ['wasm'], // u2netp 走 wasm 更稳
      });
      return this.session;
    })().catch(e => { this.loading = null; throw e; });
    return this.loading;
  }

  /** 返回与原图同尺寸的二值遮罩画布（白色=主体，透明=背景） */
  async segment(imageCanvas, onProgress) {
    const ort = window.ort;
    const session = await this.ensureSession(onProgress);
    const S = this.size;
    if (onProgress) onProgress('正在识别主体…');
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(imageCanvas, 0, 0, S, S);
    const d = ctx.getImageData(0, 0, S, S).data;
    const inp = new Float32Array(3 * S * S);
    for (let i = 0; i < S * S; i++) {
      const r = d[i * 4] / 255, g = d[i * 4 + 1] / 255, b = d[i * 4 + 2] / 255;
      inp[i] = (r - 0.485) / 0.229;
      inp[S * S + i] = (g - 0.456) / 0.224;
      inp[2 * S * S + i] = (b - 0.406) / 0.225;
    }
    const feeds = {};
    feeds[session.inputNames[0]] = new ort.Tensor('float32', inp, [1, 3, S, S]);
    const results = await session.run(feeds);
    const out = results[session.outputNames[0]].data;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < out.length; i++) {
      if (out[i] < mn) mn = out[i];
      if (out[i] > mx) mx = out[i];
    }
    const range = mx - mn || 1;
    const small = document.createElement('canvas');
    small.width = S; small.height = S;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    const sd = sctx.createImageData(S, S);
    for (let i = 0; i < out.length; i++) {
      const v = (out[i] - mn) / range;
      sd.data[i * 4] = 255;
      sd.data[i * 4 + 1] = 255;
      sd.data[i * 4 + 2] = 255;
      sd.data[i * 4 + 3] = v >= 0.5 ? 255 : 0;
    }
    sctx.putImageData(sd, 0, 0);
    const smallMask = softEdgeMask(largestAlphaComponent(small), 1);
    const full = document.createElement('canvas');
    full.width = imageCanvas.width;
    full.height = imageCanvas.height;
    const fctx = full.getContext('2d', { willReadFrequently: true });
    fctx.imageSmoothingEnabled = true;
    fctx.imageSmoothingQuality = 'high';
    fctx.drawImage(smallMask, 0, 0, full.width, full.height);
    return full;
  }
}


/* ============================================================
 * 图片编辑器（v3）
 * - 三种工具：✨ AI 修复 / 🟫 马赛克（涂抹即生效）/ 🧩 抠图
 * - 双指缩放 + 防误触（第二指落下取消第一指笔迹，修复后缩回 1:1 无损）
 * - 一键自动去豆包 / Gemini 水印
 * - 模型下载进度条 + CDN 加速
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
    this.current = null;
    this.strokeBackup = null;
    this.lastCommittedStroke = null;
    this.loaded = false;
    this.busy = false;
    this.history = [];
    this.aiRunId = 0;
    this.ai = new AiInpaint();
    this.cutoutAi = new AiCutout();
    this.segMask = null;
    this.sourceCanvas = null;

    // 缩放 / 手势
    this.zoom = { scale: 1, tx: 0, ty: 0 };
    this.pointers = new Map();
    this.pinch = null;
    this.gestureBlocked = new Set();
    this.lastTap = null;
    this._hadPinch = false;
    this._lastProgAt = 0;
    this._progT0 = 0;
    this._progLastDone = 0;
    this._progLastT = 0;

    // 马赛克笔刷临时画布
    this._tmp = document.createElement('canvas');
    this._tmpMask = document.createElement('canvas');

    this.bindTools();
    this.bindStage();
    this.bindButtons();
    this.bindDropZone();
    this.bindCompare();
    this.onModeChange();
    window.addEventListener('resize', () => {
      if (!this.loaded) return;
      this.fitCanvasSize();
      this.clampView();
      this.applyTransform();
    });
  }

  get mode() {
    const r = document.querySelector('input[name="imgMode"]:checked');
    return r ? r.value : 'inpaint';
  }

  /* ---------- 工具与模式 ---------- */
  bindTools() {
    $$('#imgToolbar .tool[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.tool = btn.dataset.tool;
        $$('#imgToolbar .tool[data-tool]').forEach(b => b.classList.toggle('active', b === btn));
        this.updateHint();
      });
    });
    $('#imgBrushSize').addEventListener('input', e => { this.brushSize = +e.target.value; });
    $('#imgUndoBtn').addEventListener('click', () => { this.undo(); });
    $('#imgClearBtn').addEventListener('click', () => { this.clearAll(); });
    $$('input[name="imgMode"]').forEach(r => r.addEventListener('change', () => this.onModeChange()));
    $('#imgAutoWmBtn').addEventListener('click', () => this.applyAutoWatermark($('#imgAutoWmType').value));
    $('#imgZoomReset').addEventListener('click', () => this.resetZoom());
  }

  onModeChange() {
    const m = this.mode;
    this.cancelCurrentStroke();
    this.strokes = [];
    this.segMask = null;
    $('#imgCompare').classList.add('hidden');
    $('#imgResult').classList.add('hidden');
    $('#imgCutoutActions').classList.add('hidden');
    $('#imgRectTool').classList.toggle('hidden', m !== 'inpaint');
    $('#imgMosaicGroup').classList.toggle('hidden', m !== 'mosaic');
    $('#imgAutoWmWrap').classList.toggle('hidden', m !== 'inpaint');
    const applyBtn = $('#imgApplyBtn');
    if (m === 'mosaic') applyBtn.textContent = '✅ 查看结果';
    else if (m === 'cutout') applyBtn.textContent = '🧩 AI 抠图';
    else applyBtn.textContent = '✨ AI 去水印';
    $('#imgBrushTool').textContent = m === 'cutout' ? '🖌 保留' : (m === 'mosaic' ? '🖌 马赛克笔' : '🖌 涂抹');
    $('#imgEraserTool').textContent = m === 'cutout' ? '🧽 去除' : (m === 'mosaic' ? '🧽 恢复' : '🧽 橡皮');
    this.redrawMask();
    this.updateHint();
  }

  updateHint() {
    const m = this.mode;
    const t = this.tool;
    let hint;
    if (m === 'inpaint') {
      hint = t === 'rect' ? '拖出一个矩形框住水印区域' :
        t === 'eraser' ? '擦掉多余的标记' :
        '涂抹水印所在区域，涂抹越贴合轮廓效果越好';
    } else if (m === 'mosaic') {
      hint = t === 'eraser' ? '涂抹区域将恢复原图（相当于擦掉马赛克）' :
        '涂抹即出现马赛克效果，无需再点任何按钮；马赛克是「加效果」工具';
    } else {
      hint = t === 'eraser' ? '红色涂抹：从主体中去除该区域' :
        '绿色涂抹：保留该区域；点「AI 抠图」可自动识别主体';
    }
    $('#imgHint').textContent = hint + ' · 双指缩放图片，双击复位';
  }

  setBusy(on, text, pct, info) {
    const busy = $('#imgBusy');
    if (!on) {
      busy.classList.add('hidden');
      $('#imgBusyProgress').classList.add('hidden');
      $('#imgBusyInfo').classList.add('hidden');
      this.busy = false;
      return;
    }
    this.busy = true;
    busy.classList.remove('hidden');
    if (text) $('#imgBusyText').textContent = text;
    const wrap = $('#imgBusyProgress');
    if (pct === undefined || pct === null) {
      wrap.classList.add('hidden');
      $('#imgBusyInfo').classList.add('hidden');
    } else {
      wrap.classList.remove('hidden');
      $('#imgBusyBar').style.width = Math.max(0, Math.min(100, Math.round(pct * 100))) + '%';
      if (info) {
        $('#imgBusyInfo').classList.remove('hidden');
        $('#imgBusyInfo').textContent = info;
      } else {
        $('#imgBusyInfo').classList.add('hidden');
      }
    }
  }

  /** 生成带节流 + 网速/剩余时间提示的进度回调 */
  progressFn() {
    this._progT0 = performance.now();
    this._progLastDone = 0;
    this._progLastT = this._progT0;
    return (text, pct, done, total) => {
      const now = performance.now();
      if (typeof pct === 'number' && pct < 1 && now - this._lastProgAt < 90) return;
      this._lastProgAt = now;
      let info = null;
      if (typeof done === 'number' && typeof total === 'number' && total > 0 && done > 0 && now - this._progT0 > 600) {
        const dt = (now - this._progLastT) / 1000;
        const dd = done - this._progLastDone;
        if (dt > 0.2 && dd > 0) {
          const speed = dd / dt / 1048576;
          const eta = (total - done) / Math.max(1, dd / dt) / 1000;
          info = speed.toFixed(1) + ' MB/s · 预计 ' + Math.max(0, Math.round(eta)) + ' 秒';
          this._progLastDone = done;
          this._progLastT = now;
        }
      }
      this.setBusy(true, text || '处理中…', typeof pct === 'number' ? pct : null, info);
    };
  }

  /* ---------- 画布与手势 ---------- */
  clientToLocal(cx, cy) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.max(0, Math.min(this.canvas.width, (cx - rect.left) / rect.width * this.canvas.width)),
      y: Math.max(0, Math.min(this.canvas.height, (cy - rect.top) / rect.height * this.canvas.height)),
    };
  }

  /** 记录画布未变换时的基础位置（页面坐标，滚动后依然有效），缩放锚点计算用 */
  measureBase() {
    const prev = this.canvas.style.transform;
    this.canvas.style.transform = 'none';
    const r = this.canvas.getBoundingClientRect();
    this.canvas.style.transform = prev;
    this.base = { x: r.left + window.scrollX, y: r.top + window.scrollY };
  }

  applyTransform() {
    const z = this.zoom;
    const t = 'translate(' + z.tx + 'px, ' + z.ty + 'px) scale(' + z.scale + ')';
    this.canvas.style.transform = t;
    this.maskCanvas.style.transform = t;
    const cmp = $('#imgCompare');
    if (cmp) cmp.style.transform = t;
    const zr = $('#imgZoomReset');
    zr.classList.toggle('hidden', z.scale <= 1.001 && Math.abs(z.tx) < 0.5 && Math.abs(z.ty) < 0.5);
  }

  /** 限制平移范围：放大时画布始终盖住舞台（不会露白/乱跑），1:1 时保持居中（页面坐标） */
  clampView() {
    const z = this.zoom;
    const sr = $('#imgStage').getBoundingClientRect();
    const sLeft = sr.left + window.scrollX;
    const sTop = sr.top + window.scrollY;
    const B = this.base;
    const w = this.canvas.clientWidth * z.scale;
    const h = this.canvas.clientHeight * z.scale;
    const margin = 24;
    const vx = B.x + z.tx;
    const vy = B.y + z.ty;
    let nvx = vx, nvy = vy;
    if (w <= sr.width) nvx = sLeft + (sr.width - w) / 2;
    else nvx = Math.max(sLeft + sr.width - w - margin, Math.min(sLeft + margin, vx));
    if (h <= sr.height) nvy = sTop + (sr.height - h) / 2;
    else nvy = Math.max(sTop + sr.height - h - margin, Math.min(sTop + margin, vy));
    z.tx = nvx - B.x;
    z.ty = nvy - B.y;
  }

  /** 以 client 坐标点 p 为锚点缩放：p 下方的图像内容保持不动 */
  zoomAround(p, s) {
    if (!this.base) this.measureBase();
    const px = p.x + window.scrollX;
    const py = p.y + window.scrollY;
    const z = this.zoom;
    const B = this.base;
    const s0 = z.scale;
    const vx0 = B.x + z.tx;
    const vy0 = B.y + z.ty;
    const lx = (px - vx0) / s0;
    const ly = (py - vy0) / s0;
    z.scale = Math.max(1, Math.min(8, s));
    z.tx = (px - lx * z.scale) - B.x;
    z.ty = (py - ly * z.scale) - B.y;
    this.clampView();
    this.applyTransform();
  }

  resetZoom() {
    if (!this.base) this.measureBase();
    this.zoom = { scale: 1, tx: 0, ty: 0 };
    this.clampView();
    this.applyTransform();
  }

  startPinch() {
    const ids = Array.from(this.pointers.keys());
    if (ids.length < 2) { this.pinch = null; return; }
    const p1 = this.pointers.get(ids[0]);
    const p2 = this.pointers.get(ids[1]);
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const dist = Math.max(24, Math.hypot(p1.x - p2.x, p1.y - p2.y));
    if (!this.base) this.measureBase();
    const B = this.base;
    const s0 = this.zoom.scale;
    const mx = mid.x + window.scrollX;
    const my = mid.y + window.scrollY;
    this.pinch = {
      startDist: dist,
      startScale: s0,
      anchor: {
        x: (mx - (B.x + this.zoom.tx)) / s0,
        y: (my - (B.y + this.zoom.ty)) / s0,
      },
    };
    this._hadPinch = true;
    ids.forEach(id => this.gestureBlocked.add(id));
  }

  updatePinch() {
    const pin = this.pinch;
    if (!pin) return;
    const ids = Array.from(this.pointers.keys());
    if (ids.length < 2) return;
    const p1 = this.pointers.get(ids[0]);
    const p2 = this.pointers.get(ids[1]);
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const dist = Math.max(24, Math.hypot(p1.x - p2.x, p1.y - p2.y));
    const z = this.zoom;
    const B = this.base;
    const mx = mid.x + window.scrollX;
    const my = mid.y + window.scrollY;
    z.scale = Math.max(1, Math.min(8, pin.startScale * dist / pin.startDist));
    z.tx = (mx - pin.anchor.x * z.scale) - B.x;
    z.ty = (my - pin.anchor.y * z.scale) - B.y;
    this.clampView();
    this.applyTransform();
  }

  bindStage() {
    const stage = $('#imgStage');

    stage.addEventListener('pointerdown', e => {
      if (!this.loaded || this.busy) return;
      if (e.target.closest('button, select')) return;
      const isTouch = e.pointerType === 'touch';
      if (isTouch) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { stage.setPointerCapture(e.pointerId); } catch (_) {}

      if (isTouch) {
        if (this.pointers.size === 1 && this.lastTap &&
            (performance.now() - this.lastTap.t < 350) &&
            Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 56) {
          this.gestureBlocked.add(e.pointerId);
          this.removeLastTapStroke();
          this.lastTap = null;
          this.resetZoom();
          return;
        }
        if (this.pointers.size >= 2) {
          // 第二根手指落下：取消第一根手指产生的笔迹，避免误涂
          this.cancelCurrentStroke();
          this.startPinch();
          return;
        }
        if (this.gestureBlocked.has(e.pointerId)) return;
      } else if (e.button > 0) {
        return;
      }

      const p = this.clientToLocal(e.clientX, e.clientY);
      if (!p) return;
      this.startStroke(p, e.pointerId);
    });

    stage.addEventListener('pointermove', e => {
      const isTouch = e.pointerType === 'touch';
      if (isTouch && this.pointers.has(e.pointerId)) {
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.pinch) { this.updatePinch(); return; }
        if (this.gestureBlocked.has(e.pointerId)) return;
      }
      if (!this.current || this.current.pointerId !== e.pointerId) return;
      const p = this.clientToLocal(e.clientX, e.clientY);
      if (!p) return;
      this.continueStroke(p);
    });

    const endPointer = e => {
      const isTouch = e.pointerType === 'touch';
      const had = isTouch && this.pointers.has(e.pointerId);
      if (had) this.pointers.delete(e.pointerId);
      try { stage.releasePointerCapture(e.pointerId); } catch (_) {}

      if (isTouch && this.pinch) {
        // 双指手势结束：剩余未抬起的手指禁止再画（防误触）
        if (this.pointers.size > 0) this.pointers.forEach((_, id) => this.gestureBlocked.add(id));
        this.pinch = null;
      }
      if (this.current && this.current.pointerId === e.pointerId) this.endStroke();
      if (isTouch && this.pointers.size === 0) {
        this.gestureBlocked.clear();
        if (this._hadPinch) {
          this._hadPinch = false;
        } else {
          this.lastTap = { t: performance.now(), x: e.clientX, y: e.clientY, stroke: this.lastCommittedStroke };
        }
      }
    };
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);

    // 桌面端 Ctrl+滚轮缩放
    stage.addEventListener('wheel', e => {
      if (!this.loaded || !e.ctrlKey) return;
      e.preventDefault();
      const p = this.clientToLocal(e.clientX, e.clientY);
      if (!p) return;
      const s = Math.max(1, Math.min(6, this.zoom.scale * (e.deltaY < 0 ? 1.12 : 0.89)));
      this.zoomAround(p, s);
    }, { passive: false });

    stage.addEventListener('dblclick', () => {
      if (!this.loaded) return;
      if (this.mode === 'mosaic') {
        let n = 0;
        while (n < 2 && this.history.length) { this.history.pop(); n++; }
        if (this.history.length) {
          this.restoreState(this.history[this.history.length - 1]).then(() => this.resetZoom());
        } else if (this.sourceCanvas) {
          this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
          this.ctx.drawImage(this.sourceCanvas, 0, 0);
          this.resetZoom();
        }
      } else {
        let n = 0;
        while (n < 2 && this.strokes.length && this.strokes[this.strokes.length - 1].points.length === 1) {
          this.strokes.pop();
          n++;
        }
        this.redrawMask();
        this.resetZoom();
      }
    });
  }

  removeLastTapStroke() {
    const t = this.lastTap && this.lastTap.stroke;
    if (!t) return;
    if (t.mosaic) {
      if (t.backup) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(t.backup, 0, 0);
      }
      if (t.historySnap && this.history[this.history.length - 1] === t.historySnap) this.history.pop();
    } else {
      const i = this.strokes.lastIndexOf(t);
      if (i >= 0) this.strokes.splice(i, 1);
      this.redrawMask();
    }
  }

  /* ---------- 笔画 ---------- */
  compositeOp(tool) {
    return (tool === 'eraser' && this.mode !== 'cutout') ? 'destination-out' : 'source-over';
  }

  strokeColor(tool) {
    if (this.mode === 'cutout') {
      return tool === 'eraser' ? 'rgba(255, 90, 90, 0.9)' : 'rgba(0, 230, 118, 0.9)';
    }
    return 'rgb(255, 90, 90)';
  }

  startStroke(p, pointerId) {
    const m = this.mode;
    if (m === 'mosaic') {
      this.pushHistory('mosaic-stroke');
      this.strokeBackup = this.cloneCanvas(this.canvas);
      this.current = {
        pointerId,
        tool: this.tool === 'eraser' ? 'unmosaic' : 'mosaic',
        size: this.brushSize,
        points: [p],
      };
      this.paintMosaicSegment(p.x, p.y, p.x, p.y, this.tool === 'eraser');
      return;
    }
    if (m === 'inpaint' && this.tool === 'rect') {
      this.strokes = this.strokes.filter(s => s.tool !== 'rect');
      this.current = { pointerId, tool: 'rect', x: p.x, y: p.y, w: 0, h: 0 };
      return;
    }
    this.current = { pointerId, tool: this.tool, size: this.brushSize, points: [p] };
    const mc = this.mctx;
    mc.save();
    mc.globalCompositeOperation = this.compositeOp(this.tool);
    mc.fillStyle = this.strokeColor(this.tool);
    mc.beginPath();
    mc.arc(p.x, p.y, Math.max(0.5, this.brushSize / 2), 0, Math.PI * 2);
    mc.fill();
    mc.restore();
  }

  continueStroke(p) {
    const c = this.current;
    if (!c) return;
    if (c.tool === 'rect') {
      c.w = p.x - c.x;
      c.h = p.y - c.y;
      this.redrawMask(c);
      return;
    }
    if (c.tool === 'mosaic' || c.tool === 'unmosaic') {
      const last = c.points[c.points.length - 1];
      this.paintMosaicSegment(last.x, last.y, p.x, p.y, c.tool === 'unmosaic');
      c.points.push(p);
      return;
    }
    const last = c.points[c.points.length - 1];
    const mc = this.mctx;
    mc.save();
    mc.globalCompositeOperation = this.compositeOp(c.tool);
    mc.strokeStyle = this.strokeColor(c.tool);
    mc.lineWidth = c.size;
    mc.lineCap = 'round';
    mc.lineJoin = 'round';
    mc.beginPath();
    mc.moveTo(last.x, last.y);
    mc.lineTo(p.x, p.y);
    mc.stroke();
    mc.restore();
    c.points.push(p);
  }

  endStroke() {
    const c = this.current;
    if (!c) return;
    this.current = null;
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
      return;
    }
    if (c.tool === 'mosaic' || c.tool === 'unmosaic') {
      if (c.points.length === 1 && this.strokeBackup) {
        this.lastCommittedStroke = {
          mosaic: true,
          backup: this.strokeBackup,
          historySnap: this.history[this.history.length - 1],
        };
      }
      this.strokeBackup = null;
      return;
    }
    if (c.points.length >= 1) {
      this.strokes.push(c);
      this.lastCommittedStroke = c;
      this.redrawMask();
    }
  }

  cancelCurrentStroke() {
    const c = this.current;
    if (!c) return;
    this.current = null;
    if (c.tool === 'mosaic' || c.tool === 'unmosaic') {
      if (this.strokeBackup) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(this.strokeBackup, 0, 0);
        this.strokeBackup = null;
      }
      const last = this.history[this.history.length - 1];
      if (last && last.__tag === 'mosaic-stroke') this.history.pop();
    } else {
      this.redrawMask();
    }
  }

  /* 涂抹即马赛克：把线段覆盖的圆形笔刷区域做马赛克（或恢复原图） */
  paintMosaicSegment(x0, y0, x1, y1, erase) {
    const size = this.current ? this.current.size : this.brushSize;
    const r = Math.max(3, Math.ceil(size / 2) + 2);
    const W = this.canvas.width, H = this.canvas.height;
    const bx0 = Math.max(0, Math.floor(Math.min(x0, x1) - r));
    const by0 = Math.max(0, Math.floor(Math.min(y0, y1) - r));
    const bx1 = Math.min(W, Math.ceil(Math.max(x0, x1) + r));
    const by1 = Math.min(H, Math.ceil(Math.max(y0, y1) + r));
    const w = bx1 - bx0, h = by1 - by0;
    if (w <= 0 || h <= 0) return;

    const tmp = this._tmp;
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    tctx.clearRect(0, 0, w, h);
    if (erase) {
      if (this.sourceCanvas) tctx.drawImage(this.sourceCanvas, bx0, by0, w, h, 0, 0, w, h);
    } else {
      tctx.drawImage(this.canvas, bx0, by0, w, h, 0, 0, w, h);
      const data = tctx.getImageData(0, 0, w, h);
      mosaicRect(data.data, w, h, { x: 0, y: 0, w, h }, +$('#imgMosaicSize').value || 14);
      tctx.putImageData(data, 0, 0);
    }

    const mk = this._tmpMask;
    mk.width = w;
    mk.height = h;
    const kctx = mk.getContext('2d');
    kctx.clearRect(0, 0, w, h);
    kctx.fillStyle = '#fff';
    kctx.beginPath();
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(4, size * 0.35)));
    for (let i = 0; i <= steps; i++) {
      const px = x0 + (x1 - x0) * i / steps - bx0;
      const py = y0 + (y1 - y0) * i / steps - by0;
      kctx.moveTo(px + r - 1, py);
      kctx.arc(px, py, Math.max(2, r - 2), 0, Math.PI * 2);
    }
    kctx.fill();
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(mk, 0, 0);
    this.ctx.drawImage(tmp, bx0, by0);
  }

  /* ---------- 遮罩与历史 ---------- */
  redrawMask(preview) {
    const m = this.mctx;
    const W = this.maskCanvas.width, H = this.maskCanvas.height;
    m.clearRect(0, 0, W, H);
    if (this.mode === 'mosaic') {
      this.maskCanvas.style.display = 'none';
      return;
    }
    this.maskCanvas.style.display = 'block';
    if (this.mode === 'cutout' && this.segMask) {
      m.save();
      m.globalAlpha = 0.5;
      m.drawImage(this.segMask, 0, 0);
      m.restore();
    }
    const drawStroke = (s) => {
      if (s.tool === 'rect') {
        m.save();
        m.globalCompositeOperation = 'source-over';
        m.fillStyle = 'rgb(255, 90, 90)';
        m.strokeStyle = 'rgb(255, 90, 90)';
        m.lineWidth = 2;
        const x = Math.min(s.x, s.x + s.w);
        const y = Math.min(s.y, s.y + s.h);
        m.fillRect(x, y, Math.abs(s.w), Math.abs(s.h));
        m.strokeRect(x, y, Math.abs(s.w), Math.abs(s.h));
        m.restore();
        return;
      }
      m.save();
      m.globalCompositeOperation = this.compositeOp(s.tool);
      m.strokeStyle = this.strokeColor(s.tool);
      m.lineWidth = s.size;
      m.lineCap = 'round';
      m.lineJoin = 'round';
      m.beginPath();
      m.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) m.lineTo(s.points[i].x, s.points[i].y);
      m.stroke();
      m.restore();
    };
    for (const s of this.strokes) drawStroke(s);
    if (preview && preview.tool === 'rect') {
      m.save();
      m.strokeStyle = 'rgb(255, 90, 90)';
      m.lineWidth = 2;
      m.strokeRect(Math.min(preview.x, preview.x + preview.w), Math.min(preview.y, preview.y + preview.h), Math.abs(preview.w), Math.abs(preview.h));
      m.restore();
    }
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

  alphaBBox(c) {
    const w = c.width, h = c.height;
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 24) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (!isFinite(minX)) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  cloneCanvas(c) {
    const out = document.createElement('canvas');
    out.width = c.width;
    out.height = c.height;
    out.getContext('2d').drawImage(c, 0, 0);
    return out;
  }

  pushHistory(tag) {
    const snap = {
      dataURL: this.canvas.toDataURL('image/png'),
      width: this.canvas.width,
      height: this.canvas.height,
      strokes: this.strokes.map(s => s.tool === 'rect'
        ? Object.assign({}, s)
        : Object.assign({}, s, { points: s.points.map(p => Object.assign({}, p)) })),
      segMask: this.segMask ? this.cloneCanvas(this.segMask) : null,
      mode: this.mode,
    };
    if (tag) snap.__tag = tag;
    this.history.push(snap);
    if (this.history.length > 15) this.history.shift();
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
    if (snap.mode && snap.mode !== this.mode) {
      const radio = document.querySelector('input[name="imgMode"][value="' + snap.mode + '"]');
      if (radio) {
        radio.checked = true;
        this.onModeChange();
      }
    }
    this.strokes = snap.strokes.map(s => s.tool === 'rect'
      ? Object.assign({}, s)
      : Object.assign({}, s, { points: s.points.map(p => Object.assign({}, p)) }));
    this.segMask = snap.segMask;
    this.redrawMask();
    this.fitCanvasSize();
    this.resetZoom();
  }

  async undo() {
    this.aiRunId++;
    if (this.current) {
      this.cancelCurrentStroke();
      return;
    }
    if (this.history.length) {
      const snap = this.history.pop();
      try {
        await this.restoreState(snap);
        $('#imgResult').classList.add('hidden');
        $('#imgCompare').classList.add('hidden');
        $('#imgCutoutActions').classList.add('hidden');
        $('#imgStage').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (e) {
        toast(e.message);
      }
      return;
    }
    this.strokes.pop();
    this.redrawMask();
  }

  clearAll() {
    this.cancelCurrentStroke();
    if (this.mode === 'mosaic') {
      if (this.sourceCanvas) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(this.sourceCanvas, 0, 0);
      }
      this.strokes = [];
      this.history = [];
      this.redrawMask();
      toast('已恢复原图', 2000);
      return;
    }
    this.strokes = [];
    this.redrawMask();
  }

  /* ---------- 加载与尺寸 ---------- */
  async loadFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      toast('请选择图片文件（JPG / PNG / WebP）');
      return;
    }
    const MAX = 2000;
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(file, { resizeQuality: 'high' });
      const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
      if (scale < 1) {
        const w = Math.round(bitmap.width * scale);
        const h = Math.round(bitmap.height * scale);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d').drawImage(bitmap, 0, 0, w, h);
        bitmap.close();
        bitmap = await createImageBitmap(c);
      }
    } catch (e) {
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
    this.sourceCanvas = this.cloneCanvas(this.canvas);
    this.strokes = [];
    this.history = [];
    this.segMask = null;
    this.aiRunId++;
    this.loaded = true;

    $('#imgDropZone').classList.add('hidden');
    $('#imgEditor').classList.remove('hidden');
    $('#imgResult').classList.add('hidden');
    $('#imgCompare').classList.add('hidden');
    $('#imgCutoutActions').classList.add('hidden');
    this.fitCanvasSize();
    this.resetZoom();
    this.onModeChange();
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
    const cmp = $('#imgCompare');
    if (cmp) {
      cmp.style.width = w + 'px';
      cmp.style.height = h + 'px';
    }
    stage.style.minHeight = h + 'px';
    this.measureBase();
  }

  /* ---------- 处理流程 ---------- */
  async apply() {
    if (!this.loaded || this.busy) return;
    const mode = this.mode;
    if (mode === 'mosaic') {
      // 马赛克是「加效果」工具：直接对比原图查看结果
      this.showResult(this.sourceCanvas, this.canvas);
      return;
    }
    if (mode === 'cutout') {
      await this.runCutout();
      return;
    }
    const bbox = this.maskBBox();
    if (!bbox) { toast('请先涂抹或框选水印区域'); return; }
    const area = bbox.w * bbox.h;
    if (area > 420000 && !confirm('标记区域较大（' + bbox.w + '×' + bbox.h + '），智能填充可能需要较长时间，是否继续？')) return;
    await this.inpaintWithMask(bbox, this.maskCanvas);
  }

  async inpaintWithMask(bbox, maskSrc) {
    const before = this.cloneCanvas(this.canvas);
    const maskSnap = this.cloneCanvas(maskSrc);
    this.setBusy(true, '正在处理…');
    await new Promise(r => setTimeout(r, 30));
    this.pushHistory();
    try {
      this.setBusy(true, '正在快速修复…');
      await this.runInpaint(bbox, maskSrc);
      this.showResult(before, this.canvas);
      const skipAi = new URLSearchParams(location.search).has('noai') || window.__skipAi === true;
      if (skipAi) {
        toast('✅ 处理完成（测试模式，已跳过 AI）', 2600);
      } else {
        this.setBusy(true, '🧠 正在加载内置 AI 模型…');
        const ok = await this.aiRefine(maskSnap, bbox);
        this.setBusy(true, ok ? '✅ AI 修复完成' : '已保留快速修复结果');
      }
      return true;
    } catch (e) {
      console.error(e);
      toast('处理失败：' + e.message);
      return false;
    } finally {
      this.setBusy(false);
    }
  }

  runInpaint(bbox, maskSrc) {
    return new Promise((resolve, reject) => {
      const w = bbox.w, h = bbox.h;
      const maskData = maskSrc.getContext('2d', { willReadFrequently: true }).getImageData(bbox.x, bbox.y, w, h).data;
      const mask = new Uint8Array(w * h);
      for (let i = 0, j = 3; i < w * h; i++, j += 4) mask[i] = maskData[j] > 32 ? 1 : 0;
      const img = this.ctx.getImageData(bbox.x, bbox.y, w, h);
      const ok = teleaInpaint(img.data, w, h, mask);
      if (!ok) { reject(new Error('标记区域没有可用的周围像素')); return; }
      this.ctx.putImageData(img, bbox.x, bbox.y);
      this.strokes = [];
      this.redrawMask();
      resolve();
    });
  }

  async aiRefine(maskSnap, bbox) {
    const runId = ++this.aiRunId;
    if (!this.ai || !this.ai.isAvailable()) {
      window.__aiDone = false;
      toast('AI 运行库未加载，已保留快速修复结果', 4000);
      return false;
    }
    const prog = this.progressFn();
    try {
      const out = await this.ai.inpaint(this.canvas, maskSnap, bbox, (text, pct, done, total) => {
        if (typeof pct === 'number') prog('🧠 ' + text, pct, done, total);
        else prog('🧠 ' + text, undefined);
      });
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
      toast('AI 修复失败，已保留快速修复结果：' + (e && e.message ? String(e.message).slice(0, 80) : e) + '。请检查网络/存储后重试', 6000);
      return false;
    }
  }

  async runCutout() {
    this.setBusy(true, '🧩 正在加载抠图模型…');
    const prog = this.progressFn();
    try {
      const mask = await this.cutoutAi.segment(this.canvas, (text, pct, done, total) => {
        if (typeof pct === 'number') prog('🧩 ' + text, pct, done, total);
        else prog('🧩 ' + text, undefined);
      });
      this.segMask = mask;
      this.strokes = [];
      this.pushHistory();
      this.redrawMask();
      $('#imgCutoutActions').classList.remove('hidden');
      $('#imgCutoutActions').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      toast('抠图完成：绿色=主体，可用「保留/去除」画笔修正，然后下载透明图或移除主体', 4600);
    } catch (e) {
      console.error(e);
      toast('抠图失败：' + (e && e.message || e) + '。请重试；大图建议先压缩尺寸', 5000);
    } finally {
      this.setBusy(false);
    }
  }

  composeCutoutMask() {
    const m = document.createElement('canvas');
    m.width = this.maskCanvas.width;
    m.height = this.maskCanvas.height;
    const mctx = m.getContext('2d');
    if (this.segMask) mctx.drawImage(this.segMask, 0, 0);
    for (const s of this.strokes) {
      mctx.save();
      mctx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
      mctx.fillStyle = '#fff';
      mctx.strokeStyle = '#fff';
      mctx.lineWidth = s.size;
      mctx.lineCap = 'round';
      mctx.lineJoin = 'round';
      if (s.points.length === 1) {
        mctx.beginPath();
        mctx.arc(s.points[0].x, s.points[0].y, s.size / 2, 0, Math.PI * 2);
        mctx.fill();
      } else {
        mctx.beginPath();
        mctx.moveTo(s.points[0].x, s.points[0].y);
        for (let i = 1; i < s.points.length; i++) mctx.lineTo(s.points[i].x, s.points[i].y);
        mctx.stroke();
      }
      mctx.restore();
    }
    return m;
  }

  composeCutoutCanvas() {
    const out = this.cloneCanvas(this.canvas);
    const octx = out.getContext('2d');
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(this.composeCutoutMask(), 0, 0);
    return out;
  }

  async removeSubject() {
    const mask = this.composeCutoutMask();
    const bbox = this.alphaBBox(mask);
    if (!bbox) { toast('主体区域为空，请先涂抹或重新抠图'); return; }
    const before = this.cloneCanvas(this.canvas);
    const maskSnap = this.cloneCanvas(mask);
    this.setBusy(true, '正在移除主体…');
    await new Promise(r => setTimeout(r, 30));
    this.pushHistory();
    try {
      if (bbox.w * bbox.h <= 700000) {
        this.setBusy(true, '正在快速修复…');
        try { await this.runInpaint(bbox, mask); } catch (e) { console.warn('快速修复跳过', e); }
      }
      this.showResult(before, this.canvas);
      const skipAi = new URLSearchParams(location.search).has('noai') || window.__skipAi === true;
      if (skipAi) {
        toast('✅ 处理完成（测试模式，已跳过 AI）', 2600);
      } else {
        this.setBusy(true, '🧠 正在加载内置 AI 模型…');
        const ok = await this.aiRefine(maskSnap, bbox);
        this.setBusy(true, ok ? '✅ 主体已移除' : '已保留快速修复结果');
      }
    } catch (e) {
      console.error(e);
      toast('处理失败：' + e.message);
    } finally {
      this.setBusy(false);
    }
  }

  async applyAutoWatermark(type) {
    if (!this.loaded || this.busy) return;
    const det = detectWatermark(this.canvas, type);
    if (!det) {
      toast('未检测到豆包 / Gemini 类水印，请切换到「AI 修复」手动涂抹', 4200);
      return;
    }
    const mctx = this.mctx;
    mctx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
    const im = mctx.createImageData(det.w, det.h);
    for (let i = 0, j = 0; i < det.w * det.h; i++, j += 4) {
      im.data[j] = 255;
      im.data[j + 1] = 90;
      im.data[j + 2] = 90;
      im.data[j + 3] = det.mask[i] ? 255 : 0;
    }
    mctx.putImageData(im, det.x, det.y);
    this.strokes = [];
    const pad = 12;
    const x0 = Math.max(0, det.x - pad);
    const y0 = Math.max(0, det.y - pad);
    const bbox = {
      x: x0,
      y: y0,
      w: Math.min(this.canvas.width, det.x + det.w + pad) - x0,
      h: Math.min(this.canvas.height, det.y + det.h + pad) - y0,
    };
    await this.inpaintWithMask(bbox, this.maskCanvas);
  }

  /* ---------- 结果与按钮 ---------- */
  showResult(beforeCanvas, afterCanvas) {
    const bv = $('#imgBeforeView');
    const av = $('#imgAfterView');
    bv.width = afterCanvas.width;
    bv.height = afterCanvas.height;
    av.width = afterCanvas.width;
    av.height = afterCanvas.height;
    const bctx = bv.getContext('2d');
    const s = Math.max(bv.width / beforeCanvas.width, bv.height / beforeCanvas.height);
    const sw = beforeCanvas.width * s, sh = beforeCanvas.height * s;
    bctx.drawImage(beforeCanvas, (bv.width - sw) / 2, (bv.height - sh) / 2, sw, sh);
    av.getContext('2d').drawImage(afterCanvas, 0, 0);
    // 结果直接在原图窗口显示：滑块默认停在结尾（全部显示结果），向左拖动可对比原图
    $('#imgCompareRange').value = 100;
    this.updateCompare(100);
    $('#imgCompare').classList.remove('hidden');
    $('#imgResult').classList.remove('hidden');
    $('#imgHint').textContent = '✅ 结果已显示在原图窗口 · 向左拖动图片上的滑块可对比原图 · 点「返回编辑」继续修改';
    this.applyTransform();
  }

  bindCompare() {
    const range = $('#imgCompareRange');
    range.addEventListener('input', () => this.updateCompare(+range.value));
  }

  updateCompare(v) {
    const top = $('#imgAfterView');
    const divider = $('#imgDivider');
    top.style.clipPath = 'inset(0 ' + (100 - v) + '% 0 0)';
    divider.style.left = v + '%';
  }

  bindButtons() {
    $('#imgApplyBtn').addEventListener('click', () => this.apply());
    $('#imgResetBtn').addEventListener('click', () => {
      this.loaded = false;
      this.strokes = [];
      this.history = [];
      this.current = null;
      this.segMask = null;
      this.aiRunId++;
      this.resetZoom();
      $('#imgEditor').classList.add('hidden');
      $('#imgResult').classList.add('hidden');
      $('#imgCompare').classList.add('hidden');
      $('#imgCutoutActions').classList.add('hidden');
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
      let src = this.canvas;
      if (this.mode === 'cutout' && this.segMask) src = this.composeCutoutCanvas();
      const blob = await new Promise(r => src.toBlob(r, 'image/png'));
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      saveResult(blob, '去水印图片-' + ts + '.png');
    });
    $('#imgShareBtn').addEventListener('click', async () => {
      let src = this.canvas;
      if (this.mode === 'cutout' && this.segMask) src = this.composeCutoutCanvas();
      const blob = await new Promise(r => src.toBlob(r, 'image/png'));
      shareResult(blob, '去水印图片.png');
    });
    $('#imgEditAgainBtn').addEventListener('click', () => {
      $('#imgResult').classList.add('hidden');
      $('#imgCompare').classList.add('hidden');
      this.updateHint();
      $('#imgStage').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    $('#imgCutoutDownloadBtn').addEventListener('click', async () => {
      const out = this.composeCutoutCanvas();
      const blob = await new Promise(r => out.toBlob(r, 'image/png'));
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      saveResult(blob, '抠图-' + ts + '.png');
    });
    $('#imgCutoutRemoveBtn').addEventListener('click', () => this.removeSubject());
    $('#imgCutoutBackBtn').addEventListener('click', () => $('#imgCutoutActions').classList.add('hidden'));
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
