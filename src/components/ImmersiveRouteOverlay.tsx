import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  APIProvider,
  Map as GoogleMap,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import { BatchedWaypointLayer } from './BatchedWaypointLayer';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bike,
  Car,
  ChevronDown,
  ChevronUp,
  Compass,
  ExternalLink,
  Footprints,
  Loader2,
  Map as MapIcon,
  Navigation,
  Plus,
  Route as RouteIcon,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import {
  computeMultiStopRoute,
  isMapsQuotaError,
  MAX_ROUTE_WAYPOINTS,
  type RouteLegSummary,
  type RouteTravelMode,
  type RouteWaypoint,
} from '../services/routingService';

export interface ImmersiveRouteOverlayProps {
  waypoints: RouteWaypoint[];
  onWaypointsChange: (waypoints: RouteWaypoint[]) => void;
  travelMode: RouteTravelMode;
  onTravelModeChange: (mode: RouteTravelMode) => void;
  optimizeOrder: boolean;
  onOptimizeOrderChange: (enabled: boolean) => void;
  onOpenFullMap: () => void;
  defaultExpanded?: boolean;
  focusedWaypointId?: string | null;
  onFocusWaypoint?: (waypointId: string | null) => void;
  onJumpToCheckpoint?: (waypointId: string) => void;
}

interface OverlayRouteSummary {
  distanceText: string;
  durationText: string;
  stopCount: number;
  legs: RouteLegSummary[];
  orderedWaypoints: RouteWaypoint[];
  optimizedOrderApplied: boolean;
}

const DEFAULT_CENTER = { lat: 37.7897, lng: -122.4014 };

function notifyIfQuotaError(err: unknown) {
  if (isMapsQuotaError(err)) {
    window.dispatchEvent(new Event('gmp-quota-exceeded'));
  }
}

interface MiniMapControllerProps {
  waypoints: RouteWaypoint[];
  travelMode: RouteTravelMode;
  optimizeOrder: boolean;
  focusedWaypointId: string | null;
  onSelectWaypoint: (id: string) => void;
  onRouteComputed: (
    summary: OverlayRouteSummary | null,
    error: string | null,
    isComputing: boolean
  ) => void;
  onAddPlaceWaypoint: (wp: Omit<RouteWaypoint, 'id'>) => void;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  onSuggestionsChange: (
    suggestions: google.maps.places.AutocompleteSuggestion[],
    searching: boolean
  ) => void;
  selectSuggestionRef: React.MutableRefObject<
    ((s: google.maps.places.AutocompleteSuggestion) => Promise<void>) | null
  >;
}

function MiniMapController({
  waypoints,
  travelMode,
  optimizeOrder,
  focusedWaypointId,
  onSelectWaypoint,
  onRouteComputed,
  onAddPlaceWaypoint,
  searchQuery,
  onSearchQueryChange,
  onSuggestionsChange,
  selectSuggestionRef,
}: MiniMapControllerProps) {
  const map = useMap();
  const routesLib = useMapsLibrary('routes');
  const geometryLib = useMapsLibrary('geometry');
  const placesLib = useMapsLibrary('places');

  const polylineRef = useRef<google.maps.Polyline | null>(null);
  const sessionTokenRef = useRef<google.maps.places.AutocompleteSessionToken | null>(
    null
  );

  // Detach single reused Polyline cleanly when MiniMapController unmounts
  useEffect(() => {
    return () => {
      if (polylineRef.current) {
        polylineRef.current.setMap(null);
        polylineRef.current = null;
      }
    };
  }, []);

  // Focus map on a clicked waypoint
  useEffect(() => {
    if (!map || !focusedWaypointId) return;
    const found = waypoints.find((w) => w.id === focusedWaypointId);
    if (!found) return;
    map.panTo({ lat: found.lat, lng: found.lng });
    if ((map.getZoom() ?? 12) < 14) {
      map.setZoom(14);
    }
  }, [focusedWaypointId, map, waypoints]);

  // Fit single waypoint when only 1 waypoint exists
  useEffect(() => {
    if (!map || waypoints.length !== 1) return;
    map.panTo({ lat: waypoints[0].lat, lng: waypoints[0].lng });
    map.setZoom(13);
  }, [map, waypoints]);

  // Live Google Places Autocomplete inside Immersive Mode
  useEffect(() => {
    if (!placesLib || !searchQuery.trim() || searchQuery.trim().length < 2) {
      onSuggestionsChange([], false);
      return;
    }

    let cancelled = false;
    onSuggestionsChange([], true);

    const timer = window.setTimeout(async () => {
      try {
        if (!sessionTokenRef.current) {
          sessionTokenRef.current = new placesLib.AutocompleteSessionToken();
        }
        const { suggestions } =
          await placesLib.AutocompleteSuggestion.fetchAutocompleteSuggestions({
            input: searchQuery.trim(),
            sessionToken: sessionTokenRef.current,
          });
        if (!cancelled) {
          onSuggestionsChange(suggestions.slice(0, 4), false);
        }
      } catch (err) {
        notifyIfQuotaError(err);
        if (!cancelled) {
          onSuggestionsChange([], false);
        }
      }
    }, 240);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [onSuggestionsChange, placesLib, searchQuery]);

  // Wire place selection handler to parent search dropdown
  useEffect(() => {
    selectSuggestionRef.current = async (
      suggestion: google.maps.places.AutocompleteSuggestion
    ) => {
      if (!placesLib || !suggestion.placePrediction) return;
      try {
        const place = suggestion.placePrediction.toPlace();
        await place.fetchFields({
          fields: ['id', 'displayName', 'formattedAddress', 'location'],
        });
        sessionTokenRef.current = null;
        if (!place.location) return;
        const lat =
          typeof place.location.lat === 'function'
            ? place.location.lat()
            : Number(place.location.lat);
        const lng =
          typeof place.location.lng === 'function'
            ? place.location.lng()
            : Number(place.location.lng);

        onAddPlaceWaypoint({
          name: place.displayName || 'Waypoint',
          address: place.formattedAddress || '',
          placeId: place.id || undefined,
          lat,
          lng,
        });
        onSearchQueryChange('');
        onSuggestionsChange([], false);
      } catch (err) {
        notifyIfQuotaError(err);
      }
    };
    return () => {
      selectSuggestionRef.current = null;
    };
  }, [
    onAddPlaceWaypoint,
    onSearchQueryChange,
    onSuggestionsChange,
    placesLib,
    selectSuggestionRef,
  ]);

  // Real-time multi-stop route computation with single-Polyline reuse & RDP vertex decimation
  useEffect(() => {
    if (!map || !routesLib || waypoints.length < 2) {
      if (polylineRef.current) {
        polylineRef.current.setMap(null);
      }
      onRouteComputed(null, null, false);
      return;
    }

    let cancelled = false;
    onRouteComputed(null, null, true);

    const run = async () => {
      try {
        const result = await computeMultiStopRoute({
          routesLib,
          geometryLib,
          waypoints,
          travelMode,
          optimizeWaypointOrder: optimizeOrder,
          maxPathVertices: 360,
          existingPolyline: polylineRef.current,
          polylineOptions: {
            strokeColor: '#22D3EE',
            strokeOpacity: 0.95,
            strokeWeight: 4,
          },
        });

        if (cancelled) return;

        const primaryLine = result.polylines[0] ?? null;
        polylineRef.current = primaryLine;
        if (primaryLine && primaryLine.getMap() !== map) {
          primaryLine.setMap(map);
        }

        if (result.viewport) {
          map.fitBounds(result.viewport, 32);
        }

        onRouteComputed(
          {
            distanceText: result.distanceText,
            durationText: result.durationText,
            stopCount: result.stopCount,
            legs: result.legs,
            orderedWaypoints: result.orderedWaypoints,
            optimizedOrderApplied: result.optimizedOrderApplied,
          },
          null,
          false
        );
      } catch (err) {
        notifyIfQuotaError(err);
        if (!cancelled) {
          if (polylineRef.current) {
            polylineRef.current.setMap(null);
          }
          onRouteComputed(
            null,
            err instanceof Error
              ? err.message
              : 'Could not compute route between stops.',
            false
          );
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [geometryLib, map, onRouteComputed, optimizeOrder, routesLib, travelMode, waypoints]);

  return (
    <BatchedWaypointLayer
      waypoints={waypoints}
      focusedWaypointId={focusedWaypointId}
      onSelectWaypoint={onSelectWaypoint}
      badgeRadius={11}
    />
  );
}

/**
 * Single-canvas schematic route preview when Maps API key is unavailable.
 */
function SchematicRoutePreview({ waypoints }: { waypoints: RouteWaypoint[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || waypoints.length === 0) return;

    const width = 356;
    const height = 176;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#090C11';
    ctx.fillRect(0, 0, width, height);

    // Single batched grid path
    ctx.strokeStyle = '#161E2B';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let x = 0; x <= width; x += 24) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let y = 0; y <= height; y += 24) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();

    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    for (const wp of waypoints) {
      if (wp.lat < minLat) minLat = wp.lat;
      if (wp.lat > maxLat) maxLat = wp.lat;
      if (wp.lng < minLng) minLng = wp.lng;
      if (wp.lng > maxLng) maxLng = wp.lng;
    }
    const latSpan = Math.max(maxLat - minLat, 0.005);
    const lngSpan = Math.max(maxLng - minLng, 0.005);

    const pts = waypoints.map((wp, idx) => ({
      idx,
      x: 34 + ((wp.lng - minLng) / lngSpan) * (width - 68),
      y: height - 34 - ((wp.lat - minLat) / latSpan) * (height - 68),
    }));

    if (pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.strokeStyle = '#22D3EE';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 10px ui-monospace, SFMono-Regular, monospace';

    for (const pt of pts) {
      const isOrigin = pt.idx === 0;
      const isDest = pt.idx === pts.length - 1 && pts.length > 1;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 10, 0, Math.PI * 2);
      ctx.fillStyle = isOrigin ? '#34D399' : isDest ? '#22D3EE' : '#0E1116';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#22D3EE';
      ctx.stroke();

      ctx.fillStyle = isOrigin || isDest ? '#071318' : '#67E8F9';
      ctx.fillText(String(pt.idx + 1), pt.x, pt.y + 0.5);
    }
  }, [waypoints]);

  return (
    <div className="relative w-full h-[176px] bg-[#090C11] border-b border-white/10 overflow-hidden flex items-center justify-center">
      {waypoints.length === 0 ? (
        <div className="text-center px-4">
          <Compass className="w-5 h-5 text-[#22D3EE]/60 mx-auto mb-1.5" />
          <p className="text-[11px] text-[#8C96A8]">
            Add stops or load a sample route to visualize waypoints
          </p>
        </div>
      ) : (
        <canvas ref={canvasRef} className="w-full h-full block" />
      )}
    </div>
  );
}

export function ImmersiveRouteOverlay({
  waypoints,
  onWaypointsChange,
  travelMode,
  onTravelModeChange,
  optimizeOrder,
  onOptimizeOrderChange,
  onOpenFullMap,
  defaultExpanded = true,
  focusedWaypointId: externalFocusedWaypointId,
  onFocusWaypoint,
  onJumpToCheckpoint,
}: ImmersiveRouteOverlayProps) {
  const apiKey = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) || '';
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [expanded, setExpanded] = useState(defaultExpanded);
  const [routeSummary, setRouteSummary] = useState<OverlayRouteSummary | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [isComputingRoute, setIsComputingRoute] = useState(false);
  const [internalFocusedId, setInternalFocusedId] = useState<string | null>(null);
  const [legsOpen, setLegsOpen] = useState(false);

  const focusedWaypointId =
    externalFocusedWaypointId !== undefined
      ? externalFocusedWaypointId
      : internalFocusedId;

  const handleSelectWaypoint = useCallback(
    (id: string | null, trigger3DJump = false) => {
      if (externalFocusedWaypointId === undefined) {
        setInternalFocusedId(id);
      }
      onFocusWaypoint?.(id);
      if (trigger3DJump && id) {
        onJumpToCheckpoint?.(id);
      }
    },
    [externalFocusedWaypointId, onFocusWaypoint, onJumpToCheckpoint]
  );

  useEffect(() => {
    setExpanded(defaultExpanded);
  }, [defaultExpanded]);

  // Live Places search state
  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState<
    google.maps.places.AutocompleteSuggestion[]
  >([]);
  const [isSearchingPlaces, setIsSearchingPlaces] = useState(false);
  const selectSuggestionRef = useRef<
    ((s: google.maps.places.AutocompleteSuggestion) => Promise<void>) | null
  >(null);

  const handleRouteComputed = useCallback(
    (
      summary: OverlayRouteSummary | null,
      error: string | null,
      computing: boolean
    ) => {
      setIsComputingRoute(computing);
      if (!computing) {
        setRouteSummary(summary);
        setRouteError(error);
      }
    },
    []
  );

  const handleSuggestionsChange = useCallback(
    (
      nextSuggestions: google.maps.places.AutocompleteSuggestion[],
      searching: boolean
    ) => {
      setSuggestions(nextSuggestions);
      setIsSearchingPlaces(searching);
    },
    []
  );

  const handleAddPlaceWaypoint = useCallback(
    (wp: Omit<RouteWaypoint, 'id'>) => {
      if (waypoints.length >= MAX_ROUTE_WAYPOINTS) return;
      const created: RouteWaypoint = {
        ...wp,
        id: `wp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        via: false,
      };
      onWaypointsChange([...waypoints, created]);
      handleSelectWaypoint(created.id, true);
    },
    [handleSelectWaypoint, onWaypointsChange, waypoints]
  );

  const handleMoveStop = useCallback(
    (index: number, delta: -1 | 1) => {
      const target = index + delta;
      if (target < 0 || target >= waypoints.length) return;
      const copy = [...waypoints];
      const [moved] = copy.splice(index, 1);
      copy.splice(target, 0, moved);
      onWaypointsChange(
        copy.map((wp, i) =>
          i === 0 || i === copy.length - 1 ? { ...wp, via: false } : wp
        )
      );
    },
    [onWaypointsChange, waypoints]
  );

  const handleToggleVia = useCallback(
    (id: string) => {
      onWaypointsChange(
        waypoints.map((wp, idx) =>
          wp.id === id && idx > 0 && idx < waypoints.length - 1
            ? { ...wp, via: !wp.via }
            : wp
        )
      );
    },
    [onWaypointsChange, waypoints]
  );

  const handleRemoveStop = useCallback(
    (id: string) => {
      const filtered = waypoints.filter((w) => w.id !== id);
      onWaypointsChange(
        filtered.map((wp, idx) =>
          idx === 0 || idx === filtered.length - 1 ? { ...wp, via: false } : wp
        )
      );
    },
    [onWaypointsChange, waypoints]
  );

  const handleReverse = useCallback(() => {
    const reversed = [...waypoints].reverse();
    onWaypointsChange(
      reversed.map((wp, idx) =>
        idx === 0 || idx === reversed.length - 1 ? { ...wp, via: false } : wp
      )
    );
  }, [onWaypointsChange, waypoints]);

  const handleApplyOptimized = useCallback(() => {
    if (!routeSummary?.optimizedOrderApplied) return;
    onWaypointsChange(routeSummary.orderedWaypoints);
    onOptimizeOrderChange(false);
  }, [onOptimizeOrderChange, onWaypointsChange, routeSummary]);

  const hasIntermediateVia = useMemo(
    () => waypoints.slice(1, -1).some((w) => Boolean(w.via)),
    [waypoints]
  );

  // Compact collapsed launcher so the user can view 100% unobstructed 3D
  if (!expanded) {
    return (
      <div className="absolute top-14 left-5 z-30">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="h-9 px-3.5 inline-flex items-center gap-2 bg-[#0D1017]/95 hover:bg-[#141A24] border border-[#22D3EE]/40 rounded-lg text-xs font-medium text-[#F5F7FA] shadow-xl cursor-pointer transition-colors"
        >
          <Navigation className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
          <span>Route Waypoints</span>
          <span className="px-1.5 py-0.5 text-[10px] font-mono tabular-nums rounded bg-[#22D3EE]/20 text-[#67E8F9]">
            {waypoints.length}
          </span>
          {routeSummary && (
            <span className="text-[11px] font-mono tabular-nums text-[#8C96A8] border-l border-white/15 pl-2">
              {routeSummary.durationText} · {routeSummary.distanceText}
            </span>
          )}
          <ChevronDown className="w-3.5 h-3.5 text-[#8C96A8]" aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <aside
      aria-label="Real-time route and waypoints overlay"
      className="absolute top-14 left-5 z-30 w-[356px] max-w-[calc(100vw-2.5rem)] max-h-[calc(100vh-11rem)] flex flex-col bg-[#0D1017]/95 border border-[#22D3EE]/35 rounded-xl shadow-[0_20px_56px_rgba(0,0,0,0.75)] overflow-hidden"
    >
      {/* Header Bar */}
      <div className="px-3.5 py-2.5 border-b border-white/10 flex items-center justify-between gap-2 bg-[#0A0D13]">
        <div className="flex items-center gap-2 min-w-0">
          <RouteIcon className="w-4 h-4 text-[#22D3EE] shrink-0" aria-hidden="true" />
          <span className="text-xs font-semibold text-[#F5F7FA] truncate">
            Live Waypoints &amp; Route
          </span>
          <span className="px-1.5 py-0.5 text-[10px] font-mono tabular-nums rounded bg-[#22D3EE]/15 text-[#67E8F9] shrink-0">
            {waypoints.length}/{MAX_ROUTE_WAYPOINTS}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onOpenFullMap}
            title="Switch to full Site & Story Map"
            className="h-7 px-2 inline-flex items-center gap-1 text-[11px] text-[#8C96A8] hover:text-[#67E8F9] bg-[#131820] border border-white/10 rounded cursor-pointer"
          >
            <MapIcon className="w-3 h-3" aria-hidden="true" />
            <span>Map</span>
            <ExternalLink className="w-2.5 h-2.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-label="Collapse route overlay"
            title="Minimize route overlay"
            className="w-7 h-7 inline-flex items-center justify-center text-[#8C96A8] hover:text-[#F5F7FA] bg-[#131820] border border-white/10 rounded cursor-pointer"
          >
            <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Live Mini-Map Viewport */}
      <div className="relative shrink-0">
        {apiKey ? (
          <div className="w-full h-[184px] bg-[#090C11] border-b border-white/10 relative">
            <APIProvider apiKey={apiKey} language="en">
              <GoogleMap
                className="w-full h-full"
                defaultCenter={
                  waypoints[0]
                    ? { lat: waypoints[0].lat, lng: waypoints[0].lng }
                    : DEFAULT_CENTER
                }
                defaultZoom={12}
                mapId="DEMO_MAP_ID"
                disableDefaultUI
                zoomControl
                gestureHandling="greedy"
                internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
              >
                <MiniMapController
                  waypoints={waypoints}
                  travelMode={travelMode}
                  optimizeOrder={optimizeOrder}
                  focusedWaypointId={focusedWaypointId}
                  onSelectWaypoint={(id) => handleSelectWaypoint(id, true)}
                  onRouteComputed={handleRouteComputed}
                  onAddPlaceWaypoint={handleAddPlaceWaypoint}
                  searchQuery={searchQuery}
                  onSearchQueryChange={setSearchQuery}
                  onSuggestionsChange={handleSuggestionsChange}
                  selectSuggestionRef={selectSuggestionRef}
                />
              </GoogleMap>
            </APIProvider>

            {isComputingRoute && (
              <div className="pointer-events-none absolute bottom-2 right-2 px-2 py-1 rounded bg-[#0B0D10]/95 border border-[#22D3EE]/35 inline-flex items-center gap-1.5 text-[10px] font-mono text-[#67E8F9]">
                <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                Routing...
              </div>
            )}
          </div>
        ) : (
          <SchematicRoutePreview waypoints={waypoints} />
        )}
      </div>

      {/* Quick Add Waypoint Search (when API key is active) */}
      {apiKey && (
        <div className="px-3 py-2 border-b border-white/10 bg-[#0B0E14] relative">
          <div className="relative">
            <Search
              className="w-3.5 h-3.5 text-[#22D3EE] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              disabled={waypoints.length >= MAX_ROUTE_WAYPOINTS}
              placeholder={
                waypoints.length >= MAX_ROUTE_WAYPOINTS
                  ? 'Maximum 12 stops reached'
                  : 'Add real place to route...'
              }
              className="w-full h-8 pl-8 pr-7 bg-[#131820] border border-white/10 focus:border-[#22D3EE]/50 rounded-md text-xs text-[#F5F7FA] placeholder:text-[#7B8698] focus:outline-none disabled:opacity-50"
            />
            {isSearchingPlaces ? (
              <Loader2 className="w-3.5 h-3.5 text-[#67E8F9] animate-spin absolute right-2 top-1/2 -translate-y-1/2" />
            ) : searchQuery ? (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setSuggestions([]);
                }}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-[#8C96A8] hover:text-[#F5F7FA] cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            ) : null}
          </div>

          {suggestions.length > 0 && (
            <ul className="mt-1.5 bg-[#0A0D12] border border-[#22D3EE]/30 rounded-lg divide-y divide-white/10 max-h-40 overflow-y-auto shadow-xl">
              {suggestions.map((suggestion, idx) => (
                <li key={suggestion.placePrediction?.placeId || idx}>
                  <button
                    type="button"
                    onClick={() => void selectSuggestionRef.current?.(suggestion)}
                    className="w-full text-left px-2.5 py-2 hover:bg-[#171E2A] flex items-center justify-between gap-2 cursor-pointer"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-[#F5F7FA] truncate">
                        {suggestion.placePrediction?.mainText?.text || 'Place'}
                      </p>
                      {suggestion.placePrediction?.secondaryText?.text && (
                        <p className="text-[10px] text-[#8C96A8] truncate">
                          {suggestion.placePrediction.secondaryText.text}
                        </p>
                      )}
                    </div>
                    <Plus
                      className="w-3.5 h-3.5 text-[#22D3EE] shrink-0"
                      aria-hidden="true"
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Travel Mode + Route Actions */}
      <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between gap-2 flex-wrap bg-[#0D1017]">
        <div className="inline-flex items-center gap-1 bg-[#131820] border border-white/10 rounded-md p-0.5">
          {(
            [
              { id: 'DRIVE', label: 'Drive', icon: Car },
              { id: 'WALK', label: 'Walk', icon: Footprints },
              { id: 'BICYCLE', label: 'Bike', icon: Bike },
            ] as const
          ).map((mode) => {
            const Icon = mode.icon;
            const active = travelMode === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                onClick={() => onTravelModeChange(mode.id)}
                className={`h-6 px-2 inline-flex items-center gap-1 text-[11px] font-medium rounded transition-colors cursor-pointer ${
                  active
                    ? 'bg-[#22D3EE]/20 text-[#67E8F9]'
                    : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                }`}
              >
                <Icon className="w-3 h-3" aria-hidden="true" />
                {mode.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1">
          {waypoints.length >= 3 && (
            <button
              type="button"
              disabled={hasIntermediateVia}
              title={
                hasIntermediateVia
                  ? 'Optimization disabled when via pass-throughs are set'
                  : 'Optimize intermediate stop order'
              }
              onClick={() => onOptimizeOrderChange(!optimizeOrder)}
              className={`h-6 px-2 inline-flex items-center gap-1 text-[10px] font-medium rounded border transition-colors cursor-pointer disabled:opacity-40 ${
                optimizeOrder && !hasIntermediateVia
                  ? 'bg-[#22D3EE]/20 border-[#22D3EE]/50 text-[#67E8F9]'
                  : 'bg-[#131820] border-white/10 text-[#8C96A8] hover:text-[#F5F7FA]'
              }`}
            >
              <Sparkles className="w-2.5 h-2.5" aria-hidden="true" />
              Optimize
            </button>
          )}
          {waypoints.length >= 2 && (
            <button
              type="button"
              onClick={handleReverse}
              title="Reverse stop order"
              className="w-6 h-6 inline-flex items-center justify-center bg-[#131820] border border-white/10 rounded text-[#8C96A8] hover:text-[#F5F7FA] cursor-pointer"
            >
              <ArrowUpDown className="w-3 h-3" aria-hidden="true" />
            </button>
          )}
          {waypoints.length > 0 && (
            <button
              type="button"
              onClick={() => {
                onWaypointsChange([]);
                handleSelectWaypoint(null, false);
              }}
              className="h-6 px-1.5 text-[10px] text-[#8C96A8] hover:text-red-300 cursor-pointer"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Live Route Telemetry Summary */}
      {routeSummary && (
        <div className="px-3 py-2 border-b border-white/10 bg-[#0A1318] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-xs font-mono font-semibold tabular-nums text-[#67E8F9]">
              {routeSummary.durationText}
            </span>
            <span className="text-[11px] font-mono tabular-nums text-[#C7D0DF]">
              {routeSummary.distanceText}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {routeSummary.optimizedOrderApplied && (
              <button
                type="button"
                onClick={handleApplyOptimized}
                className="h-6 px-2 text-[10px] font-semibold bg-[#22D3EE] text-[#071318] rounded hover:bg-[#67E8F9] cursor-pointer"
              >
                Apply Order
              </button>
            )}
            {routeSummary.legs.length > 1 && (
              <button
                type="button"
                onClick={() => setLegsOpen((v) => !v)}
                className="h-6 px-1.5 inline-flex items-center gap-0.5 text-[10px] font-mono text-[#8C96A8] hover:text-[#F5F7FA] bg-[#131820] border border-white/10 rounded cursor-pointer"
              >
                {routeSummary.legs.length} legs
                {legsOpen ? (
                  <ChevronUp className="w-2.5 h-2.5" />
                ) : (
                  <ChevronDown className="w-2.5 h-2.5" />
                )}
              </button>
            )}
          </div>
        </div>
      )}

      {routeError && (
        <div className="px-3 py-1.5 bg-red-950/60 border-b border-red-400/30 text-[11px] text-red-200">
          {routeError}
        </div>
      )}

      {/* Per-Leg Breakdown Drawer */}
      {legsOpen && routeSummary && routeSummary.legs.length > 0 && (
        <div className="px-3 py-2 border-b border-white/10 bg-[#090C11] space-y-1 max-h-28 overflow-y-auto">
          {routeSummary.legs.map((leg, idx) => (
            <div
              key={`${leg.fromName}-${leg.toName}-${idx}`}
              className="flex items-center justify-between gap-2 text-[10px]"
            >
              <span className="text-[#9FB0C4] truncate">
                <span className="font-mono text-[#22D3EE] mr-1">L{idx + 1}</span>
                {leg.fromName} → {leg.toName}
              </span>
              <span className="font-mono tabular-nums text-[#C7D0DF] shrink-0">
                {leg.durationText} · {leg.distanceText}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Ordered Waypoints List */}
      <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5 min-h-[72px]">
        {waypoints.length === 0 ? (
          <div className="py-3 px-2 text-center space-y-2">
            <p className="text-xs text-[#8C96A8]">
              Search any real venue or address above to add navigable 3D route checkpoints.
            </p>
            <div className="flex items-center justify-center gap-2">
              {apiKey && (
                <button
                  type="button"
                  onClick={() => searchInputRef.current?.focus()}
                  className="h-7 px-3 inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors cursor-pointer"
                >
                  <Search className="w-3 h-3" aria-hidden="true" />
                  Search Places
                </button>
              )}
              <button
                type="button"
                onClick={onOpenFullMap}
                className="h-7 px-3 inline-flex items-center gap-1.5 text-[11px] font-medium text-[#C7D0DF] hover:text-[#F5F7FA] bg-[#141A24] border border-white/15 rounded-md transition-colors cursor-pointer"
              >
                <MapIcon className="w-3 h-3 text-[#22D3EE]" aria-hidden="true" />
                Open Map Planner
              </button>
            </div>
          </div>
        ) : (
          waypoints.map((wp, idx) => {
            const isOrigin = idx === 0;
            const isDest = idx === waypoints.length - 1 && waypoints.length > 1;
            const isIntermediate = !isOrigin && !isDest;
            const isFocused = focusedWaypointId === wp.id;

            return (
              <div
                key={wp.id}
                onClick={() => handleSelectWaypoint(wp.id, true)}
                title="Click to focus on mini-map and warp to 3D checkpoint"
                className={`px-2.5 py-2 rounded-lg border transition-colors flex items-center gap-2 cursor-pointer ${
                  isFocused
                    ? 'bg-[#141D2A] border-[#22D3EE]/50'
                    : 'bg-[#12161E] border-white/10 hover:border-[#22D3EE]/30'
                }`}
              >
                <span
                  className={`w-5 h-5 rounded-full font-mono text-[10px] font-bold tabular-nums flex items-center justify-center shrink-0 ${
                    isOrigin
                      ? 'bg-emerald-400/20 text-emerald-300 border border-emerald-400/45'
                      : isDest
                        ? 'bg-[#22D3EE] text-[#071318]'
                        : wp.via
                          ? 'border border-dashed border-[#67E8F9]/70 text-[#67E8F9]'
                          : 'bg-[#22D3EE]/20 text-[#67E8F9] border border-[#22D3EE]/40'
                  }`}
                >
                  {idx + 1}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-[#F5F7FA] truncate">
                      {wp.name}
                    </span>
                    <span className="text-[9px] font-mono uppercase text-[#7B8698] shrink-0">
                      {isOrigin
                        ? 'Start'
                        : isDest
                          ? 'End'
                          : wp.via
                            ? 'Via'
                            : 'Stop'}
                    </span>
                  </div>
                  {wp.address && (
                    <p className="text-[10px] text-[#8C96A8] truncate">{wp.address}</p>
                  )}
                </div>

                <div
                  className="flex items-center gap-0.5 shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  {isIntermediate && (
                    <button
                      type="button"
                      onClick={() => handleToggleVia(wp.id)}
                      title="Toggle pass-through via point"
                      className={`h-6 px-1.5 text-[9px] font-mono uppercase rounded border cursor-pointer ${
                        wp.via
                          ? 'bg-[#22D3EE]/15 border-[#22D3EE]/45 text-[#67E8F9]'
                          : 'bg-[#0B0D10] border-white/10 text-[#8C96A8] hover:text-[#F5F7FA]'
                      }`}
                    >
                      via
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={idx === 0}
                    onClick={() => handleMoveStop(idx, -1)}
                    aria-label="Move stop up"
                    className="p-1 text-[#8C96A8] hover:text-[#F5F7FA] disabled:opacity-30 cursor-pointer"
                  >
                    <ArrowUp className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    disabled={idx === waypoints.length - 1}
                    onClick={() => handleMoveStop(idx, 1)}
                    aria-label="Move stop down"
                    className="p-1 text-[#8C96A8] hover:text-[#F5F7FA] disabled:opacity-30 cursor-pointer"
                  >
                    <ArrowDown className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveStop(wp.id)}
                    aria-label={`Remove ${wp.name}`}
                    className="p-1 text-[#8C96A8] hover:text-red-300 cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
