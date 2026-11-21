import * as THREE from 'three';

let cachedConcreteCanvas: HTMLCanvasElement | null = null;
let cachedCedarCanvas: HTMLCanvasElement | null = null;
let cachedContactShadowCanvas: HTMLCanvasElement | null = null;
let cachedDefaultScreenCanvas: HTMLCanvasElement | null = null;

/**
 * Schedules non-blocking asset hydration during browser idle slices
 * (with a bounded timeout so 3D assets still appear promptly under load).
 */
export function scheduleIdleStageTask(task: () => void, timeoutMs = 120): () => void {
  const win = window as Window & {
    requestIdleCallback?: (
      cb: () => void,
      opts?: { timeout: number }
    ) => number;
    cancelIdleCallback?: (id: number) => void;
  };

  if (typeof win.requestIdleCallback === 'function') {
    const idleId = win.requestIdleCallback(task, { timeout: timeoutMs });
    return () => {
      win.cancelIdleCallback?.(idleId);
    };
  }

  const timerId = window.setTimeout(task, 16);
  return () => {
    window.clearTimeout(timerId);
  };
}

/**
 * Lazily generates and caches the 512x512 concrete plaza canvas using a single
 * typed-array ImageData pass instead of thousands of 2D fillRect calls.
 */
function getConcreteCanvas(): HTMLCanvasElement {
  if (cachedConcreteCanvas) return cachedConcreteCanvas;

  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const imgData = ctx.createImageData(size, size);
    const data = imgData.data;
    // Deterministic fast LCG grain over #1b2029 (27, 32, 41)
    let seed = 0x2f6e2b1;
    for (let i = 0; i < data.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const delta = ((seed >>> 24) & 0x1f) - 12;
      data[i] = Math.max(0, Math.min(255, 27 + delta));
      data[i + 1] = Math.max(0, Math.min(255, 32 + delta));
      data[i + 2] = Math.max(0, Math.min(255, 41 + delta));
      data[i + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);

    // Subtle architectural expansion joints
    ctx.strokeStyle = 'rgba(130, 160, 195, 0.13)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= size; i += 64) {
      ctx.moveTo(i, 0);
      ctx.lineTo(i, size);
      ctx.moveTo(0, i);
      ctx.lineTo(size, i);
    }
    ctx.stroke();
  }

  cachedConcreteCanvas = canvas;
  return canvas;
}

function getCedarLouverCanvas(): HTMLCanvasElement {
  if (cachedCedarCanvas) return cachedCedarCanvas;

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#73472c';
    ctx.fillRect(0, 0, 256, 256);
    for (let x = 0; x < 256; x += 16) {
      ctx.fillStyle = x % 32 === 0 ? '#8c5938' : '#653d25';
      ctx.fillRect(x, 0, 12, 256);
      ctx.fillStyle = '#25170e';
      ctx.fillRect(x + 12, 0, 4, 256);
    }
  }

  cachedCedarCanvas = canvas;
  return canvas;
}

function getContactShadowCanvas(): HTMLCanvasElement {
  if (cachedContactShadowCanvas) return cachedContactShadowCanvas;

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(128, 128, 12, 128, 128, 122);
    grad.addColorStop(0, 'rgba(2, 5, 10, 0.72)');
    grad.addColorStop(0.55, 'rgba(2, 5, 10, 0.34)');
    grad.addColorStop(1, 'rgba(2, 5, 10, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
  }

  cachedContactShadowCanvas = canvas;
  return canvas;
}

function getDefaultScreenCanvas(): HTMLCanvasElement {
  if (cachedDefaultScreenCanvas) return cachedDefaultScreenCanvas;

  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 576;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, 1024, 576);
    grad.addColorStop(0, '#09111B');
    grad.addColorStop(1, '#102030');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1024, 576);

    ctx.strokeStyle = 'rgba(34, 211, 238, 0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= 1024; x += 64) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 576);
    }
    for (let y = 0; y <= 576; y += 64) {
      ctx.moveTo(0, y);
      ctx.lineTo(1024, y);
    }
    ctx.stroke();

    ctx.strokeStyle = '#22D3EE';
    ctx.lineWidth = 3;
    ctx.strokeRect(44, 44, 936, 488);

    ctx.fillStyle = '#67E8F9';
    ctx.font = '600 20px ui-monospace, SFMono-Regular, monospace';
    ctx.fillText('DISPATCH // 3D STAGE SHOWCASE', 84, 116);

    ctx.fillStyle = '#F5F7FA';
    ctx.font = '700 58px Georgia, serif';
    ctx.fillText('PAVILION MEDIA WALL', 84, 260);

    ctx.fillStyle = '#9FB0C4';
    ctx.font = '400 24px system-ui, sans-serif';
    ctx.fillText('Send any generated image from Media Lab or upload art below', 84, 324);

    ctx.fillStyle = '#22D3EE';
    ctx.fillRect(84, 382, 180, 6);
  }

  cachedDefaultScreenCanvas = canvas;
  return canvas;
}

export function createCachedConcreteTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(getConcreteCanvas());
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(14, 14);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return tex;
}

export function createCachedCedarTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(getCedarLouverCanvas());
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return tex;
}

export function createCachedContactShadowTexture(): THREE.CanvasTexture {
  return new THREE.CanvasTexture(getContactShadowCanvas());
}

export function createCachedDefaultScreenTexture(
  maxAnisotropy: number
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(getDefaultScreenCanvas());
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return tex;
}

/**
 * Decodes user/Media Lab screen artwork off the main thread via createImageBitmap
 * and caps maximum GPU texture dimensions to <= 2048px to prevent frame spikes.
 */
export async function decodeStageScreenTexture(
  dataUrl: string,
  maxAnisotropy: number
): Promise<THREE.Texture> {
  const MAX_DIM = 2048;

  if (typeof window !== 'undefined' && typeof window.createImageBitmap === 'function') {
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const bitmap = await window.createImageBitmap(blob, {
        premultiplyAlpha: 'none',
      });

      let tex: THREE.Texture;
      if (bitmap.width > MAX_DIM || bitmap.height > MAX_DIM) {
        const scale = Math.min(MAX_DIM / bitmap.width, MAX_DIM / bitmap.height);
        const targetW = Math.max(1, Math.round(bitmap.width * scale));
        const targetH = Math.max(1, Math.round(bitmap.height * scale));
        const offscreen = document.createElement('canvas');
        offscreen.width = targetW;
        offscreen.height = targetH;
        const ctx = offscreen.getContext('2d');
        if (ctx) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(bitmap, 0, 0, targetW, targetH);
        }
        bitmap.close();
        tex = new THREE.CanvasTexture(offscreen);
      } else {
        const offscreen = document.createElement('canvas');
        offscreen.width = bitmap.width;
        offscreen.height = bitmap.height;
        const ctx = offscreen.getContext('2d');
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0);
        }
        bitmap.close();
        tex = new THREE.CanvasTexture(offscreen);
      }

      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = maxAnisotropy;
      tex.needsUpdate = true;
      return tex;
    } catch {
      // Fall back to standard TextureLoader below
    }
  }

  return new Promise<THREE.Texture>((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.load(
      dataUrl,
      (loadedTex) => {
        loadedTex.colorSpace = THREE.SRGBColorSpace;
        loadedTex.anisotropy = maxAnisotropy;
        resolve(loadedTex);
      },
      undefined,
      (err) => reject(err)
    );
  });
}

/**
 * Warms cached procedural canvases during browser idle time before entering 3D / Immersive Mode.
 */
export function prefetchStageProceduralAssets(): () => void {
  return scheduleIdleStageTask(() => {
    getContactShadowCanvas();
    getConcreteCanvas();
    getCedarLouverCanvas();
    getDefaultScreenCanvas();
  }, 300);
}
