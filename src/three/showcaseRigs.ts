import * as THREE from 'three';
import {
  createAnodizedChassisMaterial,
  createHolographicFoilMaterial,
  type HolographicFoilMaterialHandle,
} from './materials';
import type { InspectedPartInfo, StageSlotIndex } from './types';

export interface ShowcaseRigHandle {
  group: THREE.Group;
  slotMaterials: [
    THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial,
    THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial,
    THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial,
  ];
  applyFinish: (roofHex: number, metalness: number, roughness: number) => void;
  applyExplode: (amount: number) => void;
  updateFrame?: (elapsedSec: number) => void;
  dispose: () => void;
}

function tagInspectable(mesh: THREE.Object3D, info: InspectedPartInfo): void {
  mesh.layers.enable(1);
  mesh.userData.inspectInfo = info;
}

/**
 * Composite 10-part Grounded Laptop + Smartphone Client Showcase Rig (`devices`):
 * - Grounded tiered studio turntable plinth (Y=0 bottom pivot)
 * - CNC machined unibody laptop base + recessed dark keyboard deck + glass trackpad
 * - Hinged angled display lid + 16:10 Slot [0] screen plane + camera bezel
 * - Weighted companion smartphone stand + handset chassis + 9:19.5 Slot [1] mobile screen
 * - Front chamfered brand plaque (Slot [2], 4:1)
 */
export function buildDevicesShowcaseRig(
  isSoftwareGl: boolean
): ShowcaseRigHandle {
  const group = new THREE.Group();
  const disposables: Array<{ dispose: () => void }> = [];

  const plinthMat = new THREE.MeshStandardMaterial({
    color: 0x1e2430,
    roughness: 0.82,
    metalness: 0.14,
  });
  const chassisMat = createAnodizedChassisMaterial({
    color: 0x6e7b8f,
    metalness: 0.86,
    roughness: 0.24,
  });
  const darkDeckMat = new THREE.MeshStandardMaterial({
    color: 0x11151d,
    roughness: 0.64,
    metalness: 0.28,
  });
  const glassTrimMat = new THREE.MeshPhysicalMaterial({
    color: 0x0b121c,
    roughness: 0.1,
    metalness: 0.1,
    clearcoat: 1.0,
  });
  const cyanAccentMat = new THREE.MeshStandardMaterial({
    color: 0x22d3ee,
    emissive: 0x22d3ee,
    emissiveIntensity: 1.7,
    roughness: 0.2,
  });

  const slot0LaptopScreenMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 0.36,
    roughness: 0.18,
    metalness: 0.04,
  });
  const slot1PhoneScreenMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 0.38,
    roughness: 0.16,
    metalness: 0.04,
  });
  const slot2PlaqueMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 0.32,
    roughness: 0.26,
    metalness: 0.08,
  });

  disposables.push(
    plinthMat,
    chassisMat,
    darkDeckMat,
    glassTrimMat,
    cyanAccentMat,
    slot0LaptopScreenMat,
    slot1PhoneScreenMat,
    slot2PlaqueMat
  );

  // 1. Grounded Studio Turntable Plinth (Y=0 bottom)
  const baseDiscGeo = new THREE.CylinderGeometry(5.6, 5.95, 0.36, 48);
  baseDiscGeo.translate(0, 0.18, 0);
  const baseDisc = new THREE.Mesh(baseDiscGeo, plinthMat);
  baseDisc.castShadow = true;
  baseDisc.receiveShadow = true;
  tagInspectable(baseDisc, {
    partId: 'devices-plinth',
    title: 'Turntable Presentation Plinth',
    subtitle: 'Grounded Architectural Pedestal',
    materialSummary: 'Matte Slate Composite · Roughness 0.82',
    focusPos: [9.5, 5.4, 10.5],
    focusTarget: [0, 1.4, 0],
  });

  const haloRingGeo = new THREE.TorusGeometry(5.68, 0.035, 10, 64);
  haloRingGeo.rotateX(Math.PI / 2);
  const haloRing = new THREE.Mesh(haloRingGeo, cyanAccentMat);
  haloRing.position.set(0, 0.36, 0);
  group.add(baseDisc, haloRing);
  disposables.push(baseDiscGeo, haloRingGeo);

  // 2. Laptop Assembly (Left-Center)
  const laptopRoot = new THREE.Group();
  laptopRoot.position.set(-1.15, 0.36, 0.15);
  group.add(laptopRoot);

  const laptopBaseGroup = new THREE.Group();
  const baseShape = new THREE.Shape();
  const bw = 4.9;
  const bd = 3.35;
  baseShape.moveTo(-bw / 2, -bd / 2);
  baseShape.lineTo(bw / 2, -bd / 2);
  baseShape.lineTo(bw / 2, bd / 2);
  baseShape.lineTo(-bw / 2, bd / 2);
  baseShape.closePath();
  const laptopBaseGeo = new THREE.ExtrudeGeometry(baseShape, {
    depth: 0.16,
    bevelEnabled: true,
    bevelThickness: 0.03,
    bevelSize: 0.05,
    bevelSegments: 2,
  });
  laptopBaseGeo.rotateX(Math.PI / 2);
  laptopBaseGeo.translate(0, 0.19, 0);
  if (!isSoftwareGl) laptopBaseGeo.computeTangents();
  const laptopBaseMesh = new THREE.Mesh(laptopBaseGeo, chassisMat);
  laptopBaseMesh.castShadow = true;
  laptopBaseMesh.receiveShadow = true;
  tagInspectable(laptopBaseMesh, {
    partId: 'laptop-unibody',
    title: 'CNC Unibody Laptop Deck',
    subtitle: 'Machined Workstation Chassis',
    materialSummary: 'Anodized Aluminum · Anisotropy 0.72 · Roughness 0.24',
    focusPos: [-1.15, 3.2, 6.2],
    focusTarget: [-1.15, 1.3, 0.2],
  });

  const keyboardWellGeo = new THREE.BoxGeometry(4.25, 0.03, 1.65);
  const keyboardWell = new THREE.Mesh(keyboardWellGeo, darkDeckMat);
  keyboardWell.position.set(0, 0.21, -0.36);

  const trackpadGeo = new THREE.BoxGeometry(1.45, 0.025, 0.92);
  const trackpad = new THREE.Mesh(trackpadGeo, glassTrimMat);
  trackpad.position.set(0, 0.21, 1.02);

  laptopBaseGroup.add(laptopBaseMesh, keyboardWell, trackpad);
  laptopRoot.add(laptopBaseGroup);
  disposables.push(laptopBaseGeo, keyboardWellGeo, trackpadGeo);

  // Hinged Laptop Lid + Slot [0] Screen (16:10 -> 4.64 x 2.9)
  const laptopLidGroup = new THREE.Group();
  laptopLidGroup.position.set(0, 0.22, -1.58);
  laptopLidGroup.rotation.x = -0.22; // Slight ergonomic studio tilt back
  laptopRoot.add(laptopLidGroup);

  const lidShellGeo = new THREE.BoxGeometry(4.92, 3.16, 0.1);
  lidShellGeo.translate(0, 1.58, -0.05);
  const lidShell = new THREE.Mesh(lidShellGeo, chassisMat);
  lidShell.castShadow = true;
  lidShell.receiveShadow = true;

  const lidGlassBezelGeo = new THREE.BoxGeometry(4.8, 3.04, 0.02);
  lidGlassBezelGeo.translate(0, 1.58, 0.01);
  const lidGlassBezel = new THREE.Mesh(lidGlassBezelGeo, glassTrimMat);

  const laptopScreenGeo = new THREE.PlaneGeometry(4.56, 2.85);
  laptopScreenGeo.translate(0, 1.58, 0.026);
  const laptopScreen = new THREE.Mesh(laptopScreenGeo, slot0LaptopScreenMat);
  tagInspectable(laptopScreen, {
    partId: 'laptop-display-slot-0',
    title: 'Desktop Viewport Display (Slot 1)',
    subtitle: '16:10 Calibrated Client Site Canvas',
    materialSummary: 'Self-Illuminated sRGB Display · Slot 1 Active Surface',
    slotIndex: 0 as StageSlotIndex,
    focusPos: [-1.15, 2.35, 5.4],
    focusTarget: [-1.15, 1.85, -1.2],
  });

  laptopLidGroup.add(lidShell, lidGlassBezel, laptopScreen);
  disposables.push(lidShellGeo, lidGlassBezelGeo, laptopScreenGeo);

  // 3. Companion Smartphone Stand & Handset (Right-Front, Slot [1] 9:19.5)
  const phoneRoot = new THREE.Group();
  phoneRoot.position.set(2.95, 0.36, 0.85);
  phoneRoot.rotation.y = -0.34;
  group.add(phoneRoot);

  const standFootGeo = new THREE.CylinderGeometry(0.72, 0.86, 0.14, 28);
  standFootGeo.translate(0, 0.07, 0);
  const standFoot = new THREE.Mesh(standFootGeo, chassisMat);
  standFoot.castShadow = true;

  const standPillarGeo = new THREE.CylinderGeometry(0.11, 0.14, 1.35, 16);
  standPillarGeo.rotateX(0.2);
  standPillarGeo.translate(0, 0.72, -0.14);
  const standPillar = new THREE.Mesh(standPillarGeo, chassisMat);
  standPillar.castShadow = true;
  phoneRoot.add(standFoot, standPillar);
  disposables.push(standFootGeo, standPillarGeo);

  const phoneBodyGroup = new THREE.Group();
  phoneBodyGroup.position.set(0, 1.48, 0.06);
  phoneBodyGroup.rotation.x = -0.22;
  phoneRoot.add(phoneBodyGroup);

  const phoneChassisGeo = new THREE.BoxGeometry(1.26, 2.62, 0.11);
  const phoneChassis = new THREE.Mesh(phoneChassisGeo, chassisMat);
  phoneChassis.castShadow = true;

  const phoneBezelGeo = new THREE.BoxGeometry(1.2, 2.54, 0.02);
  phoneBezelGeo.translate(0, 0, 0.058);
  const phoneBezel = new THREE.Mesh(phoneBezelGeo, glassTrimMat);

  const phoneScreenGeo = new THREE.PlaneGeometry(1.12, 2.42);
  phoneScreenGeo.translate(0, 0, 0.072);
  const phoneScreen = new THREE.Mesh(phoneScreenGeo, slot1PhoneScreenMat);
  tagInspectable(phoneScreen, {
    partId: 'phone-display-slot-1',
    title: 'Mobile Companion Display (Slot 2)',
    subtitle: '9:19.5 Responsive Handset Viewport',
    materialSummary: 'OLED High-Contrast Surface · Slot 2 Active Surface',
    slotIndex: 1 as StageSlotIndex,
    focusPos: [3.2, 2.2, 4.8],
    focusTarget: [2.85, 1.8, 0.85],
  });

  phoneBodyGroup.add(phoneChassis, phoneBezel, phoneScreen);
  disposables.push(phoneChassisGeo, phoneBezelGeo, phoneScreenGeo);

  // 4. Front Chamfered Brand Plaque (Slot [2], 4:1)
  const plaqueGroup = new THREE.Group();
  plaqueGroup.position.set(0, 0.36, 3.85);
  plaqueGroup.rotation.x = -0.45;
  group.add(plaqueGroup);

  const plaqueBackingGeo = new THREE.BoxGeometry(3.4, 0.9, 0.1);
  plaqueBackingGeo.translate(0, 0.45, 0);
  const plaqueBacking = new THREE.Mesh(plaqueBackingGeo, darkDeckMat);
  plaqueBacking.castShadow = true;

  const plaqueFaceGeo = new THREE.PlaneGeometry(3.24, 0.81);
  plaqueFaceGeo.translate(0, 0.45, 0.056);
  const plaqueFace = new THREE.Mesh(plaqueFaceGeo, slot2PlaqueMat);
  tagInspectable(plaqueFace, {
    partId: 'devices-plaque-slot-2',
    title: 'Client Brand Spec Plaque (Slot 3)',
    subtitle: '4:1 Palette & Service Area Strip',
    materialSummary: 'Satin Acrylic Marquee · Slot 3 Active Surface',
    slotIndex: 2 as StageSlotIndex,
    focusPos: [0, 1.85, 6.9],
    focusTarget: [0, 0.72, 3.85],
  });

  plaqueGroup.add(plaqueBacking, plaqueFace);
  disposables.push(plaqueBackingGeo, plaqueFaceGeo);

  return {
    group,
    slotMaterials: [slot0LaptopScreenMat, slot1PhoneScreenMat, slot2PlaqueMat],
    applyFinish: (roofHex, metalness, roughness) => {
      chassisMat.color.setHex(roofHex);
      chassisMat.metalness = Math.max(0.35, metalness);
      chassisMat.roughness = Math.min(0.55, roughness);
    },
    applyExplode: (amount) => {
      laptopLidGroup.position.y = 0.22 + amount * 1.15;
      laptopLidGroup.position.z = -1.58 - amount * 0.65;
      phoneBodyGroup.position.y = 1.48 + amount * 0.95;
      phoneBodyGroup.position.x = amount * 0.65;
      plaqueGroup.position.z = 3.85 + amount * 0.95;
    },
    dispose: () => {
      for (const d of disposables) d.dispose();
    },
  };
}

/**
 * Composite 9-Part Holographic Editorial & Briefing Collector Slab (`foilCard`):
 * - Grounded obsidian cradle pedestal + glowing cyan magnetic levitation ring (Y=0)
 * - Outer CNC titanium protector frame (ExtrudeGeometry with bevel)
 * - Inner dark carbon core + Holographic Iridescent Front Face (Slot [0], 3:4)
 * - Rear Provenance & Citation Spec Face (Slot [1], 3:4)
 * - Protective museum crystal acrylic case (explodes forward cleanly)
 * - Base Edition Plaque (Slot [2], 4:1)
 */
export function buildFoilCardShowcaseRig(
  isSoftwareGl: boolean
): ShowcaseRigHandle {
  const group = new THREE.Group();
  const disposables: Array<{ dispose: () => void }> = [];

  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x161b24,
    roughness: 0.78,
    metalness: 0.2,
  });
  const frameMat = createAnodizedChassisMaterial({
    color: 0x7a889b,
    metalness: 0.88,
    roughness: 0.2,
  });
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0x0d121b,
    roughness: 0.55,
    metalness: 0.35,
  });
  const cyanGlowMat = new THREE.MeshStandardMaterial({
    color: 0x22d3ee,
    emissive: 0x22d3ee,
    emissiveIntensity: 1.9,
    roughness: 0.18,
  });
  const protectiveGlassMat = new THREE.MeshPhysicalMaterial({
    color: 0xdff8ff,
    roughness: 0.06,
    metalness: 0.02,
    transmission: isSoftwareGl ? 0 : 0.74,
    transparent: true,
    opacity: isSoftwareGl ? 0.24 : 0.42,
    thickness: 0.22,
    clearcoat: 1.0,
    depthWrite: false,
  });

  const foilFrontHandle: HolographicFoilMaterialHandle =
    createHolographicFoilMaterial(isSoftwareGl);
  const slot1BackMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    emissive: 0x0b1520,
    emissiveIntensity: 0.28,
    roughness: 0.22,
    metalness: 0.18,
    clearcoat: 0.85,
  });
  const slot2PlaqueMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 0.3,
    roughness: 0.26,
    metalness: 0.08,
  });

  disposables.push(
    baseMat,
    frameMat,
    coreMat,
    cyanGlowMat,
    protectiveGlassMat,
    foilFrontHandle.material,
    slot1BackMat,
    slot2PlaqueMat
  );

  // 1. Grounded Obsidian Cradle Base (Y=0 bottom)
  const pedestalGeo = new THREE.CylinderGeometry(3.4, 3.85, 0.44, 40);
  pedestalGeo.translate(0, 0.22, 0);
  const pedestal = new THREE.Mesh(pedestalGeo, baseMat);
  pedestal.castShadow = true;
  pedestal.receiveShadow = true;
  tagInspectable(pedestal, {
    partId: 'foil-pedestal',
    title: 'Magnetic Collector Cradle',
    subtitle: 'Weighted Obsidian Base',
    materialSummary: 'Satin Basalt Composite · Roughness 0.78',
    focusPos: [6.4, 3.8, 7.6],
    focusTarget: [0, 2.4, 0],
  });

  const magRingGeo = new THREE.TorusGeometry(2.15, 0.045, 12, 48);
  magRingGeo.rotateX(Math.PI / 2);
  const magRing = new THREE.Mesh(magRingGeo, cyanGlowMat);
  magRing.position.set(0, 0.45, 0);
  group.add(pedestal, magRing);
  disposables.push(pedestalGeo, magRingGeo);

  // 2. Floating / Mounted Collector Slab Assembly
  const slabAssembly = new THREE.Group();
  slabAssembly.position.set(0, 2.95, 0);
  group.add(slabAssembly);

  // Outer beveled titanium frame (windowed border)
  const outerShape = new THREE.Shape();
  const fw = 3.56;
  const fh = 4.68;
  outerShape.moveTo(-fw / 2, -fh / 2);
  outerShape.lineTo(fw / 2, -fh / 2);
  outerShape.lineTo(fw / 2, fh / 2);
  outerShape.lineTo(-fw / 2, fh / 2);
  outerShape.closePath();

  const innerHole = new THREE.Path();
  const iw = 3.16;
  const ih = 4.22;
  innerHole.moveTo(-iw / 2, -ih / 2);
  innerHole.lineTo(iw / 2, -ih / 2);
  innerHole.lineTo(iw / 2, ih / 2);
  innerHole.lineTo(-iw / 2, ih / 2);
  innerHole.closePath();
  outerShape.holes.push(innerHole);

  const frameGeo = new THREE.ExtrudeGeometry(outerShape, {
    depth: 0.18,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.04,
    bevelSegments: 2,
  });
  frameGeo.translate(0, 0, -0.09);
  if (!isSoftwareGl) frameGeo.computeTangents();
  const frameMesh = new THREE.Mesh(frameGeo, frameMat);
  frameMesh.castShadow = true;
  frameMesh.receiveShadow = true;
  tagInspectable(frameMesh, {
    partId: 'foil-titanium-frame',
    title: 'Precision Graded Slab Frame',
    subtitle: 'Beveled Anodized Perimeter Chassis',
    materialSummary: 'Brushed Titanium · Anisotropy 0.72 · Roughness 0.20',
    focusPos: [2.8, 3.4, 5.8],
    focusTarget: [0, 2.95, 0],
  });
  slabAssembly.add(frameMesh);
  disposables.push(frameGeo);

  // Inner Core + Front Holographic Foil Face (Slot [0], 3:4 -> 3.18 x 4.24)
  const coreGroup = new THREE.Group();
  const coreGeo = new THREE.BoxGeometry(3.2, 4.26, 0.08);
  const coreMesh = new THREE.Mesh(coreGeo, coreMat);
  coreMesh.castShadow = true;

  const frontFoilGeo = new THREE.PlaneGeometry(3.15, 4.2);
  frontFoilGeo.translate(0, 0, 0.046);
  const frontFoilMesh = new THREE.Mesh(frontFoilGeo, foilFrontHandle.material);
  tagInspectable(frontFoilMesh, {
    partId: 'foil-front-slot-0',
    title: 'Holographic Editorial Foil Face (Slot 1)',
    subtitle: 'Iridescent Prismatic Collector Print',
    materialSummary: 'Iridescence IOR 1.38 · Clearcoat 1.0 · Slot 1 Active Surface',
    slotIndex: 0 as StageSlotIndex,
    focusPos: [0, 2.95, 5.8],
    focusTarget: [0, 2.95, 0],
  });

  const rearSpecGeo = new THREE.PlaneGeometry(3.15, 4.2);
  rearSpecGeo.rotateY(Math.PI);
  rearSpecGeo.translate(0, 0, -0.046);
  const rearSpecMesh = new THREE.Mesh(rearSpecGeo, slot1BackMat);
  tagInspectable(rearSpecMesh, {
    partId: 'foil-rear-slot-1',
    title: 'Rear Citation & Provenance Plate (Slot 2)',
    subtitle: 'Reverse Edition Index & Metadata',
    materialSummary: 'Lacquered Spec Sheet · Clearcoat 0.85 · Slot 2 Active Surface',
    slotIndex: 1 as StageSlotIndex,
    focusPos: [0, 2.95, -5.8],
    focusTarget: [0, 2.95, 0],
  });

  coreGroup.add(coreMesh, frontFoilMesh, rearSpecMesh);
  slabAssembly.add(coreGroup);
  disposables.push(coreGeo, frontFoilGeo, rearSpecGeo);

  // Protective Front Crystal Acrylic Shield
  const frontCaseGroup = new THREE.Group();
  const frontCaseGeo = new THREE.BoxGeometry(3.52, 4.64, 0.05);
  frontCaseGeo.translate(0, 0, 0.14);
  const frontCaseMesh = new THREE.Mesh(frontCaseGeo, protectiveGlassMat);
  frontCaseMesh.renderOrder = 3;
  frontCaseGroup.add(frontCaseMesh);
  slabAssembly.add(frontCaseGroup);
  disposables.push(frontCaseGeo);

  // Base Edition Plaque (Slot [2], 4:1)
  const plaqueGroup = new THREE.Group();
  plaqueGroup.position.set(0, 0.44, 2.45);
  plaqueGroup.rotation.x = -0.42;
  group.add(plaqueGroup);

  const plaqueBackGeo = new THREE.BoxGeometry(3.0, 0.78, 0.09);
  plaqueBackGeo.translate(0, 0.39, 0);
  const plaqueBack = new THREE.Mesh(plaqueBackGeo, coreMat);
  plaqueBack.castShadow = true;

  const plaqueFaceGeo = new THREE.PlaneGeometry(2.88, 0.72);
  plaqueFaceGeo.translate(0, 0.39, 0.05);
  const plaqueFace = new THREE.Mesh(plaqueFaceGeo, slot2PlaqueMat);
  tagInspectable(plaqueFace, {
    partId: 'foil-plaque-slot-2',
    title: 'Edition Masthead Plaque (Slot 3)',
    subtitle: '4:1 Title & Cast Strip',
    materialSummary: 'Satin Edition Plaque · Slot 3 Active Surface',
    slotIndex: 2 as StageSlotIndex,
    focusPos: [0, 1.5, 5.2],
    focusTarget: [0, 0.7, 2.45],
  });
  plaqueGroup.add(plaqueBack, plaqueFace);
  disposables.push(plaqueBackGeo, plaqueFaceGeo);

  return {
    group,
    slotMaterials: [foilFrontHandle.material, slot1BackMat, slot2PlaqueMat],
    applyFinish: (roofHex, metalness, roughness) => {
      frameMat.color.setHex(roofHex);
      frameMat.metalness = Math.max(0.4, metalness);
      frameMat.roughness = Math.min(0.5, roughness);
    },
    applyExplode: (amount) => {
      frontCaseGroup.position.z = amount * 1.25;
      frameMesh.position.y = amount * 0.65;
      rearSpecMesh.position.z = -amount * 0.85;
      plaqueGroup.position.z = 2.45 + amount * 0.75;
    },
    updateFrame: (elapsedSec) => {
      foilFrontHandle.setTime(elapsedSec);
      slabAssembly.position.y = 2.95 + Math.sin(elapsedSec * 1.8) * 0.05;
    },
    dispose: () => {
      for (const d of disposables) d.dispose();
    },
  };
}
