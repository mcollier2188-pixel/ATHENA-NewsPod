import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  AlertTriangle,
  Box,
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  Cpu,
  Crosshair,
  Cuboid,
  FileCheck2,
  Film,
  Gamepad2,
  Gauge,
  ImagePlus,
  Laptop,
  Layers,
  Maximize2,
  MonitorUp,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Sparkles,
  SunMedium,
  Upload,
  Video,
  X,
} from 'lucide-react';
import {
  createCachedCedarTexture,
  createCachedConcreteTexture,
  createCachedContactShadowTexture,
  createCachedDefaultScreenTexture,
  decodeStageScreenTexture,
  scheduleIdleStageTask,
} from '../utils/stageAssetCache';
import {
  AdaptiveFrameGovernor,
  QUALITY_TIER_SPECS,
  applyThreeSceneQuality,
  computeTierPixelRatio,
  type QualityTier,
} from '../utils/adaptiveQuality';
import { MAX_ROUTE_WAYPOINTS, type RouteWaypoint } from '../services/routingService';
import {
  STAGE_RIG_META,
  type CustomModelMetadata,
  type InspectedPartInfo,
  type PostProcessingConfig,
  type Runtime3DCapabilities,
  type StageRendererBackend,
  type StageRigMode,
  type StageSlotIndex,
  type StageSlotMedia,
  type Staged3DPayload,
} from '../three/types';
import {
  detectWebGLHardwareProfile,
  probeRuntime3DCapabilities,
  scheduleSoftwareGlAfterDraw,
} from '../three/capabilities';
import { createStudioSoftboxPair } from '../three/materials';
import {
  applyAspectPreservingUV,
  createLiveVideoTexture,
  type LiveVideoTextureHandle,
} from '../three/texturesAndCards';
import {
  buildDevicesShowcaseRig,
  buildFoilCardShowcaseRig,
  type ShowcaseRigHandle,
} from '../three/showcaseRigs';
import {
  buildCustomModelShowcaseRig,
  type CustomModelRigHandle,
} from '../three/gltfStageLoader';
import {
  createStudioPostPipeline,
  type StudioPostPipelineHandle,
} from '../three/postProcessing';
import {
  createStageRenderer,
  type StageRendererHandle,
} from '../three/rendererFactory';
import { recordCanvasTurntableWebM } from '../three/turntableRecorder';
import { GamepadPoller } from '../three/gamepadRouter';
import {
  SpatialBroadcastBus,
  buildSpatialDisplayUrl,
  isSpatialDisplayUrl,
} from '../three/spatialBroadcastBus';

export interface StagedStageImage {
  dataUrl: string;
  label: string;
}

export interface ThreeStageStudioProps {
  stagedImage?: StagedStageImage | null;
  onUploadStagedImage?: (img: StagedStageImage) => void;
  onClearStagedImage?: () => void;
  stagedPayload?: Staged3DPayload | null;
  onUpdateStagedPayload?: (payload: Staged3DPayload | null) => void;
  onSaveSnapshotToPitch?: (dataUrl: string, label: string) => void;
  isImmersiveMode?: boolean;
  onToggleImmersiveMode?: () => void;
  /** Optional route waypoints projected onto single-draw-call instanced 3D perimeter beacons. */
  waypoints?: RouteWaypoint[];
  /** Automatically adjust Three.js pixel ratio & shadow detail based on live frame rate. */
  adaptiveQuality?: boolean;
  onToggleAdaptiveQuality?: () => void;
  manualQualityTier?: QualityTier;
  onActiveQualityTierChange?: (tier: QualityTier) => void;
}

type CameraPresetId = 'orbit' | 'hero' | 'screen' | 'aerial' | 'crane';
type LightingMoodId = 'dusk' | 'daylight' | 'night';
type FinishId = 'slate' | 'cedar' | 'titanium';

const RIG_CAMERA_PRESETS: Record<
  StageRigMode,
  Record<
    CameraPresetId,
    { label: string; pos: [number, number, number]; target: [number, number, number] }
  >
> = {
  pavilion: {
    orbit: { label: 'Studio 3/4', pos: [14.5, 8.2, 15.5], target: [0, 2.2, 0] },
    hero: { label: 'Hero Front', pos: [0.6, 3.6, 17.5], target: [0, 2.4, 0] },
    screen: { label: 'Main Wall', pos: [-1.3, 2.45, 7.6], target: [-1.3, 2.32, 1.38] },
    aerial: { label: 'Aerial Plan', pos: [9, 20, 11], target: [0, 0.5, 0] },
    crane: { label: 'Crane & Side', pos: [10.8, 3.8, 8.4], target: [4.2, 2.3, 1.8] },
  },
  devices: {
    orbit: { label: 'Studio 3/4', pos: [7.6, 4.5, 9.2], target: [0.3, 1.65, 0.4] },
    hero: { label: 'Front Suite', pos: [0.2, 2.6, 9.6], target: [0.3, 1.6, 0.3] },
    screen: { label: 'Laptop Display', pos: [-1.15, 2.35, 5.2], target: [-1.15, 1.85, -1.2] },
    aerial: { label: 'Top Desk', pos: [0.4, 11.2, 4.5], target: [0.2, 0.8, 0.4] },
    crane: { label: 'Mobile Handset', pos: [3.2, 2.2, 4.7], target: [2.85, 1.8, 0.85] },
  },
  foilCard: {
    orbit: { label: 'Collector 3/4', pos: [5.4, 3.8, 7.4], target: [0, 2.65, 0] },
    hero: { label: 'Front Foil', pos: [0, 2.95, 6.4], target: [0, 2.95, 0] },
    screen: { label: 'Macro Print', pos: [0, 3.1, 4.6], target: [0, 3.0, 0] },
    aerial: { label: 'Cradle Top', pos: [3.2, 8.8, 5.6], target: [0, 1.8, 0] },
    crane: { label: 'Rear Citation', pos: [0.4, 2.95, -6.4], target: [0, 2.95, 0] },
  },
  customModel: {
    orbit: { label: 'Studio 3/4', pos: [6.2, 4.1, 7.6], target: [0, 2.0, 0] },
    hero: { label: 'Hero Front', pos: [0, 2.6, 8.2], target: [0, 2.0, 0] },
    screen: { label: 'Macro Detail', pos: [0.8, 2.7, 4.6], target: [0, 2.1, 0] },
    aerial: { label: 'Top Plinth', pos: [2.8, 9.6, 4.8], target: [0, 0.8, 0] },
    crane: { label: 'Low Dramatic', pos: [-5.8, 1.9, 5.8], target: [0, 2.1, 0] },
  },
};

const LIGHTING_MOODS: Record<
  LightingMoodId,
  {
    label: string;
    sky: number;
    fogDensity: number;
    keyColor: number;
    keyIntensity: number;
    keyPos: [number, number, number];
    hemiSky: number;
    hemiGround: number;
    hemiIntensity: number;
    beaconIntensity: number;
    softboxScale: number;
  }
> = {
  dusk: {
    label: 'Dusk Studio',
    sky: 0x0e141f,
    fogDensity: 0.015,
    keyColor: 0xffd2a6,
    keyIntensity: 2.3,
    keyPos: [15, 16, 11],
    hemiSky: 0x6ea8df,
    hemiGround: 0x1a1e28,
    hemiIntensity: 0.72,
    beaconIntensity: 1.8,
    softboxScale: 1.0,
  },
  daylight: {
    label: 'Daylight Site',
    sky: 0x1c2c3d,
    fogDensity: 0.011,
    keyColor: 0xfff5e4,
    keyIntensity: 2.8,
    keyPos: [18, 22, 14],
    hemiSky: 0x9ec5e8,
    hemiGround: 0x2a313b,
    hemiIntensity: 0.95,
    beaconIntensity: 0.7,
    softboxScale: 1.25,
  },
  night: {
    label: 'Night Broadcast',
    sky: 0x070a10,
    fogDensity: 0.02,
    keyColor: 0x9bd6ff,
    keyIntensity: 1.55,
    keyPos: [-12, 14, 10],
    hemiSky: 0x2d4e78,
    hemiGround: 0x0b0e15,
    hemiIntensity: 0.45,
    beaconIntensity: 2.8,
    softboxScale: 0.85,
  },
};

const FINISH_PALETTES: Record<
  FinishId,
  {
    label: string;
    hex: string;
    roof: number;
    core: number;
    metalness: number;
    roughness: number;
  }
> = {
  slate: {
    label: 'Charcoal Slate',
    hex: '#2C3442',
    roof: 0x2c3442,
    core: 0x8d5b3c,
    metalness: 0.25,
    roughness: 0.58,
  },
  cedar: {
    label: 'Warm Cedar',
    hex: '#9A633E',
    roof: 0x7e4f31,
    core: 0xc28a5a,
    metalness: 0.1,
    roughness: 0.68,
  },
  titanium: {
    label: 'Brushed Titanium',
    hex: '#7A889B',
    roof: 0x6c7a8d,
    core: 0x3b4859,
    metalness: 0.78,
    roughness: 0.26,
  },
};

// Module-scope reusable math helpers (zero per-frame GC allocations)
const _dummyObj = new THREE.Object3D();
const _tmpColor = new THREE.Color();
const _originColor = new THREE.Color(0x34d399);
const _destColor = new THREE.Color(0x22d3ee);
const _stopColor = new THREE.Color(0x67e8f9);
const _viaColor = new THREE.Color(0x38bdf8);
const _spherical = new THREE.Spherical();
const _camOffset = new THREE.Vector3();
const _ndcPointer = new THREE.Vector2();

function mergeStaticParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const normalized: THREE.BufferGeometry[] = [];
  for (const raw of parts) {
    const g = raw.index ? raw.toNonIndexed() : raw.clone();
    for (const key of Object.keys(g.attributes)) {
      if (key !== 'position' && key !== 'normal' && key !== 'uv') {
        g.deleteAttribute(key);
      }
    }
    if (!g.attributes.uv) {
      const count = g.attributes.position.count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    normalized.push(g);
    raw.dispose();
  }

  const merged = mergeGeometries(normalized, false);
  for (const n of normalized) {
    n.dispose();
  }
  const result = merged ?? new THREE.BoxGeometry(0.01, 0.01, 0.01);
  result.computeBoundingSphere();
  return result;
}

export function ThreeStageStudio({
  stagedImage = null,
  onUploadStagedImage,
  onClearStagedImage,
  stagedPayload = null,
  onUpdateStagedPayload,
  onSaveSnapshotToPitch,
  isImmersiveMode = false,
  onToggleImmersiveMode,
  waypoints = [],
  adaptiveQuality,
  onToggleAdaptiveQuality,
  manualQualityTier = 'high',
  onActiveQualityTierChange,
}: ThreeStageStudioProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const initialStagedRef = useRef<StagedStageImage | null>(stagedImage);
  const initialPayloadRef = useRef<Staged3DPayload | null>(stagedPayload);
  const initialWaypointsRef = useRef<RouteWaypoint[]>(waypoints);
  const isImmersiveRef = useRef<boolean>(isImmersiveMode);
  isImmersiveRef.current = isImmersiveMode;

  const [localAdaptive, setLocalAdaptive] = useState(true);
  const effectiveAdaptive =
    adaptiveQuality !== undefined ? adaptiveQuality : localAdaptive;
  const [activeTier, setActiveTier] = useState<QualityTier>(() =>
    effectiveAdaptive ? 'high' : manualQualityTier
  );

  const adaptiveRef = useRef<boolean>(effectiveAdaptive);
  adaptiveRef.current = effectiveAdaptive;
  const manualTierRef = useRef<QualityTier>(manualQualityTier);
  manualTierRef.current = manualQualityTier;
  const onActiveTierChangeRef = useRef(onActiveQualityTierChange);
  onActiveTierChangeRef.current = onActiveQualityTierChange;

  const [rigMode, setRigMode] = useState<StageRigMode>(
    () => stagedPayload?.rigMode ?? 'pavilion'
  );
  const [activeSlot, setActiveSlot] = useState<StageSlotIndex>(
    () => stagedPayload?.activeSlot ?? 0
  );
  const [slotMediaMap, setSlotMediaMap] = useState<
    Partial<Record<StageSlotIndex, StageSlotMedia>>
  >(() => {
    if (stagedPayload?.slots) return stagedPayload.slots;
    if (stagedImage?.dataUrl) {
      return {
        0: {
          kind: 'image',
          src: stagedImage.dataUrl,
          label: stagedImage.label,
        },
      };
    }
    return {};
  });

  const [preset, setPreset] = useState<CameraPresetId>('orbit');
  const [mood, setMood] = useState<LightingMoodId>('dusk');
  const [finish, setFinish] = useState<FinishId>('slate');
  const [explodePct, setExplodePct] = useState(0);
  const [turntable, setTurntable] = useState(false);
  const [dockOpen, setDockOpen] = useState(() => !isSpatialDisplayUrl());
  const [contextLost, setContextLost] = useState(false);

  const [capabilities, setCapabilities] = useState<Runtime3DCapabilities | null>(
    null
  );
  const [preferredBackend, setPreferredBackend] =
    useState<StageRendererBackend>('webgl2');
  const [activeBackend, setActiveBackend] =
    useState<StageRendererBackend>('webgl2');
  const [backendNotice, setBackendNotice] = useState<string | null>(null);
  const [isSwitchingBackend, setIsSwitchingBackend] = useState(false);

  const [postConfig, setPostConfig] = useState<PostProcessingConfig>({
    enabled: true,
    bloomStrength: 0.28,
    aoEnabled: true,
  });
  const [postSupported, setPostSupported] = useState(false);

  const [customModelMeta, setCustomModelMeta] =
    useState<CustomModelMetadata | null>(null);
  const [customModelError, setCustomModelError] = useState<string | null>(null);
  const [isLoadingGlb, setIsLoadingGlb] = useState(false);
  const [isDraggingGlb, setIsDraggingGlb] = useState(false);

  const [inspectedPart, setInspectedPart] = useState<InspectedPartInfo | null>(
    null
  );
  const [gamepadConnected, setGamepadConnected] = useState(false);
  const [isRecordingWebm, setIsRecordingWebm] = useState(false);
  const [recordProgressPct, setRecordProgressPct] = useState(0);
  const [pitchSavedFlash, setPitchSavedFlash] = useState(false);
  const [secondScreenCopied, setSecondScreenCopied] = useState(false);
  const [uvNudged, setUvNudged] = useState(false);

  const rigModeRef = useRef<StageRigMode>(rigMode);
  rigModeRef.current = rigMode;
  const activeSlotRef = useRef<StageSlotIndex>(activeSlot);
  activeSlotRef.current = activeSlot;
  const slotMediaMapRef = useRef(slotMediaMap);
  slotMediaMapRef.current = slotMediaMap;
  const moodRef = useRef<LightingMoodId>(mood);
  moodRef.current = mood;
  const finishRef = useRef<FinishId>(finish);
  finishRef.current = finish;
  const explodePctRef = useRef<number>(explodePct);
  explodePctRef.current = explodePct;
  const turntableRef = useRef<boolean>(turntable);
  turntableRef.current = turntable;
  const presetRef = useRef<CameraPresetId>(preset);
  presetRef.current = preset;
  const postConfigRef = useRef<PostProcessingConfig>(postConfig);
  postConfigRef.current = postConfig;
  const loadedGlbAssetRef = useRef<{
    data: ArrayBuffer | string;
    fileName: string;
  } | null>(null);

  const busRef = useRef<SpatialBroadcastBus | null>(null);
  const suppressBroadcastRef = useRef(false);
  const stopWebmRef = useRef<(() => void) | null>(null);

  const sceneApiRef = useRef<{
    setRigMode: (mode: StageRigMode, jumpPreset?: CameraPresetId) => void;
    setCameraPreset: (id: CameraPresetId) => void;
    focusWorldTarget: (
      pos: [number, number, number],
      target: [number, number, number]
    ) => void;
    setLightingMood: (id: LightingMoodId) => void;
    setFinish: (id: FinishId) => void;
    setExplode: (val: number) => void;
    setTurntable: (enabled: boolean, spinRateRadSec?: number) => void;
    setSlotMedia: (slot: StageSlotIndex, media: StageSlotMedia | null) => void;
    resetActiveSlotUV: (slot: StageSlotIndex) => void;
    setWaypoints: (stops: RouteWaypoint[]) => void;
    loadCustomGltf: (
      data: ArrayBuffer | string,
      fileName: string
    ) => Promise<CustomModelMetadata>;
    clearCustomGltf: () => CustomModelMetadata;
    setCustomAnimPlaying: (playing: boolean) => void;
    setPostConfig: (cfg: PostProcessingConfig) => void;
    syncQuality: (
      adaptive: boolean,
      manualTier: QualityTier,
      immersive: boolean
    ) => void;
    captureSnapshot: () => string | null;
    getCanvasElement: () => HTMLCanvasElement | null;
  } | null>(null);

  // Local Second-Screen BroadcastChannel (`athena_spatial_3d_bus`)
  useEffect(() => {
    const bus = new SpatialBroadcastBus((msg) => {
      if (msg.type === 'REQUEST_STATE') {
        bus.publishSync({
          rigMode: rigModeRef.current,
          activeSlot: activeSlotRef.current,
          preset,
          mood,
          finish,
          explodePct,
          turntable,
          stagedPayload,
          stagedLegacyImage: stagedImage,
        });
        return;
      }

      if (msg.type === 'STAGE_SYNC') {
        const s = msg.state;
        suppressBroadcastRef.current = true;
        setRigMode(s.rigMode);
        sceneApiRef.current?.setRigMode(s.rigMode);
        setActiveSlot(s.activeSlot);
        if (
          s.preset === 'orbit' ||
          s.preset === 'hero' ||
          s.preset === 'screen' ||
          s.preset === 'aerial' ||
          s.preset === 'crane'
        ) {
          setPreset(s.preset);
          sceneApiRef.current?.setCameraPreset(s.preset);
        }
        if (
          s.mood === 'dusk' ||
          s.mood === 'daylight' ||
          s.mood === 'night'
        ) {
          setMood(s.mood);
          sceneApiRef.current?.setLightingMood(s.mood);
        }
        if (
          s.finish === 'slate' ||
          s.finish === 'cedar' ||
          s.finish === 'titanium'
        ) {
          setFinish(s.finish);
          sceneApiRef.current?.setFinish(s.finish);
        }
        setExplodePct(s.explodePct);
        sceneApiRef.current?.setExplode(s.explodePct / 100);
        setTurntable(s.turntable);
        sceneApiRef.current?.setTurntable(s.turntable);

        if (s.stagedPayload?.slots) {
          setSlotMediaMap(s.stagedPayload.slots);
          ([0, 1, 2] as StageSlotIndex[]).forEach((idx) => {
            sceneApiRef.current?.setSlotMedia(
              idx,
              s.stagedPayload?.slots[idx] ?? null
            );
          });
        } else if (s.stagedLegacyImage?.dataUrl) {
          const legacyMedia: StageSlotMedia = {
            kind: 'image',
            src: s.stagedLegacyImage.dataUrl,
            label: s.stagedLegacyImage.label,
          };
          setSlotMediaMap({ 0: legacyMedia });
          sceneApiRef.current?.setSlotMedia(0, legacyMedia);
        }

        window.setTimeout(() => {
          suppressBroadcastRef.current = false;
        }, 40);
      }
    });

    busRef.current = bus;
    if (isSpatialDisplayUrl()) {
      bus.requestInitialState();
    }

    return () => {
      bus.dispose();
      busRef.current = null;
    };
    // Broadcast bus initializes once per studio mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Broadcast local stage changes to any open Second-Screen Display (`?display=spatial`)
  useEffect(() => {
    if (suppressBroadcastRef.current) return;
    busRef.current?.publishSync({
      rigMode,
      activeSlot,
      preset,
      mood,
      finish,
      explodePct,
      turntable,
      stagedPayload: {
        id: stagedPayload?.id || 'local-sync',
        rigMode,
        activeSlot,
        slots: slotMediaMap,
      },
      stagedLegacyImage: stagedImage,
    });
  }, [
    rigMode,
    activeSlot,
    preset,
    mood,
    finish,
    explodePct,
    turntable,
    slotMediaMap,
    stagedPayload?.id,
    stagedImage,
  ]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    let disposed = false;
    let teardownScene: (() => void) | null = null;

    setIsSwitchingBackend(true);
    setContextLost(false);

    const mountStageAsync = async () => {
      const { isSoftwareGl } = detectWebGLHardwareProfile();
      const width = container.clientWidth || 960;
      const height = container.clientHeight || 580;

      const initialTier: QualityTier = adaptiveRef.current
        ? 'high'
        : manualTierRef.current;
      const initialDpr = computeTierPixelRatio(
        initialTier,
        isImmersiveRef.current,
        isSoftwareGl
      );

      const stageRenderer: StageRendererHandle = await createStageRenderer({
        preferredBackend,
        width,
        height,
        pixelRatio: initialDpr,
        isSoftwareGl,
        shadowsEnabled: !isSoftwareGl && QUALITY_TIER_SPECS[initialTier].shadowsEnabled,
        shadowType: QUALITY_TIER_SPECS[initialTier].shadowType,
        onWebGPUDeviceLost: (reason) => {
          if (disposed) return;
          setBackendNotice(`WebGPU device lost (${reason}) — switched to WebGL2`);
          setPreferredBackend('webgl2');
        },
      });

      if (disposed) {
        stageRenderer.dispose();
        return;
      }

      setActiveBackend(stageRenderer.activeBackend);
      setBackendNotice(stageRenderer.fallbackNotice);
      setIsSwitchingBackend(false);

      const governor = new AdaptiveFrameGovernor(initialTier);
      let currentAppliedTier: QualityTier = initialTier;

      container.innerHTML = '';
      container.appendChild(stageRenderer.domElement);

      const maxAniso = stageRenderer.maxAnisotropy;

      // Probe 2027 WebGPU adapter limits & features asynchronously
      void probeRuntime3DCapabilities(maxAniso).then((caps) => {
        if (!disposed) {
          setCapabilities(caps);
        }
      });

      const scene = new THREE.Scene();
      const activeMoodCfg = LIGHTING_MOODS[moodRef.current];
      const bgSkyColor = new THREE.Color(activeMoodCfg.sky);
      const sceneFog = new THREE.FogExp2(
        activeMoodCfg.sky,
        activeMoodCfg.fogDensity
      );
      scene.background = bgSkyColor;
      scene.fog = sceneFog;

      // RoomEnvironment PMREM studio reflections on every device
      const envTarget = stageRenderer.createStudioEnvironment();
      if (envTarget) {
        scene.environment = envTarget.texture;
        scene.environmentIntensity = 0.74;
      }

      const startRig: StageRigMode = rigModeRef.current;
      const startCamCfg = RIG_CAMERA_PRESETS[startRig][presetRef.current] ?? RIG_CAMERA_PRESETS[startRig].orbit;

      const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 180);
      camera.position.set(...startCamCfg.pos);

      const controls = new OrbitControls(camera, stageRenderer.domElement);
      controls.target.set(...startCamCfg.target);
      controls.enableDamping = !isSoftwareGl;
      controls.dampingFactor = 0.08;
      controls.maxPolarAngle = Math.PI * 0.485;
      controls.minDistance = 2.6;
      controls.maxDistance = 38;

      // Three-point architectural lighting rig + Dual Studio Softbox RectAreaLights (WebGL2 hardware)
      const hemiLight = new THREE.HemisphereLight(
        activeMoodCfg.hemiSky,
        activeMoodCfg.hemiGround,
        activeMoodCfg.hemiIntensity
      );
      scene.add(hemiLight);

      const keyLight = new THREE.DirectionalLight(
        activeMoodCfg.keyColor,
        activeMoodCfg.keyIntensity
      );
      keyLight.position.set(...activeMoodCfg.keyPos);
      keyLight.castShadow =
        !isSoftwareGl && QUALITY_TIER_SPECS[initialTier].shadowsEnabled;
      keyLight.shadow.mapSize.set(
        QUALITY_TIER_SPECS[initialTier].shadowMapSize,
        QUALITY_TIER_SPECS[initialTier].shadowMapSize
      );
      keyLight.shadow.radius = QUALITY_TIER_SPECS[initialTier].shadowRadius;
      keyLight.shadow.camera.left = -16;
      keyLight.shadow.camera.right = 16;
      keyLight.shadow.camera.top = 16;
      keyLight.shadow.camera.bottom = -16;
      keyLight.shadow.camera.near = 1;
      keyLight.shadow.camera.far = 55;
      keyLight.shadow.bias = -0.0005;
      keyLight.shadow.normalBias = 0.02;
      scene.add(keyLight);

      const rimLight = new THREE.DirectionalLight(0x22d3ee, 0.58);
      rimLight.position.set(-14, 7, -12);
      scene.add(rimLight);

      // RectAreaLight LTC uniforms are WebGL2-specific; compensate cleanly on WebGPU with a cool soft fill
      const softboxLights = stageRenderer.isWebGPU
        ? []
        : createStudioSoftboxPair(isSoftwareGl);
      const baseSoftboxIntensities = softboxLights.map((l) => l.intensity);
      softboxLights.forEach((l) => {
        l.intensity *= activeMoodCfg.softboxScale;
        scene.add(l);
      });
      if (stageRenderer.isWebGPU) {
        const webgpuFill = new THREE.DirectionalLight(0x9ee8ff, 0.72);
        webgpuFill.position.set(-6.5, 5.5, 6.2);
        scene.add(webgpuFill);
      }

      // Studio Post-Processing Pipeline (GTAO + UnrealBloom + ACES OutputPass on WebGL2 hardware)
      const postPipeline: StudioPostPipelineHandle = createStudioPostPipeline({
        renderer: stageRenderer.webglRenderer,
        scene,
        camera,
        width,
        height,
        pixelRatio: initialDpr,
        isSoftwareGl,
        initialConfig: postConfigRef.current,
      });
      setPostSupported(postPipeline.isSupported);

      // Ground Plaza
    let concreteTex: THREE.CanvasTexture | null = null;
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x1b2029,
      roughness: 0.88,
      metalness: 0.08,
    });
    const ground = new THREE.Mesh(new THREE.CircleGeometry(65, 48), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.matrixAutoUpdate = false;
    ground.updateMatrix();
    scene.add(ground);

    // Contact shadow plane
    const contactTex = createCachedContactShadowTexture();
    const contactMat = new THREE.MeshBasicMaterial({
      map: contactTex,
      transparent: true,
      depthWrite: false,
      opacity: 0.9,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const pavilionShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(14.5, 11.5),
      contactMat
    );
    pavilionShadow.rotation.x = -Math.PI / 2;
    pavilionShadow.position.set(0, 0.02, 0);
    pavilionShadow.renderOrder = 1;
    scene.add(pavilionShadow);

    // ---------- Master Stage Root & 3 Multi-Slot Showcase Rigs ----------
    const stageRoot = new THREE.Group();
    scene.add(stageRoot);

    // Rig 1: Broadcast Pavilion + Crane (Equipped with 3 Media Slots & Layer-1 Inspectable Parts)
    const pavilionWrapper = new THREE.Group();
    stageRoot.add(pavilionWrapper);

    const pavilionGroup = new THREE.Group();
    pavilionWrapper.add(pavilionGroup);

    const roofMat = new THREE.MeshStandardMaterial({
      color: FINISH_PALETTES.slate.roof,
      metalness: FINISH_PALETTES.slate.metalness,
      roughness: FINISH_PALETTES.slate.roughness,
    });
    let cedarTex: THREE.CanvasTexture | null = null;
    const coreMat = new THREE.MeshStandardMaterial({
      color: 0x73472c,
      roughness: 0.72,
      metalness: 0.05,
    });
    const steelMat = new THREE.MeshStandardMaterial({
      color: 0x3b4454,
      metalness: 0.8,
      roughness: 0.28,
    });
    const plinthMat = new THREE.MeshStandardMaterial({
      color: 0x262c36,
      roughness: 0.85,
      metalness: 0.1,
    });
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x89d6eb,
      roughness: 0.1,
      metalness: 0.05,
      transmission: isSoftwareGl ? 0 : 0.62,
      transparent: true,
      opacity: isSoftwareGl ? 0.38 : 0.52,
      thickness: 0.25,
      depthWrite: false,
    });
    const accentGlowMat = new THREE.MeshStandardMaterial({
      color: 0x22d3ee,
      emissive: 0x22d3ee,
      emissiveIntensity: 1.8,
      roughness: 0.2,
    });

    const pavSlot0Mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.38,
      roughness: 0.24,
      metalness: 0.06,
    });
    const pavSlot1Mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.36,
      roughness: 0.22,
      metalness: 0.06,
    });
    const pavSlot2Mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.32,
      roughness: 0.26,
      metalness: 0.08,
    });

    const lowerStepGeo = new THREE.BoxGeometry(10.8, 0.34, 7.6);
    lowerStepGeo.translate(0, 0.17, 0);
    const upperStepGeo = new THREE.BoxGeometry(9.6, 0.28, 6.6);
    upperStepGeo.translate(0, 0.48, 0);
    const mergedPlinthGeo = mergeStaticParts([lowerStepGeo, upperStepGeo]);
    const plinthMesh = new THREE.Mesh(mergedPlinthGeo, plinthMat);
    plinthMesh.castShadow = true;
    plinthMesh.receiveShadow = true;
    plinthMesh.layers.enable(1);
    plinthMesh.userData.inspectInfo = {
      partId: 'pavilion-plinth',
      title: 'Tiered Concrete Plaza Plinth',
      subtitle: 'Grounded Architectural Foundation',
      materialSummary: 'Architectural Cast Concrete · Roughness 0.85',
      focusPos: [11.5, 5.2, 12.5],
      focusTarget: [0, 0.6, 0],
    } satisfies InspectedPartInfo;

    const entryLightStrip = new THREE.Mesh(
      new THREE.BoxGeometry(8.8, 0.06, 0.08),
      accentGlowMat
    );
    entryLightStrip.position.set(0, 0.36, 3.32);

    // Pavilion Slot [2]: Front Plinth Marquee Strip (4:1)
    const pavMarqueeBack = new THREE.Mesh(
      new THREE.BoxGeometry(3.56, 0.9, 0.1),
      steelMat
    );
    pavMarqueeBack.position.set(-1.3, 0.88, 3.36);
    pavMarqueeBack.rotation.x = -0.35;
    const pavMarqueePlane = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 0.85),
      pavSlot2Mat
    );
    pavMarqueePlane.position.set(-1.3, 0.9, 3.42);
    pavMarqueePlane.rotation.x = -0.35;
    pavMarqueePlane.layers.enable(1);
    pavMarqueePlane.userData.inspectInfo = {
      partId: 'pavilion-marquee-slot-2',
      title: 'Plinth Marquee Display (Slot 3)',
      subtitle: '4:1 Lower Broadcast Ticker',
      materialSummary: 'LED Marquee Surface · Slot 3 Active Surface',
      slotIndex: 2,
      focusPos: [-1.3, 2.1, 6.6],
      focusTarget: [-1.3, 0.9, 3.4],
    } satisfies InspectedPartInfo;

    pavilionGroup.add(plinthMesh, entryLightStrip, pavMarqueeBack, pavMarqueePlane);

    // 6 Structural Steel Columns
    const colPositions: Array<[number, number]> = [
      [-4.1, -2.5],
      [0, -2.5],
      [4.1, -2.5],
      [-4.1, 2.5],
      [0, 2.5],
      [4.1, 2.5],
    ];
    const colGeo = new THREE.BoxGeometry(0.24, 3.6, 0.24);
    const columnsInst = new THREE.InstancedMesh(colGeo, steelMat, colPositions.length);
    columnsInst.castShadow = true;
    columnsInst.receiveShadow = true;
    colPositions.forEach(([cx, cz], idx) => {
      _dummyObj.position.set(cx, 2.42, cz);
      _dummyObj.rotation.set(0, 0, 0);
      _dummyObj.scale.set(1, 1, 1);
      _dummyObj.updateMatrix();
      columnsInst.setMatrixAt(idx, _dummyObj.matrix);
    });
    columnsInst.instanceMatrix.needsUpdate = true;
    columnsInst.computeBoundingSphere();
    pavilionGroup.add(columnsInst);

    // Core Studio Room + Slot [0] Main Wall (16:9) + Slot [1] Aux Monitor (16:9)
    const coreGroup = new THREE.Group();
    const coreBox = new THREE.Mesh(new THREE.BoxGeometry(4.8, 3.25, 3.4), coreMat);
    coreBox.position.set(-1.3, 2.24, -0.35);
    coreBox.castShadow = true;
    coreBox.receiveShadow = true;
    coreBox.layers.enable(1);
    coreBox.userData.inspectInfo = {
      partId: 'pavilion-cedar-core',
      title: 'Acoustic Cedar Studio Core',
      subtitle: 'Interior Broadcast Control Volume',
      materialSummary: 'Warm Slatted Cedar · Roughness 0.72',
      focusPos: [-4.8, 3.4, 7.8],
      focusTarget: [-1.3, 2.24, -0.35],
    } satisfies InspectedPartInfo;

    const screenBezel = new THREE.Mesh(new THREE.BoxGeometry(4.24, 2.42, 0.08), steelMat);
    screenBezel.position.set(-1.3, 2.32, 1.38);
    const screenTrim = new THREE.Mesh(
      new THREE.BoxGeometry(4.06, 0.04, 0.09),
      accentGlowMat
    );
    screenTrim.position.set(-1.3, 1.09, 1.39);
    const screenPlane = new THREE.Mesh(new THREE.PlaneGeometry(4.0, 2.25), pavSlot0Mat);
    screenPlane.position.set(-1.3, 2.32, 1.43);
    screenPlane.layers.enable(1);
    screenPlane.userData.inspectInfo = {
      partId: 'pavilion-main-screen-slot-0',
      title: 'Main Broadcast Wall (Slot 1)',
      subtitle: '16:9 Widescreen Video & Visual Plate',
      materialSummary: 'Direct-View LED Matrix · Slot 1 Active Surface',
      slotIndex: 0,
      focusPos: [-1.3, 2.45, 7.6],
      focusTarget: [-1.3, 2.32, 1.38],
    } satisfies InspectedPartInfo;

    // Auxiliary Side Monitor inside Right Gallery Bay (Slot [1], 16:9)
    const auxMonitorBezel = new THREE.Mesh(
      new THREE.BoxGeometry(2.56, 1.48, 0.07),
      steelMat
    );
    auxMonitorBezel.position.set(2.35, 2.15, -0.45);
    auxMonitorBezel.rotation.y = -0.32;
    const auxMonitorPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, 1.35),
      pavSlot1Mat
    );
    auxMonitorPlane.position.set(2.33, 2.15, -0.4);
    auxMonitorPlane.rotation.y = -0.32;
    auxMonitorPlane.layers.enable(1);
    auxMonitorPlane.userData.inspectInfo = {
      partId: 'pavilion-aux-screen-slot-1',
      title: 'Gallery Side Monitor (Slot 2)',
      subtitle: '16:9 Secondary Feed Display',
      materialSummary: 'Studio Reference Monitor · Slot 2 Active Surface',
      slotIndex: 1,
      focusPos: [3.4, 2.35, 5.4],
      focusTarget: [2.33, 2.15, -0.4],
    } satisfies InspectedPartInfo;

    const interiorGlow = new THREE.PointLight(0xffb46b, 1.5, 11);
    interiorGlow.position.set(1.6, 2.5, 0.4);
    coreGroup.add(
      coreBox,
      screenBezel,
      screenTrim,
      screenPlane,
      auxMonitorBezel,
      auxMonitorPlane,
      interiorGlow
    );
    pavilionGroup.add(coreGroup);

    // Glass Curtain Wall
    const glassGroup = new THREE.Group();
    const frontGlassGeo = new THREE.BoxGeometry(8.2, 3.3, 0.08);
    frontGlassGeo.translate(0, 2.27, 2.45);
    const sideGlassGeo = new THREE.BoxGeometry(0.08, 3.3, 4.9);
    sideGlassGeo.translate(4.08, 2.27, 0);
    const mergedGlassGeo = mergeStaticParts([frontGlassGeo, sideGlassGeo]);
    const glassWallMesh = new THREE.Mesh(mergedGlassGeo, glassMat);
    glassWallMesh.renderOrder = 3;

    const topMullion = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.12, 0.14), steelMat);
    topMullion.position.set(0, 3.92, 2.45);
    glassGroup.add(glassWallMesh, topMullion);
    pavilionGroup.add(glassGroup);

    // Cantilevered Roof Canopy
    const roofGroup = new THREE.Group();
    const roofShape = new THREE.Shape();
    roofShape.moveTo(-6.1, -3.7);
    roofShape.lineTo(6.4, -3.7);
    roofShape.lineTo(5.8, 3.9);
    roofShape.lineTo(-5.7, 3.9);
    roofShape.closePath();
    const roofGeo = new THREE.ExtrudeGeometry(roofShape, {
      depth: 0.36,
      bevelEnabled: true,
      bevelThickness: 0.08,
      bevelSize: 0.12,
      bevelSegments: 2,
    });
    roofGeo.rotateX(Math.PI / 2);
    const roofMesh = new THREE.Mesh(roofGeo, roofMat);
    roofMesh.position.set(0, 4.54, 0);
    roofMesh.castShadow = true;
    roofMesh.receiveShadow = true;
    roofMesh.layers.enable(1);
    roofMesh.userData.inspectInfo = {
      partId: 'pavilion-roof-canopy',
      title: 'Cantilevered Acoustic Roof Canopy',
      subtitle: 'Beveled Overhang & Broadcast Mast',
      materialSummary: 'Standing-Seam Cladding · Customizable Finish',
      focusPos: [9.5, 9.2, 11.5],
      focusTarget: [0, 4.5, 0],
    } satisfies InspectedPartInfo;

    const mastBaseGeo = new THREE.CylinderGeometry(0.32, 0.45, 0.4, 14);
    mastBaseGeo.translate(-2.6, 4.78, -1.2);
    const mastPoleGeo = new THREE.CylinderGeometry(0.05, 0.09, 2.2, 10);
    mastPoleGeo.translate(-2.6, 5.9, -1.2);
    const mergedMastGeo = mergeStaticParts([mastBaseGeo, mastPoleGeo]);
    const mastMesh = new THREE.Mesh(mergedMastGeo, steelMat);

    const beaconRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.28, 0.04, 10, 20),
      accentGlowMat
    );
    beaconRing.rotation.x = Math.PI / 2;
    beaconRing.position.set(-2.6, 6.75, -1.2);
    roofGroup.add(roofMesh, mastMesh, beaconRing);
    pavilionGroup.add(roofGroup);

    const craneGroup = new THREE.Group();
    craneGroup.position.set(6.2, 0, 3.2);
    craneGroup.rotation.y = -0.68;
    pavilionWrapper.add(craneGroup);

    // Rig 2 (`devices`), Rig 3 (`foilCard`) & Rig 4 (`customModel` GLB/GLTF Showcase)
    const devicesRig: ShowcaseRigHandle = buildDevicesShowcaseRig(isSoftwareGl);
    const foilCardRig: ShowcaseRigHandle = buildFoilCardShowcaseRig(isSoftwareGl);
    const customModelRig: CustomModelRigHandle =
      buildCustomModelShowcaseRig(isSoftwareGl);
    stageRoot.add(devicesRig.group, foilCardRig.group, customModelRig.group);
    setCustomModelMeta(customModelRig.getMetadata());

    let currentRigMode: StageRigMode = startRig;
    const syncRigVisibility = (mode: StageRigMode) => {
      currentRigMode = mode;
      pavilionWrapper.visible = mode === 'pavilion';
      devicesRig.group.visible = mode === 'devices';
      foilCardRig.group.visible = mode === 'foilCard';
      customModelRig.group.visible = mode === 'customModel';
      if (mode === 'pavilion') {
        pavilionShadow.scale.set(1, 1, 1);
      } else if (mode === 'devices') {
        pavilionShadow.scale.set(0.82, 0.82, 1);
      } else if (mode === 'customModel') {
        pavilionShadow.scale.set(0.68, 0.68, 1);
      } else {
        pavilionShadow.scale.set(0.56, 0.56, 1);
      }
      stageRenderer.shadowMap.needsUpdate = true;
    };
    syncRigVisibility(startRig);

    // ---------- Multi-Slot Media & VideoTexture Registry ----------
    let defaultScreenTex: THREE.CanvasTexture | null = null;
    interface SlotRuntimeBinding {
      media: StageSlotMedia | null;
      customTex: THREE.Texture | null;
      videoHandle: LiveVideoTextureHandle | null;
      decodeSeq: number;
      naturalAspect: number;
      uvOffset: [number, number];
      uvScale: [number, number];
    }
    const slotRuntime: Record<StageSlotIndex, SlotRuntimeBinding> = {
      0: {
        media: null,
        customTex: null,
        videoHandle: null,
        decodeSeq: 0,
        naturalAspect: 16 / 9,
        uvOffset: [0, 0],
        uvScale: [1, 1],
      },
      1: {
        media: null,
        customTex: null,
        videoHandle: null,
        decodeSeq: 0,
        naturalAspect: 16 / 9,
        uvOffset: [0, 0],
        uvScale: [1, 1],
      },
      2: {
        media: null,
        customTex: null,
        videoHandle: null,
        decodeSeq: 0,
        naturalAspect: 4,
        uvOffset: [0, 0],
        uvScale: [1, 1],
      },
    };

    const getRigSlotMaterials = (
      mode: StageRigMode
    ): [
      THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial,
      THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial,
      THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial,
    ] => {
      if (mode === 'devices') return devicesRig.slotMaterials;
      if (mode === 'foilCard') return foilCardRig.slotMaterials;
      if (mode === 'customModel') return customModelRig.slotMaterials;
      return [pavSlot0Mat, pavSlot1Mat, pavSlot2Mat];
    };

    const bindTextureAcrossRigs = (slot: StageSlotIndex) => {
      const rt = slotRuntime[slot];
      const activeTex = rt.videoHandle?.texture ?? rt.customTex ?? defaultScreenTex;
      if (activeTex && (rt.videoHandle || rt.customTex)) {
        const targetAspect = STAGE_RIG_META[currentRigMode].slotAspects[slot];
        applyAspectPreservingUV(
          activeTex,
          rt.naturalAspect,
          targetAspect,
          rt.uvOffset,
          rt.uvScale
        );
      }

      const allModes: StageRigMode[] = [
        'pavilion',
        'devices',
        'foilCard',
        'customModel',
      ];
      for (const m of allModes) {
        const mat = getRigSlotMaterials(m)[slot];
        mat.map = activeTex ?? null;
        mat.emissiveMap = activeTex ?? null;
        mat.needsUpdate = true;
      }
    };

    const disposeSlotBinding = (slot: StageSlotIndex) => {
      const rt = slotRuntime[slot];
      if (rt.videoHandle) {
        rt.videoHandle.dispose();
        rt.videoHandle = null;
      }
      if (rt.customTex) {
        rt.customTex.dispose();
        rt.customTex = null;
      }
    };

    const extraDisposables: Array<{ dispose: () => void }> = [];

    // ---------- 1-Draw-Call Instanced Waypoints ----------
    let waypointBeaconInst: THREE.InstancedMesh | null = null;
    let waypointStemInst: THREE.InstancedMesh | null = null;
    let waypointPathLine: THREE.Line | null = null;

    const sync3DWaypoints = (stops: RouteWaypoint[]) => {
      const count = Math.min(stops.length, MAX_ROUTE_WAYPOINTS);
      if (count === 0) {
        if (waypointBeaconInst) waypointBeaconInst.visible = false;
        if (waypointStemInst) waypointStemInst.visible = false;
        if (waypointPathLine) waypointPathLine.visible = false;
        requestRender();
        return;
      }

      if (!waypointBeaconInst || !waypointStemInst || !waypointPathLine) {
        const stemGeo = new THREE.CylinderGeometry(0.035, 0.035, 1.35, 8);
        const stemMat = new THREE.MeshBasicMaterial({
          color: 0x22d3ee,
          transparent: true,
          opacity: 0.55,
        });
        waypointStemInst = new THREE.InstancedMesh(
          stemGeo,
          stemMat,
          MAX_ROUTE_WAYPOINTS
        );
        waypointStemInst.frustumCulled = false;

        const orbGeo = new THREE.OctahedronGeometry(0.2, 0);
        const orbMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
        waypointBeaconInst = new THREE.InstancedMesh(
          orbGeo,
          orbMat,
          MAX_ROUTE_WAYPOINTS
        );
        waypointBeaconInst.frustumCulled = false;

        const lineGeo = new THREE.BufferGeometry();
        lineGeo.setAttribute(
          'position',
          new THREE.BufferAttribute(new Float32Array(MAX_ROUTE_WAYPOINTS * 3), 3)
        );
        const lineMat = new THREE.LineBasicMaterial({
          color: 0x22d3ee,
          transparent: true,
          opacity: 0.7,
        });
        waypointPathLine = new THREE.Line(lineGeo, lineMat);
        waypointPathLine.frustumCulled = false;

        stageRoot.add(waypointStemInst, waypointBeaconInst, waypointPathLine);
        extraDisposables.push(stemGeo, stemMat, orbGeo, orbMat, lineGeo, lineMat);
      }

      let minLat = Infinity;
      let maxLat = -Infinity;
      let minLng = Infinity;
      let maxLng = -Infinity;
      for (let i = 0; i < count; i++) {
        const s = stops[i];
        if (s.lat < minLat) minLat = s.lat;
        if (s.lat > maxLat) maxLat = s.lat;
        if (s.lng < minLng) minLng = s.lng;
        if (s.lng > maxLng) maxLng = s.lng;
      }
      const latSpan = Math.max(maxLat - minLat, 0.002);
      const lngSpan = Math.max(maxLng - minLng, 0.002);
      const posAttr = waypointPathLine.geometry.getAttribute(
        'position'
      ) as THREE.BufferAttribute;

      for (let i = 0; i < count; i++) {
        const s = stops[i];
        const nx = (s.lng - minLng) / lngSpan - 0.5;
        const nz = (s.lat - minLat) / latSpan - 0.5;
        const baseAngle = Math.atan2(-nz, nx);
        const spreadAngle =
          count === 1 ? 0.6 : -Math.PI * 0.7 + (i / (count - 1)) * Math.PI * 1.4;
        const blendedAngle = baseAngle * 0.35 + spreadAngle * 0.65;
        const ringRadius = 9.4 + (i % 2) * 0.55;

        const wx = Math.cos(blendedAngle) * ringRadius;
        const wz = Math.sin(blendedAngle) * ringRadius;
        const wy = 1.42;

        _dummyObj.position.set(wx, wy * 0.5, wz);
        _dummyObj.rotation.set(0, 0, 0);
        _dummyObj.scale.set(1, 1, 1);
        _dummyObj.updateMatrix();
        waypointStemInst.setMatrixAt(i, _dummyObj.matrix);

        _dummyObj.position.set(wx, wy, wz);
        const scale = i === 0 || i === count - 1 ? 1.25 : s.via ? 0.8 : 1.0;
        _dummyObj.scale.setScalar(scale);
        _dummyObj.updateMatrix();
        waypointBeaconInst.setMatrixAt(i, _dummyObj.matrix);

        const c =
          i === 0
            ? _originColor
            : i === count - 1 && count > 1
              ? _destColor
              : s.via
                ? _viaColor
                : _stopColor;
        waypointBeaconInst.setColorAt(i, c);
        posAttr.setXYZ(i, wx, wy, wz);
      }

      waypointStemInst.count = count;
      waypointBeaconInst.count = count;
      waypointStemInst.instanceMatrix.needsUpdate = true;
      waypointBeaconInst.instanceMatrix.needsUpdate = true;
      if (waypointBeaconInst.instanceColor) {
        waypointBeaconInst.instanceColor.needsUpdate = true;
      }
      waypointPathLine.geometry.setDrawRange(0, count >= 2 ? count : 0);
      posAttr.needsUpdate = true;
      waypointStemInst.visible = true;
      waypointBeaconInst.visible = true;
      waypointPathLine.visible = count >= 2;
      requestRender();
    };

    // ---------- Throttled Layer-1 Raycaster Inspection ----------
    const raycaster = new THREE.Raycaster();
    raycaster.layers.set(1);
    let lastHoverRaycastMs = 0;
    let pointerDownPos: [number, number] = [0, 0];

    const resolveActiveRigObject = (): THREE.Object3D => {
      if (currentRigMode === 'devices') return devicesRig.group;
      if (currentRigMode === 'foilCard') return foilCardRig.group;
      if (currentRigMode === 'customModel') return customModelRig.group;
      return pavilionWrapper;
    };

    const pickInspectableAt = (clientX: number, clientY: number): InspectedPartInfo | null => {
      const rect = stageRenderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      _ndcPointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      _ndcPointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(_ndcPointer, camera);
      const hits = raycaster.intersectObject(resolveActiveRigObject(), true);
      for (const hit of hits) {
        let cur: THREE.Object3D | null = hit.object;
        while (cur) {
          if (cur.userData?.inspectInfo) {
            return cur.userData.inspectInfo as InspectedPartInfo;
          }
          cur = cur.parent;
        }
      }
      return null;
    };

    const onCanvasPointerDown = (e: PointerEvent) => {
      pointerDownPos = [e.clientX, e.clientY];
    };
    const onCanvasPointerMove = (e: PointerEvent) => {
      const now = performance.now();
      if (now - lastHoverRaycastMs < 55) return;
      lastHoverRaycastMs = now;
      const hitInfo = pickInspectableAt(e.clientX, e.clientY);
      stageRenderer.domElement.style.cursor = hitInfo ? 'pointer' : 'grab';
    };
    const onCanvasPointerUp = (e: PointerEvent) => {
      const dist = Math.hypot(
        e.clientX - pointerDownPos[0],
        e.clientY - pointerDownPos[1]
      );
      if (dist > 5) return; // Ignore OrbitControls drag gestures
      const info = pickInspectableAt(e.clientX, e.clientY);
      setInspectedPart(info);
      if (info && typeof info.slotIndex === 'number') {
        setActiveSlot(info.slotIndex);
      }
    };

    stageRenderer.domElement.addEventListener('pointerdown', onCanvasPointerDown);
    stageRenderer.domElement.addEventListener('pointermove', onCanvasPointerMove);
    stageRenderer.domElement.addEventListener('pointerup', onCanvasPointerUp);

    // ---------- Gamepad Poller & Coalesced Render Loop ----------
    const gamepadPoller = new GamepadPoller();
    let hasConnectedGamepad = false;
    const onGamepadConnected = () => {
      hasConnectedGamepad = true;
      setGamepadConnected(true);
      requestRender();
    };
    const onGamepadDisconnected = () => {
      const gp = gamepadPoller.poll();
      hasConnectedGamepad = gp.connected;
      setGamepadConnected(gp.connected);
    };
    window.addEventListener('gamepadconnected', onGamepadConnected);
    window.addEventListener('gamepaddisconnected', onGamepadDisconnected);

    const targetCamPos = new THREE.Vector3(...startCamCfg.pos);
    const targetLookAt = new THREE.Vector3(...startCamCfg.target);
    let cameraAnimating = false;
    let explodeTarget = explodePctRef.current / 100;
    let explodeCurrent = 0;
    let turntableActive = turntableRef.current;
    let turntableRate = 0.28;
    let cancelSoftwareWait: (() => void) | null = null;
    let rafId = 0;
    let resizeRafId = 0;
    let renderBusy = false;
    let renderDirty = false;
    const mountStartMs = performance.now();
    let lastTime = mountStartMs;
    let prevContinuousRafMs = 0;
    let wasContinuousFrame = false;

    const applyTierToStage = (tier: QualityTier, forceResize = false) => {
      currentAppliedTier = tier;
      const w = container.clientWidth || 800;
      const h = container.clientHeight || 500;
      if (stageRenderer.webglRenderer) {
        applyThreeSceneQuality({
          renderer: stageRenderer.webglRenderer,
          scene,
          shadowLight: keyLight,
          width: w,
          height: h,
          tier,
          immersive: isImmersiveRef.current,
          isSoftwareGl,
          autoUpdateShadows: false,
          forceResize,
        });
        postPipeline.setSize(w, h, stageRenderer.getPixelRatio());
      } else {
        const dpr = computeTierPixelRatio(tier, isImmersiveRef.current, isSoftwareGl);
        stageRenderer.setPixelRatio(dpr);
        stageRenderer.setSize(w, h);
        const wantShadows = !isSoftwareGl && QUALITY_TIER_SPECS[tier].shadowsEnabled;
        stageRenderer.shadowMap.enabled = wantShadows;
        keyLight.castShadow = wantShadows;
        stageRenderer.shadowMap.needsUpdate = true;
      }
      setActiveTier(tier);
      onActiveTierChangeRef.current?.(tier);
    };

    const hasActiveVideoSlot = (): boolean =>
      Boolean(
        slotRuntime[0].videoHandle ||
          slotRuntime[1].videoHandle ||
          slotRuntime[2].videoHandle
      );

    function requestRender() {
      if (disposed) return;
      if (renderBusy) {
        renderDirty = true;
        return;
      }
      renderBusy = true;
      lastTime = performance.now();
      rafId = requestAnimationFrame((now) => {
        rafId = 0;
        if (disposed) return;
        renderDirty = false;

        if (
          wasContinuousFrame &&
          prevContinuousRafMs > 0 &&
          !isSoftwareGl &&
          adaptiveRef.current
        ) {
          const realFrameSec = (now - prevContinuousRafMs) / 1000;
          const nextTier = governor.recordFrame(realFrameSec, now);
          if (nextTier && nextTier !== currentAppliedTier) {
            applyTierToStage(nextTier, false);
          }
        }

        const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
        lastTime = now;
        const elapsedSec = (now - mountStartMs) / 1000;
        const damp = isSoftwareGl ? 1 : 1 - Math.exp(-7 * dt);

        let keepGoing = false;
        let shadowsDirty = false;

        // Poll USB Gamepad for 3D Orbit, UV Pan, Dolly Zoom, and LB/RB Slot Cycling
        const gp = gamepadPoller.poll();
        if (gp.connected !== hasConnectedGamepad) {
          hasConnectedGamepad = gp.connected;
          setGamepadConnected(gp.connected);
        }
        if (gp.connected) {
          keepGoing = true;
          if (gp.lbJustPressed || gp.rbJustPressed) {
            const delta = gp.rbJustPressed ? 1 : -1;
            const nextSlot = ((activeSlotRef.current + delta + 3) %
              3) as StageSlotIndex;
            activeSlotRef.current = nextSlot;
            setActiveSlot(nextSlot);
          }

          if (
            Math.abs(gp.leftX) > 0 ||
            Math.abs(gp.leftY) > 0 ||
            gp.lt > 0.08 ||
            gp.rt > 0.08
          ) {
            cameraAnimating = false;
            _camOffset.copy(camera.position).sub(controls.target);
            _spherical.setFromVector3(_camOffset);
            _spherical.theta -= gp.leftX * dt * 1.85;
            _spherical.phi = THREE.MathUtils.clamp(
              _spherical.phi + gp.leftY * dt * 1.35,
              0.18,
              Math.PI * 0.48
            );
            const zoomFactor = 1 + (gp.lt - gp.rt) * dt * 1.4;
            _spherical.radius = THREE.MathUtils.clamp(
              _spherical.radius * zoomFactor,
              controls.minDistance,
              controls.maxDistance
            );
            _camOffset.setFromSpherical(_spherical);
            camera.position.copy(controls.target).add(_camOffset);
          }

          // Right stick UV offset pan on active slot
          if (Math.abs(gp.rightX) > 0 || Math.abs(gp.rightY) > 0) {
            const slotIdx = activeSlotRef.current;
            const rt = slotRuntime[slotIdx];
            rt.uvOffset[0] = THREE.MathUtils.clamp(
              rt.uvOffset[0] - gp.rightX * dt * 0.45,
              -0.45,
              0.45
            );
            rt.uvOffset[1] = THREE.MathUtils.clamp(
              rt.uvOffset[1] + gp.rightY * dt * 0.45,
              -0.45,
              0.45
            );
            bindTextureAcrossRigs(slotIdx);
            setUvNudged(true);
          }
        }

        if (cameraAnimating) {
          camera.position.lerp(targetCamPos, damp);
          controls.target.lerp(targetLookAt, damp);
          if (
            camera.position.distanceToSquared(targetCamPos) < 0.0009 &&
            controls.target.distanceToSquared(targetLookAt) < 0.0009
          ) {
            camera.position.copy(targetCamPos);
            controls.target.copy(targetLookAt);
            cameraAnimating = false;
          } else {
            keepGoing = true;
          }
        }

        if (Math.abs(explodeCurrent - explodeTarget) > 0.002) {
          explodeCurrent += (explodeTarget - explodeCurrent) * damp;
          roofGroup.position.y = explodeCurrent * 2.8;
          glassGroup.position.z = explodeCurrent * 1.4;
          coreGroup.position.x = -explodeCurrent * 1.1;
          craneGroup.position.x = 6.2 + explodeCurrent * 1.8;
          devicesRig.applyExplode(explodeCurrent);
          foilCardRig.applyExplode(explodeCurrent);
          customModelRig.applyExplode(explodeCurrent);
          shadowsDirty = true;
          keepGoing = true;
        }

        if (currentRigMode === 'foilCard' && !isSoftwareGl) {
          foilCardRig.updateFrame?.(elapsedSec);
          keepGoing = true;
        }

        if (currentRigMode === 'customModel') {
          const animated = customModelRig.updateFrame(dt, elapsedSec);
          if (animated) {
            keepGoing = true;
          }
        }

        if (hasActiveVideoSlot()) {
          keepGoing = true;
        }

        if (turntableActive && !isSoftwareGl) {
          stageRoot.rotation.y += dt * turntableRate;
          shadowsDirty = true;
          keepGoing = true;
        }

        const controlsChanged = controls.update();
        if (controlsChanged) {
          keepGoing = true;
        }

        if (shadowsDirty && stageRenderer.shadowMap.enabled) {
          stageRenderer.shadowMap.needsUpdate = true;
        }

        if (postPipeline.isSupported) {
          postPipeline.render();
        } else {
          stageRenderer.render(scene, camera);
        }

        prevContinuousRafMs = now;
        wasContinuousFrame = renderDirty || keepGoing;

        const done = () => {
          renderBusy = false;
          if (renderDirty || keepGoing) {
            requestRender();
          } else {
            wasContinuousFrame = false;
          }
        };

        if (isSoftwareGl && stageRenderer.webglRenderer) {
          cancelSoftwareWait = scheduleSoftwareGlAfterDraw(
            stageRenderer.webglRenderer,
            () => disposed,
            done
          );
        } else {
          done();
        }
      });
    }

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      setContextLost(true);
    };
    const handleContextRestored = () => {
      setContextLost(false);
      stageRenderer.shadowMap.needsUpdate = true;
      requestRender();
    };
    stageRenderer.domElement.addEventListener('webglcontextlost', handleContextLost, false);
    stageRenderer.domElement.addEventListener(
      'webglcontextrestored',
      handleContextRestored,
      false
    );

    controls.addEventListener('start', () => {
      cameraAnimating = false;
      requestRender();
    });
    controls.addEventListener('change', requestRender);

    // Lazy Stage 2 Hydration: procedural concrete/cedar + Broadcast Crane + Bollards
    const cancelIdleHydration = scheduleIdleStageTask(() => {
      if (disposed) return;

      concreteTex = createCachedConcreteTexture(maxAniso);
      groundMat.color.setHex(0xffffff);
      groundMat.map = concreteTex;
      groundMat.needsUpdate = true;

      cedarTex = createCachedCedarTexture(maxAniso);
      coreMat.color.setHex(0xffffff);
      coreMat.map = cedarTex;
      coreMat.needsUpdate = true;

      defaultScreenTex = createCachedDefaultScreenTexture(maxAniso);
      ([0, 1, 2] as StageSlotIndex[]).forEach((idx) => {
        bindTextureAcrossRigs(idx);
      });

      const craneShadow = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 4.8), contactMat);
      craneShadow.rotation.x = -Math.PI / 2;
      craneShadow.position.set(0, 0.02, 0);
      craneShadow.renderOrder = 1;
      craneGroup.add(craneShadow);

      const chassisMat = new THREE.MeshStandardMaterial({
        color: 0x202733,
        metalness: 0.6,
        roughness: 0.35,
      });
      const tireMat = new THREE.MeshStandardMaterial({
        color: 0x111318,
        roughness: 0.92,
        metalness: 0.05,
      });

      const chassisBaseGeo = new THREE.BoxGeometry(1.75, 0.36, 2.3);
      chassisBaseGeo.translate(0, 0.52, 0);
      const camBodyGeo = new THREE.BoxGeometry(0.42, 0.38, 0.68);
      camBodyGeo.translate(0, 3.32, 2.3);
      const mergedChassisGeo = mergeStaticParts([chassisBaseGeo, camBodyGeo]);
      const chassisMesh = new THREE.Mesh(mergedChassisGeo, chassisMat);
      chassisMesh.castShadow = true;
      craneGroup.add(chassisMesh);

      const wheelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.22, 16);
      wheelGeo.rotateZ(Math.PI / 2);
      const wheelOffsets: Array<[number, number]> = [
        [-0.95, -0.78],
        [0.95, -0.78],
        [-0.95, 0.78],
        [0.95, 0.78],
      ];
      const wheelsInst = new THREE.InstancedMesh(wheelGeo, tireMat, wheelOffsets.length);
      wheelOffsets.forEach(([wx, wz], idx) => {
        _dummyObj.position.set(wx, 0.32, wz);
        _dummyObj.rotation.set(0, 0, 0);
        _dummyObj.scale.set(1, 1, 1);
        _dummyObj.updateMatrix();
        wheelsInst.setMatrixAt(idx, _dummyObj.matrix);
      });
      wheelsInst.instanceMatrix.needsUpdate = true;
      wheelsInst.computeBoundingSphere();
      craneGroup.add(wheelsInst);

      const turretGeo = new THREE.CylinderGeometry(0.42, 0.54, 0.95, 14);
      turretGeo.translate(0, 1.16, 0);
      const jibCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, 1.45, -1.35),
        new THREE.Vector3(0, 2.15, 0),
        new THREE.Vector3(0, 3.35, 2.2),
      ]);
      const jibGeo = new THREE.TubeGeometry(jibCurve, 18, 0.1, 8, false);
      const lensPoints = [
        new THREE.Vector2(0.02, 0),
        new THREE.Vector2(0.11, 0.02),
        new THREE.Vector2(0.13, 0.25),
        new THREE.Vector2(0.16, 0.42),
        new THREE.Vector2(0.12, 0.44),
      ];
      const lensGeo = new THREE.LatheGeometry(lensPoints, 16);
      lensGeo.rotateX(Math.PI / 2);
      lensGeo.translate(0, 3.32, 2.62);
      const mergedCraneSteelGeo = mergeStaticParts([turretGeo, jibGeo, lensGeo]);
      const craneSteelMesh = new THREE.Mesh(mergedCraneSteelGeo, steelMat);
      craneSteelMesh.castShadow = true;
      craneSteelMesh.layers.enable(1);
      craneSteelMesh.userData.inspectInfo = {
        partId: 'pavilion-broadcast-crane',
        title: 'Articulated Broadcast Camera Jib',
        subtitle: 'Mobile 4-Wheel Telemetry Crane',
        materialSummary: 'Brushed Structural Steel · Roughness 0.28',
        focusPos: [11.2, 4.2, 8.2],
        focusTarget: [6.2, 2.4, 3.2],
      } satisfies InspectedPartInfo;
      craneGroup.add(craneSteelMesh);

      const counterWeight = new THREE.Mesh(
        new THREE.BoxGeometry(0.65, 0.42, 0.55),
        roofMat
      );
      counterWeight.position.set(0, 1.45, -1.42);
      const tallyLed = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 0.06, 0.06),
        accentGlowMat
      );
      tallyLed.position.set(0, 3.54, 2.52);
      craneGroup.add(counterWeight, tallyLed);

      const bollardCount = 16;
      const bollardGeo = new THREE.CylinderGeometry(0.09, 0.11, 0.95, 10);
      const bollardInst = new THREE.InstancedMesh(bollardGeo, steelMat, bollardCount);
      const capGeo = new THREE.CylinderGeometry(0.095, 0.095, 0.08, 10);
      const capInst = new THREE.InstancedMesh(capGeo, accentGlowMat, bollardCount);
      for (let i = 0; i < bollardCount; i++) {
        const angle = (i / bollardCount) * Math.PI * 2;
        const radius = 11.2;
        const bx = Math.cos(angle) * radius;
        const bz = Math.sin(angle) * radius;
        _dummyObj.position.set(bx, 0.475, bz);
        _dummyObj.rotation.set(0, 0, 0);
        _dummyObj.scale.set(1, 1, 1);
        _dummyObj.updateMatrix();
        bollardInst.setMatrixAt(i, _dummyObj.matrix);

        _dummyObj.position.set(bx, 0.96, bz);
        _dummyObj.updateMatrix();
        capInst.setMatrixAt(i, _dummyObj.matrix);
      }
      bollardInst.instanceMatrix.needsUpdate = true;
      capInst.instanceMatrix.needsUpdate = true;
      bollardInst.computeBoundingSphere();
      capInst.computeBoundingSphere();
      stageRoot.add(bollardInst, capInst);

      extraDisposables.push(chassisMat, tireMat, wheelGeo, bollardGeo, capGeo);

      if (initialWaypointsRef.current.length > 0) {
        sync3DWaypoints(initialWaypointsRef.current);
      }

      stageRenderer.compile(scene, camera);
      stageRenderer.shadowMap.needsUpdate = true;
      requestRender();
    }, 60);

    sceneApiRef.current = {
      setRigMode: (mode, jumpPreset) => {
        syncRigVisibility(mode);
        ([0, 1, 2] as StageSlotIndex[]).forEach((sIdx) => {
          bindTextureAcrossRigs(sIdx);
        });
        const p = jumpPreset ?? 'orbit';
        const cfg = RIG_CAMERA_PRESETS[mode][p];
        targetCamPos.set(...cfg.pos);
        targetLookAt.set(...cfg.target);
        cameraAnimating = true;
        setInspectedPart(null);
        requestRender();
      },
      setCameraPreset: (id) => {
        const cfg = RIG_CAMERA_PRESETS[currentRigMode][id];
        targetCamPos.set(...cfg.pos);
        targetLookAt.set(...cfg.target);
        cameraAnimating = true;
        requestRender();
      },
      focusWorldTarget: (pos, target) => {
        targetCamPos.set(...pos);
        targetLookAt.set(...target);
        cameraAnimating = true;
        requestRender();
      },
      setLightingMood: (id) => {
        const m = LIGHTING_MOODS[id];
        bgSkyColor.setHex(m.sky);
        sceneFog.color.setHex(m.sky);
        sceneFog.density = m.fogDensity;
        keyLight.color.setHex(m.keyColor);
        keyLight.intensity = m.keyIntensity;
        keyLight.position.set(...m.keyPos);
        hemiLight.color.setHex(m.hemiSky);
        hemiLight.groundColor.setHex(m.hemiGround);
        hemiLight.intensity = m.hemiIntensity;
        accentGlowMat.emissiveIntensity = m.beaconIntensity;
        softboxLights.forEach((light, idx) => {
          light.intensity = baseSoftboxIntensities[idx] * m.softboxScale;
        });
        stageRenderer.shadowMap.needsUpdate = true;
        requestRender();
      },
      setFinish: (id) => {
        const f = FINISH_PALETTES[id];
        _tmpColor.setHex(f.roof);
        roofMat.color.copy(_tmpColor);
        roofMat.metalness = f.metalness;
        roofMat.roughness = f.roughness;
        devicesRig.applyFinish(f.roof, f.metalness, f.roughness);
        foilCardRig.applyFinish(f.roof, f.metalness, f.roughness);
        customModelRig.applyFinish(f.roof, f.metalness, f.roughness);
        requestRender();
      },
      setExplode: (val) => {
        explodeTarget = val;
        requestRender();
      },
      setTurntable: (enabled, spinRateRadSec = 0.28) => {
        turntableActive = enabled;
        turntableRate = spinRateRadSec;
        requestRender();
      },
      setSlotMedia: (slot, media) => {
        const rt = slotRuntime[slot];
        const seq = ++rt.decodeSeq;
        rt.media = media;
        rt.uvOffset = media?.uvOffset ? [...media.uvOffset] : [0, 0];
        rt.uvScale = media?.uvScale ? [...media.uvScale] : [1, 1];

        if (!media) {
          disposeSlotBinding(slot);
          bindTextureAcrossRigs(slot);
          requestRender();
          return;
        }

        if (media.kind === 'video') {
          disposeSlotBinding(slot);
          const targetAspect = STAGE_RIG_META[currentRigMode].slotAspects[slot];
          rt.naturalAspect = media.aspectRatio || 16 / 9;
          rt.videoHandle = createLiveVideoTexture(
            media.src,
            maxAniso,
            targetAspect,
            rt.uvOffset,
            () => {
              if (disposed || seq !== rt.decodeSeq) return;
              if (rt.videoHandle?.video.videoWidth && rt.videoHandle.video.videoHeight) {
                rt.naturalAspect =
                  rt.videoHandle.video.videoWidth /
                  rt.videoHandle.video.videoHeight;
              }
              bindTextureAcrossRigs(slot);
              requestRender();
            }
          );
          bindTextureAcrossRigs(slot);
          requestRender();
          return;
        }

        void decodeStageScreenTexture(media.src, maxAniso)
          .then((loadedTex) => {
            if (disposed || seq !== rt.decodeSeq) {
              loadedTex.dispose();
              return;
            }
            disposeSlotBinding(slot);
            const img = loadedTex.image as
              | { width?: number; height?: number }
              | undefined;
            if (img?.width && img?.height) {
              rt.naturalAspect = img.width / img.height;
            } else {
              rt.naturalAspect =
                media.aspectRatio ||
                STAGE_RIG_META[currentRigMode].slotAspects[slot];
            }
            rt.customTex = loadedTex;
            bindTextureAcrossRigs(slot);
            requestRender();
          })
          .catch(() => {});
      },
      resetActiveSlotUV: (slot) => {
        const rt = slotRuntime[slot];
        rt.uvOffset = [0, 0];
        rt.uvScale = [1, 1];
        bindTextureAcrossRigs(slot);
        setUvNudged(false);
        requestRender();
      },
      setWaypoints: (stops) => {
        sync3DWaypoints(stops);
      },
      loadCustomGltf: async (data, fileName) => {
        const meta = await customModelRig.loadGltfFromBuffer(
          data,
          fileName,
          maxAniso
        );
        if (!disposed) {
          stageRenderer.shadowMap.needsUpdate = true;
          requestRender();
        }
        return meta;
      },
      clearCustomGltf: () => {
        const meta = customModelRig.clearCustomModel();
        stageRenderer.shadowMap.needsUpdate = true;
        requestRender();
        return meta;
      },
      setCustomAnimPlaying: (playing) => {
        customModelRig.setAnimationPlaying(playing);
        setCustomModelMeta(customModelRig.getMetadata());
        requestRender();
      },
      setPostConfig: (cfg) => {
        postPipeline.setConfig(cfg);
        requestRender();
      },
      syncQuality: (adaptive, manualTier, immersive) => {
        isImmersiveRef.current = immersive;
        const targetTier = adaptive ? governor.getTier() : manualTier;
        if (!adaptive) {
          governor.setTier(manualTier, performance.now());
        } else {
          governor.resetSamples();
        }
        applyTierToStage(targetTier, true);
        requestRender();
      },
      captureSnapshot: () => {
        if (postPipeline.isSupported) {
          postPipeline.render();
        } else {
          stageRenderer.render(scene, camera);
        }
        return stageRenderer.domElement.toDataURL('image/png');
      },
      getCanvasElement: () => stageRenderer.domElement,
    };

    // Re-apply active finish across rigs on mount/backend switch
    const activeFinish = FINISH_PALETTES[finishRef.current];
    roofMat.color.setHex(activeFinish.roof);
    roofMat.metalness = activeFinish.metalness;
    roofMat.roughness = activeFinish.roughness;
    devicesRig.applyFinish(
      activeFinish.roof,
      activeFinish.metalness,
      activeFinish.roughness
    );
    foilCardRig.applyFinish(
      activeFinish.roof,
      activeFinish.metalness,
      activeFinish.roughness
    );
    customModelRig.applyFinish(
      activeFinish.roof,
      activeFinish.metalness,
      activeFinish.roughness
    );

    // Re-hydrate any previously loaded custom GLB across backend switch
    if (loadedGlbAssetRef.current) {
      const { data, fileName } = loadedGlbAssetRef.current;
      void customModelRig
        .loadGltfFromBuffer(data, fileName, maxAniso)
        .then((meta) => {
          if (!disposed) {
            setCustomModelMeta(meta);
            stageRenderer.shadowMap.needsUpdate = true;
            requestRender();
          }
        })
        .catch(() => {});
    }

    // Hydrate current slots (or initial payload / legacy stagedImage) on mount & backend switch
    const liveSlots = slotMediaMapRef.current;
    const hasLiveSlots = Boolean(liveSlots[0] || liveSlots[1] || liveSlots[2]);
    if (hasLiveSlots) {
      ([0, 1, 2] as StageSlotIndex[]).forEach((sIdx) => {
        const m = liveSlots[sIdx] ?? null;
        if (m) sceneApiRef.current?.setSlotMedia(sIdx, m);
      });
    } else if (initialPayloadRef.current) {
      const p = initialPayloadRef.current;
      ([0, 1, 2] as StageSlotIndex[]).forEach((sIdx) => {
        const m = p.slots[sIdx] ?? null;
        if (m) sceneApiRef.current?.setSlotMedia(sIdx, m);
      });
      const focusCfg =
        p.rigMode === 'pavilion'
          ? RIG_CAMERA_PRESETS.pavilion.screen
          : RIG_CAMERA_PRESETS[p.rigMode].orbit;
      targetCamPos.set(...focusCfg.pos);
      targetLookAt.set(...focusCfg.target);
      cameraAnimating = true;
    } else if (initialStagedRef.current?.dataUrl) {
      sceneApiRef.current.setSlotMedia(0, {
        kind: 'image',
        src: initialStagedRef.current.dataUrl,
        label: initialStagedRef.current.label,
      });
      targetCamPos.set(...RIG_CAMERA_PRESETS.pavilion.screen.pos);
      targetLookAt.set(...RIG_CAMERA_PRESETS.pavilion.screen.target);
      cameraAnimating = true;
    }

    const ro = new ResizeObserver(() => {
      if (!container || disposed || resizeRafId !== 0) return;
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = 0;
        if (!container || disposed) return;
        const w = container.clientWidth || 800;
        const h = container.clientHeight || 500;
        const nextDpr = computeTierPixelRatio(
          currentAppliedTier,
          isImmersiveRef.current,
          isSoftwareGl
        );
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        stageRenderer.setPixelRatio(nextDpr);
        stageRenderer.setSize(w, h);
        postPipeline.setSize(w, h, nextDpr);
        requestRender();
      });
    });
    ro.observe(container);

    requestRender();

    teardownScene = () => {
      stopWebmRef.current?.();
      cancelIdleHydration();
      cancelSoftwareWait?.();
      if (rafId) cancelAnimationFrame(rafId);
      if (resizeRafId) cancelAnimationFrame(resizeRafId);
      ro.disconnect();
      window.removeEventListener('gamepadconnected', onGamepadConnected);
      window.removeEventListener('gamepaddisconnected', onGamepadDisconnected);
      stageRenderer.domElement.removeEventListener('pointerdown', onCanvasPointerDown);
      stageRenderer.domElement.removeEventListener('pointermove', onCanvasPointerMove);
      stageRenderer.domElement.removeEventListener('pointerup', onCanvasPointerUp);
      stageRenderer.domElement.removeEventListener(
        'webglcontextlost',
        handleContextLost,
        false
      );
      stageRenderer.domElement.removeEventListener(
        'webglcontextrestored',
        handleContextRestored,
        false
      );
      controls.dispose();
      postPipeline.dispose();
      envTarget?.dispose();
      contactTex.dispose();
      concreteTex?.dispose();
      cedarTex?.dispose();
      defaultScreenTex?.dispose();
      disposeSlotBinding(0);
      disposeSlotBinding(1);
      disposeSlotBinding(2);
      devicesRig.dispose();
      foilCardRig.dispose();
      customModelRig.dispose();
      for (const item of extraDisposables) {
        item.dispose();
      }
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach((m) => m.dispose());
        }
      });
      stageRenderer.dispose();
      sceneApiRef.current = null;
    };
    };

    void mountStageAsync();

    return () => {
      disposed = true;
      teardownScene?.();
      teardownScene = null;
    };
  }, [preferredBackend]);

  // Sync cross-studio `stagedPayload` updates (Client Mockup Devices, Foil Cards, Live Video Plates)
  useEffect(() => {
    if (!stagedPayload) return;
    setRigMode(stagedPayload.rigMode);
    setActiveSlot(stagedPayload.activeSlot);
    setSlotMediaMap(stagedPayload.slots);
    const jumpPreset: CameraPresetId =
      stagedPayload.rigMode === 'pavilion' ? 'screen' : 'orbit';
    setPreset(jumpPreset);
    sceneApiRef.current?.setRigMode(stagedPayload.rigMode, jumpPreset);
    ([0, 1, 2] as StageSlotIndex[]).forEach((sIdx) => {
      sceneApiRef.current?.setSlotMedia(sIdx, stagedPayload.slots[sIdx] ?? null);
    });
  }, [stagedPayload]);

  // Backward-compatible sync for legacy `stagedImage` transfers from Media Lab Image Studio
  useEffect(() => {
    if (!stagedImage?.dataUrl) return;
    const media: StageSlotMedia = {
      kind: 'image',
      src: stagedImage.dataUrl,
      label: stagedImage.label,
    };
    setSlotMediaMap((prev) => ({ ...prev, [activeSlotRef.current]: media }));
    sceneApiRef.current?.setSlotMedia(activeSlotRef.current, media);
    if (rigModeRef.current === 'pavilion' && activeSlotRef.current === 0) {
      setPreset('screen');
      sceneApiRef.current?.setCameraPreset('screen');
    }
  }, [stagedImage?.dataUrl, stagedImage?.label]);

  useEffect(() => {
    initialWaypointsRef.current = waypoints;
    sceneApiRef.current?.setWaypoints(waypoints);
  }, [waypoints]);

  useEffect(() => {
    sceneApiRef.current?.syncQuality(
      effectiveAdaptive,
      manualQualityTier,
      isImmersiveMode
    );
  }, [effectiveAdaptive, manualQualityTier, isImmersiveMode]);

  useEffect(() => {
    if (isImmersiveMode) {
      setDockOpen(false);
    } else if (!isSpatialDisplayUrl()) {
      setDockOpen(true);
    }
  }, [isImmersiveMode]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isImmersiveRef.current) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'h' || e.key === 'H') {
        setDockOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleSelectRigMode = (nextMode: StageRigMode) => {
    setRigMode(nextMode);
    setPreset('orbit');
    sceneApiRef.current?.setRigMode(nextMode, 'orbit');
  };

  const handleUploadMediaFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (file.type.startsWith('video/')) {
      const blobUrl = URL.createObjectURL(file);
      const vidMedia: StageSlotMedia = {
        kind: 'video',
        src: blobUrl,
        label: file.name,
      };
      const nextSlots = { ...slotMediaMap, [activeSlot]: vidMedia };
      setSlotMediaMap(nextSlots);
      sceneApiRef.current?.setSlotMedia(activeSlot, vidMedia);
      onUpdateStagedPayload?.({
        id: `vid_${Date.now()}`,
        rigMode,
        activeSlot,
        slots: nextSlots,
      });
      return;
    }

    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      const imgMedia: StageSlotMedia = {
        kind: 'image',
        src: reader.result,
        label: file.name,
      };
      const nextSlots = { ...slotMediaMap, [activeSlot]: imgMedia };
      setSlotMediaMap(nextSlots);
      sceneApiRef.current?.setSlotMedia(activeSlot, imgMedia);
      if (activeSlot === 0 && onUploadStagedImage) {
        onUploadStagedImage({ dataUrl: reader.result, label: file.name });
      }
      onUpdateStagedPayload?.({
        id: `img_${Date.now()}`,
        rigMode,
        activeSlot,
        slots: nextSlots,
      });
    };
    reader.readAsDataURL(file);
  };

  const handleClearActiveSlot = () => {
    const nextSlots = { ...slotMediaMap };
    delete nextSlots[activeSlot];
    setSlotMediaMap(nextSlots);
    sceneApiRef.current?.setSlotMedia(activeSlot, null);
    if (activeSlot === 0) {
      onClearStagedImage?.();
    }
  };

  const handleSelectPreset = (id: CameraPresetId) => {
    setPreset(id);
    sceneApiRef.current?.setCameraPreset(id);
  };

  const handleSelectMood = (id: LightingMoodId) => {
    setMood(id);
    sceneApiRef.current?.setLightingMood(id);
  };

  const handleSelectFinish = (id: FinishId) => {
    setFinish(id);
    sceneApiRef.current?.setFinish(id);
  };

  const handleExplodeChange = (val: number) => {
    setExplodePct(val);
    sceneApiRef.current?.setExplode(val / 100);
  };

  const handleToggleTurntable = () => {
    setTurntable((prev) => {
      const next = !prev;
      sceneApiRef.current?.setTurntable(next, 0.28);
      return next;
    });
  };

  const handleSnapshot = () => {
    const dataUrl = sceneApiRef.current?.captureSnapshot();
    if (!dataUrl) return;
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `dispatch-3d-${rigMode}-${Date.now()}.png`;
    link.click();
  };

  const handleSaveToClientPitch = () => {
    if (!onSaveSnapshotToPitch) return;
    const dataUrl = sceneApiRef.current?.captureSnapshot();
    if (!dataUrl) return;
    const activeMediaLabel =
      slotMediaMap[0]?.label || STAGE_RIG_META[rigMode].label;
    onSaveSnapshotToPitch(dataUrl, activeMediaLabel);
    setPitchSavedFlash(true);
    window.setTimeout(() => setPitchSavedFlash(false), 2200);
  };

  const handleRecord60FpsWebM = async () => {
    if (isRecordingWebm) {
      stopWebmRef.current?.();
      return;
    }
    const canvas = sceneApiRef.current?.getCanvasElement();
    if (!canvas) return;

    const wasSpinning = turntable;
    setIsRecordingWebm(true);
    setRecordProgressPct(0);
    // Exact 360-degree revolution over 6.0 seconds: (2 * PI) / 6 rad/s
    sceneApiRef.current?.setTurntable(true, (Math.PI * 2) / 6);

    const { stopEarly, promise } = recordCanvasTurntableWebM(
      canvas,
      6000,
      (pct) => setRecordProgressPct(pct)
    );
    stopWebmRef.current = stopEarly;

    try {
      const res = await promise;
      const a = document.createElement('a');
      a.href = res.blobUrl;
      a.download = res.filename;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(res.blobUrl), 15_000);
    } catch {
      // Ignore user cancellation or unsupported browser codec
    } finally {
      stopWebmRef.current = null;
      setIsRecordingWebm(false);
      setRecordProgressPct(0);
      sceneApiRef.current?.setTurntable(wasSpinning, 0.28);
    }
  };

  const handleCopySecondScreenUrl = async () => {
    try {
      await navigator.clipboard.writeText(buildSpatialDisplayUrl());
      setSecondScreenCopied(true);
      window.setTimeout(() => setSecondScreenCopied(false), 2200);
    } catch {
      // Clipboard blocked in restricted context
    }
  };

  const handleImportGlbFile = async (file: File) => {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.glb') && !lower.endsWith('.gltf')) {
      setCustomModelError('Please choose a .glb or embedded .gltf 3D model file.');
      return;
    }

    setCustomModelError(null);
    setIsLoadingGlb(true);
    try {
      const data: ArrayBuffer | string = lower.endsWith('.gltf')
        ? await file.text()
        : await file.arrayBuffer();

      loadedGlbAssetRef.current = { data, fileName: file.name };

      if (rigModeRef.current !== 'customModel') {
        setRigMode('customModel');
        setPreset('orbit');
        sceneApiRef.current?.setRigMode('customModel', 'orbit');
      }

      if (sceneApiRef.current) {
        const meta = await sceneApiRef.current.loadCustomGltf(data, file.name);
        setCustomModelMeta(meta);
        setInspectedPart(null);
      }
    } catch (err) {
      setCustomModelError(
        err instanceof Error
          ? err.message
          : 'Could not parse 3D model. Ensure textures are embedded in the .glb/.gltf.'
      );
    } finally {
      setIsLoadingGlb(false);
    }
  };

  const handleGlbInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) {
      void handleImportGlbFile(file);
    }
  };

  const handleResetCustomGlb = () => {
    loadedGlbAssetRef.current = null;
    setCustomModelError(null);
    if (sceneApiRef.current) {
      setCustomModelMeta(sceneApiRef.current.clearCustomGltf());
      setInspectedPart(null);
    }
  };

  const handleToggleCustomAnim = () => {
    if (!customModelMeta) return;
    sceneApiRef.current?.setCustomAnimPlaying(!customModelMeta.isPlayingAnimation);
  };

  const handleUpdatePostConfig = (patch: Partial<PostProcessingConfig>) => {
    setPostConfig((prev) => {
      const next = { ...prev, ...patch };
      postConfigRef.current = next;
      sceneApiRef.current?.setPostConfig(next);
      return next;
    });
  };

  const handleToggleRendererBackend = () => {
    setBackendNotice(null);
    setPreferredBackend((prev) => (prev === 'webgpu' ? 'webgl2' : 'webgpu'));
  };

  const handleViewportDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault();
      if (!isDraggingGlb) setIsDraggingGlb(true);
    }
  };

  const handleViewportDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget === e.target) {
      setIsDraggingGlb(false);
    }
  };

  const handleViewportDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingGlb(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.glb') || lower.endsWith('.gltf')) {
      void handleImportGlbFile(file);
    }
  };

  const activeRigMeta = STAGE_RIG_META[rigMode];
  const currentPresets = RIG_CAMERA_PRESETS[rigMode];
  const activeSlotMedia = slotMediaMap[activeSlot] ?? null;

  return (
    <div
      onDragOver={handleViewportDragOver}
      onDragLeave={handleViewportDragLeave}
      onDrop={handleViewportDrop}
      className={`relative w-full bg-[#0B0D10] overflow-hidden select-none ${
        isImmersiveMode
          ? 'h-full min-h-screen'
          : 'h-[calc(100vh-8.5rem)] min-h-[560px]'
      }`}
    >
      {/* Isolated WebGL2 / WebGPU Canvas Mount */}
      <div ref={mountRef} className="w-full h-full" />

      {/* Drag-and-Drop .GLB / .GLTF Overlay */}
      {isDraggingGlb && (
        <div className="pointer-events-none absolute inset-3 rounded-xl border-2 border-dashed border-[#22D3EE] bg-[#0B0D10]/85 flex items-center justify-center z-40">
          <div className="text-center space-y-1.5">
            <Cuboid className="w-7 h-7 text-[#22D3EE] mx-auto" />
            <p className="text-sm font-semibold text-[#F5F7FA]">
              Drop .GLB or .GLTF 3D Model
            </p>
            <p className="text-xs text-[#9FB0C4]">
              Auto-centers, scales to the studio plinth, and enables part raycasting
            </p>
          </div>
        </div>
      )}

      {/* WebGL Context Lost Recovery Banner */}
      {contextLost && (
        <div className="absolute inset-0 bg-[#0B0D10]/90 flex items-center justify-center p-6 z-20">
          <div className="max-w-sm bg-[#13161C] border border-amber-400/45 rounded-xl p-5 text-center space-y-2">
            <AlertTriangle className="w-6 h-6 text-amber-400 mx-auto" />
            <h3 className="text-sm font-semibold text-[#F5F7FA]">
              3D Graphics Context Paused
            </h3>
            <p className="text-xs text-[#8C96A8]">
              Waiting for the browser WebGL context to restore automatically.
            </p>
          </div>
        </div>
      )}

      {/* Top Title Lockup, Raycast Part Inspector & Export Actions (hidden in Full-Screen Immersive Mode) */}
      {!isImmersiveMode && (
        <>
          <div className="pointer-events-none absolute top-4 left-5 z-20 max-w-md space-y-2">
            <div>
              <div className="flex items-center gap-2 text-[11px] text-[#67E8F9] font-medium flex-wrap">
                <span>Interactive 3D Stage</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono text-[#9FB0C4] tabular-nums">
                  {activeBackend === 'webgpu'
                    ? `WebGPU Live${capabilities ? ` (${capabilities.maxBufferSizeMb}MB)` : ''}`
                    : capabilities?.webgpuSupported
                      ? `WebGL2 · WebGPU Ready (${capabilities.maxBufferSizeMb}MB)`
                      : `WebGL2${capabilities ? ` (${capabilities.maxAnisotropy}x Aniso)` : ''}`}
                </span>
                {postSupported && postConfig.enabled && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono text-[#9FB0C4]">
                      FX: {postConfig.aoEnabled ? 'GTAO + Bloom' : 'Bloom'}
                    </span>
                  </>
                )}
                {gamepadConnected && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1 text-emerald-300">
                      <Gamepad2 className="w-3 h-3" aria-hidden="true" />
                      Controller Active
                    </span>
                  </>
                )}
              </div>
              <h2 className="font-serif text-lg text-[#F5F7FA] mt-0.5">
                {activeRigMeta.heading}
              </h2>
              {rigMode === 'customModel' && customModelMeta ? (
                <p className="text-[11px] text-[#9FB0C4] mt-0.5 font-mono tabular-nums truncate max-w-[360px]">
                  {customModelMeta.fileName} · {customModelMeta.meshCount} meshes ·{' '}
                  {customModelMeta.triangleCount.toLocaleString()} tris
                </p>
              ) : activeSlotMedia ? (
                <p className="text-[11px] text-[#9FB0C4] mt-0.5 truncate max-w-[320px]">
                  Slot {activeSlot + 1}: {activeSlotMedia.label}
                  {activeSlotMedia.kind === 'video' ? ' (Live Video)' : ''}
                </p>
              ) : null}
              {backendNotice && (
                <p className="text-[11px] text-amber-300 mt-0.5">
                  {backendNotice}
                </p>
              )}
              {customModelError && (
                <p className="text-[11px] text-rose-300 mt-0.5">
                  {customModelError}
                </p>
              )}
            </div>

            {/* Compact Non-Occluding Raycast Part Inspector Readout */}
            {inspectedPart && (
              <div className="pointer-events-auto bg-[#0E1116]/95 border border-[#22D3EE]/35 rounded-lg p-3 shadow-xl space-y-1.5 max-w-[330px]">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-[#F5F7FA] truncate">
                      {inspectedPart.title}
                    </p>
                    <p className="text-[11px] text-[#9FB0C4] truncate">
                      {inspectedPart.subtitle}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setInspectedPart(null)}
                    aria-label="Close part inspector"
                    className="p-0.5 text-[#8C96A8] hover:text-[#F5F7FA] cursor-pointer shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <p className="text-[11px] font-mono text-[#67E8F9] truncate">
                  {inspectedPart.materialSummary}
                </p>
                <div className="flex items-center gap-2 pt-0.5">
                  <button
                    type="button"
                    onClick={() =>
                      sceneApiRef.current?.focusWorldTarget(
                        inspectedPart.focusPos,
                        inspectedPart.focusTarget
                      )
                    }
                    className="h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-medium text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded cursor-pointer whitespace-nowrap"
                  >
                    <Crosshair className="w-3 h-3" aria-hidden="true" />
                    Focus Part
                  </button>
                  {typeof inspectedPart.slotIndex === 'number' && (
                    <span className="text-[11px] text-[#C7D0DF]">
                      Slot {inspectedPart.slotIndex + 1} Selected
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="absolute top-4 right-5 z-30 flex items-center gap-2 flex-wrap justify-end">
            <button
              type="button"
              onClick={() => void handleRecord60FpsWebM()}
              title="Record a smooth 6-second 360-degree 60fps WebM turntable video directly from the 3D canvas"
              className={`h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md whitespace-nowrap cursor-pointer border transition-colors ${
                isRecordingWebm
                  ? 'bg-amber-500/20 text-amber-200 border-amber-400/60'
                  : 'bg-[#0E1116] hover:bg-[#19202B] text-[#F5F7FA] border-[#22D3EE]/30'
              }`}
            >
              <Video className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
              {isRecordingWebm ? (
                <span className="font-mono tabular-nums">
                  Recording {recordProgressPct}% (Stop)
                </span>
              ) : (
                <span>Record 60fps Spin</span>
              )}
            </button>

            <button
              type="button"
              onClick={handleSnapshot}
              className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#0E1116] hover:bg-[#19202B] border border-[#22D3EE]/30 rounded-md whitespace-nowrap cursor-pointer"
            >
              <Camera className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
              Snapshot PNG
            </button>

            {onSaveSnapshotToPitch && (
              <button
                type="button"
                onClick={handleSaveToClientPitch}
                title="Save this 3D stage view into the Client Pitch Sheet & Site Mockup Media Collection"
                className={`h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md whitespace-nowrap cursor-pointer border transition-colors ${
                  pitchSavedFlash
                    ? 'bg-emerald-500/20 text-emerald-200 border-emerald-400/60'
                    : 'bg-[#0E1116] hover:bg-[#19202B] text-[#F5F7FA] border-white/15'
                }`}
              >
                {pitchSavedFlash ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-300" aria-hidden="true" />
                    Saved to Pitch
                  </>
                ) : (
                  <>
                    <FileCheck2 className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                    Save to Client Pitch
                  </>
                )}
              </button>
            )}

            <button
              type="button"
              onClick={() => void handleCopySecondScreenUrl()}
              title="Copy clean Second-Screen 3D Display URL synced live via local BroadcastChannel"
              className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#C7D0DF] bg-[#0E1116] hover:bg-[#19202B] border border-white/15 rounded-md whitespace-nowrap cursor-pointer"
            >
              {secondScreenCopied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-300" aria-hidden="true" />
                  2nd Screen Copied
                </>
              ) : (
                <>
                  <MonitorUp className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                  2nd Screen Sync
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => setDockOpen((v) => !v)}
              className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#C7D0DF] bg-[#0E1116] hover:bg-[#19202B] border border-white/15 rounded-md whitespace-nowrap cursor-pointer"
            >
              <SlidersHorizontal className="w-3.5 h-3.5 text-[#22D3EE]" />
              Stage Controls
              {dockOpen ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronUp className="w-3.5 h-3.5" />
              )}
            </button>

            {onToggleImmersiveMode && (
              <button
                type="button"
                onClick={onToggleImmersiveMode}
                className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-semibold rounded-md whitespace-nowrap transition-colors cursor-pointer bg-[#0E1116] text-[#67E8F9] hover:bg-[#19202B] border border-[#22D3EE]/45"
              >
                <Maximize2 className="w-3.5 h-3.5" aria-hidden="true" />
                Full Screen
              </button>
            )}
          </div>
        </>
      )}

      {/* Unified Collapsible Bottom Control Dock (Zero Side-Panel Clutter; Zero backdrop-filter over WebGL) */}
      {!isImmersiveMode && dockOpen && (
        <div className="absolute left-4 right-4 bottom-4 mx-auto max-w-6xl bg-[#0D1017]/95 border border-[#22D3EE]/30 rounded-xl px-4 py-3 space-y-2.5 z-20 shadow-2xl">
          {/* Row 1: 3D Rig Switcher + GLB Model Import + 3 Addressable Media/Video Slots */}
          <div className="flex flex-wrap items-center justify-between gap-2.5 pb-2.5 border-b border-white/10">
            {/* Showcase Rig Selector */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] font-medium text-[#8C96A8] mr-1">
                Rig
              </span>
              {(
                [
                  { id: 'pavilion', label: 'Broadcast Pavilion', icon: Box },
                  { id: 'devices', label: 'Laptop & Phone', icon: Laptop },
                  { id: 'foilCard', label: 'Holographic Foil Card', icon: Sparkles },
                  { id: 'customModel', label: 'Custom GLB', icon: Cuboid },
                ] as const
              ).map((item) => {
                const Icon = item.icon;
                const active = rigMode === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleSelectRigMode(item.id)}
                    className={`h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium rounded-md whitespace-nowrap cursor-pointer transition-colors ${
                      active
                        ? 'bg-[#22D3EE] text-[#071318] font-semibold'
                        : 'bg-[#161B24] text-[#C7D0DF] hover:text-[#F5F7FA]'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                    {item.label}
                  </button>
                );
              })}
            </div>

            {/* Custom GLB Controls OR Multi-Slot UV Target Selector */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {rigMode === 'customModel' ? (
                <>
                  <label
                    title="Import a local .glb or embedded .gltf 3D model onto the showcase plinth"
                    className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border bg-[#22D3EE]/15 border-[#22D3EE]/60 text-[#67E8F9] hover:border-[#22D3EE] whitespace-nowrap cursor-pointer"
                  >
                    <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                    {isLoadingGlb ? 'Loading GLB...' : 'Import .GLB / .GLTF'}
                    <input
                      type="file"
                      accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
                      onChange={handleGlbInputChange}
                      className="sr-only"
                    />
                  </label>

                  {customModelMeta && customModelMeta.animationCount > 0 && (
                    <button
                      type="button"
                      onClick={handleToggleCustomAnim}
                      title="Play or pause built-in 3D animation"
                      className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs rounded-md border bg-[#161B24] border-white/15 text-[#C7D0DF] hover:text-[#F5F7FA] whitespace-nowrap cursor-pointer"
                    >
                      {customModelMeta.isPlayingAnimation ? (
                        <>
                          <Pause className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                          Pause Motion
                        </>
                      ) : (
                        <>
                          <Play className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                          Play Motion
                        </>
                      )}
                    </button>
                  )}

                  {customModelMeta && !customModelMeta.isDefaultArtifact && (
                    <button
                      type="button"
                      onClick={handleResetCustomGlb}
                      title="Clear imported model and restore calibration gimbal"
                      className="h-8 px-2.5 inline-flex items-center gap-1 text-xs rounded-md border bg-[#161B24] border-white/15 text-[#9FB0C4] hover:text-[#F5F7FA] whitespace-nowrap cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3 text-[#22D3EE]" aria-hidden="true" />
                      Reset Asset
                    </button>
                  )}
                </>
              ) : (
                <>
                  <Layers className="w-3.5 h-3.5 text-[#67E8F9] mr-0.5" aria-hidden="true" />
                  {([0, 1, 2] as StageSlotIndex[]).map((slotIdx) => {
                    const slotMedia = slotMediaMap[slotIdx];
                    const isSelected = activeSlot === slotIdx;
                    return (
                      <button
                        key={slotIdx}
                        type="button"
                        onClick={() => setActiveSlot(slotIdx)}
                        title={activeRigMeta.slotLabels[slotIdx]}
                        className={`h-8 px-2.5 inline-flex items-center gap-1.5 text-xs rounded-md whitespace-nowrap cursor-pointer border transition-colors ${
                          isSelected
                            ? 'bg-[#22D3EE]/20 border-[#22D3EE] text-[#F5F7FA] font-semibold'
                            : 'bg-[#161B24] border-white/10 text-[#9FB0C4] hover:text-[#F5F7FA]'
                        }`}
                      >
                        <span className="font-mono text-[11px] tabular-nums text-[#67E8F9]">
                          S{slotIdx + 1}
                        </span>
                        <span>{activeRigMeta.slotLabels[slotIdx].split(' (')[0]}</span>
                        {slotMedia?.kind === 'video' && (
                          <Film className="w-3 h-3 text-amber-300" aria-hidden="true" />
                        )}
                      </button>
                    );
                  })}

                  <label
                    title="Wrap an image or looping MP4/WebM video onto the selected 3D surface slot"
                    className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs rounded-md border bg-[#161B24] border-[#22D3EE]/35 text-[#67E8F9] hover:border-[#22D3EE] whitespace-nowrap cursor-pointer"
                  >
                    <ImagePlus className="w-3.5 h-3.5" aria-hidden="true" />
                    Wrap Image / Video
                    <input
                      type="file"
                      accept="image/*,video/mp4,video/webm"
                      onChange={handleUploadMediaFile}
                      className="sr-only"
                    />
                  </label>

                  <label
                    title="Import a local .glb or .gltf 3D model onto the studio plinth"
                    className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs rounded-md border bg-[#161B24] border-white/15 text-[#C7D0DF] hover:border-[#22D3EE]/60 hover:text-[#F5F7FA] whitespace-nowrap cursor-pointer"
                  >
                    <Upload className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                    Import .GLB
                    <input
                      type="file"
                      accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
                      onChange={handleGlbInputChange}
                      className="sr-only"
                    />
                  </label>

                  {uvNudged && (
                    <button
                      type="button"
                      onClick={() => sceneApiRef.current?.resetActiveSlotUV(activeSlot)}
                      title="Reset UV pan offset on active slot"
                      className="h-8 px-2 inline-flex items-center gap-1 text-xs rounded-md border bg-[#161B24] border-white/15 text-[#C7D0DF] hover:text-[#F5F7FA] whitespace-nowrap cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3 text-[#22D3EE]" aria-hidden="true" />
                      Reset UV
                    </button>
                  )}

                  {activeSlotMedia && (
                    <button
                      type="button"
                      title={`Clear Slot ${activeSlot + 1} media`}
                      onClick={handleClearActiveSlot}
                      className="w-8 h-8 inline-flex items-center justify-center rounded-md border bg-[#161B24] border-white/15 text-[#8C96A8] hover:text-[#F5F7FA] cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Row 2: Camera Presets, Explode, Lighting, Finishes, Post-FX, WebGPU Engine & Adaptive Quality */}
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            {/* Camera Presets */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] font-medium text-[#8C96A8] mr-1">
                Camera
              </span>
              {(Object.keys(currentPresets) as CameraPresetId[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => handleSelectPreset(id)}
                  className={`h-8 px-2.5 text-xs font-medium rounded-md whitespace-nowrap cursor-pointer transition-colors ${
                    preset === id
                      ? 'bg-[#22D3EE] text-[#071318]'
                      : 'bg-[#161B24] text-[#C7D0DF] hover:text-[#F5F7FA]'
                  }`}
                >
                  {currentPresets[id].label}
                </button>
              ))}
            </div>

            {/* Explode Slider */}
            <div className="flex items-center gap-2 min-w-[140px]">
              <label
                htmlFor="explode-range"
                className="text-[11px] font-medium text-[#8C96A8] whitespace-nowrap"
              >
                Explode
              </label>
              <input
                id="explode-range"
                type="range"
                min={0}
                max={100}
                value={explodePct}
                onChange={(e) => handleExplodeChange(Number(e.target.value))}
                className="w-16 accent-[#22D3EE] cursor-pointer"
              />
              <span className="text-xs font-mono tabular-nums text-[#67E8F9] w-8 text-right">
                {explodePct}%
              </span>
            </div>

            {/* Lighting Moods */}
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-medium text-[#8C96A8] mr-0.5">
                Light
              </span>
              {(Object.keys(LIGHTING_MOODS) as LightingMoodId[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => handleSelectMood(id)}
                  className={`h-8 px-2 text-xs rounded-md whitespace-nowrap cursor-pointer ${
                    mood === id
                      ? 'bg-[#22D3EE]/20 text-[#67E8F9] border border-[#22D3EE]/45'
                      : 'bg-[#161B24] text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                  }`}
                >
                  {LIGHTING_MOODS[id].label.split(' ')[0]}
                </button>
              ))}
            </div>

            {/* Finish Swatches, Studio Post-FX, WebGPU Backend, Spin & Adaptive Quality */}
            <div className="flex items-center gap-2 flex-wrap">
              {(
                [
                  { id: 'slate', bgClass: 'bg-[#2C3442]' },
                  { id: 'cedar', bgClass: 'bg-[#9A633E]' },
                  { id: 'titanium', bgClass: 'bg-[#7A889B]' },
                ] as const
              ).map((swatch) => (
                <button
                  key={swatch.id}
                  type="button"
                  title={FINISH_PALETTES[swatch.id].label}
                  onClick={() => handleSelectFinish(swatch.id)}
                  className={`w-6 h-6 rounded-full border-2 cursor-pointer transition-transform ${swatch.bgClass} ${
                    finish === swatch.id ? 'border-[#22D3EE] scale-110' : 'border-white/25'
                  }`}
                />
              ))}

              {/* Studio Post-Processing Controls (Bloom + GTAO Contact Grounding) */}
              {postSupported && (
                <div className="flex items-center gap-1.5 pl-1 border-l border-white/10">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={postConfig.enabled}
                    onClick={() =>
                      handleUpdatePostConfig({ enabled: !postConfig.enabled })
                    }
                    title="Toggle Studio Post-Processing (Selective HDR Bloom + GTAO Contact Grounding + ACES Output)"
                    className={`h-8 px-2 inline-flex items-center gap-1 text-xs rounded-md border whitespace-nowrap cursor-pointer transition-colors ${
                      postConfig.enabled
                        ? 'bg-[#22D3EE]/20 border-[#22D3EE]/50 text-[#67E8F9]'
                        : 'bg-[#161B24] border-white/10 text-[#8C96A8] hover:text-[#F5F7FA]'
                    }`}
                  >
                    <SunMedium className="w-3.5 h-3.5" aria-hidden="true" />
                    FX
                  </button>

                  {postConfig.enabled && (
                    <>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={postConfig.aoEnabled}
                        onClick={() =>
                          handleUpdatePostConfig({ aoEnabled: !postConfig.aoEnabled })
                        }
                        title="Toggle Ground-Truth Ambient Occlusion (GTAO) contact shadows"
                        className={`h-8 px-2 text-xs font-mono rounded-md border whitespace-nowrap cursor-pointer transition-colors ${
                          postConfig.aoEnabled
                            ? 'bg-[#22D3EE]/20 border-[#22D3EE]/50 text-[#67E8F9]'
                            : 'bg-[#161B24] border-white/10 text-[#8C96A8] hover:text-[#F5F7FA]'
                        }`}
                      >
                        AO
                      </button>

                      <div className="flex items-center gap-1.5">
                        <label
                          htmlFor="bloom-range"
                          className="text-[11px] text-[#8C96A8] whitespace-nowrap"
                        >
                          Bloom
                        </label>
                        <input
                          id="bloom-range"
                          type="range"
                          min={0}
                          max={100}
                          value={Math.round(postConfig.bloomStrength * 100)}
                          onChange={(e) =>
                            handleUpdatePostConfig({
                              bloomStrength: Number(e.target.value) / 100,
                            })
                          }
                          className="w-14 accent-[#22D3EE] cursor-pointer"
                        />
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Live WebGPU / WebGL2 Backend Switcher */}
              <button
                type="button"
                disabled={isSwitchingBackend}
                onClick={handleToggleRendererBackend}
                title={
                  activeBackend === 'webgpu'
                    ? 'Running on live Three.js WebGPURenderer — click to switch back to WebGL2'
                    : capabilities?.webgpuSupported
                      ? 'Switch live 3D engine to Three.js WebGPURenderer (automatic WebGL2 fallback if unavailable)'
                      : 'Attempt WebGPURenderer (falls back cleanly to WebGL2 when unsupported)'
                }
                className={`h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-mono rounded-md border whitespace-nowrap cursor-pointer transition-colors disabled:opacity-50 ${
                  activeBackend === 'webgpu'
                    ? 'bg-emerald-500/20 border-emerald-400/60 text-emerald-200'
                    : 'bg-[#161B24] border-white/10 text-[#C7D0DF] hover:border-[#22D3EE]/50 hover:text-[#67E8F9]'
                }`}
              >
                <Cpu className="w-3.5 h-3.5" aria-hidden="true" />
                <span>
                  {isSwitchingBackend
                    ? 'Switching...'
                    : activeBackend === 'webgpu'
                      ? 'WebGPU'
                      : 'WebGL2'}
                </span>
              </button>

              <button
                type="button"
                onClick={handleToggleTurntable}
                className={`h-8 px-2.5 inline-flex items-center gap-1 text-xs rounded-md border whitespace-nowrap cursor-pointer ${
                  turntable
                    ? 'bg-[#22D3EE]/20 border-[#22D3EE]/50 text-[#67E8F9]'
                    : 'bg-[#161B24] border-white/10 text-[#8C96A8] hover:text-[#F5F7FA]'
                }`}
              >
                <RotateCw className="w-3.5 h-3.5" />
                Spin
              </button>

              <button
                type="button"
                role="switch"
                aria-checked={effectiveAdaptive}
                onClick={() => {
                  if (onToggleAdaptiveQuality) {
                    onToggleAdaptiveQuality();
                  } else {
                    setLocalAdaptive((prev) => !prev);
                  }
                }}
                title="Automatically adjust 3D resolution and shadow detail based on frame rate"
                className={`h-8 px-2.5 inline-flex items-center gap-1.5 text-xs rounded-md border whitespace-nowrap cursor-pointer transition-colors ${
                  effectiveAdaptive
                    ? 'bg-[#22D3EE]/20 border-[#22D3EE]/50 text-[#67E8F9]'
                    : 'bg-[#161B24] border-white/10 text-[#8C96A8] hover:text-[#F5F7FA]'
                }`}
              >
                <Gauge className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Adaptive</span>
                <span className="font-mono text-[11px] tabular-nums">
                  {effectiveAdaptive
                    ? QUALITY_TIER_SPECS[activeTier].label
                    : QUALITY_TIER_SPECS[manualQualityTier].label}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
