import * as THREE from 'three';
import type { Runtime3DCapabilities } from './types';

interface GpuAdapterInfoLike {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

interface GpuAdapterLike {
  limits?: {
    maxBufferSize?: number;
    maxStorageBufferBindingSize?: number;
  };
  features?: ReadonlySet<string>;
  info?: GpuAdapterInfoLike;
}

interface NavigatorWithGpu {
  gpu?: {
    requestAdapter: (options?: {
      powerPreference?: 'high-performance' | 'low-power';
    }) => Promise<GpuAdapterLike | null>;
  };
}

let cachedGlProfile: { isSoftwareGl: boolean; rendererLabel: string } | null =
  null;

/**
 * Detects software WebGL (SwiftShader, llvmpipe, softpipe, WARP) directly from
 * the GPU renderer string and immediately releases the probe context.
 */
export function detectWebGLHardwareProfile(): {
  isSoftwareGl: boolean;
  rendererLabel: string;
} {
  if (cachedGlProfile) return cachedGlProfile;
  if (typeof document === 'undefined') {
    return { isSoftwareGl: true, rendererLabel: 'Headless WebGL' };
  }

  const probeCanvas = document.createElement('canvas');
  const gl =
    probeCanvas.getContext('webgl2') || probeCanvas.getContext('webgl');
  if (!gl) {
    cachedGlProfile = { isSoftwareGl: true, rendererLabel: 'WebGL Unavailable' };
    return cachedGlProfile;
  }

  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const param = dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
  const rawGpu = String(gl.getParameter(param) || 'WebGL2 Renderer').trim();
  gl.getExtension('WEBGL_lose_context')?.loseContext();

  const isSoftwareGl =
    /SwiftShader|llvmpipe|softpipe|Software|Basic Render|Mesa/i.test(rawGpu);

  const compactLabel = rawGpu
    .replace(/^ANGLE \((.*)\)$/i, '$1')
    .split(',')[0]
    .trim()
    .slice(0, 42);

  cachedGlProfile = {
    isSoftwareGl,
    rendererLabel: compactLabel || 'WebGL2 GPU',
  };
  return cachedGlProfile;
}

/**
 * Probes 2027-ready WebGPU adapter limits (`maxBufferSize`, `maxStorageBufferBindingSize`)
 * and optional features (`float32-filterable`, `shader-f16`) alongside WebGL2 anisotropy.
 */
export async function probeRuntime3DCapabilities(
  maxAnisotropy: number
): Promise<Runtime3DCapabilities> {
  const { isSoftwareGl, rendererLabel } = detectWebGLHardwareProfile();
  const base: Runtime3DCapabilities = {
    webgpuSupported: false,
    webgpuAdapterLabel: 'WebGL2 Active',
    maxBufferSizeMb: 256,
    maxStorageBufferMb: 128,
    featuresCount: 0,
    hasFloat32Filterable: false,
    hasShaderF16: false,
    isSoftwareGl,
    rendererLabel,
    maxAnisotropy,
  };

  if (typeof navigator === 'undefined') return base;
  const nav = navigator as unknown as NavigatorWithGpu;
  if (!nav.gpu || typeof nav.gpu.requestAdapter !== 'function') {
    return base;
  }

  try {
    const adapter = await nav.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });
    if (!adapter) return base;

    const maxBufBytes = adapter.limits?.maxBufferSize ?? 268_435_456;
    const maxStorageBytes =
      adapter.limits?.maxStorageBufferBindingSize ?? 134_217_728;
    const features = adapter.features;
    const info = adapter.info;
    const labelParts = [info?.vendor, info?.architecture || info?.device]
      .filter(Boolean)
      .join(' ');

    return {
      ...base,
      webgpuSupported: true,
      webgpuAdapterLabel: labelParts
        ? `WebGPU Ready (${labelParts})`
        : 'WebGPU Ready',
      maxBufferSizeMb: Math.round(maxBufBytes / (1024 * 1024)),
      maxStorageBufferMb: Math.round(maxStorageBytes / (1024 * 1024)),
      featuresCount: features ? features.size : 0,
      hasFloat32Filterable: Boolean(features?.has('float32-filterable')),
      hasShaderF16: Boolean(features?.has('shader-f16')),
    };
  } catch {
    return base;
  }
}

/**
 * Schedules a non-starving software-WebGL continuation using WebGL2 `fenceSync`
 * + 80ms breathing pause so headless/VDI browsers never lock the main thread.
 */
export function scheduleSoftwareGlAfterDraw(
  renderer: THREE.WebGLRenderer,
  isDisposed: () => boolean,
  onReady: () => void
): () => void {
  let timerId = 0;
  const gl = renderer.getContext() as WebGL2RenderingContext | null;

  if (gl && typeof gl.fenceSync === 'function') {
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (isDisposed()) {
        if (sync) gl.deleteSync(sync);
        return;
      }
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        timerId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        timerId = window.setTimeout(() => {
          if (!isDisposed()) onReady();
        }, 80);
      }
    };
    timerId = window.setTimeout(poll, 5);
    return () => {
      if (timerId) window.clearTimeout(timerId);
      if (sync) {
        try {
          gl.deleteSync(sync);
        } catch {
          // Context may already be disposed
        }
      }
    };
  }

  timerId = window.setTimeout(() => {
    if (!isDisposed()) onReady();
  }, 80);

  return () => {
    if (timerId) window.clearTimeout(timerId);
  };
}
