import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  ArrowRight,
  Box,
  Compass,
  Eye,
  EyeOff,
  Gauge,
  Loader2,
  MapPin,
  Maximize2,
  Minimize2,
  Navigation,
  X,
} from 'lucide-react';
import { SiteStoryMapView } from './SiteStoryMapView';
import type { StagedStageImage } from './ThreeStageStudio';
import type { Staged3DPayload } from '../three/types';
import { isSpatialDisplayUrl } from '../three/spatialBroadcastBus';
import { prefetchStageProceduralAssets } from '../utils/stageAssetCache';
import {
  QUALITY_TIER_ORDER,
  QUALITY_TIER_SPECS,
  loadAdaptiveQualitySettings,
  saveAdaptiveQualitySettings,
  type AdaptiveQualitySettings,
  type QualityTier,
} from '../utils/adaptiveQuality';
import type { AudioBriefing, NewsArticle } from '../types';
import { useAuth } from '../contexts/AuthContext';
import { recordClientConfigEvent } from '../services/suiteApi';
import {
  MAX_ROUTE_WAYPOINTS,
  type RouteTravelMode,
  type RouteWaypoint,
} from '../services/routingService';

// Lazy-load heavy Three.js studios into separate async chunks
const loadThreeStageStudio = () =>
  import('./ThreeStageStudio').then((m) => ({ default: m.ThreeStageStudio }));
const loadDispatchRunGame = () =>
  import('./DispatchRunGame').then((m) => ({ default: m.DispatchRunGame }));

const LazyThreeStageStudio = lazy(loadThreeStageStudio);
const LazyDispatchRunGame = lazy(loadDispatchRunGame);

type SpatialTab = 'map' | 'studio3d' | 'arcade3d';

export type { StagedStageImage };

export interface SpatialMapsHubViewProps {
  onSendLocationToMockup: (serviceArea: string, address: string) => void;
  stagedImageFor3D?: StagedStageImage | null;
  onSetStagedImageFor3D?: (img: StagedStageImage | null) => void;
  staged3DPayload?: Staged3DPayload | null;
  onSetStaged3DPayload?: (payload: Staged3DPayload | null) => void;
  onSaveRenderToClientPitch?: (dataUrl: string, label: string) => void;
  /** Controlled array of route waypoints (origin, intermediate stops, destination). */
  waypoints?: RouteWaypoint[];
  /** Callback invoked when waypoints are added, reordered, toggled, or cleared. */
  onWaypointsChange?: (waypoints: RouteWaypoint[]) => void;
  /** Active generated briefing whose chapters anchor the 3D journey. */
  activeBriefing?: AudioBriefing | null;
  /** Fallback source articles when an audio briefing has not been generated yet. */
  articles?: NewsArticle[];
  /** Currently selected audio segment index for synchronized chapter playback. */
  activeSegmentIndex?: number;
  /** Whether briefing audio is actively playing. */
  isPlayingAudio?: boolean;
  /** Trigger playback of a specific briefing chapter from a 3D checkpoint. */
  onSelectBriefingSegment?: (segmentIndex: number) => void;
  /** Toggle play/pause on the active briefing chapter. */
  onToggleBriefingAudio?: () => void;
  /** Notify parent workspace when full-screen immersive mode enters or exits. */
  onImmersiveModeChange?: (immersive: boolean) => void;
}

function StageLoadingFallback({ immersive = false }: { immersive?: boolean }) {
  return (
    <div
      className={`w-full bg-[#0B0D10] flex flex-col items-center justify-center gap-2.5 text-center px-6 ${
        immersive ? 'h-screen' : 'h-[calc(100vh-8.5rem)] min-h-[540px]'
      }`}
    >
      <Loader2 className="w-6 h-6 text-[#22D3EE] animate-spin" aria-hidden="true" />
      <p className="text-xs font-medium text-[#C7D0DF]">
        Loading 3D Stage Viewport...
      </p>
    </div>
  );
}

export function SpatialMapsHubView({
  onSendLocationToMockup,
  stagedImageFor3D = null,
  onSetStagedImageFor3D,
  staged3DPayload = null,
  onSetStaged3DPayload,
  onSaveRenderToClientPitch,
  waypoints,
  onWaypointsChange,
  activeBriefing = null,
  articles,
  activeSegmentIndex = 0,
  isPlayingAudio = false,
  onSelectBriefingSegment,
  onToggleBriefingAudio,
  onImmersiveModeChange,
}: SpatialMapsHubViewProps) {
  const hubContainerRef = useRef<HTMLDivElement | null>(null);
  const prefetched3DRef = useRef(false);
  const prefetchedArcadeRef = useRef(false);

  const [subTab, setSubTab] = useState<SpatialTab>(() =>
    staged3DPayload || stagedImageFor3D || isSpatialDisplayUrl() ? 'studio3d' : 'map'
  );
  const [isImmersiveMode, setIsImmersiveMode] = useState(() =>
    isSpatialDisplayUrl()
  );
  const [immersiveHudHidden, setImmersiveHudHidden] = useState(() =>
    isSpatialDisplayUrl()
  );
  const [travelMode, setTravelMode] = useState<RouteTravelMode>('DRIVE');
  const [optimizeOrder, setOptimizeOrder] = useState(false);
  const [focusedWaypointId, setFocusedWaypointId] = useState<string | null>(null);
  const [internalWaypoints, setInternalWaypoints] = useState<RouteWaypoint[]>(
    () => waypoints ?? []
  );

  const { user, getIdToken } = useAuth();
  const [qualitySettings, setQualitySettings] =
    useState<AdaptiveQualitySettings>(loadAdaptiveQualitySettings);
  const [activeQualityTier, setActiveQualityTier] = useState<QualityTier>(() =>
    qualitySettings.adaptive ? 'high' : qualitySettings.manualTier
  );

  const emitSpatialConfigAudit = useCallback(
    async (
      settingKey: string,
      settingLabel: string,
      previousValue: string | boolean,
      nextValue: string | boolean
    ) => {
      if (!user) return;
      try {
        const token = await getIdToken();
        if (!token) return;
        await recordClientConfigEvent(token, {
          settingKey,
          settingLabel,
          previousValue,
          nextValue,
          subsystem: 'Spatial & Maps Hub',
        });
      } catch {
        // Non-blocking audit telemetry
      }
    },
    [getIdToken, user]
  );

  const handleToggleAdaptiveQuality = useCallback(() => {
    setQualitySettings((prev) => {
      const nextAdaptive = !prev.adaptive;
      const next: AdaptiveQualitySettings = {
        ...prev,
        adaptive: nextAdaptive,
      };
      saveAdaptiveQualitySettings(next);
      if (!next.adaptive) {
        setActiveQualityTier(next.manualTier);
      }
      void emitSpatialConfigAudit(
        'spatial.adaptiveQuality',
        '3D Adaptive Quality',
        prev.adaptive ? 'enabled' : 'disabled',
        nextAdaptive ? 'enabled' : 'disabled'
      );
      return next;
    });
  }, [emitSpatialConfigAudit]);

  const handleSelectManualTier = useCallback(
    (tier: QualityTier) => {
      setQualitySettings((prev) => {
        const prevLabel = prev.adaptive ? `adaptive (${activeQualityTier})` : prev.manualTier;
        const next: AdaptiveQualitySettings = {
          adaptive: false,
          manualTier: tier,
        };
        saveAdaptiveQualitySettings(next);
        void emitSpatialConfigAudit(
          'spatial.manualQualityTier',
          '3D Render Quality Tier',
          prevLabel,
          tier
        );
        return next;
      });
      setActiveQualityTier(tier);
    },
    [activeQualityTier, emitSpatialConfigAudit]
  );

  // Warm 3D chunks and procedural textures during browser idle time after initial Map mount
  const prefetchImmersiveAssets = useCallback(() => {
    if (prefetched3DRef.current) return;
    prefetched3DRef.current = true;
    void loadThreeStageStudio();
    prefetchStageProceduralAssets();
  }, []);

  const prefetchArcadeAssets = useCallback(() => {
    if (prefetchedArcadeRef.current) return;
    prefetchedArcadeRef.current = true;
    void loadDispatchRunGame();
  }, []);

  useEffect(() => {
    const cancel = prefetchStageProceduralAssets();
    const timer = window.setTimeout(() => {
      void loadDispatchRunGame();
      void loadThreeStageStudio();
      prefetched3DRef.current = true;
      prefetchedArcadeRef.current = true;
    }, 650);
    return () => {
      cancel();
      window.clearTimeout(timer);
    };
  }, []);

  // Sync internal fallback state if external waypoints prop changes
  useEffect(() => {
    if (waypoints !== undefined) {
      setInternalWaypoints(waypoints);
    }
  }, [waypoints]);

  const activeWaypoints = waypoints !== undefined ? waypoints : internalWaypoints;

  const handleWaypointsChange = useCallback(
    (next: RouteWaypoint[]) => {
      const clamped = next.slice(0, MAX_ROUTE_WAYPOINTS);
      if (waypoints === undefined) {
        setInternalWaypoints(clamped);
      }
      onWaypointsChange?.(clamped);
    },
    [onWaypointsChange, waypoints]
  );

  const handleRemoveWaypoint = useCallback(
    (id: string) => {
      handleWaypointsChange(activeWaypoints.filter((wp) => wp.id !== id));
      setFocusedWaypointId((prev) => (prev === id ? null : prev));
    },
    [activeWaypoints, handleWaypointsChange]
  );

  useEffect(() => {
    if (stagedImageFor3D?.dataUrl) {
      setSubTab('studio3d');
    }
  }, [stagedImageFor3D?.dataUrl]);

  useEffect(() => {
    if (staged3DPayload?.id) {
      setSubTab('studio3d');
    }
  }, [staged3DPayload?.id]);

  // Notify parent workspace and lock document body scroll while full-screen immersive mode is active
  useEffect(() => {
    onImmersiveModeChange?.(isImmersiveMode);
    if (!isImmersiveMode) {
      setImmersiveHudHidden(false);
      return;
    }
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isImmersiveMode, onImmersiveModeChange]);

  useEffect(() => {
    return () => {
      onImmersiveModeChange?.(false);
    };
  }, [onImmersiveModeChange]);

  // Sync browser native fullscreen exit (e.g., OS Escape) back into React state
  useEffect(() => {
    const handleFsChange = () => {
      if (!document.fullscreenElement) {
        setIsImmersiveMode(false);
      }
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  const enterImmersiveMode = useCallback(
    (preferredTab?: SpatialTab) => {
      const nextTab = preferredTab ?? subTab;
      if (nextTab === 'studio3d') {
        prefetchImmersiveAssets();
      } else if (nextTab === 'arcade3d') {
        prefetchArcadeAssets();
      }
      setSubTab(nextTab);
      setImmersiveHudHidden(false);
      setIsImmersiveMode(true);
      void emitSpatialConfigAudit(
        'spatial.immersiveMode',
        'Spatial Full-Screen Immersive Mode',
        'standard',
        `immersive (${nextTab})`
      );
      try {
        const el = hubContainerRef.current;
        if (el && typeof el.requestFullscreen === 'function') {
          el.requestFullscreen().catch(() => {
            // Fixed full-viewport overlay fallback works cleanly inside sandboxed iframes
          });
        }
      } catch {
        // Fixed full-viewport overlay fallback remains active
      }
    },
    [emitSpatialConfigAudit, prefetchArcadeAssets, prefetchImmersiveAssets, subTab]
  );

  const exitImmersiveMode = useCallback(() => {
    setIsImmersiveMode(false);
    setImmersiveHudHidden(false);
    void emitSpatialConfigAudit(
      'spatial.immersiveMode',
      'Spatial Full-Screen Immersive Mode',
      `immersive (${subTab})`,
      'standard'
    );
    try {
      if (
        document.fullscreenElement &&
        typeof document.exitFullscreen === 'function'
      ) {
        document.exitFullscreen().catch(() => {});
      }
    } catch {
      // Non-fatal fullscreen exit error
    }
  }, [emitSpatialConfigAudit, subTab]);

  const toggleImmersiveMode = useCallback(() => {
    if (isImmersiveMode) {
      exitImmersiveMode();
    } else {
      enterImmersiveMode(subTab);
    }
  }, [enterImmersiveMode, exitImmersiveMode, isImmersiveMode, subTab]);

  // Smooth Map -> Dispatch Run 3D exploration transition
  const handleLaunchDispatchRun3D = useCallback(
    (waypointId?: string, fullImmersive = true) => {
      prefetchArcadeAssets();
      if (waypointId) {
        setFocusedWaypointId(waypointId);
      }
      if (fullImmersive) {
        enterImmersiveMode('arcade3d');
      } else {
        setSubTab('arcade3d');
      }
    },
    [enterImmersiveMode, prefetchArcadeAssets]
  );

  // Smooth 3D Checkpoint -> Map Planner transition
  const handleOpenMapFrom3D = useCallback((waypointId?: string) => {
    if (waypointId) {
      setFocusedWaypointId(waypointId);
    }
    setSubTab('map');
  }, []);

  // Keyboard shortcuts: 'F' toggles Full-Screen Immersive Mode, 'Escape' exits, 'H' hides/shows minimal floating bar in immersive mode
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const isTyping =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (e.key === 'Escape' && isImmersiveMode) {
        exitImmersiveMode();
        return;
      }

      if (isTyping) return;

      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleImmersiveMode();
        return;
      }

      if (isImmersiveMode && (e.key === 'h' || e.key === 'H')) {
        e.preventDefault();
        setImmersiveHudHidden((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [exitImmersiveMode, isImmersiveMode, toggleImmersiveMode]);

  return (
    <div
      ref={hubContainerRef}
      className={
        isImmersiveMode
          ? 'fixed inset-0 z-[60] w-screen h-screen bg-[#0B0D10] flex flex-col overflow-hidden'
          : 'min-h-[calc(100vh-4rem)] flex flex-col'
      }
    >
      {/* Standard Workspace Sub-Tab Bar (hidden while maximized in Immersive Mode) */}
      {!isImmersiveMode && (
        <div className="bg-[#0E1116] border-b border-[#22D3EE]/20 px-5 sm:px-7 py-2.5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-1.5 overflow-x-auto">
            {(
              [
                { id: 'map', label: 'Site & Story Map', icon: MapPin },
                { id: 'arcade3d', label: 'Dispatch Run 3D', icon: Compass },
                { id: 'studio3d', label: '3D Stage Studio', icon: Box },
              ] as const
            ).map((tab) => {
              const Icon = tab.icon;
              const active = subTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onMouseEnter={() => {
                    if (tab.id === 'studio3d') prefetchImmersiveAssets();
                    if (tab.id === 'arcade3d') prefetchArcadeAssets();
                  }}
                  onFocus={() => {
                    if (tab.id === 'studio3d') prefetchImmersiveAssets();
                    if (tab.id === 'arcade3d') prefetchArcadeAssets();
                  }}
                  onClick={() => setSubTab(tab.id)}
                  className={`h-9 px-3.5 inline-flex items-center gap-2 text-xs font-medium rounded-md whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                    active
                      ? 'bg-[#22D3EE]/15 text-[#67E8F9] border border-[#22D3EE]/45'
                      : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                  {tab.label}
                  {tab.id === 'map' && activeWaypoints.length > 0 && (
                    <span className="ml-0.5 px-1.5 py-0.5 text-[10px] font-mono tabular-nums rounded bg-[#22D3EE]/20 text-[#67E8F9]">
                      {activeWaypoints.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-3 min-w-0 max-w-full flex-wrap">
            {/* Active Multi-Stop Waypoints Summary Strip (click any stop to focus on Map or 3D Run) */}
            {activeWaypoints.length > 0 && (
              <div className="flex items-center gap-2 min-w-0 max-w-full overflow-x-auto py-0.5">
                <button
                  type="button"
                  onClick={() => setSubTab('map')}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-[#22D3EE] hover:text-[#67E8F9] whitespace-nowrap shrink-0 cursor-pointer"
                  title="Open multi-stop route on Site & Story Map"
                >
                  <Navigation className="w-3.5 h-3.5" aria-hidden="true" />
                  Route ({activeWaypoints.length}/{MAX_ROUTE_WAYPOINTS})
                </button>

                <div className="flex items-center gap-1 overflow-x-auto">
                  {activeWaypoints.map((wp, idx) => {
                    const isFocused = focusedWaypointId === wp.id;
                    return (
                      <div
                        key={wp.id}
                        className="inline-flex items-center gap-1 shrink-0"
                      >
                        {idx > 0 && (
                          <ArrowRight
                            className="w-3 h-3 text-[#4B5565] shrink-0"
                            aria-hidden="true"
                          />
                        )}
                        <span
                          className={`inline-flex items-center gap-1.5 h-7 pl-1.5 pr-1 rounded text-[11px] border transition-colors ${
                            isFocused
                              ? 'bg-[#162231] border-[#22D3EE]/60 text-[#F5F7FA]'
                              : 'bg-[#131820] border-white/10 text-[#E2E8F0]'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => setFocusedWaypointId(wp.id)}
                            className="inline-flex items-center gap-1.5 cursor-pointer"
                            title={
                              subTab === 'arcade3d'
                                ? `Warp to Checkpoint ${idx + 1}: ${wp.name}`
                                : `Focus Waypoint ${idx + 1}: ${wp.name}`
                            }
                          >
                            <span
                              className={`w-4 h-4 rounded-full font-mono text-[9px] font-bold tabular-nums flex items-center justify-center shrink-0 ${
                                idx === 0
                                  ? 'bg-emerald-400/20 text-emerald-300 border border-emerald-400/40'
                                  : idx === activeWaypoints.length - 1
                                    ? 'bg-[#22D3EE] text-[#071318]'
                                    : wp.via
                                      ? 'border border-dashed border-[#67E8F9]/60 text-[#67E8F9]'
                                      : 'bg-[#22D3EE]/20 text-[#67E8F9] border border-[#22D3EE]/40'
                              }`}
                            >
                              {idx + 1}
                            </span>
                            <span className="max-w-[110px] truncate">{wp.name}</span>
                          </button>
                          {wp.via && idx > 0 && idx < activeWaypoints.length - 1 && (
                            <span className="text-[9px] font-mono uppercase text-[#8C96A8]">
                              via
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => handleRemoveWaypoint(wp.id)}
                            className="p-0.5 text-[#8C96A8] hover:text-red-300 cursor-pointer"
                            aria-label={`Remove waypoint ${wp.name}`}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    handleWaypointsChange([]);
                    setFocusedWaypointId(null);
                  }}
                  className="text-[11px] text-[#8C96A8] hover:text-[#F5F7FA] whitespace-nowrap shrink-0 pl-1 cursor-pointer"
                >
                  Clear
                </button>
              </div>
            )}

            {/* Adaptive Quality Setting (auto-scales Three.js resolution & shadow detail) */}
            <div className="inline-flex items-center gap-1 bg-[#131820] border border-white/10 rounded-md p-0.5 shrink-0">
              <button
                type="button"
                role="switch"
                aria-checked={qualitySettings.adaptive}
                onClick={handleToggleAdaptiveQuality}
                title="Automatically adjust Three.js scene resolution and shadow detail based on frame rate"
                className={`h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium rounded whitespace-nowrap cursor-pointer transition-colors ${
                  qualitySettings.adaptive
                    ? 'bg-[#22D3EE]/15 text-[#67E8F9]'
                    : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                }`}
              >
                <Gauge className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Adaptive Quality</span>
                {qualitySettings.adaptive && (
                  <span className="font-mono text-[11px] tabular-nums text-[#C7D0DF]">
                    · {QUALITY_TIER_SPECS[activeQualityTier].label}
                  </span>
                )}
              </button>

              {!qualitySettings.adaptive &&
                QUALITY_TIER_ORDER.map((tier) => (
                  <button
                    key={tier}
                    type="button"
                    onClick={() => handleSelectManualTier(tier)}
                    className={`h-8 px-2 text-[11px] font-medium rounded whitespace-nowrap cursor-pointer transition-colors ${
                      qualitySettings.manualTier === tier
                        ? 'bg-[#22D3EE] text-[#071318] font-semibold'
                        : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                    }`}
                  >
                    {QUALITY_TIER_SPECS[tier].label}
                  </button>
                ))}
            </div>

            {/* Full-Screen Clean Immersive Mode Launcher (works across Map, Dispatch Run 3D, and 3D Stage Studio) */}
            <button
              type="button"
              onMouseEnter={() => {
                prefetchArcadeAssets();
                prefetchImmersiveAssets();
              }}
              onFocus={() => {
                prefetchArcadeAssets();
                prefetchImmersiveAssets();
              }}
              onClick={() => enterImmersiveMode(subTab)}
              title="Enter full-screen immersive mode (F) — hides all secondary sidebars and overlays"
              className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md whitespace-nowrap shrink-0 transition-colors cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5" aria-hidden="true" />
              Full-Screen Mode
            </button>
          </div>
        </div>
      )}

      <div className={isImmersiveMode ? 'relative flex-1 w-full h-full' : 'flex-1'}>
        {/* Minimal Unobtrusive Immersive Navigation Pill (hides all secondary sidebars/overlays; press H to collapse even this bar) */}
        {isImmersiveMode && !immersiveHudHidden && (
          <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 z-30 max-w-[96vw]">
            <div
              role="toolbar"
              aria-label="Immersive Viewport Navigation"
              className="pointer-events-auto inline-flex items-center gap-1 p-1 bg-[#0B0F17]/95 border border-white/15 rounded-lg shadow-xl overflow-x-auto"
            >
              <button
                type="button"
                onClick={() => setSubTab('map')}
                className={`h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  subTab === 'map'
                    ? 'bg-[#22D3EE] text-[#071318] font-semibold'
                    : 'text-[#C7D0DF] hover:text-[#F5F7FA]'
                }`}
              >
                <MapPin className="w-3.5 h-3.5" aria-hidden="true" />
                Map
              </button>

              <button
                type="button"
                onMouseEnter={prefetchArcadeAssets}
                onClick={() => setSubTab('arcade3d')}
                className={`h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  subTab === 'arcade3d'
                    ? 'bg-[#22D3EE] text-[#071318] font-semibold'
                    : 'text-[#C7D0DF] hover:text-[#F5F7FA]'
                }`}
              >
                <Compass className="w-3.5 h-3.5" aria-hidden="true" />
                Dispatch Run 3D
              </button>

              <button
                type="button"
                onMouseEnter={prefetchImmersiveAssets}
                onClick={() => setSubTab('studio3d')}
                className={`h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  subTab === 'studio3d'
                    ? 'bg-[#22D3EE] text-[#071318] font-semibold'
                    : 'text-[#C7D0DF] hover:text-[#F5F7FA]'
                }`}
              >
                <Box className="w-3.5 h-3.5" aria-hidden="true" />
                3D Stage
              </button>

              <span className="w-px h-5 bg-white/15 mx-0.5 shrink-0" aria-hidden="true" />

              <button
                type="button"
                onClick={() => setImmersiveHudHidden(true)}
                title="Hide navigation bar for pure canvas (H)"
                aria-label="Hide navigation bar"
                className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#9FB0C4] hover:text-[#F5F7FA] rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <EyeOff className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">Hide Bar</span>
              </button>

              <button
                type="button"
                onClick={exitImmersiveMode}
                title="Exit Full-Screen Immersive Mode (Esc)"
                className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#151C28] hover:bg-[#1E2838] border border-white/10 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Minimize2 className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                Exit Full Screen
              </button>
            </div>
          </div>
        )}

        {/* Discreet Corner Restore / Exit Control when Zen Clean Bar is hidden (H) */}
        {isImmersiveMode && immersiveHudHidden && (
          <div className="pointer-events-auto absolute top-3 right-3 z-30 inline-flex items-center gap-1 p-1 bg-[#0B0F17]/85 hover:bg-[#0B0F17]/95 border border-white/15 rounded-lg shadow-lg opacity-75 hover:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={() => setImmersiveHudHidden(false)}
              title="Show navigation bar (H)"
              aria-label="Show navigation bar"
              className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#C7D0DF] hover:text-[#F5F7FA] rounded-md cursor-pointer whitespace-nowrap"
            >
              <Eye className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
              Show Bar
            </button>
            <button
              type="button"
              onClick={exitImmersiveMode}
              title="Exit Full-Screen Mode (Esc)"
              aria-label="Exit full-screen mode"
              className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#C7D0DF] hover:text-[#F5F7FA] rounded-md cursor-pointer whitespace-nowrap"
            >
              <Minimize2 className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
              Exit
            </button>
          </div>
        )}

        {/* Site & Story Map (Edge-to-edge 100vw x 100vh in Immersive Mode with sidebar & search overlays hidden) */}
        {subTab === 'map' && (
          <div className={isImmersiveMode ? 'w-full h-full bg-[#0B0D10]' : ''}>
            <SiteStoryMapView
              onSendLocationToMockup={onSendLocationToMockup}
              waypoints={activeWaypoints}
              onWaypointsChange={handleWaypointsChange}
              travelMode={travelMode}
              onTravelModeChange={setTravelMode}
              optimizeOrder={optimizeOrder}
              onOptimizeOrderChange={setOptimizeOrder}
              focusedWaypointId={focusedWaypointId}
              onFocusWaypoint={setFocusedWaypointId}
              isImmersiveMode={isImmersiveMode}
              onToggleImmersiveMode={toggleImmersiveMode}
              onLaunchDispatchRun3D={(waypointId) =>
                handleLaunchDispatchRun3D(waypointId, isImmersiveMode || true)
              }
            />
          </div>
        )}

        {/* 3D Stage Studio (Clean 100vw x 100vh 3D viewport in Immersive Mode — no secondary route sidebar) */}
        {subTab === 'studio3d' && (
          <div className={isImmersiveMode ? 'relative w-full h-full' : 'relative'}>
            <Suspense fallback={<StageLoadingFallback immersive={isImmersiveMode} />}>
              <LazyThreeStageStudio
                stagedImage={stagedImageFor3D}
                onUploadStagedImage={(img) => onSetStagedImageFor3D?.(img)}
                onClearStagedImage={() => onSetStagedImageFor3D?.(null)}
                stagedPayload={staged3DPayload}
                onUpdateStagedPayload={onSetStaged3DPayload}
                onSaveSnapshotToPitch={onSaveRenderToClientPitch}
                isImmersiveMode={isImmersiveMode}
                onToggleImmersiveMode={toggleImmersiveMode}
                waypoints={activeWaypoints}
                adaptiveQuality={qualitySettings.adaptive}
                onToggleAdaptiveQuality={handleToggleAdaptiveQuality}
                manualQualityTier={qualitySettings.manualTier}
                onActiveQualityTierChange={setActiveQualityTier}
              />
            </Suspense>
          </div>
        )}

        {/* Dispatch Run 3D (Clean 100vw x 100vh 3D corridor in Immersive Mode — no secondary route sidebar) */}
        {subTab === 'arcade3d' && (
          <div className={isImmersiveMode ? 'relative w-full h-full' : 'relative'}>
            <Suspense fallback={<StageLoadingFallback immersive={isImmersiveMode} />}>
              <LazyDispatchRunGame
                briefing={activeBriefing}
                fallbackArticles={articles}
                waypoints={activeWaypoints}
                focusedWaypointId={focusedWaypointId}
                onFocusWaypoint={(id) => setFocusedWaypointId(id)}
                onOpenMapPlanner={handleOpenMapFrom3D}
                isImmersiveMode={isImmersiveMode}
                onToggleImmersiveMode={toggleImmersiveMode}
                activeSegmentIndex={activeSegmentIndex}
                isPlayingAudio={isPlayingAudio}
                onSelectBriefingSegment={onSelectBriefingSegment}
                onToggleBriefingAudio={onToggleBriefingAudio}
                adaptiveQuality={qualitySettings.adaptive}
                onToggleAdaptiveQuality={handleToggleAdaptiveQuality}
                manualQualityTier={qualitySettings.manualTier}
                onActiveQualityTierChange={setActiveQualityTier}
              />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}
