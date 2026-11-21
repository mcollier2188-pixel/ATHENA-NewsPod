import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Compass,
  Gamepad2,
  Gauge,
  Headphones,
  MapPin,
  Maximize2,
  Minimize2,
  Navigation,
  Orbit,
  Pause,
  Play,
  RotateCcw,
  Trophy,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import type { AudioBriefing, NewsArticle } from '../types';
import type { RouteWaypoint } from '../services/routingService';
import {
  fetchDbGameScores,
  saveDbGameScore,
  type DbGameScoreEntry,
} from '../services/suiteApi';
import {
  AdaptiveFrameGovernor,
  QUALITY_TIER_SPECS,
  applyThreeSceneQuality,
  computeTierPixelRatio,
  type QualityTier,
} from '../utils/adaptiveQuality';
import {
  DispatchRunImmersivePanel,
  type CorridorCameraView,
  type CorridorLightingMode,
} from './DispatchRunImmersivePanel';
import { createWetAsphaltCorridorMaterial } from '../three/materials';
import { GamepadPoller } from '../three/gamepadRouter';
import {
  CorridorWaypointPhysicsWorld,
  type CorridorPhysicsMode,
} from '../three/corridorPhysics';

export type DispatchRunMode = 'explore' | 'arcade';
type GamePhase = 'title' | 'playing' | 'paused' | 'gameover' | 'victory';
type CheckpointRole = 'origin' | 'stop' | 'via' | 'destination' | 'chapter';

export interface JourneyCheckpoint {
  index: number;
  id: string;
  waypointId?: string;
  segmentIndex?: number;
  hasAudio: boolean;
  role: CheckpointRole;
  roleLabel: string;
  title: string;
  address?: string;
  chapterTitle: string;
  category: string;
  keyPoint: string;
  distanceMeters: number;
  cumulativeKm?: number;
  lat?: number;
  lng?: number;
}

export interface DispatchRunGameProps {
  briefing?: AudioBriefing | null;
  fallbackArticles?: NewsArticle[];
  waypoints?: RouteWaypoint[];
  focusedWaypointId?: string | null;
  onFocusWaypoint?: (waypointId: string) => void;
  onOpenMapPlanner?: (waypointId?: string) => void;
  isImmersiveMode?: boolean;
  onToggleImmersiveMode?: () => void;
  activeSegmentIndex?: number;
  isPlayingAudio?: boolean;
  onSelectBriefingSegment?: (segmentIndex: number) => void;
  onToggleBriefingAudio?: () => void;
  /** Automatically adjust Three.js pixel ratio & shadow detail based on live frame rate. */
  adaptiveQuality?: boolean;
  onToggleAdaptiveQuality?: () => void;
  manualQualityTier?: QualityTier;
  onActiveQualityTierChange?: (tier: QualityTier) => void;
}

interface HudSnapshot {
  score: number;
  capsules: number;
  distance: number;
  combo: number;
  bestCombo: number;
  shield: number;
  boostCharge: number;
  speedKmh: number;
  activeCheckpointIdx: number;
  clearedCheckpoints: number;
}

const INITIAL_HUD: HudSnapshot = {
  score: 0,
  capsules: 0,
  distance: 0,
  combo: 1,
  bestCombo: 1,
  shield: 3,
  boostCharge: 100,
  speedKmh: 145,
  activeCheckpointIdx: 0,
  clearedCheckpoints: 0,
};

const STEP_METERS = 500;
const FINISH_BUFFER_METERS = 180;
const METERS_PER_Z = 0.72;
const Z_PER_METER = 1 / METERS_PER_Z;
const LANE_WIDTH = 3.2;
const LANE_X = [-LANE_WIDTH, 0, LANE_WIDTH];
const MAX_VISIBLE_GATES = 6;

const CORRIDOR_LIGHTING_ORDER: readonly CorridorLightingMode[] = [
  'dusk',
  'daylight',
  'night',
];

const CORRIDOR_LIGHTING_PRESETS: Record<
  CorridorLightingMode,
  {
    sky: number;
    fogDensity: number;
    shelfColor: number;
    hemiSky: number;
    hemiGround: number;
    hemiIntensity: number;
    keyColor: number;
    keyIntensity: number;
    keyPos: [number, number, number];
    rimColor: number;
    rimIntensity: number;
    envIntensity: number;
    pylonEmissive: number;
    spineEmissive: number;
    hoverIntensity: number;
  }
> = {
  dusk: {
    sky: 0x090d16,
    fogDensity: 0.012,
    shelfColor: 0x070a12,
    hemiSky: 0x5ea2e8,
    hemiGround: 0x101420,
    hemiIntensity: 0.88,
    keyColor: 0xffd8b2,
    keyIntensity: 2.15,
    keyPos: [14, 24, 12],
    rimColor: 0x38bdf8,
    rimIntensity: 0.9,
    envIntensity: 0.7,
    pylonEmissive: 2.2,
    spineEmissive: 1.5,
    hoverIntensity: 2.2,
  },
  daylight: {
    sky: 0x1b2d42,
    fogDensity: 0.0085,
    shelfColor: 0x152233,
    hemiSky: 0xa6d4fa,
    hemiGround: 0x2c3747,
    hemiIntensity: 1.18,
    keyColor: 0xfff5e4,
    keyIntensity: 2.85,
    keyPos: [20, 30, 16],
    rimColor: 0x7dd3fc,
    rimIntensity: 0.65,
    envIntensity: 0.96,
    pylonEmissive: 1.05,
    spineEmissive: 0.85,
    hoverIntensity: 1.35,
  },
  night: {
    sky: 0x04070d,
    fogDensity: 0.0155,
    shelfColor: 0x03050a,
    hemiSky: 0x223b61,
    hemiGround: 0x060911,
    hemiIntensity: 0.42,
    keyColor: 0x8ec5ff,
    keyIntensity: 1.35,
    keyPos: [-14, 22, 10],
    rimColor: 0x22d3ee,
    rimIntensity: 1.28,
    envIntensity: 0.48,
    pylonEmissive: 3.0,
    spineEmissive: 2.15,
    hoverIntensity: 3.1,
  },
};

// Reusable module-scope math temporaries (zero per-frame GC allocations)
const _burstPos = new THREE.Vector3();
const _camLookTarget = new THREE.Vector3();

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface EditorialBeat {
  segmentIndex?: number;
  hasAudio: boolean;
  chapterTitle: string;
  category: string;
  keyPoint: string;
}

const DEFAULT_EDITORIAL_BEATS: EditorialBeat[] = [
  {
    hasAudio: false,
    chapterTitle: 'Opening Lead & Morning Context',
    category: 'Lead',
    keyPoint:
      'Build an audio briefing from the Article Desk or add map waypoints to anchor real-world stops along this 3D corridor.',
  },
  {
    hasAudio: false,
    chapterTitle: 'Core Analysis & Signal Synthesis',
    category: 'Analysis',
    keyPoint:
      'Each checkpoint archway pairs your planned route stopovers with key takeaways from your active briefing.',
  },
  {
    hasAudio: false,
    chapterTitle: 'Field Operations & Regional Outlook',
    category: 'Operations',
    keyPoint:
      'Jump directly between 3D checkpoints using the bottom navigator or switch to the Map Planner to adjust stops.',
  },
  {
    hasAudio: false,
    chapterTitle: 'Closing Takeaways & Next Actions',
    category: 'Wrap',
    keyPoint:
      'Complete the journey in scenic Explore mode or test your reflexes in Arcade Run to post a leaderboard score.',
  },
];

export function buildJourneyCheckpoints(
  waypoints: RouteWaypoint[],
  briefing: AudioBriefing | null | undefined,
  fallbackArticles: NewsArticle[] | undefined
): JourneyCheckpoint[] {
  const beats: EditorialBeat[] =
    briefing && briefing.segments.length > 0
      ? briefing.segments.map((seg, idx) => ({
          segmentIndex: idx,
          hasAudio: Boolean(seg.audioBase64),
          chapterTitle: seg.title,
          category: seg.category || 'Briefing',
          keyPoint:
            seg.keyPoint ||
            seg.lines[0]?.text ||
            briefing.takeaways[idx % Math.max(1, briefing.takeaways.length)] ||
            briefing.editionSubtitle,
        }))
      : fallbackArticles && fallbackArticles.length > 0
        ? (fallbackArticles.some((a) => a.selected)
            ? fallbackArticles.filter((a) => a.selected)
            : fallbackArticles
          )
            .slice(0, 8)
            .map((art) => ({
              hasAudio: false,
              chapterTitle: art.title,
              category: art.category || art.source || 'Source',
              keyPoint: art.keyFacts[0] || art.summary,
            }))
        : DEFAULT_EDITORIAL_BEATS;

  if (waypoints.length > 0) {
    let runningKm = 0;
    const mapped: JourneyCheckpoint[] = waypoints.map((wp, idx) => {
      if (idx > 0) {
        const prev = waypoints[idx - 1];
        runningKm += haversineKm(prev.lat, prev.lng, wp.lat, wp.lng);
      }
      const isOrigin = idx === 0;
      const isDest = idx === waypoints.length - 1 && waypoints.length > 1;
      const role: CheckpointRole = isOrigin
        ? 'origin'
        : isDest
          ? 'destination'
          : wp.via
            ? 'via'
            : 'stop';
      const roleLabel = isOrigin
        ? 'Origin'
        : isDest
          ? 'Destination'
          : wp.via
            ? 'Via Pass-Through'
            : `Stop ${idx}`;
      const beat = beats[idx % beats.length];

      return {
        index: idx,
        id: `cp-wp-${wp.id}`,
        waypointId: wp.id,
        segmentIndex: beat.segmentIndex,
        hasAudio: beat.hasAudio,
        role,
        roleLabel,
        title: wp.name,
        address: wp.address,
        chapterTitle: beat.chapterTitle,
        category: beat.category,
        keyPoint: beat.keyPoint,
        distanceMeters: (idx + 1) * STEP_METERS,
        cumulativeKm: Number(runningKm.toFixed(2)),
        lat: wp.lat,
        lng: wp.lng,
      };
    });

    // If only 1 starting pin is set, append remaining briefing chapters so the 3D journey stays multi-stage
    if (mapped.length === 1 && beats.length > 1) {
      const extraCount = Math.min(beats.length - 1, 3);
      for (let e = 1; e <= extraCount; e++) {
        const beat = beats[e];
        const isLast = e === extraCount;
        mapped.push({
          index: e,
          id: `cp-beat-${e}`,
          segmentIndex: beat.segmentIndex,
          hasAudio: beat.hasAudio,
          role: isLast ? 'destination' : 'chapter',
          roleLabel: isLast ? 'Final Chapter' : `Chapter ${e + 1}`,
          title: beat.chapterTitle,
          chapterTitle: briefing?.editionTitle || 'Active Briefing Journey',
          category: beat.category,
          keyPoint: beat.keyPoint,
          distanceMeters: (e + 1) * STEP_METERS,
        });
      }
    }

    return mapped;
  }

  return beats.map((beat, idx) => {
    const isOrigin = idx === 0;
    const isDest = idx === beats.length - 1 && beats.length > 1;
    return {
      index: idx,
      id: `cp-ch-${idx}`,
      segmentIndex: beat.segmentIndex,
      hasAudio: beat.hasAudio,
      role: isOrigin ? 'origin' : isDest ? 'destination' : 'chapter',
      roleLabel: `Chapter ${idx + 1}`,
      title: beat.chapterTitle,
      chapterTitle: briefing?.editionTitle || 'Briefing Corridor',
      category: beat.category,
      keyPoint: beat.keyPoint,
      distanceMeters: (idx + 1) * STEP_METERS,
    };
  });
}

// Lightweight Procedural Web Audio Synth SFX (zero external asset fetches)
class ArcadeSynthAudio {
  private ctx: AudioContext | null = null;
  public muted = false;

  private ensureCtx(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) return null;
      this.ctx = new Ctx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public playPickup(combo: number) {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    const baseFreq = 440 + Math.min(combo, 10) * 55;
    osc.frequency.setValueAtTime(baseFreq, now);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.48, now + 0.11);
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.15);
  }

  public playCheckpoint() {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const chord = [523.25, 783.99];
    chord.forEach((freq, i) => {
      const start = ctx.currentTime + i * 0.055;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.12, start + 0.18);
      gain.gain.setValueAtTime(0.11, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.24);
    });
  }

  public playBoost() {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(420, now + 0.22);
    gain.gain.setValueAtTime(0.09, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.26);
  }

  public playHit() {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(170, now);
    osc.frequency.exponentialRampToValueAtTime(48, now + 0.24);
    gain.gain.setValueAtTime(0.16, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.27);
  }

  private lastBounceAt = 0;

  public playFloorBounce(intensity = 1) {
    const nowMs = performance.now();
    if (nowMs - this.lastBounceAt < 65) return;
    this.lastBounceAt = nowMs;

    const ctx = this.ensureCtx();
    if (!ctx) return;
    const clamped = Math.max(0.35, Math.min(1.6, intensity));
    const now = ctx.currentTime;

    // 432Hz-referenced low-end stage floor impact thud + harmonic overtone
    const subOsc = ctx.createOscillator();
    const subGain = ctx.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(108 * clamped, now);
    subOsc.frequency.exponentialRampToValueAtTime(42, now + 0.14);
    subGain.gain.setValueAtTime(0.095 * Math.min(1.2, clamped), now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    subOsc.connect(subGain);
    subGain.connect(ctx.destination);
    subOsc.start(now);
    subOsc.stop(now + 0.17);

    const bellOsc = ctx.createOscillator();
    const bellGain = ctx.createGain();
    bellOsc.type = 'triangle';
    bellOsc.frequency.setValueAtTime(432 * (0.85 + clamped * 0.2), now);
    bellOsc.frequency.exponentialRampToValueAtTime(324, now + 0.09);
    bellGain.gain.setValueAtTime(0.04 * Math.min(1.1, clamped), now);
    bellGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    bellOsc.connect(bellGain);
    bellGain.connect(ctx.destination);
    bellOsc.start(now);
    bellOsc.stop(now + 0.11);
  }

  public playVictory() {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, idx) => {
      const now = ctx.currentTime + idx * 0.09;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.3);
    });
  }
}

function createRoadTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#111620';
    ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 2400; i++) {
      const x = ((i * 73) % 509) + 1;
      const y = ((i * 137) % 509) + 1;
      ctx.fillStyle = `rgba(255,255,255,${0.015 + (i % 5) * 0.006})`;
      ctx.fillRect(x, y, 2, 2);
    }
    // Outer cyan edge rails
    ctx.fillStyle = '#22D3EE';
    ctx.fillRect(14, 0, 8, 512);
    ctx.fillRect(490, 0, 8, 512);
    // Warm inner shoulder hairline
    ctx.fillStyle = 'rgba(245, 158, 11, 0.36)';
    ctx.fillRect(26, 0, 2, 512);
    ctx.fillRect(484, 0, 2, 512);
    // Dashed lane dividers (3 lanes)
    ctx.fillStyle = 'rgba(103, 232, 249, 0.52)';
    for (let y = 0; y < 512; y += 64) {
      ctx.fillRect(172, y, 6, 34);
      ctx.fillRect(334, y, 6, 34);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 14);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return tex;
}

function createContactShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(64, 64, 8, 64, 64, 60);
    grad.addColorStop(0, 'rgba(3, 7, 14, 0.78)');
    grad.addColorStop(0.55, 'rgba(6, 18, 30, 0.36)');
    grad.addColorStop(1, 'rgba(6, 18, 30, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function roleAccentHex(role: CheckpointRole, cleared: boolean): string {
  if (cleared) return '#34D399';
  if (role === 'origin') return '#34D399';
  if (role === 'destination') return '#F59E0B';
  return '#22D3EE';
}

function truncateCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let trimmed = text;
  while (trimmed.length > 4 && ctx.measureText(`${trimmed}...`).width > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}...`;
}

function createCheckpointSignTexture(
  cp: JourneyCheckpoint,
  totalCount: number,
  cleared: boolean,
  maxAnisotropy: number
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    const accent = roleAccentHex(cp.role, cleared);

    // Deep obsidian signboard chassis
    ctx.fillStyle = '#090E17';
    ctx.fillRect(0, 0, 1024, 256);

    // Subtle top & bottom architectural trim
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, 1024, 8);
    ctx.fillRect(0, 248, 1024, 8);

    // Left index block
    ctx.fillStyle = 'rgba(34, 211, 238, 0.08)';
    ctx.fillRect(24, 28, 168, 200);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.strokeRect(24, 28, 168, 200);

    ctx.fillStyle = accent;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 68px ui-monospace, SFMono-Regular, monospace';
    ctx.fillText(String(cp.index + 1).padStart(2, '0'), 108, 112);

    ctx.fillStyle = '#9FB0C4';
    ctx.font = '600 22px ui-monospace, SFMono-Regular, monospace';
    ctx.fillText(`OF ${String(totalCount).padStart(2, '0')}`, 108, 186);

    // Right primary copy zone
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // Kicker row
    ctx.fillStyle = accent;
    ctx.font = '600 24px ui-monospace, SFMono-Regular, monospace';
    const metaParts = [cp.roleLabel.toUpperCase(), cp.category.toUpperCase()];
    if (typeof cp.cumulativeKm === 'number' && cp.index > 0) {
      metaParts.push(`${cp.cumulativeKm} KM`);
    }
    if (cleared) {
      metaParts.push('CLEARED');
    }
    ctx.fillText(
      truncateCanvasText(ctx, metaParts.join('  ·  '), 780),
      224,
      74
    );

    // Primary Waypoint / Chapter Title
    ctx.fillStyle = '#F8FAFC';
    ctx.font = '700 50px system-ui, -apple-system, sans-serif';
    ctx.fillText(truncateCanvasText(ctx, cp.title, 770), 224, 146);

    // Paired Briefing Chapter / Subtitle
    ctx.fillStyle = '#B8C4D6';
    ctx.font = '500 28px system-ui, -apple-system, sans-serif';
    const subLine =
      cp.title === cp.chapterTitle
        ? cp.keyPoint
        : `${cp.chapterTitle}`;
    ctx.fillText(truncateCanvasText(ctx, subLine, 770), 224, 204);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return tex;
}

export function DispatchRunGame({
  briefing = null,
  fallbackArticles,
  waypoints = [],
  focusedWaypointId = null,
  onFocusWaypoint,
  onOpenMapPlanner,
  isImmersiveMode,
  onToggleImmersiveMode,
  activeSegmentIndex = 0,
  isPlayingAudio = false,
  onSelectBriefingSegment,
  onToggleBriefingAudio,
  adaptiveQuality,
  onToggleAdaptiveQuality,
  manualQualityTier = 'high',
  onActiveQualityTierChange,
}: DispatchRunGameProps) {
  const { user, getIdToken, signInWithGoogle } = useAuth();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sfxRef = useRef<ArcadeSynthAudio>(new ArcadeSynthAudio());

  const checkpoints = useMemo(
    () => buildJourneyCheckpoints(waypoints, briefing, fallbackArticles),
    [briefing, fallbackArticles, waypoints]
  );
  const totalSectorMeters = useMemo(
    () =>
      Math.max(
        1600,
        (checkpoints[checkpoints.length - 1]?.distanceMeters ?? 1500) +
          FINISH_BUFFER_METERS
      ),
    [checkpoints]
  );

  // Auto-start in Explore Journey mode when launched in Immersive Mode or with active route waypoints
  const [runMode, setRunMode] = useState<DispatchRunMode>(() =>
    isImmersiveMode || waypoints.length > 0 ? 'explore' : 'explore'
  );
  const [phase, setPhase] = useState<GamePhase>(() =>
    isImmersiveMode || focusedWaypointId ? 'playing' : 'title'
  );
  const [cruisePaused, setCruisePaused] = useState(false);
  const [hudCollapsed, setHudCollapsed] = useState(() => Boolean(isImmersiveMode));
  const [lightingMode, setLightingMode] = useState<CorridorLightingMode>('dusk');
  const [isCameraOffset, setIsCameraOffset] = useState(false);
  const [arrivalBanner, setArrivalBanner] = useState<{
    step: number;
    title: string;
    subtitle: string;
  } | null>(null);

  const [hud, setHud] = useState<HudSnapshot>(INITIAL_HUD);
  const [muted, setMuted] = useState(false);
  const [internalFullscreen, setInternalFullscreen] = useState(false);
  const [contextLost, setContextLost] = useState(false);
  const [leaderboard, setLeaderboard] = useState<DbGameScoreEntry[]>([]);
  const [personalBest, setPersonalBest] = useState<number>(() => {
    try {
      return Number(localStorage.getItem('dispatch_run_best_v1') || '0') || 0;
    } catch {
      return 0;
    }
  });
  const [scoreSubmitted, setScoreSubmitted] = useState(false);

  const [localAdaptive, setLocalAdaptive] = useState(true);
  const effectiveAdaptive =
    adaptiveQuality !== undefined ? adaptiveQuality : localAdaptive;
  const [activeTier, setActiveTier] = useState<QualityTier>(() =>
    effectiveAdaptive ? 'high' : manualQualityTier
  );

  const effectiveFullscreen = Boolean(isImmersiveMode || internalFullscreen);

  // Default to minimal unobtrusive overlay and active corridor navigation when entering Immersive Mode
  useEffect(() => {
    if (effectiveFullscreen) {
      setHudCollapsed(true);
      if (phaseRef.current === 'title') {
        gameActionsRef.current?.startRun('explore');
      }
    }
  }, [effectiveFullscreen]);

  // Refs for zero-teardown access inside the Three.js rAF loop
  const phaseRef = useRef<GamePhase>(phase);
  const runModeRef = useRef<DispatchRunMode>(runMode);
  const cruisePausedRef = useRef<boolean>(cruisePaused);
  const checkpointsRef = useRef<JourneyCheckpoint[]>(checkpoints);
  const totalSectorMetersRef = useRef<number>(totalSectorMeters);
  const onFocusWaypointRef = useRef(onFocusWaypoint);
  const bannerTimeoutRef = useRef<number | null>(null);
  const adaptiveRef = useRef<boolean>(effectiveAdaptive);
  adaptiveRef.current = effectiveAdaptive;
  const manualTierRef = useRef<QualityTier>(manualQualityTier);
  manualTierRef.current = manualQualityTier;
  const effectiveFullscreenRef = useRef<boolean>(effectiveFullscreen);
  effectiveFullscreenRef.current = effectiveFullscreen;
  const [cameraView, setCameraView] = useState<CorridorCameraView>('chase');
  const cameraViewRef = useRef<CorridorCameraView>(cameraView);
  cameraViewRef.current = cameraView;
  const [physicsMode, setPhysicsMode] =
    useState<CorridorPhysicsMode>('smoothOrbit');
  const physicsModeRef = useRef<CorridorPhysicsMode>(physicsMode);
  physicsModeRef.current = physicsMode;
  const onActiveTierChangeRef = useRef(onActiveQualityTierChange);
  onActiveTierChangeRef.current = onActiveQualityTierChange;

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    runModeRef.current = runMode;
  }, [runMode]);

  useEffect(() => {
    cruisePausedRef.current = cruisePaused;
  }, [cruisePaused]);

  useEffect(() => {
    checkpointsRef.current = checkpoints;
    totalSectorMetersRef.current = totalSectorMeters;
  }, [checkpoints, totalSectorMeters]);

  useEffect(() => {
    onFocusWaypointRef.current = onFocusWaypoint;
  }, [onFocusWaypoint]);

  useEffect(() => {
    sfxRef.current.muted = muted;
  }, [muted]);

  const showCheckpointToast = useCallback(
    (cp: JourneyCheckpoint) => {
      setArrivalBanner({
        step: cp.index + 1,
        title: cp.title,
        subtitle: cp.chapterTitle,
      });
      if (bannerTimeoutRef.current) {
        window.clearTimeout(bannerTimeoutRef.current);
      }
      bannerTimeoutRef.current = window.setTimeout(() => {
        setArrivalBanner(null);
      }, 2800);
    },
    []
  );

  useEffect(() => {
    return () => {
      if (bannerTimeoutRef.current) {
        window.clearTimeout(bannerTimeoutRef.current);
      }
    };
  }, []);

  // Sync native browser Fullscreen exit when using internal fullscreen
  useEffect(() => {
    if (isImmersiveMode !== undefined) return;
    const onFsChange = () => {
      if (!document.fullscreenElement) {
        setInternalFullscreen(false);
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, [isImmersiveMode]);

  const handleToggleFullscreen = useCallback(() => {
    if (onToggleImmersiveMode) {
      onToggleImmersiveMode();
      return;
    }
    setInternalFullscreen((prev) => {
      const next = !prev;
      if (next) {
        try {
          const el = rootRef.current;
          if (el && typeof el.requestFullscreen === 'function') {
            el.requestFullscreen().catch(() => {});
          }
        } catch {
          // CSS fixed inset-0 fallback handles expansion cleanly
        }
      } else {
        try {
          if (
            document.fullscreenElement &&
            typeof document.exitFullscreen === 'function'
          ) {
            document.exitFullscreen().catch(() => {});
          }
        } catch {
          // Ignore exit error
        }
      }
      return next;
    });
  }, [onToggleImmersiveMode]);

  const gameActionsRef = useRef<{
    startRun: (mode?: DispatchRunMode, startAtCheckpointIdx?: number) => void;
    warpToCheckpoint: (checkpointIdx: number, holdAtGate?: boolean) => void;
    skipWaypoint: (delta: -1 | 1) => void;
    resetCameraOrientation: () => void;
    setCorridorLighting: (mode: CorridorLightingMode) => void;
    setPhysicsModeLive: (mode: CorridorPhysicsMode) => void;
    triggerWaypointDrop: () => void;
    switchModeLive: (mode: DispatchRunMode) => void;
    togglePause: () => void;
    resumeRun: () => void;
    syncQuality: (
      adaptive: boolean,
      manualTier: QualityTier,
      immersive: boolean
    ) => void;
  } | null>(null);

  const handleToggleLighting = useCallback(() => {
    setLightingMode((prev) => {
      const idx = CORRIDOR_LIGHTING_ORDER.indexOf(prev);
      const next =
        CORRIDOR_LIGHTING_ORDER[(idx + 1) % CORRIDOR_LIGHTING_ORDER.length];
      gameActionsRef.current?.setCorridorLighting(next);
      return next;
    });
  }, []);

  const handleSelectPhysicsMode = useCallback((next: CorridorPhysicsMode) => {
    physicsModeRef.current = next;
    setPhysicsMode(next);
    gameActionsRef.current?.setPhysicsModeLive(next);
  }, []);

  const handleTogglePhysicsMode = useCallback(() => {
    const next: CorridorPhysicsMode =
      physicsModeRef.current === 'smoothOrbit'
        ? 'gravityExploration'
        : 'smoothOrbit';
    handleSelectPhysicsMode(next);
  }, [handleSelectPhysicsMode]);

  const handleDropWaypoints = useCallback(() => {
    if (physicsModeRef.current !== 'gravityExploration') {
      physicsModeRef.current = 'gravityExploration';
      setPhysicsMode('gravityExploration');
    }
    gameActionsRef.current?.triggerWaypointDrop();
  }, []);

  const handleToggleCameraView = useCallback(() => {
    setCameraView((prev) => {
      const next: CorridorCameraView = prev === 'chase' ? 'cockpit' : 'chase';
      cameraViewRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    gameActionsRef.current?.syncQuality(
      effectiveAdaptive,
      manualQualityTier,
      effectiveFullscreen
    );
  }, [effectiveAdaptive, manualQualityTier, effectiveFullscreen]);

  // Sync external focusedWaypointId (e.g. clicked in ImmersiveRouteOverlay or Map Planner) -> smooth 3D warp
  const lastExternalFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusedWaypointId || focusedWaypointId === lastExternalFocusRef.current) {
      return;
    }
    lastExternalFocusRef.current = focusedWaypointId;
    const cpIdx = checkpoints.findIndex((c) => c.waypointId === focusedWaypointId);
    if (cpIdx >= 0) {
      if (phaseRef.current === 'title') {
        gameActionsRef.current?.startRun('explore', cpIdx);
      } else {
        gameActionsRef.current?.warpToCheckpoint(cpIdx, false);
      }
    }
  }, [checkpoints, focusedWaypointId]);

  // Load leaderboard when signed in
  useEffect(() => {
    if (!user) return;
    let active = true;
    getIdToken()
      .then((token) => (token ? fetchDbGameScores(token) : null))
      .then((data) => {
        if (!active || !data) return;
        setLeaderboard(data.leaderboard);
        setPersonalBest((prev) => Math.max(prev, data.personalBest));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [user, getIdToken]);

  const submitFinalRun = useCallback(
    async (finalHud: HudSnapshot) => {
      setPersonalBest((prev) => {
        const nextBest = Math.max(prev, finalHud.score);
        try {
          localStorage.setItem('dispatch_run_best_v1', String(nextBest));
        } catch {
          // Ignore storage error
        }
        return nextBest;
      });
      if (!user || finalHud.score <= 0) return;
      try {
        const token = await getIdToken();
        if (!token) return;
        const res = await saveDbGameScore(token, {
          score: finalHud.score,
          capsulesCollected: finalHud.capsules,
          distanceMeters: finalHud.distance,
          bestCombo: finalHud.bestCombo,
        });
        setLeaderboard(res.leaderboard);
        setPersonalBest((prev) => Math.max(prev, res.personalBest));
        setScoreSubmitted(true);
      } catch {
        // Keep local best intact
      }
    },
    [getIdToken, user]
  );

  // ---------- Stable Single-Mount Three.js WebGL Pipeline ----------
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = (() => {
      const probeCanvas = document.createElement('canvas');
      const gl =
        probeCanvas.getContext('webgl2') || probeCanvas.getContext('webgl');
      if (!gl) return true;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const param = dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param) || '');
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render|Mesa/i.test(gpu);
    })();

    const width = container.clientWidth || 1080;
    const height = container.clientHeight || 640;

    const initialTier: QualityTier = adaptiveRef.current
      ? 'high'
      : manualTierRef.current;
    const governor = new AdaptiveFrameGovernor(initialTier);
    let currentAppliedTier: QualityTier = initialTier;

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    renderer.setPixelRatio(
      computeTierPixelRatio(
        initialTier,
        effectiveFullscreenRef.current,
        isSoftwareGl
      )
    );
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled =
      !isSoftwareGl && QUALITY_TIER_SPECS[initialTier].shadowsEnabled;
    renderer.shadowMap.type = QUALITY_TIER_SPECS[initialTier].shadowType;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const maxAniso = renderer.capabilities.getMaxAnisotropy();

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      setContextLost(true);
    };
    const handleContextRestored = () => {
      setContextLost(false);
    };
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost, false);
    renderer.domElement.addEventListener(
      'webglcontextrestored',
      handleContextRestored,
      false
    );

    const scene = new THREE.Scene();
    const bgSkyColor = new THREE.Color(CORRIDOR_LIGHTING_PRESETS.dusk.sky);
    const sceneFog = new THREE.FogExp2(
      CORRIDOR_LIGHTING_PRESETS.dusk.sky,
      CORRIDOR_LIGHTING_PRESETS.dusk.fogDensity
    );
    scene.background = bgSkyColor;
    scene.fog = sceneFog;

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envTarget.texture;
    scene.environmentIntensity = 0.7;
    pmrem.dispose();

    const camera = new THREE.PerspectiveCamera(56, width / height, 0.1, 210);
    camera.position.set(0, 4.4, 9.8);
    camera.lookAt(0, 1.2, -16);

    // Warm key light + cool sky/ground HemisphereLight fill + rim accent
    const hemi = new THREE.HemisphereLight(0x5ea2e8, 0x101420, 0.88);
    scene.add(hemi);
    const dirLight = new THREE.DirectionalLight(0xffd8b2, 2.15);
    dirLight.position.set(14, 24, 12);
    dirLight.target.position.set(0, 0, -24);
    dirLight.castShadow =
      !isSoftwareGl && QUALITY_TIER_SPECS[initialTier].shadowsEnabled;
    dirLight.shadow.mapSize.set(
      QUALITY_TIER_SPECS[initialTier].shadowMapSize,
      QUALITY_TIER_SPECS[initialTier].shadowMapSize
    );
    dirLight.shadow.radius = QUALITY_TIER_SPECS[initialTier].shadowRadius;
    dirLight.shadow.camera.left = -14;
    dirLight.shadow.camera.right = 14;
    dirLight.shadow.camera.top = 26;
    dirLight.shadow.camera.bottom = -34;
    dirLight.shadow.camera.near = 2;
    dirLight.shadow.camera.far = 78;
    dirLight.shadow.bias = -0.0006;
    dirLight.shadow.normalBias = 0.02;
    scene.add(dirLight, dirLight.target);
    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.9);
    rimLight.position.set(-14, 10, -24);
    scene.add(rimLight);

    const applyTierToCorridor = (tier: QualityTier, forceResize = false) => {
      currentAppliedTier = tier;
      const w = container.clientWidth || 960;
      const h = container.clientHeight || 580;
      applyThreeSceneQuality({
        renderer,
        scene,
        shadowLight: dirLight,
        width: w,
        height: h,
        tier,
        immersive: effectiveFullscreenRef.current,
        isSoftwareGl,
        autoUpdateShadows: true,
        forceResize,
      });
      setActiveTier(tier);
      onActiveTierChangeRef.current?.(tier);
    };

    // Extended natural side terrain shelves beyond the expressway (no floating box void)
    const shelfGeo = new THREE.PlaneGeometry(240, 210);
    const shelfMat = new THREE.MeshStandardMaterial({
      color: 0x070a12,
      roughness: 0.92,
      metalness: 0.08,
    });
    const shelf = new THREE.Mesh(shelfGeo, shelfMat);
    shelf.rotation.x = -Math.PI / 2;
    shelf.position.set(0, -0.06, -78);
    scene.add(shelf);

    // Scrolling Expressway Deck (Wet-Asphalt Specular Puddle Shader via onBeforeCompile)
    const roadTex = createRoadTexture(maxAniso);
    const roadGeo = new THREE.PlaneGeometry(11.8, 195);
    const wetRoadHandle = createWetAsphaltCorridorMaterial(roadTex, isSoftwareGl);
    const roadMat = wetRoadHandle.material;
    const road = new THREE.Mesh(roadGeo, roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0, -76);
    road.receiveShadow = true;
    scene.add(road);

    // Elevated Continuous Route Spine Rails
    const spineRailGeo = new THREE.BoxGeometry(0.12, 0.12, 195);
    const spineRailMat = new THREE.MeshStandardMaterial({
      color: 0x22d3ee,
      emissive: 0x22d3ee,
      emissiveIntensity: 1.5,
      roughness: 0.2,
    });
    const leftSpine = new THREE.Mesh(spineRailGeo, spineRailMat);
    leftSpine.position.set(-6.5, 6.2, -76);
    const rightSpine = new THREE.Mesh(spineRailGeo, spineRailMat);
    rightSpine.position.set(6.5, 6.2, -76);
    scene.add(leftSpine, rightSpine);

    // ---------- Instanced Highway Pylons & Cityscape Towers ----------
    const pylonCount = 28;
    const pylonGeo = new THREE.BoxGeometry(0.32, 6.2, 0.32);
    const pylonMat = new THREE.MeshStandardMaterial({
      color: 0x1c2536,
      metalness: 0.72,
      roughness: 0.28,
    });
    const pylonInst = new THREE.InstancedMesh(pylonGeo, pylonMat, pylonCount);
    pylonInst.castShadow = true;
    pylonInst.frustumCulled = false;

    const pylonStripGeo = new THREE.BoxGeometry(0.36, 0.9, 0.36);
    const cyanGlowMat = new THREE.MeshStandardMaterial({
      color: 0x22d3ee,
      emissive: 0x22d3ee,
      emissiveIntensity: 2.2,
      roughness: 0.2,
    });
    const pylonGlowInst = new THREE.InstancedMesh(
      pylonStripGeo,
      cyanGlowMat,
      pylonCount
    );
    pylonGlowInst.frustumCulled = false;
    scene.add(pylonInst, pylonGlowInst);

    const towerCount = 36;
    const towerGeo = new THREE.BoxGeometry(1, 1, 1);
    const towerMat = new THREE.MeshStandardMaterial({
      color: 0x111724,
      roughness: 0.82,
      metalness: 0.22,
    });
    const towerInst = new THREE.InstancedMesh(towerGeo, towerMat, towerCount);
    towerInst.frustumCulled = false;
    const towerTint = new THREE.Color();
    const towerMeta = Array.from({ length: towerCount }, (_, i) => {
      const side = i % 2 === 0 ? -1 : 1;
      const shade = 0.82 + (i % 5) * 0.08;
      towerTint.setRGB(0.08 * shade, 0.11 * shade, 0.18 * shade);
      towerInst.setColorAt(i, towerTint);
      return {
        x: side * (12.2 + (i % 4) * 4.8),
        z: -i * 5.2,
        w: 3.2 + (i % 3) * 1.8,
        h: 9 + ((i * 7) % 20),
        d: 3.5 + (i % 2) * 2.2,
      };
    });
    if (towerInst.instanceColor) {
      towerInst.instanceColor.needsUpdate = true;
    }
    scene.add(towerInst);

    const dummy = new THREE.Object3D();

    // ---------- Composite 9-Part Grounded Hover-Courier ----------
    const courier = new THREE.Group();
    const hullMat = new THREE.MeshStandardMaterial({
      color: 0xe6edf7,
      metalness: 0.58,
      roughness: 0.22,
    });
    const darkTrimMat = new THREE.MeshStandardMaterial({
      color: 0x1d2534,
      metalness: 0.65,
      roughness: 0.52,
    });
    const canopyMat = new THREE.MeshPhysicalMaterial({
      color: 0x0b2a38,
      metalness: 0.12,
      roughness: 0.08,
      clearcoat: 1,
    });
    const thrusterMat = new THREE.MeshStandardMaterial({
      color: 0x67e8f9,
      emissive: 0x22d3ee,
      emissiveIntensity: 2.6,
      roughness: 0.15,
    });
    const contactShadowTex = createContactShadowTexture();
    const contactShadowMat = new THREE.MeshBasicMaterial({
      map: contactShadowTex,
      transparent: true,
      depthWrite: false,
      opacity: 0.68,
    });

    const hullGeo = new THREE.BoxGeometry(1.18, 0.42, 2.45);
    const noseGeo = new THREE.ConeGeometry(0.62, 1.15, 4);
    const canopyGeo = new THREE.BoxGeometry(0.76, 0.32, 1.05);
    const nacelleGeo = new THREE.BoxGeometry(0.32, 0.3, 1.85);
    const finGeo = new THREE.BoxGeometry(0.1, 0.52, 0.95);
    const thrusterGeo = new THREE.CylinderGeometry(0.16, 0.2, 0.32, 14);
    const shadowPlaneGeo = new THREE.PlaneGeometry(2.6, 3.8);

    const hull = new THREE.Mesh(hullGeo, hullMat);
    hull.position.set(0, 0.72, 0);
    hull.castShadow = true;
    const nose = new THREE.Mesh(noseGeo, hullMat);
    nose.rotation.x = -Math.PI / 2;
    nose.rotation.z = Math.PI / 4;
    nose.position.set(0, 0.68, -1.62);
    nose.castShadow = true;
    const canopy = new THREE.Mesh(canopyGeo, canopyMat);
    canopy.position.set(0, 0.98, -0.18);
    canopy.castShadow = true;
    const leftNacelle = new THREE.Mesh(nacelleGeo, darkTrimMat);
    leftNacelle.position.set(-0.78, 0.66, 0.16);
    leftNacelle.castShadow = true;
    const rightNacelle = new THREE.Mesh(nacelleGeo, darkTrimMat);
    rightNacelle.position.set(0.78, 0.66, 0.16);
    rightNacelle.castShadow = true;
    const fin = new THREE.Mesh(finGeo, darkTrimMat);
    fin.position.set(0, 1.14, 0.65);
    fin.castShadow = true;
    const leftThruster = new THREE.Mesh(thrusterGeo, thrusterMat);
    leftThruster.rotation.x = Math.PI / 2;
    leftThruster.position.set(-0.42, 0.68, 1.32);
    const rightThruster = new THREE.Mesh(thrusterGeo, thrusterMat);
    rightThruster.rotation.x = Math.PI / 2;
    rightThruster.position.set(0.42, 0.68, 1.32);
    const contactShadow = new THREE.Mesh(shadowPlaneGeo, contactShadowMat);
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.position.set(0, 0.025, 0.05);

    const hoverLight = new THREE.PointLight(0x22d3ee, 2.2, 8);
    hoverLight.position.set(0, 0.45, 0.1);

    courier.add(
      contactShadow,
      hull,
      nose,
      canopy,
      leftNacelle,
      rightNacelle,
      fin,
      leftThruster,
      rightThruster,
      hoverLight
    );
    scene.add(courier);

    // ---------- 3D Navigable Waypoint & Briefing Checkpoint Portals Pool ----------
    const gatePlinthGeo = new THREE.BoxGeometry(1.15, 0.48, 1.35);
    const gatePillarGeo = new THREE.BoxGeometry(0.56, 6.8, 0.72);
    const gateBeamGeo = new THREE.BoxGeometry(14.4, 0.56, 0.86);
    const gateSignGeo = new THREE.PlaneGeometry(10.8, 2.7);
    const gateBladeGeo = new THREE.BoxGeometry(0.14, 6.2, 0.18);
    const gateThresholdGeo = new THREE.PlaneGeometry(11.2, 0.58);
    const gateCrownGeo = new THREE.OctahedronGeometry(0.46, 0);

    const gateChassisMat = new THREE.MeshStandardMaterial({
      color: 0x182132,
      metalness: 0.78,
      roughness: 0.25,
    });
    const gatePlinthMat = new THREE.MeshStandardMaterial({
      color: 0x101622,
      metalness: 0.35,
      roughness: 0.62,
    });

    const signTextureCache = new Map<string, THREE.CanvasTexture>();
    const getSignTexture = (
      cp: JourneyCheckpoint,
      totalCount: number,
      cleared: boolean
    ): THREE.CanvasTexture => {
      const cacheKey = `${cp.id}|${cp.index}|${totalCount}|${cp.title}|${cp.chapterTitle}|${cp.role}|${cp.cumulativeKm ?? ''}|${cleared ? '1' : '0'}`;
      const existing = signTextureCache.get(cacheKey);
      if (existing) return existing;
      if (signTextureCache.size > 36) {
        const oldestKey = signTextureCache.keys().next().value;
        if (oldestKey) {
          signTextureCache.get(oldestKey)?.dispose();
          signTextureCache.delete(oldestKey);
        }
      }
      const created = createCheckpointSignTexture(cp, totalCount, cleared, maxAniso);
      signTextureCache.set(cacheKey, created);
      return created;
    };

    interface CheckpointGateSlot {
      group: THREE.Group;
      signMat: THREE.MeshBasicMaterial;
      accentMat: THREE.MeshStandardMaterial;
      thresholdMat: THREE.MeshBasicMaterial;
      crownMesh: THREE.Mesh;
      boundKey: string;
    }

    const gatePool: CheckpointGateSlot[] = [];
    for (let i = 0; i < MAX_VISIBLE_GATES; i++) {
      const group = new THREE.Group();

      const leftPlinth = new THREE.Mesh(gatePlinthGeo, gatePlinthMat);
      leftPlinth.position.set(-6.45, 0.24, 0);
      leftPlinth.receiveShadow = true;
      const rightPlinth = new THREE.Mesh(gatePlinthGeo, gatePlinthMat);
      rightPlinth.position.set(6.45, 0.24, 0);
      rightPlinth.receiveShadow = true;

      const leftPillar = new THREE.Mesh(gatePillarGeo, gateChassisMat);
      leftPillar.position.set(-6.35, 3.64, 0);
      leftPillar.rotation.z = -0.04;
      leftPillar.castShadow = true;

      const rightPillar = new THREE.Mesh(gatePillarGeo, gateChassisMat);
      rightPillar.position.set(6.35, 3.64, 0);
      rightPillar.rotation.z = 0.04;
      rightPillar.castShadow = true;

      const topBeam = new THREE.Mesh(gateBeamGeo, gateChassisMat);
      topBeam.position.set(0, 7.05, 0);
      topBeam.castShadow = true;

      const signMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const signFront = new THREE.Mesh(gateSignGeo, signMat);
      signFront.position.set(0, 5.55, 0.46);

      const signBack = new THREE.Mesh(gateSignGeo, gateChassisMat);
      signBack.rotation.y = Math.PI;
      signBack.position.set(0, 5.55, -0.44);

      const accentMat = new THREE.MeshStandardMaterial({
        color: 0x22d3ee,
        emissive: 0x22d3ee,
        emissiveIntensity: 2.3,
        roughness: 0.2,
      });
      const leftBlade = new THREE.Mesh(gateBladeGeo, accentMat);
      leftBlade.position.set(-5.88, 3.55, 0.3);
      const rightBlade = new THREE.Mesh(gateBladeGeo, accentMat);
      rightBlade.position.set(5.88, 3.55, 0.3);

      const thresholdMat = new THREE.MeshBasicMaterial({
        color: 0x22d3ee,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      const threshold = new THREE.Mesh(gateThresholdGeo, thresholdMat);
      threshold.rotation.x = -Math.PI / 2;
      threshold.position.set(0, 0.03, 0);

      const crownMesh = new THREE.Mesh(gateCrownGeo, accentMat);
      crownMesh.position.set(0, 8.15, 0);

      group.add(
        leftPlinth,
        rightPlinth,
        leftPillar,
        rightPillar,
        topBeam,
        signBack,
        signFront,
        leftBlade,
        rightBlade,
        threshold,
        crownMesh
      );
      group.visible = false;
      scene.add(group);

      gatePool.push({
        group,
        signMat,
        accentMat,
        thresholdMat,
        crownMesh,
        boundKey: '',
      });
    }

    // ---------- Shared-Geometry Obstacle & Capsule Pools ----------
    const hazardBodyGeo = new THREE.BoxGeometry(2.25, 1.25, 1.1);
    const hazardChevronGeo = new THREE.BoxGeometry(2.34, 0.24, 1.16);
    const hazardBeaconGeo = new THREE.OctahedronGeometry(0.24, 0);
    const hazardMat = new THREE.MeshStandardMaterial({
      color: 0x26202b,
      metalness: 0.6,
      roughness: 0.32,
    });
    const hazardGlowMat = new THREE.MeshStandardMaterial({
      color: 0xf97316,
      emissive: 0xf97316,
      emissiveIntensity: 2.3,
      roughness: 0.2,
    });

    interface HazardEntity {
      mesh: THREE.Group;
      active: boolean;
      lane: number;
      z: number;
      passed: boolean;
    }

    const hazards: HazardEntity[] = [];
    for (let i = 0; i < 12; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(hazardBodyGeo, hazardMat);
      body.position.y = 0.625;
      body.castShadow = true;
      body.receiveShadow = true;
      const chevron = new THREE.Mesh(hazardChevronGeo, hazardGlowMat);
      chevron.position.y = 1.12;
      const topBeacon = new THREE.Mesh(hazardBeaconGeo, hazardGlowMat);
      topBeacon.position.y = 1.56;
      g.add(body, chevron, topBeacon);
      g.visible = false;
      scene.add(g);
      hazards.push({ mesh: g, active: false, lane: 1, z: -120, passed: false });
    }

    const capsuleCoreGeo = new THREE.OctahedronGeometry(0.48, 0);
    const capsuleRingGeo = new THREE.TorusGeometry(0.68, 0.05, 8, 20);
    const capsuleMat = new THREE.MeshStandardMaterial({
      color: 0x67e8f9,
      emissive: 0x22d3ee,
      emissiveIntensity: 2.1,
      metalness: 0.35,
      roughness: 0.2,
    });

    interface CapsuleEntity {
      mesh: THREE.Group;
      active: boolean;
      lane: number;
      z: number;
    }

    const capsules: CapsuleEntity[] = [];
    for (let i = 0; i < 14; i++) {
      const g = new THREE.Group();
      const core = new THREE.Mesh(capsuleCoreGeo, capsuleMat);
      core.position.y = 1.05;
      core.castShadow = true;
      const ring = new THREE.Mesh(capsuleRingGeo, capsuleMat);
      ring.position.y = 1.05;
      g.add(core, ring);
      g.visible = false;
      scene.add(g);
      capsules.push({ mesh: g, active: false, lane: 1, z: -120 });
    }

    // ---------- Pooled Particle Burst System ----------
    const particleCount = 48;
    const pGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16);
    const pMatCyan = new THREE.MeshBasicMaterial({ color: 0x67e8f9 });
    const pMatAmber = new THREE.MeshBasicMaterial({ color: 0xf97316 });
    interface Particle {
      mesh: THREE.Mesh;
      vel: THREE.Vector3;
      life: number;
    }
    const particles: Particle[] = [];
    for (let i = 0; i < particleCount; i++) {
      const m = new THREE.Mesh(pGeo, i % 2 === 0 ? pMatCyan : pMatAmber);
      m.visible = false;
      scene.add(m);
      particles.push({ mesh: m, vel: new THREE.Vector3(), life: 0 });
    }

    const spawnBurst = (pos: THREE.Vector3, isHit: boolean) => {
      let spawned = 0;
      for (const p of particles) {
        if (p.life <= 0 && spawned < 14) {
          p.mesh.material = isHit ? pMatAmber : pMatCyan;
          p.mesh.position.copy(pos);
          p.mesh.visible = true;
          p.vel.set(
            (Math.random() - 0.5) * 11,
            2.5 + Math.random() * 6,
            (Math.random() - 0.5) * 10
          );
          p.life = 0.45 + Math.random() * 0.25;
          spawned++;
        }
      }
    };

    // ---------- Input & 2-Axis Drag-Look State ----------
    const heldKeys: Record<string, boolean> = {};
    const justPressed: Record<string, boolean> = {};
    let laneBufferDir = 0;
    let laneBufferTimer = 0;
    let pointerDragging = false;
    let pointerDownX = 0;
    let pointerDownY = 0;
    let pointerLastX = 0;
    let pointerLastY = 0;
    let userYawOffset = 0;
    let userPitchOffset = 0;
    let recenteringCamera = false;
    let reportedCameraOffset = false;

    // 3D Map Waypoint Physics Engine (Smooth Orbit <-> Gravity Exploration)
    const waypointPhysics = new CorridorWaypointPhysicsWorld(
      scene,
      contactShadowTex,
      renderer.capabilities.getMaxAnisotropy()
    );
    waypointPhysics.setMode(physicsModeRef.current);
    const clickRaycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();

    const syncCameraOffsetFlag = (offsetActive: boolean) => {
      if (reportedCameraOffset !== offsetActive) {
        reportedCameraOffset = offsetActive;
        setIsCameraOffset(offsetActive);
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      pointerDragging = true;
      recenteringCamera = false;
      pointerDownX = e.clientX;
      pointerDownY = e.clientY;
      pointerLastX = e.clientX;
      pointerLastY = e.clientY;
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!pointerDragging) return;
      const dx = e.clientX - pointerLastX;
      const dy = e.clientY - pointerLastY;
      pointerLastX = e.clientX;
      pointerLastY = e.clientY;
      userYawOffset = THREE.MathUtils.clamp(userYawOffset + dx * 0.0045, -0.78, 0.78);
      userPitchOffset = THREE.MathUtils.clamp(
        userPitchOffset + dy * 0.0032,
        -0.32,
        0.46
      );
      syncCameraOffsetFlag(
        Math.abs(userYawOffset) > 0.025 || Math.abs(userPitchOffset) > 0.025
      );
    };
    const onPointerUp = (e: PointerEvent) => {
      const wasDragging = pointerDragging;
      pointerDragging = false;
      if (!wasDragging) return;

      const travel = Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY);
      if (
        travel < 7 &&
        (phaseRef.current === 'playing' || phaseRef.current === 'title')
      ) {
        const rect = renderer.domElement.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
          pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
          clickRaycaster.setFromCamera(pointerNdc, camera);
          const hit = waypointPhysics.raycastImpulse(clickRaycaster);
          if (hit) {
            spawnBurst(hit.worldPoint, false);
            sfxRef.current.playFloorBounce(1.2);
            const cp = checkpointsRef.current[hit.checkpointIndex];
            if (cp) {
              showCheckpointToast(cp);
              if (cp.waypointId) {
                lastExternalFocusRef.current = cp.waypointId;
                onFocusWaypointRef.current?.(cp.waypointId);
              }
            }
          }
        }
      }
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    const isTextInputFocused = () => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        (el as HTMLElement).isContentEditable
      );
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTextInputFocused()) return;

      if (
        ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)
      ) {
        if (phaseRef.current === 'playing' || phaseRef.current === 'title') {
          e.preventDefault();
        }
      }
      if (!heldKeys[e.code]) {
        justPressed[e.code] = true;
      }
      heldKeys[e.code] = true;

      if (e.code === 'KeyH') {
        if (!effectiveFullscreenRef.current) {
          setHudCollapsed((v) => !v);
        }
        return;
      }

      if (e.code === 'KeyR') {
        gameActionsRef.current?.resetCameraOrientation();
        return;
      }

      if (e.code === 'KeyG') {
        const nextMode: CorridorPhysicsMode =
          physicsModeRef.current === 'smoothOrbit'
            ? 'gravityExploration'
            : 'smoothOrbit';
        physicsModeRef.current = nextMode;
        setPhysicsMode(nextMode);
        gameActionsRef.current?.setPhysicsModeLive(nextMode);
        return;
      }

      if (e.code === 'KeyV') {
        if (physicsModeRef.current !== 'gravityExploration') {
          physicsModeRef.current = 'gravityExploration';
          setPhysicsMode('gravityExploration');
        }
        gameActionsRef.current?.triggerWaypointDrop();
        return;
      }

      if (e.code === 'KeyL') {
        setLightingMode((prev) => {
          const idx = CORRIDOR_LIGHTING_ORDER.indexOf(prev);
          const next =
            CORRIDOR_LIGHTING_ORDER[(idx + 1) % CORRIDOR_LIGHTING_ORDER.length];
          gameActionsRef.current?.setCorridorLighting(next);
          return next;
        });
        return;
      }

      if (e.code === 'KeyC') {
        setCameraView((prev) => {
          const next: CorridorCameraView = prev === 'chase' ? 'cockpit' : 'chase';
          cameraViewRef.current = next;
          return next;
        });
        return;
      }

      // Direct checkpoint navigation shortcuts ([ / ] and 1..9)
      if (e.code === 'BracketLeft') {
        gameActionsRef.current?.skipWaypoint(-1);
        return;
      }
      if (e.code === 'BracketRight') {
        gameActionsRef.current?.skipWaypoint(1);
        return;
      }
      if (e.code.startsWith('Digit')) {
        const num = Number(e.code.replace('Digit', ''));
        if (num >= 1 && num <= 9 && num <= checkpointsRef.current.length) {
          gameActionsRef.current?.warpToCheckpoint(num - 1, false);
          return;
        }
      }

      if (e.code === 'Escape' && !isImmersiveMode) {
        if (phaseRef.current === 'playing') {
          setPhase('paused');
        } else if (phaseRef.current === 'paused') {
          setPhase('playing');
        }
      } else if (
        (e.code === 'Enter' || e.code === 'Space') &&
        phaseRef.current === 'title'
      ) {
        gameActionsRef.current?.startRun(runModeRef.current);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      heldKeys[e.code] = false;
    };

    const handleBlur = () => {
      pointerDragging = false;
      for (const k of Object.keys(heldKeys)) heldKeys[k] = false;
      for (const k of Object.keys(justPressed)) justPressed[k] = false;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    // ---------- Simulation State ----------
    let currentLane = 1;
    let laneCooldown = 0;
    let analogLaneLatch: -1 | 0 | 1 = 0;
    let courierX = 0;
    let courierTilt = 0;
    let suspY = 0;
    let suspVel = 0;
    let courierPitch = 0;
    let courierPitchVel = 0;
    let courierGravY = 0;
    let courierGravVelY = 0;
    let distance = 0;
    let warpTargetDistance: number | null = null;
    let speed = 26;
    let prevSpeed = 26;
    let boostTimer = 0;
    let boostCharge = 100;
    let shield = 3;
    let invulnTimer = 0;
    let hitstopTimer = 0;
    let shakeIntensity = 0;
    let score = 0;
    let capsulesCollected = 0;
    let combo = 1;
    let bestCombo = 1;
    let hazardSpawnTimer = 1.1;
    let capsuleSpawnTimer = 0.65;
    let hudSyncAccum = 0;
    let titleOrbitAngle = 0;
    let titleDemoScroll = 0;
    let activeCheckpointIdx = 0;
    const clearedCheckpointIds = new Set<string>();
    const gamepadPoller = new GamepadPoller();

    const clearHazards = () => {
      for (const h of hazards) {
        h.active = false;
        h.mesh.visible = false;
      }
    };

    const resetSimulation = (startAtCheckpointIdx?: number) => {
      currentLane = 1;
      laneCooldown = 0;
      analogLaneLatch = 0;
      courierX = 0;
      courierTilt = 0;
      suspY = 0;
      suspVel = 0;
      courierPitch = 0;
      courierPitchVel = 0;
      courierGravY = 0;
      courierGravVelY = 0;
      userYawOffset = 0;
      userPitchOffset = 0;
      recenteringCamera = false;
      syncCameraOffsetFlag(false);
      speed = runModeRef.current === 'explore' ? 24 : 36;
      prevSpeed = speed;
      boostTimer = 0;
      boostCharge = 100;
      shield = 3;
      invulnTimer = 0;
      hitstopTimer = 0;
      shakeIntensity = 0;
      score = 0;
      capsulesCollected = 0;
      combo = 1;
      bestCombo = 1;
      hazardSpawnTimer = 1.05;
      capsuleSpawnTimer = 0.55;
      clearedCheckpointIds.clear();

      const cps = checkpointsRef.current;
      if (
        typeof startAtCheckpointIdx === 'number' &&
        cps[startAtCheckpointIdx]
      ) {
        activeCheckpointIdx = startAtCheckpointIdx;
        const targetM = Math.max(0, cps[startAtCheckpointIdx].distanceMeters - 16);
        distance = Math.max(0, targetM - 65);
        warpTargetDistance = targetM;
        for (let i = 0; i < startAtCheckpointIdx; i++) {
          clearedCheckpointIds.add(cps[i].id);
        }
      } else {
        activeCheckpointIdx = 0;
        distance = 0;
        warpTargetDistance = null;
      }

      clearHazards();
      for (const c of capsules) {
        c.active = false;
        c.mesh.visible = false;
      }
      for (const p of particles) {
        p.life = 0;
        p.mesh.visible = false;
      }
      setScoreSubmitted(false);
      setCruisePaused(false);
      setHud({
        ...INITIAL_HUD,
        distance: Math.round(distance),
        activeCheckpointIdx,
        clearedCheckpoints: clearedCheckpointIds.size,
      });
    };

    const applyCorridorLighting = (mode: CorridorLightingMode) => {
      const cfg = CORRIDOR_LIGHTING_PRESETS[mode];
      bgSkyColor.setHex(cfg.sky);
      sceneFog.color.setHex(cfg.sky);
      sceneFog.density = cfg.fogDensity;
      shelfMat.color.setHex(cfg.shelfColor);
      hemi.color.setHex(cfg.hemiSky);
      hemi.groundColor.setHex(cfg.hemiGround);
      hemi.intensity = cfg.hemiIntensity;
      dirLight.color.setHex(cfg.keyColor);
      dirLight.intensity = cfg.keyIntensity;
      dirLight.position.set(...cfg.keyPos);
      rimLight.color.setHex(cfg.rimColor);
      rimLight.intensity = cfg.rimIntensity;
      scene.environmentIntensity = cfg.envIntensity;
      cyanGlowMat.emissiveIntensity = cfg.pylonEmissive;
      spineRailMat.emissiveIntensity = cfg.spineEmissive;
      hoverLight.intensity = cfg.hoverIntensity;
      if (renderer.shadowMap.enabled) {
        renderer.shadowMap.needsUpdate = true;
      }
    };

    gameActionsRef.current = {
      startRun: (mode, startAtCheckpointIdx) => {
        if (mode) {
          runModeRef.current = mode;
          setRunMode(mode);
        }
        resetSimulation(startAtCheckpointIdx);
        setPhase('playing');
      },
      warpToCheckpoint: (checkpointIdx, holdAtGate = false) => {
        const cps = checkpointsRef.current;
        const cp = cps[checkpointIdx];
        if (!cp) return;
        activeCheckpointIdx = checkpointIdx;
        // Glide to 12m in front of the selected 3D Checkpoint Portal so its signboard frames cleanly
        warpTargetDistance = Math.max(0, cp.distanceMeters - 12);
        if (phaseRef.current !== 'playing') {
          setPhase('playing');
        }
        if (runModeRef.current === 'arcade') {
          clearHazards();
        }
        if (holdAtGate) {
          setCruisePaused(true);
        }
        if (cp.waypointId) {
          lastExternalFocusRef.current = cp.waypointId;
          onFocusWaypointRef.current?.(cp.waypointId);
        }
        setHud((prev) => ({
          ...prev,
          activeCheckpointIdx: checkpointIdx,
        }));
        showCheckpointToast(cp);
        sfxRef.current.playCheckpoint();
      },
      skipWaypoint: (delta) => {
        const cps = checkpointsRef.current;
        if (cps.length === 0) return;
        const nextIdx =
          cps.length === 1
            ? 0
            : (activeCheckpointIdx + delta + cps.length) % cps.length;
        gameActionsRef.current?.warpToCheckpoint(nextIdx, false);
      },
      resetCameraOrientation: () => {
        pointerDragging = false;
        recenteringCamera = true;
        titleOrbitAngle = 0;
        camera.fov = 58.5;
        camera.updateProjectionMatrix();
        syncCameraOffsetFlag(false);
      },
      setCorridorLighting: (mode) => {
        applyCorridorLighting(mode);
      },
      setPhysicsModeLive: (mode) => {
        physicsModeRef.current = mode;
        waypointPhysics.setMode(mode);
        if (mode === 'gravityExploration') {
          courierGravVelY = Math.max(courierGravVelY, 4.2);
          sfxRef.current.playFloorBounce(0.9);
        } else {
          sfxRef.current.playCheckpoint();
        }
      },
      triggerWaypointDrop: () => {
        physicsModeRef.current = 'gravityExploration';
        waypointPhysics.triggerGravityDropWave();
        courierGravVelY = Math.max(courierGravVelY, 5.8);
        sfxRef.current.playFloorBounce(1.1);
      },
      switchModeLive: (mode) => {
        runModeRef.current = mode;
        setRunMode(mode);
        setCruisePaused(false);
        warpTargetDistance = null;
        if (mode === 'explore') {
          clearHazards();
          invulnTimer = 0;
          courier.visible = true;
        } else {
          shield = Math.max(shield, 3);
        }
        if (phaseRef.current !== 'playing') {
          resetSimulation();
          setPhase('playing');
        }
      },
      togglePause: () => {
        setPhase((prev) =>
          prev === 'playing' ? 'paused' : prev === 'paused' ? 'playing' : prev
        );
      },
      resumeRun: () => {
        setPhase('playing');
      },
      syncQuality: (adaptive, manualTier, immersive) => {
        effectiveFullscreenRef.current = immersive;
        const targetTier = adaptive ? governor.getTier() : manualTier;
        if (!adaptive) {
          governor.setTier(manualTier, performance.now());
        } else {
          governor.resetSamples();
        }
        applyTierToCorridor(targetTier, true);
      },
    };

    // Initial environment placement + pre-warm PBR shaders before frame 1
    const updateEnvironmentInstances = (scroll: number) => {
      const pylonSpan = 140;
      for (let i = 0; i < pylonCount; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const baseZ = -Math.floor(i / 2) * 10;
        let z = (baseZ + scroll) % pylonSpan;
        if (z > 14) z -= pylonSpan;
        dummy.position.set(side * 6.5, 3.1, z);
        dummy.scale.set(1, 1, 1);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        pylonInst.setMatrixAt(i, dummy.matrix);

        dummy.position.set(side * 6.5, 5.2, z);
        dummy.updateMatrix();
        pylonGlowInst.setMatrixAt(i, dummy.matrix);
      }
      pylonInst.instanceMatrix.needsUpdate = true;
      pylonGlowInst.instanceMatrix.needsUpdate = true;

      const towerSpan = 185;
      for (let i = 0; i < towerCount; i++) {
        const t = towerMeta[i];
        let z = (t.z + scroll * 0.62) % towerSpan;
        if (z > 18) z -= towerSpan;
        dummy.position.set(t.x, t.h * 0.5 - 0.05, z);
        dummy.scale.set(t.w, t.h, t.d);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        towerInst.setMatrixAt(i, dummy.matrix);
      }
      towerInst.instanceMatrix.needsUpdate = true;
    };

    const updateCheckpointGates = (currentMeters: number, elapsedSec: number) => {
      const cps = checkpointsRef.current;
      let slotIdx = 0;
      for (let i = 0; i < cps.length && slotIdx < MAX_VISIBLE_GATES; i++) {
        const cp = cps[i];
        const relMeters = cp.distanceMeters - currentMeters;
        const gateZ = -relMeters * Z_PER_METER;
        if (gateZ > 18 || gateZ < -178) continue;

        const slot = gatePool[slotIdx++];
        slot.group.visible = true;
        slot.group.position.set(0, 0, gateZ);

        const isCleared = clearedCheckpointIds.has(cp.id);
        const accentHex = roleAccentHex(cp.role, isCleared);
        const tex = getSignTexture(cp, cps.length, isCleared);
        const key = `${cp.id}|${isCleared ? '1' : '0'}|${cp.title}|${cp.chapterTitle}`;
        if (slot.boundKey !== key) {
          slot.boundKey = key;
          slot.signMat.map = tex;
          slot.signMat.needsUpdate = true;
          slot.accentMat.color.set(accentHex);
          slot.accentMat.emissive.set(accentHex);
          slot.thresholdMat.color.set(accentHex);
        }
        slot.crownMesh.rotation.y = elapsedSec * 1.9 + i * 0.7;
        slot.crownMesh.position.y = 8.15 + Math.sin(elapsedSec * 2.4 + i) * 0.12;
      }

      for (let j = slotIdx; j < MAX_VISIBLE_GATES; j++) {
        gatePool[j].group.visible = false;
      }
    };

    updateEnvironmentInstances(0);
    updateCheckpointGates(0, 0);
    waypointPhysics.step({
      dt: 0.016,
      elapsed: 0,
      currentMeters: 0,
      zPerMeter: Z_PER_METER,
      corridorSpeed: 0,
      courierPos: courier.position,
      courierVisible: true,
      checkpoints: checkpointsRef.current,
      clearedIds: clearedCheckpointIds,
    });
    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    // If initialfocusedWaypointId was set on mount, position near it smoothly
    if (focusedWaypointId) {
      const initialIdx = checkpointsRef.current.findIndex(
        (c) => c.waypointId === focusedWaypointId
      );
      if (initialIdx >= 0) {
        activeCheckpointIdx = initialIdx;
        warpTargetDistance = Math.max(
          0,
          checkpointsRef.current[initialIdx].distanceMeters - 12
        );
      }
    }

    const clock = new THREE.Clock();
    let frameId = 0;
    let isTimerFrame = false;
    let disposed = false;

    const scheduleNextFrame = (cb: () => void) => {
      if (disposed) return;
      if (!isSoftwareGl) {
        isTimerFrame = false;
        frameId = requestAnimationFrame(cb);
        return;
      }
      // Mandatory software-WebGL fenceSync + 80ms frame pacing
      const gl = renderer.getContext() as WebGL2RenderingContext;
      if (gl && typeof gl.fenceSync === 'function') {
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        const poll = () => {
          if (disposed) {
            if (sync) gl.deleteSync(sync);
            return;
          }
          const status = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
          if (status === gl.UNSIGNALED) {
            isTimerFrame = true;
            frameId = window.setTimeout(poll, 5);
          } else {
            if (sync) gl.deleteSync(sync);
            isTimerFrame = true;
            frameId = window.setTimeout(cb, 80);
          }
        };
        isTimerFrame = true;
        frameId = window.setTimeout(poll, 5);
      } else {
        isTimerFrame = true;
        frameId = window.setTimeout(cb, 80);
      }
    };

    const tick = () => {
      if (disposed) return;
      const rawDt = clock.getDelta();
      const dt = Math.min(rawDt, 0.05);
      const elapsed = clock.elapsedTime;
      const activePhase = phaseRef.current;
      const currentMode = runModeRef.current;
      const cps = checkpointsRef.current;
      const sectorFinish = totalSectorMetersRef.current;

      // Adaptive Quality Governor: scale pixelRatio & directional shadow detail based on live frame rate
      if (
        !isSoftwareGl &&
        adaptiveRef.current &&
        (activePhase === 'playing' || activePhase === 'title')
      ) {
        const nextTier = governor.recordFrame(rawDt, performance.now());
        if (nextTier && nextTier !== currentAppliedTier) {
          applyTierToCorridor(nextTier, false);
        }
      }

      const gp = gamepadPoller.poll();
      if (gp.connected) {
        if (gp.rbJustPressed) {
          const nextPhysics: CorridorPhysicsMode =
            physicsModeRef.current === 'smoothOrbit'
              ? 'gravityExploration'
              : 'smoothOrbit';
          physicsModeRef.current = nextPhysics;
          setPhysicsMode(nextPhysics);
          gameActionsRef.current?.setPhysicsModeLive(nextPhysics);
        } else if (gp.lbJustPressed) {
          if (physicsModeRef.current !== 'gravityExploration') {
            physicsModeRef.current = 'gravityExploration';
            setPhysicsMode('gravityExploration');
          }
          gameActionsRef.current?.triggerWaypointDrop();
        }
      }

      if (activePhase === 'title') {
        if (gp.aJustPressed) {
          gameActionsRef.current?.startRun(runModeRef.current);
        }
        titleOrbitAngle += dt * 0.34;
        titleDemoScroll += dt * 19;
        const previewMeters = (titleDemoScroll * METERS_PER_Z) % sectorFinish;
        roadTex.offset.y = -(titleDemoScroll * 0.08);
        wetRoadHandle.setTelemetry(elapsed, 0.42);
        updateEnvironmentInstances(titleDemoScroll);
        updateCheckpointGates(previewMeters, elapsed);

        courier.visible = true;
        const isGravityTitle = physicsModeRef.current === 'gravityExploration';
        if (isGravityTitle) {
          courierGravVelY -= 20.5 * dt;
          courierGravY += courierGravVelY * dt;
          if (courierGravY <= 0) {
            if (courierGravVelY < -2.2) {
              courierGravVelY = Math.abs(courierGravVelY) * 0.45;
            } else {
              courierGravY = 0;
              courierGravVelY = 0;
            }
          }
        } else {
          courierGravY = THREE.MathUtils.damp(courierGravY, 0, 7, dt);
          courierGravVelY = 0;
        }
        courier.position.set(
          Math.sin(titleOrbitAngle * 1.4) * 1.35,
          (isGravityTitle ? 0.11 + courierGravY : 0.16 + Math.sin(titleOrbitAngle * 3.1) * 0.07),
          0
        );
        courier.rotation.set(0, 0, -Math.cos(titleOrbitAngle * 1.4) * 0.13);
        contactShadow.position.y = 0.025 - courier.position.y + 0.14;

        waypointPhysics.step({
          dt,
          elapsed,
          currentMeters: previewMeters,
          zPerMeter: Z_PER_METER,
          corridorSpeed: 19,
          courierPos: courier.position,
          courierVisible: true,
          checkpoints: cps,
          clearedIds: clearedCheckpointIds,
          onFloorImpact: (ev) => {
            if (ev.impactSpeed > 4.2) {
              spawnBurst(ev.position, false);
            }
            sfxRef.current.playFloorBounce(ev.impactSpeed / 8);
          },
          onCourierCollide: (ev) => {
            spawnBurst(ev.position, false);
            sfxRef.current.playFloorBounce(1.1);
          },
        });

        for (const p of particles) {
          if (p.life <= 0) continue;
          p.life -= dt;
          if (p.life <= 0) {
            p.mesh.visible = false;
          } else {
            p.mesh.position.addScaledVector(p.vel, dt);
            p.vel.y -= 14 * dt;
            if (p.mesh.position.y < 0.05 && p.vel.y < 0) {
              p.mesh.position.y = 0.05;
              p.vel.y = -p.vel.y * 0.55;
            }
            p.mesh.rotation.x += dt * 7;
            p.mesh.rotation.y += dt * 5;
          }
        }

        camera.position.set(
          Math.sin(titleOrbitAngle + userYawOffset) * 3.4,
          THREE.MathUtils.clamp(
            4.25 + Math.sin(titleOrbitAngle * 0.7) * 0.35 + userPitchOffset * 2.8,
            2.1,
            7.2
          ),
          9.6
        );
        camera.lookAt(0, 1.35, -20);
      } else if (activePhase === 'playing') {
        if (gp.connected) {
          if (gp.xJustPressed) {
            gameActionsRef.current?.skipWaypoint(-1);
          } else if (gp.bJustPressed) {
            gameActionsRef.current?.skipWaypoint(1);
          }
          if (gp.yJustPressed) {
            setCameraView((prev) => {
              const next: CorridorCameraView = prev === 'chase' ? 'cockpit' : 'chase';
              cameraViewRef.current = next;
              return next;
            });
          }
          if (Math.abs(gp.rightX) > 0.01 || Math.abs(gp.rightY) > 0.01) {
            recenteringCamera = false;
            userYawOffset = THREE.MathUtils.clamp(
              userYawOffset + gp.rightX * dt * 1.65,
              -0.78,
              0.78
            );
            userPitchOffset = THREE.MathUtils.clamp(
              userPitchOffset + gp.rightY * dt * 1.25,
              -0.32,
              0.46
            );
            syncCameraOffsetFlag(
              Math.abs(userYawOffset) > 0.025 || Math.abs(userPitchOffset) > 0.025
            );
          }
        }

        if (hitstopTimer > 0) {
          hitstopTimer -= dt;
        } else {
          // Gamepad analog stick hysteresis for crisp 3-lane snaps
          let gpSteerDir: -1 | 0 | 1 = 0;
          if (gp.connected) {
            if (gp.dpadLeftJustPressed) {
              gpSteerDir = -1;
            } else if (gp.dpadRightJustPressed) {
              gpSteerDir = 1;
            } else if (gp.leftX < -0.46 && analogLaneLatch !== -1) {
              analogLaneLatch = -1;
              gpSteerDir = -1;
            } else if (gp.leftX > 0.46 && analogLaneLatch !== 1) {
              analogLaneLatch = 1;
              gpSteerDir = 1;
            } else if (Math.abs(gp.leftX) < 0.24) {
              analogLaneLatch = 0;
            }
          }

          // Steering & Boost Inputs
          if (justPressed.ArrowLeft || justPressed.KeyA || gpSteerDir === -1) {
            laneBufferDir = -1;
            laneBufferTimer = 0.16;
          } else if (justPressed.ArrowRight || justPressed.KeyD || gpSteerDir === 1) {
            laneBufferDir = 1;
            laneBufferTimer = 0.16;
          }

          const boostTriggered =
            justPressed.Space ||
            justPressed.ArrowUp ||
            justPressed.KeyW ||
            (gp.connected && (gp.aJustPressed || gp.rt > 0.55));

          if (
            boostTriggered &&
            physicsModeRef.current === 'gravityExploration' &&
            courierGravY <= 0.06
          ) {
            courierGravVelY = 7.6;
            courierPitchVel -= 1.4;
          }

          if (boostTriggered && boostCharge >= 35 && boostTimer <= 0) {
            if (currentMode === 'explore' && cruisePausedRef.current) {
              setCruisePaused(false);
            }
            boostTimer = 1.3;
            boostCharge = Math.max(0, boostCharge - 35);
            hitstopTimer = 0.024;
            shakeIntensity = Math.max(shakeIntensity, 0.14);
            suspVel += 0.95;
            courierPitchVel -= 1.8;
            sfxRef.current.playBoost();
          }

          if (laneCooldown > 0) laneCooldown -= dt;
          if (laneBufferTimer > 0) {
            laneBufferTimer -= dt;
            if (laneCooldown <= 0 && laneBufferDir !== 0) {
              const nextLane = Math.max(0, Math.min(2, currentLane + laneBufferDir));
              if (nextLane !== currentLane) {
                currentLane = nextLane;
                laneCooldown = 0.11;
                suspVel -= 0.42;
              }
              laneBufferDir = 0;
              laneBufferTimer = 0;
            }
          }

          const isBoosting = boostTimer > 0;
          if (isBoosting) {
            boostTimer -= dt;
          } else {
            boostCharge = Math.min(100, boostCharge + dt * 15);
          }

          // Advance distance: either smooth exponential warp to selected checkpoint OR continuous cruise/run
          const prevDistance = distance;
          prevSpeed = speed;
          if (warpTargetDistance !== null) {
            distance = THREE.MathUtils.damp(distance, warpTargetDistance, 5.4, dt);
            const effectiveVel = Math.abs(distance - prevDistance) / Math.max(dt, 0.001);
            speed = Math.max(18, Math.min(95, effectiveVel * Z_PER_METER));
            if (Math.abs(warpTargetDistance - distance) < 0.8) {
              distance = warpTargetDistance;
              warpTargetDistance = null;
            }
          } else {
            const baseTargetSpeed =
              currentMode === 'explore'
                ? cruisePausedRef.current
                  ? 0
                  : 25
                : 37 + Math.min(24, distance * 0.01);
            const targetSpeed = isBoosting ? baseTargetSpeed * 1.5 : baseTargetSpeed;
            speed = THREE.MathUtils.damp(speed, targetSpeed, 7.5, dt);
            distance += speed * dt * METERS_PER_Z;

            // In Explore Journey mode, loop seamlessly back to start after passing the final archway
            if (currentMode === 'explore' && distance > sectorFinish) {
              distance = 0;
              clearedCheckpointIds.clear();
              activeCheckpointIdx = 0;
            }
          }

          thrusterMat.emissiveIntensity = isBoosting ? 4.6 : speed < 2 ? 1.4 : 2.5;
          if (currentMode === 'arcade') {
            score += Math.round(speed * dt * (isBoosting ? 2.4 : 1.1));
          }

          const worldScroll = distance * Z_PER_METER;
          roadTex.offset.y = -(worldScroll * 0.08);
          wetRoadHandle.setTelemetry(
            elapsed,
            THREE.MathUtils.clamp(speed / 55, 0, 1.35)
          );
          updateEnvironmentInstances(worldScroll);
          updateCheckpointGates(distance, elapsed);

          // Check Checkpoint Portal Crossings & Nearest Active Checkpoint
          let currentIdx = 0;
          for (let i = 0; i < cps.length; i++) {
            const cp = cps[i];
            if (distance >= cp.distanceMeters - 30) {
              currentIdx = i;
            }
            if (
              prevDistance < cp.distanceMeters &&
              distance >= cp.distanceMeters &&
              !clearedCheckpointIds.has(cp.id)
            ) {
              clearedCheckpointIds.add(cp.id);
              score += currentMode === 'arcade' ? 250 * combo : 100;
              suspVel += 0.55;
              _burstPos.set(courierX, 2.2, -1.5);
              spawnBurst(_burstPos, false);
              sfxRef.current.playCheckpoint();
              showCheckpointToast(cp);
              if (cp.waypointId) {
                lastExternalFocusRef.current = cp.waypointId;
                onFocusWaypointRef.current?.(cp.waypointId);
              }
            }
          }
          activeCheckpointIdx = currentIdx;

          // Second-order spring suspension + longitudinal pitch squat/dive + lateral roll
          const targetX = LANE_X[currentLane];
          const prevX = courierX;
          courierX = THREE.MathUtils.damp(courierX, targetX, 15, dt);
          const vx = (courierX - prevX) / Math.max(dt, 0.001);
          const accel = THREE.MathUtils.clamp(
            (speed - prevSpeed) / Math.max(dt, 0.001),
            -65,
            65
          );

          // Vertical spring: stiffness 84, damping 11
          const suspForce = -84 * suspY - 11 * suspVel;
          suspVel += suspForce * dt;
          suspY = THREE.MathUtils.clamp(suspY + suspVel * dt, -0.18, 0.22);

          // Pitch spring: positive accel squats tail (nose up slightly), braking dives nose
          const targetPitch = THREE.MathUtils.clamp(-accel * 0.0024, -0.12, 0.14);
          const pitchForce = 92 * (targetPitch - courierPitch) - 12.5 * courierPitchVel;
          courierPitchVel += pitchForce * dt;
          courierPitch = THREE.MathUtils.clamp(
            courierPitch + courierPitchVel * dt,
            -0.22,
            0.24
          );

          courierTilt = THREE.MathUtils.damp(
            courierTilt,
            THREE.MathUtils.clamp(-vx * 0.038, -0.36, 0.36),
            14,
            dt
          );
          const isGravityPlay = physicsModeRef.current === 'gravityExploration';
          if (isGravityPlay) {
            courierGravVelY -= 21.5 * dt;
            courierGravY += courierGravVelY * dt;
            if (courierGravY <= 0) {
              const landingSpeed = -courierGravVelY;
              courierGravY = 0;
              if (landingSpeed > 2.4) {
                courierGravVelY = landingSpeed * 0.28;
                suspVel -= Math.min(1.3, landingSpeed * 0.14);
                _burstPos.set(courierX, 0.12, 0);
                spawnBurst(_burstPos, false);
                sfxRef.current.playFloorBounce(landingSpeed / 7.5);
              } else {
                courierGravVelY = 0;
              }
            }
          } else {
            courierGravY = THREE.MathUtils.damp(courierGravY, 0, 8, dt);
            courierGravVelY = 0;
          }

          const hoverBob = isGravityPlay
            ? courierGravY + suspY * 0.85
            : Math.sin(elapsed * 3.6) * 0.048 + suspY;
          const baseClearance = isGravityPlay ? 0.11 : 0.16;
          courier.position.set(courierX, baseClearance + hoverBob, 0);
          courier.rotation.set(courierPitch, -vx * 0.008, courierTilt);
          contactShadow.position.y = 0.025 - hoverBob;

          // Step interactive 3D Map Waypoints (Smooth Orbit vs Gravity Exploration floor & courier collisions)
          waypointPhysics.step({
            dt,
            elapsed,
            currentMeters: distance,
            zPerMeter: Z_PER_METER,
            corridorSpeed: speed,
            courierPos: courier.position,
            courierVisible: true,
            checkpoints: cps,
            clearedIds: clearedCheckpointIds,
            onFloorImpact: (ev) => {
              if (ev.impactSpeed > 4.0) {
                spawnBurst(ev.position, false);
              }
              sfxRef.current.playFloorBounce(ev.impactSpeed / 8);
            },
            onCourierCollide: (ev) => {
              score += 150 * combo;
              boostCharge = Math.min(100, boostCharge + 14);
              suspVel -= 0.88;
              shakeIntensity = Math.max(shakeIntensity, 0.16);
              spawnBurst(ev.position, false);
              sfxRef.current.playFloorBounce(1.25);
              const collidedCp = cps[ev.checkpoint.index];
              if (collidedCp) {
                showCheckpointToast(collidedCp);
                if (collidedCp.waypointId) {
                  lastExternalFocusRef.current = collidedCp.waypointId;
                  onFocusWaypointRef.current?.(collidedCp.waypointId);
                }
              }
            },
          });

          const isCockpit = cameraViewRef.current === 'cockpit';
          if (isCockpit) {
            courier.visible = false;
          } else if (invulnTimer > 0) {
            invulnTimer -= dt;
            courier.visible = Math.floor(invulnTimer * 18) % 2 === 0;
          } else {
            courier.visible = true;
          }
          if (isCockpit && invulnTimer > 0) {
            invulnTimer -= dt;
          }

          // Spawn & advance roadblock hazards ONLY in Arcade Run mode (keep checkpoint gate zones clear!)
          if (currentMode === 'arcade' && warpTargetDistance === null) {
            hazardSpawnTimer -= dt;
            if (hazardSpawnTimer <= 0) {
              const interval = Math.max(0.48, 1.08 - distance * 0.00022);
              hazardSpawnTimer = interval;
              const futureMeters = distance + 112 * METERS_PER_Z;
              const nearGate = cps.some(
                (cp) => Math.abs(cp.distanceMeters - futureMeters) < 26
              );
              if (!nearGate) {
                const spawnDouble = distance > 350 && Math.random() < 0.36;
                const firstLane = Math.floor(Math.random() * 3);
                const lanesToSpawn = [firstLane];
                if (spawnDouble) {
                  lanesToSpawn.push(
                    (firstLane + 1 + Math.floor(Math.random() * 2)) % 3
                  );
                }
                for (const ln of lanesToSpawn) {
                  const slot = hazards.find((h) => !h.active);
                  if (slot) {
                    slot.active = true;
                    slot.lane = ln;
                    slot.z = -112;
                    slot.passed = false;
                    slot.mesh.position.set(LANE_X[ln], 0, slot.z);
                    slot.mesh.visible = true;
                  }
                }
              }
            }

            for (const h of hazards) {
              if (!h.active) continue;
              h.z += speed * dt;
              h.mesh.position.z = h.z;
              h.mesh.children[2].rotation.y += dt * 4.5;

              if (
                !h.passed &&
                Math.abs(h.z) < 1.6 &&
                Math.abs(LANE_X[h.lane] - courierX) < 1.35
              ) {
                if (invulnTimer <= 0) {
                  h.active = false;
                  h.mesh.visible = false;
                  shield -= 1;
                  combo = 1;
                  invulnTimer = 1.25;
                  hitstopTimer = 0.045;
                  shakeIntensity = 0.52;
                  suspVel -= 1.85;
                  courierPitchVel += 2.6;
                  _burstPos.set(courierX, 1.0, -0.5);
                  spawnBurst(_burstPos, true);
                  sfxRef.current.playHit();

                  if (shield <= 0) {
                    const finalSnapshot: HudSnapshot = {
                      score,
                      capsules: capsulesCollected,
                      distance: Math.round(distance),
                      combo,
                      bestCombo,
                      shield: 0,
                      boostCharge: Math.round(boostCharge),
                      speedKmh: Math.round(speed * 4.6),
                      activeCheckpointIdx,
                      clearedCheckpoints: clearedCheckpointIds.size,
                    };
                    setHud(finalSnapshot);
                    setPhase('gameover');
                    void submitFinalRun(finalSnapshot);
                  }
                }
              } else if (h.z > 10) {
                h.active = false;
                h.mesh.visible = false;
              }
            }
          }

          // Priority Data Capsules (spawned in both Explore & Arcade for tactile expressway energy)
          if (speed > 4 && warpTargetDistance === null) {
            capsuleSpawnTimer -= dt;
            if (capsuleSpawnTimer <= 0) {
              capsuleSpawnTimer =
                currentMode === 'explore'
                  ? 1.15 + Math.random() * 0.45
                  : 0.72 + Math.random() * 0.38;
              const slot = capsules.find((c) => !c.active);
              if (slot) {
                const ln = Math.floor(Math.random() * 3);
                slot.active = true;
                slot.lane = ln;
                slot.z = -118;
                slot.mesh.position.set(LANE_X[ln], 0, slot.z);
                slot.mesh.visible = true;
              }
            }
          }

          for (const c of capsules) {
            if (!c.active) continue;
            c.z += speed * dt;
            c.mesh.position.z = c.z;
            c.mesh.rotation.y += dt * 3.2;

            if (
              Math.abs(c.z) < 1.65 &&
              Math.abs(LANE_X[c.lane] - courierX) < 1.38
            ) {
              c.active = false;
              c.mesh.visible = false;
              capsulesCollected += 1;
              combo = Math.min(12, combo + 1);
              bestCombo = Math.max(bestCombo, combo);
              score += 120 * combo;
              boostCharge = Math.min(100, boostCharge + 18);
              _burstPos.set(courierX, 1.1, -0.4);
              spawnBurst(_burstPos, false);
              sfxRef.current.playPickup(combo);
            } else if (c.z > 10) {
              c.active = false;
              c.mesh.visible = false;
            }
          }

          // Arcade Victory when clearing the Final Destination Sector
          if (
            currentMode === 'arcade' &&
            distance >= sectorFinish &&
            shield > 0
          ) {
            score += 1500 + shield * 500 + clearedCheckpointIds.size * 200;
            const finalSnapshot: HudSnapshot = {
              score,
              capsules: capsulesCollected,
              distance: Math.round(sectorFinish),
              combo,
              bestCombo,
              shield,
              boostCharge: Math.round(boostCharge),
              speedKmh: Math.round(speed * 4.6),
              activeCheckpointIdx: Math.max(0, cps.length - 1),
              clearedCheckpoints: cps.length,
            };
            sfxRef.current.playVictory();
            setHud(finalSnapshot);
            setPhase('victory');
            void submitFinalRun(finalSnapshot);
          }

          // Particles (with stage-floor bounce in Gravity Exploration mode)
          for (const p of particles) {
            if (p.life <= 0) continue;
            p.life -= dt;
            if (p.life <= 0) {
              p.mesh.visible = false;
            } else {
              p.mesh.position.addScaledVector(p.vel, dt);
              p.vel.y -= 14 * dt;
              if (
                physicsModeRef.current === 'gravityExploration' &&
                p.mesh.position.y < 0.06 &&
                p.vel.y < 0
              ) {
                p.mesh.position.y = 0.06;
                p.vel.y = -p.vel.y * 0.58;
              }
              p.mesh.rotation.x += dt * 7;
              p.mesh.rotation.y += dt * 5;
            }
          }

          // Smooth spring-damped chase camera + persistent 2-axis drag-look with explicit Reset Camera
          if (recenteringCamera && !pointerDragging) {
            userYawOffset = THREE.MathUtils.damp(userYawOffset, 0, 11, dt);
            userPitchOffset = THREE.MathUtils.damp(userPitchOffset, 0, 11, dt);
            if (
              Math.abs(userYawOffset) < 0.002 &&
              Math.abs(userPitchOffset) < 0.002
            ) {
              userYawOffset = 0;
              userPitchOffset = 0;
              recenteringCamera = false;
            }
          }
          shakeIntensity = Math.max(0, shakeIntensity - dt * 2.2);
          const shakeX = (Math.random() - 0.5) * shakeIntensity;
          const shakeY = (Math.random() - 0.5) * shakeIntensity;
          const speedRatio = THREE.MathUtils.clamp((speed - 20) / 48, 0, 1);
          const baseFov = cameraViewRef.current === 'cockpit' ? 58 : 55;
          const targetFov = Math.min(
            70,
            baseFov +
              speedRatio * 10.5 +
              (boostTimer > 0 || warpTargetDistance !== null ? 4.5 : 0)
          );
          if (Math.abs(camera.fov - targetFov) > 0.04) {
            camera.fov = THREE.MathUtils.damp(camera.fov, targetFov, 7.5, dt);
            camera.updateProjectionMatrix();
          }

          if (cameraViewRef.current === 'cockpit') {
            camera.position.set(
              courierX + Math.sin(userYawOffset) * 0.35 + shakeX * 0.45,
              1.38 + suspY * 0.55 + Math.sin(elapsed * 3.6) * 0.02 + shakeY * 0.45,
              -0.82
            );
            _camLookTarget.set(
              courierX * 0.72 - Math.sin(userYawOffset) * 7.2 - courierTilt * 3.2,
              1.28 - userPitchOffset * 3.4 - courierPitch * 4.5,
              -34
            );
            camera.lookAt(_camLookTarget);
          } else {
            camera.position.set(
              courierX * 0.44 + Math.sin(userYawOffset) * 5.6 + shakeX,
              THREE.MathUtils.clamp(
                4.25 + userPitchOffset * 3.4 + suspY * 0.35,
                2.2,
                7.6
              ) + shakeY,
              9.4 - Math.abs(Math.sin(userYawOffset)) * 0.8
            );
            _camLookTarget.set(
              courierX * 0.25 - Math.sin(userYawOffset) * 4.8,
              1.9 - userPitchOffset * 2.6 - courierPitch * 2.2,
              -18
            );
            camera.lookAt(_camLookTarget);
          }

          // Throttled HUD React sync (12Hz)
          hudSyncAccum += dt;
          if (hudSyncAccum >= 0.08) {
            hudSyncAccum = 0;
            setHud({
              score,
              capsules: capsulesCollected,
              distance: Math.round(distance),
              combo,
              bestCombo,
              shield,
              boostCharge: Math.round(boostCharge),
              speedKmh: Math.round(speed * 4.6),
              activeCheckpointIdx,
              clearedCheckpoints: clearedCheckpointIds.size,
            });
          }
        }
      }

      for (const k of Object.keys(justPressed)) {
        justPressed[k] = false;
      }

      renderer.render(scene, camera);
      scheduleNextFrame(tick);
    };

    // rAF-coalesced ResizeObserver
    let resizeRaf = 0;
    const ro = new ResizeObserver(() => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        if (!container || disposed) return;
        const w = container.clientWidth || 960;
        const h = container.clientHeight || 580;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setPixelRatio(
          computeTierPixelRatio(
            currentAppliedTier,
            effectiveFullscreenRef.current,
            isSoftwareGl
          )
        );
        renderer.setSize(w, h);
      });
    });
    ro.observe(container);

    scheduleNextFrame(tick);

    return () => {
      disposed = true;
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      if (frameId) {
        if (isTimerFrame) window.clearTimeout(frameId);
        else cancelAnimationFrame(frameId);
      }
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener(
        'webglcontextlost',
        handleContextLost,
        false
      );
      renderer.domElement.removeEventListener(
        'webglcontextrestored',
        handleContextRestored,
        false
      );
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);

      envTarget.dispose();
      dirLight.shadow.map?.dispose();
      roadTex.dispose();
      contactShadowTex.dispose();
      signTextureCache.forEach((tex) => tex.dispose());
      signTextureCache.clear();
      waypointPhysics.dispose();

      // Deduplicated disposal of shared geometries & materials
      const disposedGeos = new Set<THREE.BufferGeometry>();
      const disposedMats = new Set<THREE.Material>();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          if (!disposedGeos.has(obj.geometry)) {
            disposedGeos.add(obj.geometry);
            obj.geometry.dispose();
          }
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach((m) => {
            if (!disposedMats.has(m)) {
              disposedMats.add(m);
              m.dispose();
            }
          });
        }
      });
      renderer.dispose();
      gameActionsRef.current = null;
    };
    // Intentionally single-mount lifecycle; dynamic props read via refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeCheckpoint =
    checkpoints[Math.min(hud.activeCheckpointIdx, checkpoints.length - 1)] ||
    checkpoints[0];
  const progressPct = Math.min(
    100,
    Math.round((hud.distance / Math.max(1, totalSectorMeters)) * 100)
  );
  const editionHeading =
    briefing?.editionTitle ||
    (waypoints.length > 0
      ? `${waypoints.length}-Stop Dispatch Corridor`
      : 'Dispatch Briefing Corridor');

  const isCurrentSegmentPlaying =
    Boolean(isPlayingAudio) &&
    typeof activeCheckpoint?.segmentIndex === 'number' &&
    activeSegmentIndex === activeCheckpoint.segmentIndex;

  return (
    <div
      ref={rootRef}
      className={`${
        isImmersiveMode
          ? 'relative w-full h-full min-h-screen'
          : internalFullscreen
            ? 'fixed inset-0 z-50 h-screen w-screen'
            : 'relative w-full h-[calc(100vh-8.5rem)] min-h-[580px]'
      } bg-[#090D16] overflow-hidden select-none`}
    >
      {/* Isolated Three.js Canvas Mount */}
      <div ref={mountRef} className="w-full h-full" />

      {/* WebGL Context Lost Recovery Banner */}
      {contextLost && (
        <div className="absolute inset-0 bg-[#090D16]/95 flex items-center justify-center p-6 z-30">
          <div className="max-w-sm bg-[#11151E] border border-amber-400/45 rounded-xl p-5 text-center space-y-2">
            <AlertTriangle className="w-6 h-6 text-amber-400 mx-auto" />
            <h3 className="text-sm font-semibold text-[#F5F7FA]">
              Graphics Context Paused
            </h3>
            <p className="text-xs text-[#8C96A8]">
              Waiting for WebGL to restore automatically.
            </p>
          </div>
        </div>
      )}

      {/* ---------- TITLE SCREEN (Live Atmospheric Briefing Corridor Behind) ---------- */}
      {phase === 'title' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center bg-[#090D16]/55 z-10">
          <div className="absolute top-4 right-5 flex items-center gap-2">
            {onOpenMapPlanner && (
              <button
                type="button"
                onClick={() => onOpenMapPlanner(activeCheckpoint?.waypointId)}
                className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#C7D0DF] hover:text-[#F5F7FA] bg-[#0B0F17]/95 border border-white/15 rounded-lg whitespace-nowrap cursor-pointer"
              >
                <MapPin className="w-3.5 h-3.5 text-[#22D3EE]" />
                Plan Waypoints on Map
              </button>
            )}
            <button
              type="button"
              onClick={handleToggleFullscreen}
              className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#C7D0DF] hover:text-[#F5F7FA] bg-[#0B0F17]/95 border border-[#22D3EE]/35 rounded-lg whitespace-nowrap cursor-pointer"
            >
              {effectiveFullscreen ? (
                <>
                  <Minimize2 className="w-3.5 h-3.5 text-[#22D3EE]" />
                  Exit Immersive
                </>
              ) : (
                <>
                  <Maximize2 className="w-3.5 h-3.5 text-[#22D3EE]" />
                  Immersive Mode
                </>
              )}
            </button>
          </div>

          {/* Bespoke Inline SVG Title Lockup */}
          <svg
            viewBox="0 0 540 120"
            className="w-full max-w-[460px] h-auto mb-3"
            role="img"
            aria-label="Dispatch Run 3D"
          >
            <defs>
              <linearGradient id="drCyanGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#67E8F9" />
                <stop offset="55%" stopColor="#22D3EE" />
                <stop offset="100%" stopColor="#F59E0B" />
              </linearGradient>
            </defs>
            <path
              d="M36 96 L504 96"
              stroke="url(#drCyanGrad)"
              strokeWidth="3"
              strokeLinecap="round"
            />
            <polygon points="48,18 68,18 56,34 36,34" fill="#22D3EE" />
            <polygon points="74,18 90,18 78,34 62,34" fill="#F59E0B" />
            <text
              x="270"
              y="76"
              textAnchor="middle"
              fill="#F5F7FA"
              fontFamily="Georgia, serif"
              fontWeight="700"
              fontSize="50"
              letterSpacing="4"
            >
              DISPATCH RUN 3D
            </text>
            <text
              x="270"
              y="114"
              textAnchor="middle"
              fill="#67E8F9"
              fontFamily="ui-monospace, SFMono-Regular, monospace"
              fontSize="12"
              letterSpacing="4"
            >
              BRIEFING JOURNEY · WAYPOINT CORRIDOR
            </text>
          </svg>

          {/* Clean unboxed journey metadata summary */}
          <div className="flex items-center justify-center gap-2 text-xs text-[#C7D0DF] mb-5 flex-wrap max-w-xl">
            <span className="font-medium text-[#F5F7FA] truncate max-w-[280px]">
              {editionHeading}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums text-[#67E8F9]">
              {checkpoints.length} Checkpoints
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              {waypoints.length > 0
                ? `${waypoints.length} Map Stops Synced`
                : 'Editorial Chapters Ready'}
            </span>
          </div>

          {/* Live Real-Time Physics Toggle on Title Stage */}
          <div className="mb-4 inline-flex items-center gap-1 p-1 bg-[#0B0F17]/95 border border-white/15 rounded-lg">
            <button
              type="button"
              onClick={() => handleSelectPhysicsMode('smoothOrbit')}
              className={`h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                physicsMode === 'smoothOrbit'
                  ? 'bg-[#22D3EE] text-[#071318] font-semibold'
                  : 'text-[#9FB0C4] hover:text-[#F5F7FA]'
              }`}
            >
              <Orbit className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Smooth Orbit</span>
            </button>
            <button
              type="button"
              onClick={() => handleSelectPhysicsMode('gravityExploration')}
              className={`h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                physicsMode === 'gravityExploration'
                  ? 'bg-[#F59E0B] text-[#170F02] font-semibold'
                  : 'text-[#9FB0C4] hover:text-[#F5F7FA]'
              }`}
            >
              <ArrowDownToLine className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Gravity Exploration</span>
            </button>
            {physicsMode === 'gravityExploration' && (
              <button
                type="button"
                onClick={handleDropWaypoints}
                title="Drop waypoints onto the stage floor (V)"
                className="h-8 px-2.5 inline-flex items-center gap-1 text-xs font-medium text-[#FDE68A] hover:text-[#F5F7FA] bg-[#141B27] border border-[#F59E0B]/35 rounded-md cursor-pointer whitespace-nowrap shrink-0"
              >
                <ArrowUpDown className="w-3.5 h-3.5 text-[#F59E0B]" aria-hidden="true" />
                <span>Drop</span>
              </button>
            )}
          </div>

          {/* Primary Launch Actions: Explore Journey vs Arcade Run */}
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={() => gameActionsRef.current?.startRun('explore')}
              className="h-11 px-6 inline-flex items-center gap-2 bg-[#22D3EE] hover:bg-[#67E8F9] text-[#071318] font-semibold text-sm rounded-lg transition-colors cursor-pointer whitespace-nowrap"
            >
              <Compass className="w-4 h-4" />
              Explore Briefing Journey
            </button>
            <button
              type="button"
              onClick={() => gameActionsRef.current?.startRun('arcade')}
              className="h-11 px-6 inline-flex items-center gap-2 bg-[#0E131D]/95 hover:bg-[#161F2E] text-[#F5F7FA] border border-[#22D3EE]/40 font-semibold text-sm rounded-lg transition-colors cursor-pointer whitespace-nowrap"
            >
              <Gamepad2 className="w-4 h-4 text-[#F59E0B]" />
              Arcade Challenge Run
            </button>
          </div>

          <p className="mt-4 text-xs font-mono text-[#9FB0C4]">
            A/D Steer · G Physics Toggle · Click Waypoint to Bounce · Space Boost/Hop · C Cockpit Cam
          </p>

          {personalBest > 0 && (
            <p className="mt-2 text-xs text-[#67E8F9] font-mono tabular-nums">
              Personal Best: {personalBest.toLocaleString()}
            </p>
          )}
        </div>
      )}

      {/* ---------- PLAYING HUD (Hidden in Full-Screen Immersive Mode for a 100% Clean 3D Corridor Viewport) ---------- */}
      {phase === 'playing' && !isImmersiveMode && (
        <>
          {/* Top-Right Compact Telemetry & Utility Controls (keeps top-left clear for ImmersiveRouteOverlay) */}
          <div
            className={`pointer-events-none absolute ${
              isImmersiveMode ? 'top-14' : 'top-4'
            } right-5 z-20 flex flex-col items-end gap-2`}
          >
            <div className="pointer-events-auto flex items-center gap-2 bg-[#0B0F17]/95 border border-white/15 rounded-lg p-1">
              <button
                type="button"
                onClick={() => gameActionsRef.current?.switchModeLive('explore')}
                className={`h-7 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  runMode === 'explore'
                    ? 'bg-[#22D3EE] text-[#071318] font-semibold'
                    : 'text-[#9FB0C4] hover:text-[#F5F7FA]'
                }`}
              >
                <Compass className="w-3.5 h-3.5" />
                Explore
              </button>
              <button
                type="button"
                onClick={() => gameActionsRef.current?.switchModeLive('arcade')}
                className={`h-7 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  runMode === 'arcade'
                    ? 'bg-[#F59E0B] text-[#170F02] font-semibold'
                    : 'text-[#9FB0C4] hover:text-[#F5F7FA]'
                }`}
              >
                <Gamepad2 className="w-3.5 h-3.5" />
                Arcade
              </button>

              <span className="w-px h-4 bg-white/10" aria-hidden="true" />

              <button
                type="button"
                onClick={() => handleSelectPhysicsMode('smoothOrbit')}
                title="Smooth Orbit physics — weightless harmonic waypoint paths (G)"
                className={`h-7 px-2 inline-flex items-center gap-1 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  physicsMode === 'smoothOrbit'
                    ? 'bg-[#22D3EE]/20 text-[#67E8F9] border border-[#22D3EE]/45'
                    : 'text-[#9FB0C4] hover:text-[#F5F7FA]'
                }`}
              >
                <Orbit className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden md:inline">Smooth Orbit</span>
              </button>
              <button
                type="button"
                onClick={() => handleSelectPhysicsMode('gravityExploration')}
                title="Gravity Exploration physics — waypoints collide with the stage floor & courier (G)"
                className={`h-7 px-2 inline-flex items-center gap-1 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  physicsMode === 'gravityExploration'
                    ? 'bg-[#F59E0B]/20 text-[#FDE68A] border border-[#F59E0B]/50'
                    : 'text-[#9FB0C4] hover:text-[#F5F7FA]'
                }`}
              >
                <ArrowDownToLine className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden md:inline">Gravity Exploration</span>
              </button>

              <span className="w-px h-4 bg-white/10" aria-hidden="true" />

              <button
                type="button"
                onClick={() => setMuted((m) => !m)}
                title={muted ? 'Unmute synth audio' : 'Mute synth audio'}
                className="w-7 h-7 inline-flex items-center justify-center rounded text-[#C7D0DF] hover:text-[#F5F7FA] hover:bg-white/5 cursor-pointer"
              >
                {muted ? (
                  <VolumeX className="w-3.5 h-3.5" />
                ) : (
                  <Volume2 className="w-3.5 h-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => gameActionsRef.current?.togglePause()}
                title="Pause"
                className="w-7 h-7 inline-flex items-center justify-center rounded text-[#C7D0DF] hover:text-[#F5F7FA] hover:bg-white/5 cursor-pointer"
              >
                <Pause className="w-3.5 h-3.5" />
              </button>
              {!isImmersiveMode && (
                <>
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
                    title={`Adaptive Quality (${effectiveAdaptive ? `Auto · ${QUALITY_TIER_SPECS[activeTier].label}` : QUALITY_TIER_SPECS[manualQualityTier].label})`}
                    className={`h-7 px-2 inline-flex items-center gap-1 rounded text-[11px] font-medium cursor-pointer whitespace-nowrap transition-colors ${
                      effectiveAdaptive
                        ? 'bg-[#22D3EE]/15 text-[#67E8F9]'
                        : 'text-[#9FB0C4] hover:text-[#F5F7FA] hover:bg-white/5'
                    }`}
                  >
                    <Gauge className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{QUALITY_TIER_SPECS[activeTier].label}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleToggleFullscreen}
                    title="Enter Immersive Full-Screen"
                    className="w-7 h-7 inline-flex items-center justify-center rounded text-[#22D3EE] hover:bg-white/5 cursor-pointer"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>

            {/* Compact Arcade / Speed Readout */}
            <div className="bg-[#0B0F17]/95 border border-[#22D3EE]/30 rounded-lg px-3.5 py-2 text-right">
              {runMode === 'arcade' ? (
                <>
                  <div className="flex items-center justify-end gap-3 font-mono tabular-nums">
                    <span className="text-lg font-bold text-[#F5F7FA]">
                      {hud.score.toLocaleString()}
                    </span>
                    <span className="text-xs text-[#67E8F9]">x{hud.combo}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-end gap-1.5">
                    {[0, 1, 2].map((idx) => (
                      <span
                        key={idx}
                        className={`w-5 h-1.5 rounded-sm ${
                          idx < hud.shield ? 'bg-[#22D3EE]' : 'bg-[#1F2735]'
                        }`}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <div className="text-xs text-[#C7D0DF] font-mono tabular-nums">
                  {hud.distance}m / {totalSectorMeters}m · {hud.speedKmh} km/h
                </div>
              )}
            </div>
          </div>

          {/* Checkpoint Arrival Toast (Top Center, non-blocking) */}
          {arrivalBanner && (
            <div
              className={`pointer-events-none absolute ${
                isImmersiveMode ? 'top-14' : 'top-4'
              } left-1/2 -translate-x-1/2 z-20 bg-[#0B0F17]/95 border border-[#22D3EE]/45 rounded-lg px-4 py-2 text-center shadow-lg transition-opacity duration-200`}
            >
              <div className="text-[11px] font-mono text-[#67E8F9] tabular-nums">
                Checkpoint {String(arrivalBanner.step).padStart(2, '0')} Reached
              </div>
              <div className="text-sm font-semibold text-[#F5F7FA] truncate max-w-[320px]">
                {arrivalBanner.title}
              </div>
            </div>
          )}

          {/* ---------- BOTTOM OVERLAY CONTROLS: Minimal Immersive Bar vs Expanded Journey Drawer ---------- */}
          <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 z-20 w-[min(920px,94vw)] flex flex-col items-center gap-2">
            {/* Optional Expandable Journey & Briefing Drawer (tucked away by default in Immersive Mode) */}
            {!hudCollapsed && (
              <div className="pointer-events-auto w-full bg-[#0B0F17]/95 border border-[#22D3EE]/35 rounded-xl p-4 shadow-2xl">
                {/* Row 1: Navigable Waypoint / Chapter Scrubber */}
                <div className="flex items-center gap-2 pb-3 border-b border-white/10">
                  <button
                    type="button"
                    onClick={() => gameActionsRef.current?.skipWaypoint(-1)}
                    disabled={checkpoints.length <= 1}
                    title="Previous Checkpoint ([)"
                    className="w-8 h-8 inline-flex items-center justify-center rounded-md bg-[#131924] border border-white/10 text-[#C7D0DF] hover:text-[#F5F7FA] disabled:opacity-35 cursor-pointer shrink-0"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>

                  <div className="flex-1 flex items-center gap-1.5 overflow-x-auto py-0.5">
                    {checkpoints.map((cp, idx) => {
                      const isActive = idx === hud.activeCheckpointIdx;
                      const isPassed = hud.distance >= cp.distanceMeters;
                      return (
                        <button
                          key={cp.id}
                          type="button"
                          onClick={() =>
                            gameActionsRef.current?.warpToCheckpoint(idx, false)
                          }
                          title={`${idx + 1}. ${cp.title} — ${cp.chapterTitle}`}
                          className={`h-8 px-2.5 inline-flex items-center gap-1.5 rounded-md text-xs transition-colors whitespace-nowrap shrink-0 cursor-pointer border ${
                            isActive
                              ? 'bg-[#22D3EE]/20 border-[#22D3EE] text-[#F5F7FA] font-semibold'
                              : isPassed
                                ? 'bg-emerald-500/10 border-emerald-400/35 text-emerald-200'
                                : 'bg-[#121722] border-white/10 text-[#9FB0C4] hover:text-[#F5F7FA] hover:border-white/25'
                          }`}
                        >
                          <span className="font-mono text-[11px] tabular-nums text-[#67E8F9]">
                            {String(idx + 1).padStart(2, '0')}.
                          </span>
                          <span className="max-w-[130px] truncate">{cp.title}</span>
                        </button>
                      );
                    })}
                  </div>

                  <button
                    type="button"
                    onClick={() => gameActionsRef.current?.skipWaypoint(1)}
                    disabled={checkpoints.length <= 1}
                    title="Next Checkpoint (])"
                    className="w-8 h-8 inline-flex items-center justify-center rounded-md bg-[#131924] border border-white/10 text-[#C7D0DF] hover:text-[#F5F7FA] disabled:opacity-35 cursor-pointer shrink-0"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>

                {/* Thin Sector Progress Hairline */}
                <svg
                  aria-hidden="true"
                  viewBox="0 0 100 4"
                  preserveAspectRatio="none"
                  className="w-full h-1 rounded-full overflow-hidden my-2.5 block"
                >
                  <rect width="100" height="4" fill="#18202E" />
                  <rect width={progressPct} height="4" fill="#22D3EE" />
                </svg>

                {/* Row 2: Active Checkpoint Briefing Story Beat & Smooth Map Transition */}
                {activeCheckpoint && (
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-xs text-[#9FB0C4] flex-wrap">
                        <span className="font-mono tabular-nums text-[#67E8F9]">
                          {String(activeCheckpoint.index + 1).padStart(2, '0')}.{' '}
                          {activeCheckpoint.roleLabel}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{activeCheckpoint.category}</span>
                        {typeof activeCheckpoint.cumulativeKm === 'number' &&
                          activeCheckpoint.index > 0 && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums">
                                {activeCheckpoint.cumulativeKm} km
                              </span>
                            </>
                          )}
                        {activeCheckpoint.address && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="truncate max-w-[220px]">
                              {activeCheckpoint.address}
                            </span>
                          </>
                        )}
                      </div>

                      <div className="text-sm font-semibold text-[#F5F7FA] truncate mt-0.5">
                        {activeCheckpoint.title}
                        {activeCheckpoint.chapterTitle !== activeCheckpoint.title && (
                          <span className="font-normal text-[#9FB0C4]">
                            {' '}
                            — {activeCheckpoint.chapterTitle}
                          </span>
                        )}
                      </div>

                      <p className="text-xs text-[#B8C4D6] line-clamp-1 mt-0.5">
                        {activeCheckpoint.keyPoint}
                      </p>
                    </div>

                    {/* Action Controls: Cruise/Hold · Briefing Chapter Audio · Map Transition */}
                    <div className="flex items-center gap-2 shrink-0 flex-wrap">
                      {runMode === 'explore' && (
                        <button
                          type="button"
                          onClick={() => setCruisePaused((p) => !p)}
                          className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium bg-[#141B27] hover:bg-[#1B2434] border border-white/15 rounded-lg text-[#F5F7FA] cursor-pointer whitespace-nowrap"
                        >
                          {cruisePaused ? (
                            <>
                              <Play className="w-3.5 h-3.5 text-[#22D3EE] fill-current" />
                              Resume Cruise
                            </>
                          ) : (
                            <>
                              <Pause className="w-3.5 h-3.5 text-[#22D3EE]" />
                              Hold at Gate
                            </>
                          )}
                        </button>
                      )}

                      {typeof activeCheckpoint.segmentIndex === 'number' &&
                        activeCheckpoint.hasAudio &&
                        onSelectBriefingSegment && (
                          <button
                            type="button"
                            onClick={() => {
                              if (
                                isCurrentSegmentPlaying &&
                                onToggleBriefingAudio
                              ) {
                                onToggleBriefingAudio();
                              } else if (
                                typeof activeCheckpoint.segmentIndex === 'number'
                              ) {
                                onSelectBriefingSegment(activeCheckpoint.segmentIndex);
                              }
                            }}
                            className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium bg-[#22D3EE]/15 hover:bg-[#22D3EE]/25 border border-[#22D3EE]/45 rounded-lg text-[#67E8F9] cursor-pointer whitespace-nowrap"
                          >
                            <Headphones className="w-3.5 h-3.5" />
                            {isCurrentSegmentPlaying ? 'Pause Chapter' : 'Play Chapter'}
                          </button>
                        )}

                      {onOpenMapPlanner && (
                        <button
                          type="button"
                          onClick={() => onOpenMapPlanner(activeCheckpoint.waypointId)}
                          className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium bg-[#141B27] hover:bg-[#1B2434] border border-[#22D3EE]/35 rounded-lg text-[#67E8F9] cursor-pointer whitespace-nowrap"
                        >
                          <Navigation className="w-3.5 h-3.5" />
                          {activeCheckpoint.waypointId ? 'View on Map' : 'Plan on Map'}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Minimal Single-Row Overlay Control Panel (Reset Camera · Scene Lighting · Waypoint Skipping) */}
            <DispatchRunImmersivePanel
              lightingMode={lightingMode}
              onToggleLighting={handleToggleLighting}
              physicsMode={physicsMode}
              onTogglePhysicsMode={handleTogglePhysicsMode}
              onDropWaypoints={handleDropWaypoints}
              cameraView={cameraView}
              onToggleCameraView={handleToggleCameraView}
              isCameraOffset={isCameraOffset}
              onResetCamera={() =>
                gameActionsRef.current?.resetCameraOrientation()
              }
              activeCheckpointIndex={hud.activeCheckpointIdx}
              totalCheckpoints={checkpoints.length}
              activeCheckpointTitle={
                activeCheckpoint?.title ?? 'Briefing Origin'
              }
              onSkipPrevWaypoint={() => gameActionsRef.current?.skipWaypoint(-1)}
              onSkipNextWaypoint={() => gameActionsRef.current?.skipWaypoint(1)}
              isExploreMode={runMode === 'explore'}
              cruisePaused={cruisePaused}
              onToggleCruisePause={() => setCruisePaused((p) => !p)}
              hasChapterAudio={Boolean(
                typeof activeCheckpoint?.segmentIndex === 'number' &&
                  activeCheckpoint.hasAudio &&
                  onSelectBriefingSegment
              )}
              isPlayingChapterAudio={isCurrentSegmentPlaying}
              onToggleChapterAudio={() => {
                if (!activeCheckpoint || !onSelectBriefingSegment) return;
                if (isCurrentSegmentPlaying && onToggleBriefingAudio) {
                  onToggleBriefingAudio();
                } else if (typeof activeCheckpoint.segmentIndex === 'number') {
                  onSelectBriefingSegment(activeCheckpoint.segmentIndex);
                }
              }}
              onOpenMap={
                onOpenMapPlanner
                  ? () => onOpenMapPlanner(activeCheckpoint?.waypointId)
                  : undefined
              }
              detailsExpanded={!hudCollapsed}
              onToggleDetails={() => setHudCollapsed((v) => !v)}
            />
          </div>
        </>
      )}

      {/* ---------- PAUSE / VICTORY / GAME OVER MODAL ---------- */}
      {(phase === 'paused' || phase === 'gameover' || phase === 'victory') && (
        <div className="absolute inset-0 bg-[#070A10]/90 flex items-center justify-center p-5 z-30">
          <div className="w-full max-w-md bg-[#11151E] border border-[#22D3EE]/35 rounded-xl p-6 space-y-5">
            <div className="text-center">
              <p className="text-xs text-[#22D3EE] font-medium">
                {phase === 'paused'
                  ? 'Journey Paused'
                  : phase === 'victory'
                    ? 'Route Sector Cleared'
                    : 'Hull Integrity Depleted'}
              </p>
              <h3 className="font-serif text-3xl text-[#F5F7FA] mt-1">
                {phase === 'paused'
                  ? 'Courier Standing By'
                  : phase === 'victory'
                    ? 'Dispatch Delivered'
                    : 'Run Terminated'}
              </h3>
            </div>

            <div className="grid grid-cols-3 gap-2.5 text-center">
              <div className="p-3 bg-[#0B0E15] border border-white/10 rounded-lg">
                <div className="text-[11px] text-[#8C96A8]">Score</div>
                <div className="font-mono text-lg font-bold text-[#67E8F9] tabular-nums mt-0.5">
                  {hud.score.toLocaleString()}
                </div>
              </div>
              <div className="p-3 bg-[#0B0E15] border border-white/10 rounded-lg">
                <div className="text-[11px] text-[#8C96A8]">Checkpoints</div>
                <div className="font-mono text-lg font-bold text-[#F5F7FA] tabular-nums mt-0.5">
                  {hud.clearedCheckpoints}/{checkpoints.length}
                </div>
              </div>
              <div className="p-3 bg-[#0B0E15] border border-white/10 rounded-lg">
                <div className="text-[11px] text-[#8C96A8]">Max Combo</div>
                <div className="font-mono text-lg font-bold text-[#F59E0B] tabular-nums mt-0.5">
                  x{hud.bestCombo}
                </div>
              </div>
            </div>

            {/* Cloud Leaderboard Preview on End Screens */}
            {phase !== 'paused' && (
              <div className="bg-[#0B0E15] border border-white/10 rounded-lg p-3.5">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-[#8C96A8] inline-flex items-center gap-1.5">
                    <Trophy className="w-3.5 h-3.5 text-[#F59E0B]" />
                    Top Runs
                  </span>
                  {scoreSubmitted ? (
                    <span className="text-xs text-[#67E8F9]">Score saved</span>
                  ) : !user ? (
                    <button
                      type="button"
                      onClick={() => void signInWithGoogle()}
                      className="text-xs text-[#67E8F9] hover:underline cursor-pointer"
                    >
                      Sign in to record score
                    </button>
                  ) : null}
                </div>

                {leaderboard.length === 0 ? (
                  <p className="text-xs text-[#8C96A8]">
                    Personal Best:{' '}
                    <span className="font-mono tabular-nums text-[#F5F7FA]">
                      {personalBest.toLocaleString()}
                    </span>
                  </p>
                ) : (
                  <div className="space-y-1.5 max-h-32 overflow-y-auto">
                    {leaderboard.slice(0, 5).map((entry, idx) => (
                      <div
                        key={entry.id}
                        className="flex items-center justify-between text-xs"
                      >
                        <span className="text-[#C7D0DF] truncate">
                          {idx + 1}. {entry.displayName || 'Dispatch Runner'}
                        </span>
                        <span className="font-mono tabular-nums text-[#67E8F9]">
                          {entry.score.toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-2.5 flex-wrap">
              {phase === 'paused' ? (
                <button
                  type="button"
                  onClick={() => gameActionsRef.current?.resumeRun()}
                  className="flex-1 h-10 px-4 inline-flex items-center justify-center gap-2 bg-[#22D3EE] hover:bg-[#67E8F9] text-[#071318] font-semibold text-sm rounded-lg cursor-pointer whitespace-nowrap"
                >
                  <Play className="w-4 h-4 fill-current" />
                  Resume
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => gameActionsRef.current?.startRun('explore')}
                  className="flex-1 h-10 px-4 inline-flex items-center justify-center gap-2 bg-[#141B27] hover:bg-[#1B2434] border border-[#22D3EE]/40 text-[#F5F7FA] font-semibold text-sm rounded-lg cursor-pointer whitespace-nowrap"
                >
                  <Compass className="w-4 h-4 text-[#22D3EE]" />
                  Explore Journey
                </button>
              )}
              <button
                type="button"
                onClick={() => gameActionsRef.current?.startRun('arcade')}
                className="flex-1 h-10 px-4 inline-flex items-center justify-center gap-2 bg-[#22D3EE] hover:bg-[#67E8F9] text-[#071318] font-semibold text-sm rounded-lg cursor-pointer whitespace-nowrap"
              >
                <RotateCcw className="w-4 h-4" />
                {phase === 'paused' ? 'Restart Arcade' : 'Run Again'}
              </button>
            </div>

            <div className="flex items-center gap-2">
              {onOpenMapPlanner && (
                <button
                  type="button"
                  onClick={() => onOpenMapPlanner(activeCheckpoint?.waypointId)}
                  className="flex-1 h-9 inline-flex items-center justify-center gap-1.5 text-xs font-medium text-[#67E8F9] hover:text-[#F5F7FA] bg-[#0B0E15] border border-white/15 rounded-lg cursor-pointer whitespace-nowrap"
                >
                  <MapPin className="w-3.5 h-3.5" />
                  Edit Route on Map
                </button>
              )}
              {effectiveFullscreen && (
                <button
                  type="button"
                  onClick={handleToggleFullscreen}
                  className="flex-1 h-9 inline-flex items-center justify-center gap-1.5 text-xs font-medium text-[#C7D0DF] hover:text-[#F5F7FA] bg-[#0B0E15] border border-white/15 rounded-lg cursor-pointer whitespace-nowrap"
                >
                  <Minimize2 className="w-3.5 h-3.5 text-[#22D3EE]" />
                  Exit Immersive
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
