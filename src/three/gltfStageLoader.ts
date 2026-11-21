import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createAnodizedChassisMaterial } from './materials';
import type { CustomModelMetadata, InspectedPartInfo } from './types';

export interface CustomModelRigHandle {
  group: THREE.Group;
  slotMaterials: [
    THREE.MeshStandardMaterial,
    THREE.MeshStandardMaterial,
    THREE.MeshStandardMaterial,
  ];
  loadGltfFromBuffer: (
    data: ArrayBuffer | string,
    fileName: string,
    maxAnisotropy: number
  ) => Promise<CustomModelMetadata>;
  clearCustomModel: () => CustomModelMetadata;
  setAnimationPlaying: (playing: boolean) => void;
  applyExplode: (amount: number) => void;
  applyFinish: (colorHex: number, metalness: number, roughness: number) => void;
  updateFrame: (dt: number, elapsedSec: number) => boolean;
  getMetadata: () => CustomModelMetadata;
  dispose: () => void;
}

interface ExplodableMeshEntry {
  mesh: THREE.Object3D;
  restPos: THREE.Vector3;
  explodeDir: THREE.Vector3;
}

const PLINTH_TOP_Y = 0.28;
const TARGET_MODEL_SIZE = 4.1;

function disposeObjectSubtree(root: THREE.Object3D): void {
  const textures = new Set<THREE.Texture>();
  const materials = new Set<THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();

  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      if (obj.geometry) geometries.add(obj.geometry);
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (!mat) continue;
        materials.add(mat);
        const record = mat as unknown as Record<string, unknown>;
        for (const val of Object.values(record)) {
          if (val instanceof THREE.Texture) {
            textures.add(val);
          }
        }
      }
    }
  });

  textures.forEach((t) => t.dispose());
  materials.forEach((m) => m.dispose());
  geometries.forEach((g) => g.dispose());
}

function summarizeMaterial(mat: THREE.Material | THREE.Material[]): string {
  const primary = Array.isArray(mat) ? mat[0] : mat;
  if (!primary) return 'Standard Mesh Material';
  if (primary instanceof THREE.MeshPhysicalMaterial) {
    return `Physical PBR · M ${primary.metalness.toFixed(2)} · R ${primary.roughness.toFixed(2)} · Clearcoat ${primary.clearcoat.toFixed(2)}`;
  }
  if (primary instanceof THREE.MeshStandardMaterial) {
    return `Standard PBR · M ${primary.metalness.toFixed(2)} · R ${primary.roughness.toFixed(2)}`;
  }
  return primary.type || 'Custom Material';
}

function countGeometryTriangles(geo: THREE.BufferGeometry): number {
  if (geo.index) return Math.floor(geo.index.count / 3);
  const pos = geo.attributes.position;
  return pos ? Math.floor(pos.count / 3) : 0;
}

function tagInspectable(mesh: THREE.Object3D, info: InspectedPartInfo): void {
  mesh.layers.enable(1);
  mesh.userData.inspectInfo = info;
}

/**
 * Builds the Custom `.GLB` / `.GLTF` Showcase Rig:
 * - Grounded CNC studio plinth with backlit cyan calibration trim and plaque slot.
 * - Composite 6-part procedural Calibration Gyroscope artifact shown by default
 *   before a user imports a `.glb`/`.gltf` file (zero external 404 assets).
 * - Full GLTFLoader.parse pipeline with auto-centering, auto-scaling, raycast
 *   inspection per mesh, radial exploded-view support, and AnimationMixer playback.
 */
export function buildCustomModelShowcaseRig(
  isSoftwareGl: boolean
): CustomModelRigHandle {
  const group = new THREE.Group();
  group.name = 'CustomModelShowcaseRig';

  const plinthDisposables: Array<{ dispose: () => void }> = [];

  // 1. Studio Plinth Base (Y=0 bottom -> Y=0.28 top)
  const plinthMat = createAnodizedChassisMaterial({
    color: 0x181e28,
    metalness: 0.72,
    roughness: 0.32,
    anisotropy: 0.65,
  });
  const trimRingMat = new THREE.MeshStandardMaterial({
    color: 0x0b1620,
    emissive: 0x22d3ee,
    emissiveIntensity: 1.45,
    roughness: 0.25,
    metalness: 0.2,
  });
  const collarMat = createAnodizedChassisMaterial({
    color: 0x526074,
    metalness: 0.88,
    roughness: 0.22,
  });

  const plinthGeo = new THREE.CylinderGeometry(3.35, 3.58, PLINTH_TOP_Y, 48);
  const plinthMesh = new THREE.Mesh(plinthGeo, plinthMat);
  plinthMesh.position.set(0, PLINTH_TOP_Y / 2, 0);
  plinthMesh.receiveShadow = true;
  plinthMesh.castShadow = true;
  tagInspectable(plinthMesh, {
    partId: 'custom-glb-plinth',
    title: 'Precision Inspection Turntable',
    subtitle: 'Machined Anodized Showcase Plinth',
    materialSummary: 'Anodized Aluminum · M 0.72 · R 0.32',
    focusPos: [5.4, 3.6, 6.2],
    focusTarget: [0, 0.5, 0],
  });

  const collarGeo = new THREE.TorusGeometry(3.38, 0.038, 12, 64);
  collarGeo.rotateX(Math.PI / 2);
  const collarMesh = new THREE.Mesh(collarGeo, collarMat);
  collarMesh.position.set(0, PLINTH_TOP_Y - 0.015, 0);

  const glowRingGeo = new THREE.TorusGeometry(3.49, 0.022, 10, 64);
  glowRingGeo.rotateX(Math.PI / 2);
  const glowRingMesh = new THREE.Mesh(glowRingGeo, trimRingMat);
  glowRingMesh.position.set(0, 0.04, 0);

  // Subtle floor AO grounding ring directly around plinth footprint
  const floorContactGeo = new THREE.RingGeometry(3.45, 4.65, 48);
  floorContactGeo.rotateX(-Math.PI / 2);
  const floorContactMat = new THREE.MeshBasicMaterial({
    color: 0x030508,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const floorContactMesh = new THREE.Mesh(floorContactGeo, floorContactMat);
  floorContactMesh.position.set(0, 0.018, 0);

  // Addressable slot materials (keeping 3-slot contract consistent with all rigs)
  const slot0Mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.4,
    metalness: 0.1,
    emissive: 0x0d1b24,
    emissiveIntensity: 0.3,
  });
  const slot1Mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.35,
    metalness: 0.15,
    emissive: 0x0d1b24,
    emissiveIntensity: 0.25,
  });
  const slot2Mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.42,
    metalness: 0.15,
    emissive: 0x0b1620,
    emissiveIntensity: 0.22,
  });

  // Angled Front Spec Plaque on plinth edge (Slot 2)
  const plaqueFrameGeo = new THREE.BoxGeometry(1.78, 0.46, 0.08);
  const plaqueFrame = new THREE.Mesh(plaqueFrameGeo, collarMat);
  plaqueFrame.position.set(0, 0.22, 3.68);
  plaqueFrame.rotation.x = -0.45;
  const plaqueFaceGeo = new THREE.PlaneGeometry(1.66, 0.38);
  const plaqueFace = new THREE.Mesh(plaqueFaceGeo, slot1Mat);
  plaqueFace.position.set(0, 0, 0.045);
  plaqueFrame.add(plaqueFace);
  tagInspectable(plaqueFrame, {
    partId: 'custom-glb-plaque',
    title: 'Asset Specification Plaque',
    subtitle: 'Slot 2 Media Surface',
    materialSummary: 'Machined Frame · Emissive Spec Plate',
    slotIndex: 1,
    focusPos: [0, 1.45, 5.8],
    focusTarget: [0, 0.3, 3.5],
  });

  group.add(plinthMesh, collarMesh, glowRingMesh, floorContactMesh, plaqueFrame);
  plinthDisposables.push(
    plinthMat,
    trimRingMat,
    collarMat,
    plinthGeo,
    collarGeo,
    glowRingGeo,
    floorContactGeo,
    floorContactMat,
    plaqueFrameGeo,
    plaqueFaceGeo,
    slot0Mat,
    slot1Mat,
    slot2Mat
  );

  // 2. Default Composite 6-Part Studio Calibration Artifact (shown before GLB import)
  const defaultArtifactRoot = new THREE.Group();
  defaultArtifactRoot.name = 'StudioCalibrationArtifact';
  const defaultExplodables: ExplodableMeshEntry[] = [];
  const defaultDisposables: Array<{ dispose: () => void }> = [];

  const brushedTiMat = createAnodizedChassisMaterial({
    color: 0x8e9db0,
    metalness: 0.92,
    roughness: 0.18,
    anisotropy: 0.85,
  });
  const warmBrassMat = createAnodizedChassisMaterial({
    color: 0xc99c58,
    metalness: 0.94,
    roughness: 0.2,
    anisotropy: 0.78,
  });
  const matteCarbonMat = new THREE.MeshStandardMaterial({
    color: 0x1a202b,
    metalness: 0.22,
    roughness: 0.72,
  });
  const crystalCoreMat = new THREE.MeshPhysicalMaterial({
    color: 0xbef5ff,
    metalness: 0.05,
    roughness: 0.08,
    transmission: isSoftwareGl ? 0 : 0.88,
    transparent: true,
    opacity: isSoftwareGl ? 0.42 : 1,
    ior: 1.62,
    thickness: 1.4,
    clearcoat: 1.0,
    clearcoatRoughness: 0.06,
    emissive: 0x0e4f63,
    emissiveIntensity: 0.42,
  });
  const beaconMat = new THREE.MeshStandardMaterial({
    color: 0x67e8f9,
    emissive: 0x22d3ee,
    emissiveIntensity: 2.2,
    roughness: 0.2,
    metalness: 0.1,
  });

  // Part A: Stepped Lathe Pedestal Stem
  const stemPoints = [
    new THREE.Vector2(0.01, 0),
    new THREE.Vector2(0.82, 0),
    new THREE.Vector2(0.76, 0.16),
    new THREE.Vector2(0.42, 0.26),
    new THREE.Vector2(0.32, 0.78),
    new THREE.Vector2(0.48, 0.92),
    new THREE.Vector2(0.01, 0.92),
  ];
  const stemGeo = new THREE.LatheGeometry(stemPoints, 32);
  const stemMesh = new THREE.Mesh(stemGeo, matteCarbonMat);
  stemMesh.position.set(0, PLINTH_TOP_Y, 0);
  stemMesh.castShadow = true;
  stemMesh.receiveShadow = true;
  tagInspectable(stemMesh, {
    partId: 'calib-stem',
    title: 'Machined Carbon Pedestal',
    subtitle: 'Studio Calibration Assembly',
    materialSummary: 'Matte Carbon Composite · R 0.72 · M 0.22',
    focusPos: [4.2, 2.2, 4.6],
    focusTarget: [0, 0.85, 0],
  });

  // Part B: Outer Brushed Titanium Gimbal Ring
  const outerRingGeo = new THREE.TorusGeometry(1.42, 0.11, 20, 64);
  const outerRingMesh = new THREE.Mesh(outerRingGeo, brushedTiMat);
  outerRingMesh.position.set(0, PLINTH_TOP_Y + 2.15, 0);
  outerRingMesh.castShadow = true;
  tagInspectable(outerRingMesh, {
    partId: 'calib-outer-gimbal',
    title: 'Outer Titanium Gimbal Ring',
    subtitle: 'Anisotropic PBR Calibration Surface',
    materialSummary: 'Brushed Titanium · M 0.92 · R 0.18 · Aniso 0.85',
    focusPos: [4.8, 3.2, 5.2],
    focusTarget: [0, 2.4, 0],
  });

  // Part C: Inner Machined Brass Gimbal Ring
  const innerRingGeo = new THREE.TorusGeometry(1.04, 0.085, 18, 56);
  const innerRingMesh = new THREE.Mesh(innerRingGeo, warmBrassMat);
  innerRingMesh.position.set(0, PLINTH_TOP_Y + 2.15, 0);
  innerRingMesh.rotation.y = Math.PI * 0.35;
  innerRingMesh.castShadow = true;
  tagInspectable(innerRingMesh, {
    partId: 'calib-inner-gimbal',
    title: 'Inner Machined Brass Ring',
    subtitle: 'Warm Metallic Specular Reference',
    materialSummary: 'Machined Brass · M 0.94 · R 0.20',
    focusPos: [3.6, 2.8, 4.0],
    focusTarget: [0, 2.4, 0],
  });

  // Part D: Optical Crystal Octahedron Core
  const crystalGeo = new THREE.OctahedronGeometry(0.58, 1);
  const crystalMesh = new THREE.Mesh(crystalGeo, crystalCoreMat);
  crystalMesh.position.set(0, PLINTH_TOP_Y + 2.15, 0);
  crystalMesh.castShadow = true;
  tagInspectable(crystalMesh, {
    partId: 'calib-crystal-core',
    title: 'Optical Refraction Prism Core',
    subtitle: 'IOR 1.62 Transmissive Crystal Reference',
    materialSummary: 'Optical Glass · IOR 1.62 · Clearcoat 1.00',
    focusPos: [2.8, 2.7, 3.2],
    focusTarget: [0, 2.4, 0],
  });

  // Part E: Top & Bottom Axis Trunnion Pins (composite pair)
  const pinGeo = new THREE.CylinderGeometry(0.065, 0.065, 0.52, 16);
  const topPinMesh = new THREE.Mesh(pinGeo, brushedTiMat);
  topPinMesh.position.set(0, PLINTH_TOP_Y + 3.68, 0);
  const bottomPinMesh = new THREE.Mesh(pinGeo, brushedTiMat);
  bottomPinMesh.position.set(0, PLINTH_TOP_Y + 0.96, 0);

  // Part F: Emissive Calibration Halo Ring (bloom test anchor)
  const haloGeo = new THREE.TorusGeometry(0.76, 0.025, 10, 48);
  haloGeo.rotateX(Math.PI / 2);
  const haloMesh = new THREE.Mesh(haloGeo, beaconMat);
  haloMesh.position.set(0, PLINTH_TOP_Y + 2.15, 0);

  defaultArtifactRoot.add(
    stemMesh,
    outerRingMesh,
    innerRingMesh,
    crystalMesh,
    topPinMesh,
    bottomPinMesh,
    haloMesh
  );

  const registerDefaultExplodable = (
    mesh: THREE.Object3D,
    dir: [number, number, number]
  ) => {
    defaultExplodables.push({
      mesh,
      restPos: mesh.position.clone(),
      explodeDir: new THREE.Vector3(...dir),
    });
  };
  registerDefaultExplodable(stemMesh, [0, -0.1, 0]);
  registerDefaultExplodable(outerRingMesh, [-0.9, 0.65, 0.35]);
  registerDefaultExplodable(innerRingMesh, [0.85, 0.35, -0.45]);
  registerDefaultExplodable(crystalMesh, [0, 0.95, 0.55]);
  registerDefaultExplodable(topPinMesh, [0, 1.5, 0]);
  registerDefaultExplodable(bottomPinMesh, [0, 0.25, 0]);
  registerDefaultExplodable(haloMesh, [0, 0.55, 0.95]);

  defaultDisposables.push(
    brushedTiMat,
    warmBrassMat,
    matteCarbonMat,
    crystalCoreMat,
    beaconMat,
    stemGeo,
    outerRingGeo,
    innerRingGeo,
    crystalGeo,
    pinGeo,
    haloGeo
  );

  group.add(defaultArtifactRoot);

  // 3. Imported User GLB / GLTF Container & State
  const importedHost = new THREE.Group();
  importedHost.name = 'ImportedGltfHost';
  group.add(importedHost);

  const gltfLoader = new GLTFLoader();
  let importedRoot: THREE.Object3D | null = null;
  let importedExplodables: ExplodableMeshEntry[] = [];
  let mixer: THREE.AnimationMixer | null = null;
  let animationPlaying = true;
  let lastExplodeVal = 0;

  const defaultMeta: CustomModelMetadata = {
    fileName: 'Studio Calibration Gimbal (Drop .GLB / .GLTF)',
    meshCount: 7,
    triangleCount:
      countGeometryTriangles(stemGeo) +
      countGeometryTriangles(outerRingGeo) +
      countGeometryTriangles(innerRingGeo) +
      countGeometryTriangles(crystalGeo) +
      countGeometryTriangles(pinGeo) * 2 +
      countGeometryTriangles(haloGeo),
    animationCount: 1,
    isPlayingAnimation: true,
    isDefaultArtifact: true,
  };
  let currentMeta: CustomModelMetadata = { ...defaultMeta };

  const clearImportedInternal = () => {
    if (mixer) {
      mixer.stopAllAction();
      mixer = null;
    }
    if (importedRoot) {
      importedHost.remove(importedRoot);
      disposeObjectSubtree(importedRoot);
      importedRoot = null;
    }
    importedExplodables = [];
  };

  const applyExplode = (amount: number) => {
    lastExplodeVal = amount;
    if (importedRoot) {
      for (const entry of importedExplodables) {
        entry.mesh.position
          .copy(entry.restPos)
          .addScaledVector(entry.explodeDir, amount);
      }
    } else {
      for (const entry of defaultExplodables) {
        entry.mesh.position
          .copy(entry.restPos)
          .addScaledVector(entry.explodeDir, amount);
      }
    }
  };

  const loadGltfFromBuffer = (
    data: ArrayBuffer | string,
    fileName: string,
    maxAnisotropy: number
  ): Promise<CustomModelMetadata> => {
    return new Promise((resolve, reject) => {
      gltfLoader.parse(
        data,
        '',
        (gltf: GLTF) => {
          clearImportedInternal();

          const model = gltf.scene || gltf.scenes[0];
          if (!model) {
            reject(new Error('GLB/GLTF file does not contain a visible scene.'));
            return;
          }

          // Wrap inside a normalized pivot group
          const wrapper = new THREE.Group();
          wrapper.name = `Imported:${fileName}`;
          wrapper.add(model);

          // Compute bounding box and normalize scale + ground flush on plinth
          wrapper.updateMatrixWorld(true);
          const rawBox = new THREE.Box3().setFromObject(model);
          const rawSize = rawBox.getSize(new THREE.Vector3());
          const rawCenter = rawBox.getCenter(new THREE.Vector3());
          const maxDim = Math.max(rawSize.x, rawSize.y, rawSize.z, 0.001);
          const scaleFactor = TARGET_MODEL_SIZE / maxDim;

          model.scale.multiplyScalar(scaleFactor);
          model.position.set(
            -rawCenter.x * scaleFactor,
            -rawBox.min.y * scaleFactor + PLINTH_TOP_Y,
            -rawCenter.z * scaleFactor
          );
          wrapper.updateMatrixWorld(true);

          const finalBox = new THREE.Box3().setFromObject(wrapper);
          const modelCenter = finalBox.getCenter(new THREE.Vector3());

          let meshCount = 0;
          let triangleCount = 0;
          const nextExplodables: ExplodableMeshEntry[] = [];
          const partBox = new THREE.Box3();
          const partCenter = new THREE.Vector3();
          const partSize = new THREE.Vector3();

          model.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              meshCount++;
              child.castShadow = !isSoftwareGl;
              child.receiveShadow = true;
              triangleCount += countGeometryTriangles(child.geometry);

              // Enhance textures & envMap intensity on imported PBR materials
              const mats = Array.isArray(child.material)
                ? child.material
                : [child.material];
              for (const m of mats) {
                if (m instanceof THREE.MeshStandardMaterial) {
                  m.envMapIntensity = Math.max(m.envMapIntensity ?? 1, 0.85);
                  if (m.map) {
                    m.map.anisotropy = maxAnisotropy;
                    m.map.needsUpdate = true;
                  }
                }
              }

              // Compute mesh bounds for raycast inspection & focus camera
              partBox.setFromObject(child);
              partBox.getCenter(partCenter);
              partBox.getSize(partSize);
              const focusDist = Math.max(
                2.4,
                Math.max(partSize.x, partSize.y, partSize.z) * 2.2
              );

              const partName =
                child.name && child.name.trim().length > 0
                  ? child.name.replace(/[_-]+/g, ' ')
                  : `Mesh Part ${meshCount}`;

              tagInspectable(child, {
                partId: `glb-mesh-${meshCount}`,
                title: partName,
                subtitle: `${fileName} · ${countGeometryTriangles(child.geometry).toLocaleString()} tris`,
                materialSummary: summarizeMaterial(child.material),
                focusPos: [
                  partCenter.x + focusDist * 0.72,
                  Math.max(0.8, partCenter.y + focusDist * 0.42),
                  partCenter.z + focusDist * 0.85,
                ],
                focusTarget: [partCenter.x, partCenter.y, partCenter.z],
              });

              // Compute radial explode direction in local parent space
              const dirWorld = partCenter.clone().sub(modelCenter);
              if (dirWorld.lengthSq() < 0.0004) {
                dirWorld.set(
                  Math.cos(meshCount * 1.7),
                  0.65,
                  Math.sin(meshCount * 1.7)
                );
              }
              dirWorld.normalize().multiplyScalar(1.35 / Math.max(scaleFactor, 0.001));
              nextExplodables.push({
                mesh: child,
                restPos: child.position.clone(),
                explodeDir: dirWorld,
              });
            }
          });

          importedRoot = wrapper;
          importedExplodables = nextExplodables;
          importedHost.add(wrapper);
          defaultArtifactRoot.visible = false;

          // Wire AnimationMixer if the GLB contains animations
          const animCount = gltf.animations?.length ?? 0;
          if (animCount > 0) {
            mixer = new THREE.AnimationMixer(model);
            gltf.animations.forEach((clip) => {
              mixer?.clipAction(clip).play();
            });
            animationPlaying = true;
          } else {
            animationPlaying = false;
          }

          if (lastExplodeVal > 0.001) {
            applyExplode(lastExplodeVal);
          }

          currentMeta = {
            fileName,
            meshCount,
            triangleCount,
            animationCount: animCount,
            isPlayingAnimation: animCount > 0,
            isDefaultArtifact: false,
          };

          resolve({ ...currentMeta });
        },
        (err) => {
          reject(
            err instanceof Error
              ? err
              : new Error('Unable to parse .glb / .gltf model.')
          );
        }
      );
    });
  };

  const clearCustomModel = (): CustomModelMetadata => {
    clearImportedInternal();
    defaultArtifactRoot.visible = true;
    animationPlaying = true;
    applyExplode(lastExplodeVal);
    currentMeta = { ...defaultMeta };
    return { ...currentMeta };
  };

  return {
    group,
    slotMaterials: [slot0Mat, slot1Mat, slot2Mat],
    loadGltfFromBuffer,
    clearCustomModel,
    setAnimationPlaying: (playing: boolean) => {
      animationPlaying = playing;
      currentMeta = { ...currentMeta, isPlayingAnimation: playing };
    },
    applyExplode,
    applyFinish: (colorHex, metalness, roughness) => {
      plinthMat.color.setHex(colorHex).multiplyScalar(0.68);
      plinthMat.metalness = Math.min(0.9, metalness + 0.25);
      plinthMat.roughness = Math.max(0.18, roughness * 0.72);
      brushedTiMat.color.setHex(colorHex).lerp(new THREE.Color(0xc8d2e0), 0.55);
    },
    updateFrame: (dt: number, elapsedSec: number): boolean => {
      if (importedRoot) {
        if (mixer && animationPlaying) {
          mixer.update(dt);
          return true;
        }
        return false;
      }
      if (!animationPlaying || isSoftwareGl) return false;
      // Gentle studio calibration gyroscope motion
      outerRingMesh.rotation.y = elapsedSec * 0.42;
      outerRingMesh.rotation.x = Math.sin(elapsedSec * 0.65) * 0.28;
      innerRingMesh.rotation.x = elapsedSec * 0.68;
      innerRingMesh.rotation.z = Math.cos(elapsedSec * 0.5) * 0.35;
      crystalMesh.rotation.y = -elapsedSec * 0.55;
      crystalMesh.rotation.x = Math.sin(elapsedSec * 0.45) * 0.25;
      haloMesh.rotation.z = Math.sin(elapsedSec * 0.7) * 0.22;
      return true;
    },
    getMetadata: () => ({ ...currentMeta }),
    dispose: () => {
      clearImportedInternal();
      for (const d of defaultDisposables) d.dispose();
      for (const d of plinthDisposables) d.dispose();
    },
  };
}
