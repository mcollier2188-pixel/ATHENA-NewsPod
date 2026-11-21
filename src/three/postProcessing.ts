import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { PostProcessingConfig } from './types';

export interface StudioPostPipelineHandle {
  isSupported: boolean;
  setConfig: (config: PostProcessingConfig) => void;
  setSize: (width: number, height: number, pixelRatio: number) => void;
  render: () => void;
  dispose: () => void;
}

/**
 * Studio Post-Processing Pipeline for WebGL2 hardware GPUs:
 * - HalfFloat MSAA EffectComposer render target
 * - RenderPass -> GTAOPass (contact ambient occlusion) -> UnrealBloomPass (selective specular/emissive glow) -> OutputPass (ACES Filmic + sRGB)
 * Automatically bypasses multi-pass post-processing on software WebGL or when disabled.
 */
export function createStudioPostPipeline(opts: {
  renderer: THREE.WebGLRenderer | null;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  width: number;
  height: number;
  pixelRatio: number;
  isSoftwareGl: boolean;
  initialConfig: PostProcessingConfig;
}): StudioPostPipelineHandle {
  const { renderer, scene, camera, width, height, pixelRatio, isSoftwareGl } = opts;
  let config: PostProcessingConfig = { ...opts.initialConfig };

  // Software WebGL or WebGPU backend: render directly via the active renderer without WebGL2 EffectComposer
  if (!renderer || isSoftwareGl) {
    return {
      isSupported: false,
      setConfig: (next) => {
        config = { ...next };
      },
      setSize: () => {},
      render: () => {
        renderer?.render(scene, camera);
      },
      dispose: () => {},
    };
  }

  const safeW = Math.max(64, Math.floor(width));
  const safeH = Math.max(64, Math.floor(height));

  const renderTarget = new THREE.WebGLRenderTarget(
    Math.floor(safeW * pixelRatio),
    Math.floor(safeH * pixelRatio),
    {
      type: THREE.HalfFloatType,
      samples: 4,
    }
  );

  const composer = new EffectComposer(renderer, renderTarget);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(safeW, safeH);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  let gtaoPass: GTAOPass | null = null;
  try {
    gtaoPass = new GTAOPass(scene, camera, safeW, safeH);
    gtaoPass.output = GTAOPass.OUTPUT.Default;
    gtaoPass.blendIntensity = 0.58;
    gtaoPass.updateGtaoMaterial({
      radius: 0.48,
      distanceExponent: 1.75,
      thickness: 0.9,
      distanceFallOff: 1.0,
      scale: 1.05,
      samples: 12,
      screenSpaceRadius: false,
    });
    gtaoPass.updatePdMaterial({
      lumaPhi: 10,
      depthPhi: 2,
      normalPhi: 3,
      radius: 4,
      radiusExponent: 1,
      rings: 2,
      samples: 12,
    });
    gtaoPass.enabled = config.enabled && config.aoEnabled;
    composer.addPass(gtaoPass);
  } catch {
    gtaoPass = null;
  }

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(safeW, safeH),
    config.bloomStrength,
    0.42,
    0.92
  );
  bloomPass.enabled = config.enabled && config.bloomStrength > 0.005;
  composer.addPass(bloomPass);

  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  const applyConfig = (next: PostProcessingConfig) => {
    config = { ...next };
    bloomPass.strength = THREE.MathUtils.clamp(config.bloomStrength, 0, 1.5);
    bloomPass.enabled = config.enabled && bloomPass.strength > 0.005;
    if (gtaoPass) {
      gtaoPass.enabled = config.enabled && config.aoEnabled;
    }
  };
  applyConfig(config);

  return {
    isSupported: true,
    setConfig: applyConfig,
    setSize: (nextW: number, nextH: number, nextDpr: number) => {
      const w = Math.max(64, Math.floor(nextW));
      const h = Math.max(64, Math.floor(nextH));
      composer.setPixelRatio(nextDpr);
      composer.setSize(w, h);
      bloomPass.resolution.set(w, h);
      if (gtaoPass) {
        gtaoPass.setSize(w, h);
      }
    },
    render: () => {
      if (!config.enabled) {
        renderer.render(scene, camera);
        return;
      }
      composer.render();
    },
    dispose: () => {
      try {
        gtaoPass?.dispose();
      } catch {
        // Ignore internal disposal quirks
      }
      bloomPass.dispose();
      outputPass.dispose();
      renderTarget.dispose();
      composer.dispose();
    },
  };
}
