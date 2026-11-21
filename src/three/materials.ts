import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';

let rectAreaUniformsInitialized = false;

/**
 * Initializes RectAreaLight LTC uniforms once on hardware GPUs.
 * Skipped on software WebGL to avoid per-fragment LTC lookup cost.
 */
export function initStudioSoftboxUniforms(isSoftwareGl: boolean): void {
  if (isSoftwareGl || rectAreaUniformsInitialized) return;
  RectAreaLightUniformsLib.init();
  rectAreaUniformsInitialized = true;
}

/**
 * Creates a warm/cool pair of studio RectAreaLight softboxes positioned to throw
 * elongated specular highlights across machined laptop bevels, glass, and foil slabs.
 */
export function createStudioSoftboxPair(
  isSoftwareGl: boolean
): THREE.RectAreaLight[] {
  if (isSoftwareGl) return [];
  initStudioSoftboxUniforms(false);

  const warmKeyBox = new THREE.RectAreaLight(0xffe7cc, 3.2, 5.4, 2.8);
  warmKeyBox.position.set(5.6, 6.2, 6.4);
  warmKeyBox.lookAt(0, 2.0, 0);

  const coolFillBox = new THREE.RectAreaLight(0x67e8f9, 2.1, 4.6, 2.6);
  coolFillBox.position.set(-5.8, 4.8, 5.2);
  coolFillBox.lookAt(0, 1.9, 0);

  return [warmKeyBox, coolFillBox];
}

/**
 * Node-ready anodized CNC aluminum / titanium PBR material with directional anisotropy.
 */
export function createAnodizedChassisMaterial(opts: {
  color: number;
  roughness?: number;
  metalness?: number;
  anisotropy?: number;
  clearcoat?: number;
}): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: opts.color,
    metalness: opts.metalness ?? 0.86,
    roughness: opts.roughness ?? 0.24,
    anisotropy: opts.anisotropy ?? 0.72,
    anisotropyRotation: Math.PI * 0.25,
    clearcoat: opts.clearcoat ?? 0.32,
    clearcoatRoughness: 0.18,
  });
}

export interface HolographicFoilMaterialHandle {
  material: THREE.MeshPhysicalMaterial;
  setTime: (elapsedSec: number) => void;
}

/**
 * Creates an iridescent holographic collector foil PBR material.
 * Preserves full PBR shadows, RoomEnvironment reflections, and clearcoat while
 * injecting a subtle angle- & time-reactive prismatic wave via `onBeforeCompile`.
 */
export function createHolographicFoilMaterial(
  isSoftwareGl: boolean
): HolographicFoilMaterialHandle {
  const uniforms = {
    uFoilTime: { value: 0 },
    uFoilStrength: { value: isSoftwareGl ? 0.14 : 0.22 },
  };

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0.28,
    roughness: 0.16,
    clearcoat: 1.0,
    clearcoatRoughness: 0.08,
    iridescence: 1.0,
    iridescenceIOR: 1.38,
    iridescenceThicknessRange: [130, 480],
    emissive: 0x0b1926,
    emissiveIntensity: 0.34,
  });

  if (!isSoftwareGl) {
    material.customProgramCacheKey = () => 'athena-holo-foil-v1';
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uFoilTime = uniforms.uFoilTime;
      shader.uniforms.uFoilStrength = uniforms.uFoilStrength;

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec2 vHoloUv;
varying vec3 vHoloViewPos;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
vHoloUv = uv;
vHoloViewPos = (modelViewMatrix * vec4(transformed, 1.0)).xyz;`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uFoilTime;
uniform float uFoilStrength;
varying vec2 vHoloUv;
varying vec3 vHoloViewPos;`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
vec3 holoViewDir = normalize(-vHoloViewPos);
float holoBand = sin((vHoloUv.x * 11.0 + vHoloUv.y * 8.5) + uFoilTime * 1.35 + holoViewDir.x * 4.5);
float holoBand2 = cos((vHoloUv.x * 6.5 - vHoloUv.y * 12.0) - uFoilTime * 0.9 + holoViewDir.y * 3.8);
vec3 prismTint = vec3(
  0.52 + 0.48 * sin(holoBand * 2.4 + 0.2),
  0.58 + 0.42 * sin(holoBand * 2.4 + 2.1),
  0.66 + 0.34 * sin(holoBand2 * 2.4 + 4.1)
);
float sheenMask = smoothstep(-0.2, 0.95, holoBand * 0.6 + holoBand2 * 0.4);
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * (0.82 + prismTint * 0.55), sheenMask * uFoilStrength);`
        );
    };
  }

  return {
    material,
    setTime: (elapsedSec: number) => {
      uniforms.uFoilTime.value = elapsedSec;
    },
  };
}

export interface WetAsphaltRoadHandle {
  material: THREE.MeshPhysicalMaterial;
  setTelemetry: (elapsedSec: number, speedNorm: number) => void;
}

/**
 * Creates a wet-asphalt expressway material for Dispatch Run 3D with clearcoat
 * specular reflections and speed-reactive cyan/amber horizon lane streaks via `onBeforeCompile`.
 */
export function createWetAsphaltCorridorMaterial(
  roadTex: THREE.Texture,
  isSoftwareGl: boolean
): WetAsphaltRoadHandle {
  const uniforms = {
    uRoadTime: { value: 0 },
    uSpeedNorm: { value: 0.35 },
  };

  const material = new THREE.MeshPhysicalMaterial({
    map: roadTex,
    roughness: 0.44,
    metalness: 0.26,
    clearcoat: isSoftwareGl ? 0 : 0.68,
    clearcoatRoughness: 0.22,
  });

  if (!isSoftwareGl) {
    material.customProgramCacheKey = () => 'athena-wet-asphalt-v1';
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uRoadTime = uniforms.uRoadTime;
      shader.uniforms.uSpeedNorm = uniforms.uSpeedNorm;

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec2 vRoadUv;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
vRoadUv = uv;`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uRoadTime;
uniform float uSpeedNorm;
varying vec2 vRoadUv;`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
float puddleWave = sin(vRoadUv.y * 46.0 - uRoadTime * (4.0 + uSpeedNorm * 9.0)) * cos(vRoadUv.x * 18.0);
float edgeGlow = smoothstep(0.32, 0.49, abs(vRoadUv.x - 0.5));
vec3 wetSheen = mix(vec3(0.05, 0.24, 0.32), vec3(0.26, 0.16, 0.04), step(0.82, edgeGlow));
diffuseColor.rgb += wetSheen * max(0.0, puddleWave) * (0.14 + uSpeedNorm * 0.22);`
        );
    };
  }

  return {
    material,
    setTelemetry: (elapsedSec: number, speedNorm: number) => {
      uniforms.uRoadTime.value = elapsedSec;
      uniforms.uSpeedNorm.value = THREE.MathUtils.clamp(speedNorm, 0, 1.5);
    },
  };
}
