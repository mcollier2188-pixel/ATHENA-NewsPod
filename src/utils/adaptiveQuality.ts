import * as THREE from 'three';

export type QualityTier = 'high' | 'medium' | 'low';

export interface AdaptiveQualitySettings {
  adaptive: boolean;
  manualTier: QualityTier;
}

export interface QualityTierSpec {
  id: QualityTier;
  label: string;
  standardMaxDpr: number;
  immersiveMaxDpr: number;
  dprScale: number;
  minDpr: number;
  shadowsEnabled: boolean;
  shadowMapSize: number;
  shadowType: THREE.ShadowMapType;
  shadowRadius: number;
}

const STORAGE_KEY = 'dispatch_spatial_adaptive_quality_v1';

export const QUALITY_TIER_ORDER: readonly QualityTier[] = ['high', 'medium', 'low'];

export const QUALITY_TIER_SPECS: Record<QualityTier, QualityTierSpec> = {
  high: {
    id: 'high',
    label: 'High',
    standardMaxDpr: 2.0,
    immersiveMaxDpr: 1.65,
    dprScale: 1.0,
    minDpr: 1.0,
    shadowsEnabled: true,
    shadowMapSize: 1024,
    shadowType: THREE.PCFSoftShadowMap,
    shadowRadius: 2.4,
  },
  medium: {
    id: 'medium',
    label: 'Balanced',
    standardMaxDpr: 1.35,
    immersiveMaxDpr: 1.15,
    dprScale: 0.8,
    minDpr: 0.85,
    shadowsEnabled: true,
    shadowMapSize: 512,
    shadowType: THREE.PCFShadowMap,
    shadowRadius: 1.0,
  },
  low: {
    id: 'low',
    label: 'Performance',
    standardMaxDpr: 1.0,
    immersiveMaxDpr: 0.85,
    dprScale: 0.65,
    minDpr: 0.72,
    shadowsEnabled: false,
    shadowMapSize: 256,
    shadowType: THREE.BasicShadowMap,
    shadowRadius: 1.0,
  },
};

export function loadAdaptiveQualitySettings(): AdaptiveQualitySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { adaptive: true, manualTier: 'high' };
    }
    const parsed = JSON.parse(raw) as Partial<AdaptiveQualitySettings>;
    const adaptive = typeof parsed.adaptive === 'boolean' ? parsed.adaptive : true;
    const manualTier: QualityTier =
      parsed.manualTier === 'high' ||
      parsed.manualTier === 'medium' ||
      parsed.manualTier === 'low'
        ? parsed.manualTier
        : 'high';
    return { adaptive, manualTier };
  } catch {
    return { adaptive: true, manualTier: 'high' };
  }
}

export function saveAdaptiveQualitySettings(settings: AdaptiveQualitySettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

export function computeTierPixelRatio(
  tier: QualityTier,
  immersive: boolean,
  isSoftwareGl: boolean
): number {
  if (isSoftwareGl) {
    return tier === 'low' ? 0.8 : 1.0;
  }
  const nativeDpr =
    typeof window !== 'undefined' && window.devicePixelRatio
      ? window.devicePixelRatio
      : 1;
  const spec = QUALITY_TIER_SPECS[tier];
  const maxCap = immersive ? spec.immersiveMaxDpr : spec.standardMaxDpr;
  const scaled = Math.max(spec.minDpr, Math.min(nativeDpr * spec.dprScale, maxCap));
  return Number(scaled.toFixed(2));
}

/**
 * Zero-allocation rolling frame-time governor with hysteresis cooldowns.
 * Automatically steps down quality when sustained FPS drops and recovers smoothly
 * once headroom returns, ignoring idle pauses or backgrounded tab intervals.
 */
export class AdaptiveFrameGovernor {
  private readonly samples = new Float32Array(45);
  private sampleIndex = 0;
  private sampleCount = 0;
  private runningSum = 0;
  private currentTier: QualityTier;
  private lastTransitionMs = 0;

  private static readonly MIN_VALID_DELTA_SEC = 0.001;
  private static readonly MAX_IDLE_GAP_SEC = 0.14;
  private static readonly MIN_SAMPLES_FOR_DOWNGRADE = 28;
  private static readonly MIN_SAMPLES_FOR_UPGRADE = 45;
  private static readonly DOWNGRADE_COOLDOWN_MS = 1650;
  private static readonly UPGRADE_COOLDOWN_MS = 3600;

  constructor(initialTier: QualityTier = 'high') {
    this.currentTier = initialTier;
  }

  getTier(): QualityTier {
    return this.currentTier;
  }

  resetSamples(): void {
    this.sampleIndex = 0;
    this.sampleCount = 0;
    this.runningSum = 0;
    this.samples.fill(0);
  }

  setTier(tier: QualityTier, nowMs = 0): void {
    this.currentTier = tier;
    this.lastTransitionMs = nowMs;
    this.resetSamples();
  }

  recordFrame(rawDeltaSec: number, nowMs: number): QualityTier | null {
    if (
      rawDeltaSec < AdaptiveFrameGovernor.MIN_VALID_DELTA_SEC ||
      rawDeltaSec > AdaptiveFrameGovernor.MAX_IDLE_GAP_SEC
    ) {
      // Ignore tab switch / on-demand idle gap so pauses never masquerade as low FPS
      this.resetSamples();
      return null;
    }

    if (this.sampleCount === this.samples.length) {
      this.runningSum -= this.samples[this.sampleIndex];
    } else {
      this.sampleCount += 1;
    }
    this.samples[this.sampleIndex] = rawDeltaSec;
    this.runningSum += rawDeltaSec;
    this.sampleIndex = (this.sampleIndex + 1) % this.samples.length;

    if (this.sampleCount < AdaptiveFrameGovernor.MIN_SAMPLES_FOR_DOWNGRADE) {
      return null;
    }

    const avgDeltaSec = this.runningSum / this.sampleCount;
    const avgFps = 1 / Math.max(avgDeltaSec, 0.0001);
    const elapsedSinceTransition = nowMs - this.lastTransitionMs;

    // Step down when frame rate dips below smooth navigation thresholds
    if (elapsedSinceTransition >= AdaptiveFrameGovernor.DOWNGRADE_COOLDOWN_MS) {
      if (this.currentTier === 'high' && avgFps < 48) {
        this.currentTier = 'medium';
        this.lastTransitionMs = nowMs;
        this.resetSamples();
        return this.currentTier;
      }
      if (this.currentTier === 'medium' && avgFps < 35) {
        this.currentTier = 'low';
        this.lastTransitionMs = nowMs;
        this.resetSamples();
        return this.currentTier;
      }
    }

    // Step back up gradually when sustained near-60fps headroom is confirmed
    if (
      this.currentTier !== 'high' &&
      this.sampleCount >= AdaptiveFrameGovernor.MIN_SAMPLES_FOR_UPGRADE &&
      elapsedSinceTransition >= AdaptiveFrameGovernor.UPGRADE_COOLDOWN_MS &&
      avgFps >= 57
    ) {
      this.currentTier = this.currentTier === 'low' ? 'medium' : 'high';
      this.lastTransitionMs = nowMs;
      this.resetSamples();
      return this.currentTier;
    }

    return null;
  }
}

export interface ApplyThreeQualityOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  shadowLight: THREE.DirectionalLight;
  width: number;
  height: number;
  tier: QualityTier;
  immersive: boolean;
  isSoftwareGl: boolean;
  autoUpdateShadows: boolean;
  forceResize?: boolean;
}

/**
 * Applies Three.js pixel ratio scaling and directional shadow map resolution/filtering
 * for a given QualityTier, safely disposing stale WebGL shadow targets and refreshing
 * PBR shader defines when shadow state changes.
 */
export function applyThreeSceneQuality({
  renderer,
  scene,
  shadowLight,
  width,
  height,
  tier,
  immersive,
  isSoftwareGl,
  autoUpdateShadows,
  forceResize = false,
}: ApplyThreeQualityOptions): void {
  const spec = QUALITY_TIER_SPECS[tier];
  const targetDpr = computeTierPixelRatio(tier, immersive, isSoftwareGl);

  if (forceResize || Math.abs(renderer.getPixelRatio() - targetDpr) > 0.005) {
    renderer.setPixelRatio(targetDpr);
    renderer.setSize(width, height);
  }

  const wantShadows = !isSoftwareGl && spec.shadowsEnabled;
  const prevShadowsEnabled = renderer.shadowMap.enabled;
  const prevShadowType = renderer.shadowMap.type;

  renderer.shadowMap.enabled = wantShadows;
  renderer.shadowMap.type = spec.shadowType;
  renderer.shadowMap.autoUpdate = wantShadows && autoUpdateShadows;
  shadowLight.castShadow = wantShadows;
  shadowLight.shadow.radius = spec.shadowRadius;

  const shadowWithMap = shadowLight.shadow as THREE.DirectionalLightShadow & {
    map: THREE.WebGLRenderTarget | null;
  };

  if (wantShadows) {
    if (
      shadowLight.shadow.mapSize.x !== spec.shadowMapSize ||
      shadowLight.shadow.mapSize.y !== spec.shadowMapSize
    ) {
      if (shadowWithMap.map) {
        shadowWithMap.map.dispose();
        shadowWithMap.map = null;
      }
      shadowLight.shadow.mapSize.set(spec.shadowMapSize, spec.shadowMapSize);
    }
    renderer.shadowMap.needsUpdate = true;
  } else if (shadowWithMap.map) {
    shadowWithMap.map.dispose();
    shadowWithMap.map = null;
  }

  if (prevShadowsEnabled !== wantShadows || prevShadowType !== spec.shadowType) {
    const visited = new Set<THREE.Material>();
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
          if (
            mat &&
            !visited.has(mat) &&
            !(mat instanceof THREE.MeshBasicMaterial)
          ) {
            visited.add(mat);
            mat.needsUpdate = true;
          }
        }
      }
    });
  }
}
