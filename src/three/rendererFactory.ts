import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { StageRendererBackend } from './types';

export interface StageRendererHandle {
  activeBackend: StageRendererBackend;
  isWebGPU: boolean;
  webglRenderer: THREE.WebGLRenderer | null;
  domElement: HTMLCanvasElement;
  maxAnisotropy: number;
  fallbackNotice: string | null;
  shadowMap: {
    enabled: boolean;
    type: THREE.ShadowMapType;
    autoUpdate: boolean;
    needsUpdate: boolean;
  };
  setPixelRatio: (dpr: number) => void;
  getPixelRatio: () => number;
  setSize: (width: number, height: number) => void;
  render: (scene: THREE.Scene, camera: THREE.Camera) => void;
  compile: (scene: THREE.Scene, camera: THREE.Camera) => void;
  createStudioEnvironment: () => { texture: THREE.Texture; dispose: () => void } | null;
  dispose: () => void;
}

interface WebGPURendererLike {
  domElement: HTMLCanvasElement;
  toneMapping: THREE.ToneMapping;
  toneMappingExposure: number;
  outputColorSpace: THREE.ColorSpace;
  shadowMap: {
    enabled: boolean;
    type: THREE.ShadowMapType;
    autoUpdate: boolean;
    needsUpdate: boolean;
  };
  backend?: {
    device?: {
      lost?: Promise<{ reason?: string; message?: string }>;
    };
  };
  init: () => Promise<void>;
  setPixelRatio: (dpr: number) => void;
  getPixelRatio: () => number;
  setSize: (width: number, height: number) => void;
  render: (scene: THREE.Scene, camera: THREE.Camera) => void;
  compileAsync?: (scene: THREE.Scene, camera: THREE.Camera) => Promise<void>;
  dispose: () => void;
}

/**
 * Instantiates either a live Three.js `WebGPURenderer` (dynamically imported from `three/webgpu`
 * when requested and supported by the host browser) or a standard `THREE.WebGLRenderer`,
 * with automatic fallback to WebGL2 and WebGPU device-loss monitoring.
 */
export async function createStageRenderer(opts: {
  preferredBackend: StageRendererBackend;
  width: number;
  height: number;
  pixelRatio: number;
  isSoftwareGl: boolean;
  shadowsEnabled: boolean;
  shadowType: THREE.ShadowMapType;
  onWebGPUDeviceLost?: (reason: string) => void;
}): Promise<StageRendererHandle> {
  const {
    preferredBackend,
    width,
    height,
    pixelRatio,
    isSoftwareGl,
    shadowsEnabled,
    shadowType,
    onWebGPUDeviceLost,
  } = opts;

  let fallbackNotice: string | null = null;

  if (preferredBackend === 'webgpu') {
    const hasGpuApi =
      typeof navigator !== 'undefined' &&
      Boolean((navigator as unknown as { gpu?: unknown }).gpu);

    if (isSoftwareGl) {
      fallbackNotice = 'Software GPU detected — using WebGL2';
    } else if (!hasGpuApi) {
      fallbackNotice = 'WebGPU API not available in this browser — using WebGL2';
    } else {
      try {
        const webgpuMod = (await import('three/webgpu')) as unknown as {
          WebGPURenderer: new (params?: Record<string, unknown>) => WebGPURendererLike;
          PMREMGenerator?: new (renderer: unknown) => {
            fromScene: (scene: THREE.Scene, sigma?: number) => {
              texture: THREE.Texture;
              dispose: () => void;
            };
            dispose: () => void;
          };
        };

        const gpuRenderer = new webgpuMod.WebGPURenderer({
          antialias: true,
          powerPreference: 'high-performance',
          forceWebGL: false,
        });

        await gpuRenderer.init();

        gpuRenderer.setPixelRatio(pixelRatio);
        gpuRenderer.setSize(width, height);
        gpuRenderer.toneMapping = THREE.ACESFilmicToneMapping;
        gpuRenderer.toneMappingExposure = 1.08;
        gpuRenderer.outputColorSpace = THREE.SRGBColorSpace;
        if (gpuRenderer.shadowMap) {
          gpuRenderer.shadowMap.enabled = shadowsEnabled;
          gpuRenderer.shadowMap.type = shadowType;
          gpuRenderer.shadowMap.autoUpdate = false;
          gpuRenderer.shadowMap.needsUpdate = true;
        }

        // Monitor unexpected WebGPU device loss and recover cleanly to WebGL2
        const deviceLostPromise = gpuRenderer.backend?.device?.lost;
        if (deviceLostPromise && typeof deviceLostPromise.then === 'function') {
          void deviceLostPromise.then((info) => {
            if (info?.reason && info.reason !== 'destroyed') {
              onWebGPUDeviceLost?.(info.message || info.reason);
            }
          });
        }

        return {
          activeBackend: 'webgpu',
          isWebGPU: true,
          webglRenderer: null,
          domElement: gpuRenderer.domElement,
          maxAnisotropy: 16,
          fallbackNotice: null,
          shadowMap: gpuRenderer.shadowMap ?? {
            enabled: shadowsEnabled,
            type: shadowType,
            autoUpdate: false,
            needsUpdate: true,
          },
          setPixelRatio: (dpr) => gpuRenderer.setPixelRatio(dpr),
          getPixelRatio: () => gpuRenderer.getPixelRatio(),
          setSize: (w, h) => gpuRenderer.setSize(w, h),
          render: (scene, camera) => gpuRenderer.render(scene, camera),
          compile: (scene, camera) => {
            if (typeof gpuRenderer.compileAsync === 'function') {
              void gpuRenderer.compileAsync(scene, camera).catch(() => {});
            }
          },
          createStudioEnvironment: () => {
            try {
              const PmremCtor =
                webgpuMod.PMREMGenerator ??
                (THREE.PMREMGenerator as unknown as new (r: unknown) => {
                  fromScene: (scene: THREE.Scene, sigma?: number) => {
                    texture: THREE.Texture;
                    dispose: () => void;
                  };
                  dispose: () => void;
                });
              const pmrem = new PmremCtor(gpuRenderer);
              const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
              pmrem.dispose();
              return envTarget;
            } catch {
              return null;
            }
          },
          dispose: () => {
            try {
              gpuRenderer.dispose();
            } catch {
              // Ignore disposal error if device already lost
            }
          },
        };
      } catch {
        fallbackNotice = 'WebGPU init failed — fell back cleanly to WebGL2';
      }
    }
  }

  // Standard WebGL2 Hardware / Software Renderer
  const glRenderer = new THREE.WebGLRenderer({
    antialias: !isSoftwareGl,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });

  glRenderer.setPixelRatio(pixelRatio);
  glRenderer.setSize(width, height);
  glRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  glRenderer.toneMappingExposure = 1.08;
  glRenderer.outputColorSpace = THREE.SRGBColorSpace;
  glRenderer.shadowMap.enabled = !isSoftwareGl && shadowsEnabled;
  glRenderer.shadowMap.type = shadowType;
  glRenderer.shadowMap.autoUpdate = false;
  glRenderer.shadowMap.needsUpdate = true;

  const maxAnisotropy = glRenderer.capabilities.getMaxAnisotropy();

  return {
    activeBackend: 'webgl2',
    isWebGPU: false,
    webglRenderer: glRenderer,
    domElement: glRenderer.domElement,
    maxAnisotropy,
    fallbackNotice,
    shadowMap: glRenderer.shadowMap,
    setPixelRatio: (dpr) => glRenderer.setPixelRatio(dpr),
    getPixelRatio: () => glRenderer.getPixelRatio(),
    setSize: (w, h) => glRenderer.setSize(w, h),
    render: (scene, camera) => glRenderer.render(scene, camera),
    compile: (scene, camera) => {
      if (!isSoftwareGl) {
        glRenderer.compile(scene, camera);
      }
    },
    createStudioEnvironment: () => {
      const pmrem = new THREE.PMREMGenerator(glRenderer);
      const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
      pmrem.dispose();
      return envTarget;
    },
    dispose: () => {
      glRenderer.dispose();
    },
  };
}
