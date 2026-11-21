import { useState } from 'react';
import {
  ArrowDownToLine,
  Camera,
  ChevronDown,
  ChevronUp,
  Compass,
  Crosshair,
  Headphones,
  Moon,
  Navigation,
  Orbit,
  Pause,
  Play,
  SlidersHorizontal,
  SkipBack,
  SkipForward,
  ArrowUpDown,
  Sun,
  Sunset,
} from 'lucide-react';
import type { CorridorPhysicsMode } from '../three/corridorPhysics';

export type CorridorLightingMode = 'dusk' | 'daylight' | 'night';
export type CorridorCameraView = 'chase' | 'cockpit';
export type { CorridorPhysicsMode };

export interface DispatchRunImmersivePanelProps {
  lightingMode: CorridorLightingMode;
  onToggleLighting: () => void;
  physicsMode?: CorridorPhysicsMode;
  onTogglePhysicsMode?: () => void;
  onDropWaypoints?: () => void;
  cameraView?: CorridorCameraView;
  onToggleCameraView?: () => void;
  isCameraOffset: boolean;
  onResetCamera: () => void;
  activeCheckpointIndex: number;
  totalCheckpoints: number;
  activeCheckpointTitle: string;
  onSkipPrevWaypoint: () => void;
  onSkipNextWaypoint: () => void;
  /** Optional secondary actions kept tucked away unless needed */
  isExploreMode?: boolean;
  cruisePaused?: boolean;
  onToggleCruisePause?: () => void;
  hasChapterAudio?: boolean;
  isPlayingChapterAudio?: boolean;
  onToggleChapterAudio?: () => void;
  onOpenMap?: () => void;
  detailsExpanded?: boolean;
  onToggleDetails?: () => void;
}

const LIGHTING_LABELS: Record<CorridorLightingMode, string> = {
  dusk: 'Dusk',
  daylight: 'Daylight',
  night: 'Night',
};

function LightingIcon({ mode }: { mode: CorridorLightingMode }) {
  if (mode === 'daylight') {
    return <Sun className="w-3.5 h-3.5 text-[#F59E0B]" aria-hidden="true" />;
  }
  if (mode === 'night') {
    return <Moon className="w-3.5 h-3.5 text-[#67E8F9]" aria-hidden="true" />;
  }
  return <Sunset className="w-3.5 h-3.5 text-[#F59E0B]" aria-hidden="true" />;
}

/**
 * Minimal, single-row overlay control panel for 'Dispatch Run 3D'.
 * Uses solid high-opacity dark surfaces (zero backdrop-filter over WebGL) and
 * keeps >90% of the 3D stage unobstructed while exposing Chase/Cockpit Cam,
 * Reset Camera, Scene Lighting Toggle, and Waypoint Navigation Skipping.
 */
export function DispatchRunImmersivePanel({
  lightingMode,
  onToggleLighting,
  physicsMode = 'smoothOrbit',
  onTogglePhysicsMode,
  onDropWaypoints,
  cameraView = 'chase',
  onToggleCameraView,
  isCameraOffset,
  onResetCamera,
  activeCheckpointIndex,
  totalCheckpoints,
  activeCheckpointTitle,
  onSkipPrevWaypoint,
  onSkipNextWaypoint,
  isExploreMode = false,
  cruisePaused = false,
  onToggleCruisePause,
  hasChapterAudio = false,
  isPlayingChapterAudio = false,
  onToggleChapterAudio,
  onOpenMap,
  detailsExpanded = false,
  onToggleDetails,
}: DispatchRunImmersivePanelProps) {
  const [minimized, setMinimized] = useState(false);

  if (minimized) {
    return (
      <div className="pointer-events-auto inline-flex items-center gap-1.5 bg-[#0B0F17]/95 border border-white/15 rounded-lg p-1 shadow-xl">
        <button
          type="button"
          onClick={() => setMinimized(false)}
          title="Expand immersive 3D controls"
          className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#C7D0DF] hover:text-[#F5F7FA] rounded-md cursor-pointer whitespace-nowrap"
        >
          <SlidersHorizontal className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
          <span>3D Controls</span>
          <span className="font-mono text-[11px] tabular-nums text-[#67E8F9]">
            {String(Math.min(activeCheckpointIndex + 1, Math.max(1, totalCheckpoints))).padStart(2, '0')}/
            {String(Math.max(1, totalCheckpoints)).padStart(2, '0')}
          </span>
        </button>
      </div>
    );
  }

  const displayStep = String(
    Math.min(activeCheckpointIndex + 1, Math.max(1, totalCheckpoints))
  ).padStart(2, '0');
  const displayTotal = String(Math.max(1, totalCheckpoints)).padStart(2, '0');

  return (
    <div
      role="toolbar"
      aria-label="Dispatch Run 3D Immersive Controls"
      className="pointer-events-auto inline-flex items-center gap-1.5 bg-[#0B0F17]/95 border border-[#22D3EE]/30 rounded-xl px-2.5 py-1.5 shadow-2xl max-w-[95vw] overflow-x-auto"
    >
      {/* 1. Waypoint Navigation Skipping */}
      <div className="inline-flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={onSkipPrevWaypoint}
          disabled={totalCheckpoints <= 1}
          aria-label="Skip to previous waypoint"
          title="Skip to previous waypoint ([)"
          className="h-8 px-2.5 inline-flex items-center gap-1 rounded-lg bg-[#131924] hover:bg-[#1A2232] border border-white/10 text-xs font-medium text-[#C7D0DF] hover:text-[#F5F7FA] disabled:opacity-35 cursor-pointer whitespace-nowrap shrink-0 transition-colors"
        >
          <SkipBack className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
          <span className="hidden sm:inline">Prev</span>
        </button>

        <button
          type="button"
          onClick={onToggleDetails}
          title={`${displayStep}/${displayTotal} · ${activeCheckpointTitle} (Press H for chapter details)`}
          className="h-8 px-2.5 inline-flex items-center gap-1.5 rounded-lg bg-[#111620] hover:bg-[#171E2C] border border-white/10 text-xs text-[#F5F7FA] cursor-pointer whitespace-nowrap shrink-0 transition-colors"
        >
          <Compass className="w-3.5 h-3.5 text-[#67E8F9] shrink-0" aria-hidden="true" />
          <span className="font-mono text-[11px] tabular-nums text-[#67E8F9]">
            {displayStep}/{displayTotal}
          </span>
          <span className="max-w-[135px] truncate text-[#E2E8F0] font-medium">
            {activeCheckpointTitle}
          </span>
          {onToggleDetails &&
            (detailsExpanded ? (
              <ChevronDown className="w-3 h-3 text-[#8C96A8]" aria-hidden="true" />
            ) : (
              <ChevronUp className="w-3 h-3 text-[#8C96A8]" aria-hidden="true" />
            ))}
        </button>

        <button
          type="button"
          onClick={onSkipNextWaypoint}
          disabled={totalCheckpoints <= 1}
          aria-label="Skip to next waypoint"
          title="Skip to next waypoint (])"
          className="h-8 px-2.5 inline-flex items-center gap-1 rounded-lg bg-[#131924] hover:bg-[#1A2232] border border-white/10 text-xs font-medium text-[#C7D0DF] hover:text-[#F5F7FA] disabled:opacity-35 cursor-pointer whitespace-nowrap shrink-0 transition-colors"
        >
          <span className="hidden sm:inline">Next</span>
          <SkipForward className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
        </button>
      </div>

      <span className="w-px h-5 bg-white/10 shrink-0" aria-hidden="true" />

      {/* 2. Real-Time Physics Mode Toggle: Smooth Orbit vs Gravity Exploration */}
      {onTogglePhysicsMode && (
        <div className="inline-flex items-center gap-1 shrink-0">
          <button
            type="button"
            role="switch"
            aria-checked={physicsMode === 'gravityExploration'}
            onClick={onTogglePhysicsMode}
            title="Switch real-time waypoint physics between Smooth Orbit and Gravity Exploration (G or Gamepad RB)"
            className={`h-8 px-2.5 inline-flex items-center gap-1.5 rounded-lg border text-xs font-medium cursor-pointer whitespace-nowrap shrink-0 transition-colors ${
              physicsMode === 'gravityExploration'
                ? 'bg-[#F59E0B]/20 border-[#F59E0B]/55 text-[#FDE68A]'
                : 'bg-[#22D3EE]/15 border-[#22D3EE]/45 text-[#67E8F9] hover:text-[#F5F7FA]'
            }`}
          >
            {physicsMode === 'gravityExploration' ? (
              <>
                <ArrowDownToLine className="w-3.5 h-3.5 text-[#F59E0B]" aria-hidden="true" />
                <span>Gravity Exploration</span>
              </>
            ) : (
              <>
                <Orbit className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                <span>Smooth Orbit</span>
              </>
            )}
          </button>

          {physicsMode === 'gravityExploration' && onDropWaypoints && (
            <button
              type="button"
              onClick={onDropWaypoints}
              title="Launch waypoints upward to collide with the stage floor (V or click any 3D waypoint)"
              className="h-8 px-2 inline-flex items-center gap-1 rounded-lg bg-[#131924] hover:bg-[#1A2232] border border-[#F59E0B]/40 text-xs font-medium text-[#FDE68A] hover:text-[#F5F7FA] cursor-pointer whitespace-nowrap shrink-0 transition-colors"
            >
              <ArrowUpDown className="w-3.5 h-3.5 text-[#F59E0B]" aria-hidden="true" />
              <span>Drop</span>
            </button>
          )}
        </div>
      )}

      {/* 3. Chase vs Cockpit Camera View */}
      {onToggleCameraView && (
        <button
          type="button"
          onClick={onToggleCameraView}
          title="Toggle Chase Camera vs First-Person Cockpit View (C or Gamepad Y)"
          className={`h-8 px-2.5 inline-flex items-center gap-1.5 rounded-lg border text-xs font-medium cursor-pointer whitespace-nowrap shrink-0 transition-colors ${
            cameraView === 'cockpit'
              ? 'bg-[#22D3EE]/20 border-[#22D3EE]/55 text-[#67E8F9]'
              : 'bg-[#131924] hover:bg-[#1A2232] border-white/10 text-[#C7D0DF] hover:text-[#F5F7FA]'
          }`}
        >
          <Camera className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
          <span>{cameraView === 'cockpit' ? 'Cockpit Cam' : 'Chase Cam'}</span>
        </button>
      )}

      {/* 3. Camera Orientation Reset */}
      <button
        type="button"
        onClick={onResetCamera}
        aria-label="Reset camera orientation"
        title="Reset camera look orientation to corridor centerline (R)"
        className={`h-8 px-2.5 inline-flex items-center gap-1.5 rounded-lg border text-xs font-medium cursor-pointer whitespace-nowrap shrink-0 transition-colors ${
          isCameraOffset
            ? 'bg-[#22D3EE]/20 border-[#22D3EE]/55 text-[#67E8F9]'
            : 'bg-[#131924] hover:bg-[#1A2232] border-white/10 text-[#C7D0DF] hover:text-[#F5F7FA]'
        }`}
      >
        <Crosshair className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
        <span>Reset</span>
      </button>

      {/* 4. Scene Lighting Toggle */}
      <button
        type="button"
        onClick={onToggleLighting}
        aria-label={`Toggle scene lighting, current ${LIGHTING_LABELS[lightingMode]}`}
        title="Cycle 3D corridor lighting mood: Dusk, Daylight, Night (L)"
        className="h-8 px-2.5 inline-flex items-center gap-1.5 rounded-lg bg-[#131924] hover:bg-[#1A2232] border border-white/10 text-xs font-medium text-[#C7D0DF] hover:text-[#F5F7FA] cursor-pointer whitespace-nowrap shrink-0 transition-colors"
      >
        <LightingIcon mode={lightingMode} />
        <span>{LIGHTING_LABELS[lightingMode]}</span>
      </button>

      {/* Compact Optional Explore Hold / Audio / Map Quick Icons */}
      {(isExploreMode && onToggleCruisePause) ||
      (hasChapterAudio && onToggleChapterAudio) ||
      onOpenMap ? (
        <>
          <span className="w-px h-5 bg-white/10 shrink-0" aria-hidden="true" />
          <div className="inline-flex items-center gap-1 shrink-0">
            {isExploreMode && onToggleCruisePause && (
              <button
                type="button"
                onClick={onToggleCruisePause}
                title={cruisePaused ? 'Resume corridor cruise' : 'Hold position at gate'}
                aria-label={cruisePaused ? 'Resume cruise' : 'Hold at gate'}
                className={`w-8 h-8 inline-flex items-center justify-center rounded-lg border cursor-pointer transition-colors ${
                  cruisePaused
                    ? 'bg-[#22D3EE]/20 border-[#22D3EE]/45 text-[#67E8F9]'
                    : 'bg-[#131924] hover:bg-[#1A2232] border-white/10 text-[#C7D0DF] hover:text-[#F5F7FA]'
                }`}
              >
                {cruisePaused ? (
                  <Play className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
                ) : (
                  <Pause className="w-3.5 h-3.5" aria-hidden="true" />
                )}
              </button>
            )}

            {hasChapterAudio && onToggleChapterAudio && (
              <button
                type="button"
                onClick={onToggleChapterAudio}
                title={
                  isPlayingChapterAudio
                    ? 'Pause chapter audio'
                    : 'Play chapter audio'
                }
                aria-label={
                  isPlayingChapterAudio
                    ? 'Pause chapter audio'
                    : 'Play chapter audio'
                }
                className={`w-8 h-8 inline-flex items-center justify-center rounded-lg border cursor-pointer transition-colors ${
                  isPlayingChapterAudio
                    ? 'bg-[#22D3EE]/20 border-[#22D3EE]/50 text-[#67E8F9]'
                    : 'bg-[#131924] hover:bg-[#1A2232] border-white/10 text-[#C7D0DF] hover:text-[#F5F7FA]'
                }`}
              >
                <Headphones className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}

            {onOpenMap && (
              <button
                type="button"
                onClick={onOpenMap}
                title="View active waypoint on Map Planner"
                aria-label="View active waypoint on Map Planner"
                className="w-8 h-8 inline-flex items-center justify-center rounded-lg bg-[#131924] hover:bg-[#1A2232] border border-white/10 text-[#67E8F9] hover:text-[#F5F7FA] cursor-pointer transition-colors"
              >
                <Navigation className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </>
      ) : null}

      <button
        type="button"
        onClick={() => setMinimized(true)}
        title="Minimize control bar"
        aria-label="Minimize control bar"
        className="w-7 h-8 inline-flex items-center justify-center rounded-lg text-[#8C96A8] hover:text-[#F5F7FA] hover:bg-white/5 cursor-pointer shrink-0"
      >
        <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
