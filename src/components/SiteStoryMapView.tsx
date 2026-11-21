import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  APIProvider,
  AdvancedMarker,
  InfoWindow,
  Map as GoogleMap,
  Pin,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import { BatchedWaypointLayer } from './BatchedWaypointLayer';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Bike,
  BookmarkPlus,
  Car,
  Check,
  ChevronDown,
  ChevronUp,
  Compass,
  Footprints,
  Loader2,
  MapPin,
  Maximize2,
  Navigation,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import {
  deleteDbMapPin,
  fetchDbMapPins,
  saveDbMapPin,
  type DbMapPinRow,
} from '../services/suiteApi';
import {
  computeMultiStopRoute,
  isMapsQuotaError,
  MAX_ROUTE_WAYPOINTS,
  type RouteLegSummary,
  type RouteTravelMode,
  type RouteWaypoint,
} from '../services/routingService';

interface SiteStoryMapViewProps {
  onSendLocationToMockup: (serviceArea: string, address: string) => void;
  waypoints?: RouteWaypoint[];
  onWaypointsChange?: (waypoints: RouteWaypoint[]) => void;
  travelMode?: RouteTravelMode;
  onTravelModeChange?: (mode: RouteTravelMode) => void;
  optimizeOrder?: boolean;
  onOptimizeOrderChange?: (enabled: boolean) => void;
  focusedWaypointId?: string | null;
  onFocusWaypoint?: (waypointId: string | null) => void;
  onLaunchDispatchRun3D?: (waypointId?: string) => void;
  isImmersiveMode?: boolean;
  onToggleImmersiveMode?: () => void;
}

interface SelectedPlaceDetails {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  rating?: number | null;
  websiteURI?: string | null;
  viewport?: google.maps.LatLngBounds | null;
}

interface RouteMetrics {
  distanceText: string;
  durationText: string;
  stopCount: number;
  intermediateCount: number;
  travelMode: RouteTravelMode;
  legs: RouteLegSummary[];
  orderedWaypoints: RouteWaypoint[];
  optimizedOrderApplied: boolean;
}

const DEFAULT_CENTER = { lat: 37.7897, lng: -122.4014 };

const CATEGORY_STYLES: Record<
  string,
  { label: string; bg: string; border: string; glyph: string }
> = {
  client_site: {
    label: 'Client Site',
    bg: '#22D3EE',
    border: '#0E7490',
    glyph: '#071318',
  },
  story_beat: {
    label: 'Story Beat',
    bg: '#F59E0B',
    border: '#B45309',
    glyph: '#1F1304',
  },
  field_stop: {
    label: 'Field Stop',
    bg: '#A78BFA',
    border: '#6D28D9',
    glyph: '#150B2E',
  },
};

function notifyIfQuotaError(err: unknown) {
  if (isMapsQuotaError(err)) {
    window.dispatchEvent(new Event('gmp-quota-exceeded'));
  }
}

interface SavedPinMarkerProps {
  pin: DbMapPinRow;
  onPickPin: (pinId: number) => void;
}

const SavedPinMarker = memo(function SavedPinMarker({
  pin,
  onPickPin,
}: SavedPinMarkerProps) {
  const style = CATEGORY_STYLES[pin.category] || CATEGORY_STYLES.client_site;
  return (
    <AdvancedMarker
      position={{ lat: pin.lat, lng: pin.lng }}
      title={pin.name}
      onClick={() => onPickPin(pin.id)}
    >
      <Pin
        background={style.bg}
        borderColor={style.border}
        glyphColor={style.glyph}
      />
    </AdvancedMarker>
  );
});

// ---------- Inner Map Controller (Places Autocomplete + Routes + Camera) ----------

interface MapWorkspaceInnerProps {
  pins: DbMapPinRow[];
  selectedPlace: SelectedPlaceDetails | null;
  activePinId: number | null;
  routeStops: RouteWaypoint[];
  focusedWaypointId?: string | null;
  onFocusWaypoint?: (waypointId: string | null) => void;
  optimizeOrder: boolean;
  travelMode: RouteTravelMode;
  onSelectPlace: (place: SelectedPlaceDetails | null) => void;
  onSelectPin: (pinId: number | null) => void;
  onRouteResult: (metrics: RouteMetrics | null, error: string | null) => void;
  onSaveSelectedPlace: (category: string, notes: string) => Promise<void>;
  onDeletePin: (id: number) => Promise<void>;
  onSetStartStop: (pt: { name: string; lat: number; lng: number; address?: string; placeId?: string }) => void;
  onAddRouteStop: (pt: { name: string; lat: number; lng: number; address?: string; placeId?: string }) => void;
  onSendLocationToMockup: (serviceArea: string, address: string) => void;
  isSavingPin: boolean;
  isImmersiveMode?: boolean;
  onToggleImmersiveMode?: () => void;
}

function MapWorkspaceInner({
  pins,
  selectedPlace,
  activePinId,
  routeStops,
  focusedWaypointId = null,
  onFocusWaypoint,
  optimizeOrder,
  travelMode,
  onSelectPlace,
  onSelectPin,
  onRouteResult,
  onSaveSelectedPlace,
  onDeletePin,
  onSetStartStop,
  onAddRouteStop,
  onSendLocationToMockup,
  isSavingPin,
  isImmersiveMode = false,
  onToggleImmersiveMode,
}: MapWorkspaceInnerProps) {
  const map = useMap();
  const placesLib = useMapsLibrary('places');
  const routesLib = useMapsLibrary('routes');
  const geometryLib = useMapsLibrary('geometry');

  // Modern Places API (New) AutocompleteSuggestion + AutocompleteSessionToken
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<
    google.maps.places.AutocompleteSuggestion[]
  >([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const sessionTokenRef =
    useRef<google.maps.places.AutocompleteSessionToken | null>(null);

  const [pinCategory, setPinCategory] = useState<string>('client_site');
  const [pinNotes, setPinNotes] = useState('');

  // Single reused Polyline instance for Routes API
  const polylineRef = useRef<google.maps.Polyline | null>(null);

  // Track padded map viewport bounds so off-screen saved pins are frustum-culled
  const [mapBounds, setMapBounds] = useState<{
    south: number;
    west: number;
    north: number;
    east: number;
  } | null>(null);

  useEffect(() => {
    return () => {
      if (polylineRef.current) {
        polylineRef.current.setMap(null);
        polylineRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!map) return;
    const syncBounds = () => {
      const b = map.getBounds();
      if (!b) return;
      const sw = b.getSouthWest();
      const ne = b.getNorthEast();
      const latPad = Math.max(0.02, (ne.lat() - sw.lat()) * 0.25);
      const lngPad = Math.max(0.02, (ne.lng() - sw.lng()) * 0.25);
      setMapBounds({
        south: sw.lat() - latPad,
        west: sw.lng() - lngPad,
        north: ne.lat() + latPad,
        east: ne.lng() + lngPad,
      });
    };
    syncBounds();
    const idleListener = map.addListener('idle', syncBounds);
    return () => {
      idleListener.remove();
    };
  }, [map]);

  useEffect(() => {
    if (!placesLib) return;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      setSearchError(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        setIsSearching(true);
        setSearchError(null);
        if (!sessionTokenRef.current) {
          sessionTokenRef.current = new placesLib.AutocompleteSessionToken();
        }
        const res =
          await placesLib.AutocompleteSuggestion.fetchAutocompleteSuggestions({
            input: trimmed,
            sessionToken: sessionTokenRef.current,
          });
        if (!cancelled) {
          setSuggestions(res.suggestions ?? []);
        }
      } catch (err) {
        notifyIfQuotaError(err);
        if (!cancelled) {
          setSearchError('Could not load place suggestions right now.');
          setSuggestions([]);
        }
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }, 240);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [placesLib, query]);

  const handleSelectSuggestion = useCallback(
    async (suggestion: google.maps.places.AutocompleteSuggestion) => {
      if (!placesLib || !suggestion.placePrediction) return;
      try {
        setIsSearching(true);
        setSearchError(null);
        const place = suggestion.placePrediction.toPlace();
        await place.fetchFields({
          fields: [
            'id',
            'displayName',
            'formattedAddress',
            'location',
            'viewport',
            'rating',
            'websiteURI',
          ],
        });

        // Reset session token after consuming fetchFields
        sessionTokenRef.current = null;
        setSuggestions([]);
        setQuery('');

        const loc = place.location;
        if (!loc) {
          setSearchError('Selected place has no map coordinates.');
          return;
        }

        const lat = typeof loc.lat === 'function' ? loc.lat() : Number(loc.lat);
        const lng = typeof loc.lng === 'function' ? loc.lng() : Number(loc.lng);

        onSelectPin(null);
        onSelectPlace({
          placeId: place.id || '',
          name: place.displayName || 'Selected Location',
          address: place.formattedAddress || '',
          lat,
          lng,
          rating: place.rating ?? null,
          websiteURI: place.websiteURI ?? null,
          viewport: place.viewport ?? null,
        });

        if (map) {
          if (place.viewport) {
            map.fitBounds(place.viewport);
          } else {
            map.panTo({ lat, lng });
            map.setZoom(15);
          }
        }
      } catch (err) {
        notifyIfQuotaError(err);
        setSearchError('Could not fetch place details.');
      } finally {
        setIsSearching(false);
      }
    },
    [map, onSelectPin, onSelectPlace, placesLib]
  );

  // Compute Multi-Stop Routes via dedicated routingService with single-Polyline reuse & RDP decimation
  useEffect(() => {
    if (!map || !routesLib || routeStops.length < 2) {
      if (polylineRef.current) {
        polylineRef.current.setMap(null);
      }
      onRouteResult(null, null);
      return;
    }

    let cancelled = false;

    const compute = async () => {
      try {
        const result = await computeMultiStopRoute({
          routesLib,
          geometryLib,
          waypoints: routeStops,
          travelMode,
          optimizeWaypointOrder: optimizeOrder,
          maxPathVertices: 1200,
          existingPolyline: polylineRef.current,
          polylineOptions: {
            strokeColor: '#22D3EE',
            strokeOpacity: 0.95,
            strokeWeight: 5,
          },
        });

        if (cancelled) return;

        const primaryLine = result.polylines[0] ?? null;
        polylineRef.current = primaryLine;
        if (primaryLine && primaryLine.getMap() !== map) {
          primaryLine.setMap(map);
        }

        if (result.viewport) {
          map.fitBounds(result.viewport, 70);
        }

        onRouteResult(
          {
            distanceText: result.distanceText,
            durationText: result.durationText,
            stopCount: result.stopCount,
            intermediateCount: result.intermediateCount,
            travelMode: result.travelMode,
            legs: result.legs,
            orderedWaypoints: result.orderedWaypoints,
            optimizedOrderApplied: result.optimizedOrderApplied,
          },
          null
        );
      } catch (err) {
        notifyIfQuotaError(err);
        if (!cancelled) {
          if (polylineRef.current) {
            polylineRef.current.setMap(null);
          }
          onRouteResult(
            null,
            err instanceof Error
              ? err.message
              : 'Could not compute multi-stop route between these locations.'
          );
        }
      }
    };

    void compute();

    return () => {
      cancelled = true;
    };
  }, [
    geometryLib,
    map,
    onRouteResult,
    optimizeOrder,
    routeStops,
    routesLib,
    travelMode,
  ]);

  const activePin = useMemo(
    () => pins.find((p) => p.id === activePinId) ?? null,
    [pins, activePinId]
  );

  const handlePickSavedPin = useCallback(
    (pinId: number) => {
      onSelectPlace(null);
      onSelectPin(pinId);
    },
    [onSelectPin, onSelectPlace]
  );

  // Frustum-cull off-screen pins and suppress pins already covered by an active numbered route stop
  const visiblePins = useMemo(() => {
    return pins.filter((pin) => {
      if (pin.id === activePinId) return true;
      const overlappedByStop = routeStops.some(
        (stop) =>
          Math.abs(stop.lat - pin.lat) < 1e-5 &&
          Math.abs(stop.lng - pin.lng) < 1e-5
      );
      if (overlappedByStop) return false;
      if (!mapBounds) return true;
      return (
        pin.lat >= mapBounds.south &&
        pin.lat <= mapBounds.north &&
        pin.lng >= mapBounds.west &&
        pin.lng <= mapBounds.east
      );
    });
  }, [activePinId, mapBounds, pins, routeStops]);

  // Pan map when clicking a saved pin
  useEffect(() => {
    if (!map || !activePin) return;
    map.panTo({ lat: activePin.lat, lng: activePin.lng });
  }, [activePin, map]);

  // Pan map smoothly when focusing a waypoint (including returning from 3D Checkpoint exploration)
  useEffect(() => {
    if (!map || !focusedWaypointId) return;
    const wp = routeStops.find((s) => s.id === focusedWaypointId);
    if (!wp) return;
    map.panTo({ lat: wp.lat, lng: wp.lng });
    if ((map.getZoom() ?? 12) < 14) {
      map.setZoom(14);
    }
  }, [focusedWaypointId, map, routeStops]);

  const handleSaveForm = async (e: FormEvent) => {
    e.preventDefault();
    await onSaveSelectedPlace(pinCategory, pinNotes);
    setPinNotes('');
  };

  // Smoothly re-sync map viewport tiles & camera center when toggling Full-Screen Immersive Mode
  useEffect(() => {
    if (!map) return;
    const center = map.getCenter();
    const raf = window.requestAnimationFrame(() => {
      if (typeof google !== 'undefined' && google.maps?.event) {
        google.maps.event.trigger(map, 'resize');
      }
      if (center) {
        map.panTo(center);
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [isImmersiveMode, map]);

  return (
    <>
      {/* Floating Places Autocomplete Search Bar (hidden in Full-Screen Immersive Mode for a clean map viewport) */}
      {!isImmersiveMode && (
        <div className="absolute top-3.5 left-3.5 right-16 sm:right-auto sm:w-[390px] z-20">
          <div className="relative bg-[#0E1116]/95 border border-[#22D3EE]/35 rounded-lg shadow-xl">
            <Search
              className="w-4 h-4 text-[#22D3EE] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search real places, venues, or client addresses..."
              className="w-full h-11 pl-10 pr-9 bg-transparent text-sm text-[#F5F7FA] placeholder:text-[#8C96A8] focus:outline-none"
            />
            {isSearching ? (
              <Loader2 className="w-4 h-4 text-[#67E8F9] animate-spin absolute right-3 top-1/2 -translate-y-1/2" />
            ) : query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setSuggestions([]);
                }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[#8C96A8] hover:text-[#F5F7FA] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            ) : null}
          </div>

          {searchError && (
            <div className="mt-1.5 px-3 py-2 bg-red-950/90 border border-red-400/40 rounded-lg text-xs text-red-200">
              {searchError}
            </div>
          )}

          {suggestions.length > 0 && (
            <ul className="mt-1.5 bg-[#0E1116]/98 border border-[#22D3EE]/30 rounded-lg shadow-2xl overflow-hidden divide-y divide-white/10 max-h-72 overflow-y-auto">
              {suggestions.map((suggestion, idx) => (
                <li key={suggestion.placePrediction?.placeId || idx}>
                  <button
                    type="button"
                    onClick={() => void handleSelectSuggestion(suggestion)}
                    className="w-full px-3.5 py-2.5 text-left hover:bg-[#19202C] transition-colors flex items-start gap-2.5 cursor-pointer"
                  >
                    <MapPin className="w-4 h-4 text-[#22D3EE] shrink-0 mt-0.5" />
                    <span className="text-xs text-[#F5F7FA] leading-snug">
                      {suggestion.placePrediction?.text.text}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Direct In-Map Full-Screen Launcher (shown only in standard workspace mode) */}
      {!isImmersiveMode && onToggleImmersiveMode && (
        <button
          type="button"
          onClick={onToggleImmersiveMode}
          title="Enter Full-Screen Map Navigation (F)"
          className="absolute top-3.5 right-3.5 z-20 h-10 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#0E1116]/95 hover:bg-[#19202C] border border-[#22D3EE]/35 rounded-lg shadow-xl cursor-pointer whitespace-nowrap"
        >
          <Maximize2 className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
          <span className="hidden sm:inline">Full Screen</span>
        </button>
      )}

      {/* Frustum-Culled & Deduplicated Saved Pins */}
      {visiblePins.map((pin) => (
        <SavedPinMarker key={pin.id} pin={pin} onPickPin={handlePickSavedPin} />
      ))}

      {/* Single-Canvas Batched Route Waypoint Layer */}
      <BatchedWaypointLayer
        waypoints={routeStops}
        focusedWaypointId={focusedWaypointId}
        onSelectWaypoint={(id) => onFocusWaypoint?.(id)}
        badgeRadius={13}
      />

      {/* Temporary Selected Search Marker */}
      {selectedPlace && (
        <AdvancedMarker
          position={{ lat: selectedPlace.lat, lng: selectedPlace.lng }}
          title={selectedPlace.name}
        >
          <Pin background="#67E8F9" borderColor="#0891B2" glyphColor="#071318" />
        </AdvancedMarker>
      )}

      {/* InfoWindow for Newly Searched Place */}
      {selectedPlace && (
        <InfoWindow
          position={{ lat: selectedPlace.lat, lng: selectedPlace.lng }}
          onCloseClick={() => onSelectPlace(null)}
        >
          <div className="p-1 max-w-[270px] text-[#0F172A]">
            <div className="font-semibold text-sm leading-snug">
              {selectedPlace.name}
            </div>
            {selectedPlace.address && (
              <p className="text-xs text-slate-600 mt-0.5">{selectedPlace.address}</p>
            )}
            {typeof selectedPlace.rating === 'number' && (
              <p className="text-xs text-amber-700 font-medium mt-1 tabular-nums">
                Rating: {selectedPlace.rating.toFixed(1)} / 5
              </p>
            )}

            <form onSubmit={(e) => void handleSaveForm(e)} className="mt-2.5 space-y-2">
              <select
                value={pinCategory}
                onChange={(e) => setPinCategory(e.target.value)}
                className="w-full h-8 px-2 text-xs border border-slate-300 rounded bg-white text-slate-900"
              >
                <option value="client_site">Client Site</option>
                <option value="story_beat">Story Beat</option>
                <option value="field_stop">Field Stop</option>
              </select>
              <input
                type="text"
                value={pinNotes}
                onChange={(e) => setPinNotes(e.target.value)}
                placeholder="Optional field note..."
                className="w-full h-8 px-2 text-xs border border-slate-300 rounded bg-white text-slate-900"
              />
              <div className="flex items-center gap-1.5">
                <button
                  type="submit"
                  disabled={isSavingPin}
                  className="flex-1 h-8 px-2.5 inline-flex items-center justify-center gap-1 bg-slate-900 text-white text-xs font-medium rounded hover:bg-slate-800 cursor-pointer"
                >
                  <BookmarkPlus className="w-3.5 h-3.5" />
                  Save Pin
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onAddRouteStop({
                      name: selectedPlace.name,
                      lat: selectedPlace.lat,
                      lng: selectedPlace.lng,
                      address: selectedPlace.address,
                      placeId: selectedPlace.placeId,
                    })
                  }
                  className="h-8 px-2.5 bg-cyan-600 text-white text-xs font-medium rounded hover:bg-cyan-700 whitespace-nowrap cursor-pointer"
                >
                  + Route Stop
                </button>
              </div>
              <button
                type="button"
                onClick={() =>
                  onSendLocationToMockup(
                    selectedPlace.name,
                    selectedPlace.address || selectedPlace.name
                  )
                }
                className="w-full h-7 text-[11px] font-medium text-cyan-800 bg-cyan-50 border border-cyan-200 rounded hover:bg-cyan-100 cursor-pointer"
              >
                Use as Mockup Service Area
              </button>
            </form>
          </div>
        </InfoWindow>
      )}

      {/* InfoWindow for Saved Pin */}
      {activePin && (
        <InfoWindow
          position={{ lat: activePin.lat, lng: activePin.lng }}
          onCloseClick={() => onSelectPin(null)}
        >
          <div className="p-1 max-w-[260px] text-[#0F172A]">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-cyan-800">
              {CATEGORY_STYLES[activePin.category]?.label || 'Saved Pin'}
            </div>
            <div className="font-semibold text-sm leading-snug mt-0.5">
              {activePin.name}
            </div>
            {activePin.address && (
              <p className="text-xs text-slate-600 mt-0.5">{activePin.address}</p>
            )}
            {activePin.notes && (
              <p className="text-xs text-slate-700 mt-1.5 bg-slate-100 p-1.5 rounded">
                {activePin.notes}
              </p>
            )}
            <div className="mt-2.5 flex items-center gap-1.5">
              <button
                type="button"
                onClick={() =>
                  onSetStartStop({
                    name: activePin.name,
                    lat: activePin.lat,
                    lng: activePin.lng,
                    address: activePin.address,
                    placeId: activePin.placeId,
                  })
                }
                className="flex-1 h-7 text-[11px] font-medium bg-slate-900 text-white rounded cursor-pointer"
              >
                Set Start
              </button>
              <button
                type="button"
                onClick={() =>
                  onAddRouteStop({
                    name: activePin.name,
                    lat: activePin.lat,
                    lng: activePin.lng,
                    address: activePin.address,
                    placeId: activePin.placeId,
                  })
                }
                className="flex-1 h-7 text-[11px] font-medium bg-cyan-600 text-white rounded cursor-pointer"
              >
                Add Stop
              </button>
              <button
                type="button"
                onClick={() => void onDeletePin(activePin.id)}
                className="h-7 px-2 text-red-700 bg-red-50 hover:bg-red-100 rounded cursor-pointer"
                title="Delete pin"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </InfoWindow>
      )}
    </>
  );
}

// ---------- Main Exported SiteStoryMapView ----------

export function SiteStoryMapView({
  onSendLocationToMockup,
  waypoints,
  onWaypointsChange,
  travelMode: controlledTravelMode,
  onTravelModeChange,
  optimizeOrder: controlledOptimizeOrder,
  onOptimizeOrderChange,
  focusedWaypointId = null,
  onFocusWaypoint,
  onLaunchDispatchRun3D,
  isImmersiveMode = false,
  onToggleImmersiveMode,
}: SiteStoryMapViewProps) {
  const { user, getIdToken, signInWithGoogle } = useAuth();
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

  const [pins, setPins] = useState<DbMapPinRow[]>([]);
  const [selectedPlace, setSelectedPlace] = useState<SelectedPlaceDetails | null>(null);
  const [activePinId, setActivePinId] = useState<number | null>(null);
  const [isSavingPin, setIsSavingPin] = useState(false);

  const [internalStops, setInternalStops] = useState<RouteWaypoint[]>(
    () => waypoints ?? []
  );
  const isControlledWaypoints = waypoints !== undefined;
  const routeStops = isControlledWaypoints ? waypoints : internalStops;

  const updateRouteStops = useCallback(
    (updater: (prev: RouteWaypoint[]) => RouteWaypoint[]) => {
      if (isControlledWaypoints) {
        const next = updater(waypoints).slice(0, MAX_ROUTE_WAYPOINTS);
        onWaypointsChange?.(next);
      } else {
        setInternalStops((prev) => {
          const next = updater(prev).slice(0, MAX_ROUTE_WAYPOINTS);
          onWaypointsChange?.(next);
          return next;
        });
      }
    },
    [isControlledWaypoints, onWaypointsChange, waypoints]
  );

  const [internalOptimizeOrder, setInternalOptimizeOrder] = useState<boolean>(false);
  const optimizeOrder =
    controlledOptimizeOrder !== undefined
      ? controlledOptimizeOrder
      : internalOptimizeOrder;
  const setOptimizeOrder = useCallback(
    (val: boolean | ((prev: boolean) => boolean)) => {
      const next = typeof val === 'function' ? val(optimizeOrder) : val;
      if (controlledOptimizeOrder === undefined) {
        setInternalOptimizeOrder(next);
      }
      onOptimizeOrderChange?.(next);
    },
    [controlledOptimizeOrder, onOptimizeOrderChange, optimizeOrder]
  );

  const [legsExpanded, setLegsExpanded] = useState<boolean>(false);
  const [internalTravelMode, setInternalTravelMode] = useState<RouteTravelMode>('DRIVE');
  const travelMode =
    controlledTravelMode !== undefined ? controlledTravelMode : internalTravelMode;
  const setTravelMode = useCallback(
    (mode: RouteTravelMode) => {
      if (controlledTravelMode === undefined) {
        setInternalTravelMode(mode);
      }
      onTravelModeChange?.(mode);
    },
    [controlledTravelMode, onTravelModeChange]
  );
  const [routeMetrics, setRouteMetrics] = useState<RouteMetrics | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let active = true;
    getIdToken()
      .then((token) => (token ? fetchDbMapPins(token) : []))
      .then((loaded) => {
        if (active) setPins(loaded);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [user, getIdToken]);

  const handleRouteResult = useCallback(
    (metrics: RouteMetrics | null, error: string | null) => {
      setRouteMetrics(metrics);
      setRouteError(error);
    },
    []
  );

  const handleSetStartStop = useCallback(
    (pt: { name: string; lat: number; lng: number; address?: string; placeId?: string }) => {
      updateRouteStops((prev) => {
        const nextStop: RouteWaypoint = {
          id: `stop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: pt.name,
          lat: pt.lat,
          lng: pt.lng,
          address: pt.address,
          placeId: pt.placeId,
          via: false,
        };
        if (prev.length === 0) return [nextStop];
        return [nextStop, ...prev.slice(1)];
      });
    },
    [updateRouteStops]
  );

  const handleAddRouteStop = useCallback(
    (pt: { name: string; lat: number; lng: number; address?: string; placeId?: string }) => {
      updateRouteStops((prev) => {
        if (prev.length >= MAX_ROUTE_WAYPOINTS) return prev;
        const last = prev[prev.length - 1];
        if (
          last &&
          Math.abs(last.lat - pt.lat) < 1e-5 &&
          Math.abs(last.lng - pt.lng) < 1e-5
        ) {
          return prev;
        }
        return [
          ...prev,
          {
            id: `stop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: pt.name,
            lat: pt.lat,
            lng: pt.lng,
            address: pt.address,
            placeId: pt.placeId,
            via: false,
          },
        ];
      });
    },
    [updateRouteStops]
  );

  const handleMoveRouteStop = useCallback(
    (index: number, delta: -1 | 1) => {
      updateRouteStops((prev) => {
        const target = index + delta;
        if (target < 0 || target >= prev.length) return prev;
        const copy = [...prev];
        const [moved] = copy.splice(index, 1);
        copy.splice(target, 0, moved);
        // Origin and destination are always stopovers, never via pass-throughs
        return copy.map((wp, i) =>
          i === 0 || i === copy.length - 1 ? { ...wp, via: false } : wp
        );
      });
    },
    [updateRouteStops]
  );

  const handleToggleViaWaypoint = useCallback(
    (id: string) => {
      updateRouteStops((prev) =>
        prev.map((wp, idx) => {
          if (wp.id !== id || idx === 0 || idx === prev.length - 1) return wp;
          return { ...wp, via: !wp.via };
        })
      );
    },
    [updateRouteStops]
  );

  const handleReverseRoute = useCallback(() => {
    updateRouteStops((prev) => {
      const reversed = [...prev].reverse();
      return reversed.map((wp, idx) =>
        idx === 0 || idx === reversed.length - 1 ? { ...wp, via: false } : wp
      );
    });
  }, [updateRouteStops]);

  const handleApplyOptimizedOrder = useCallback(() => {
    if (!routeMetrics?.optimizedOrderApplied) return;
    updateRouteStops(() => routeMetrics.orderedWaypoints);
    setOptimizeOrder(false);
  }, [routeMetrics, updateRouteStops]);

  const handleRemoveRouteStop = useCallback(
    (id: string) => {
      updateRouteStops((prev) => {
        const filtered = prev.filter((s) => s.id !== id);
        return filtered.map((wp, idx) =>
          idx === 0 || idx === filtered.length - 1 ? { ...wp, via: false } : wp
        );
      });
    },
    [updateRouteStops]
  );

  const hasIntermediateVia = useMemo(
    () => routeStops.slice(1, -1).some((s) => Boolean(s.via)),
    [routeStops]
  );

  const handleSaveSelectedPlace = useCallback(
    async (category: string, notes: string) => {
      if (!selectedPlace) return;
      setIsSavingPin(true);
      try {
        if (user) {
          const token = await getIdToken();
          if (token) {
            const saved = await saveDbMapPin(token, {
              placeId: selectedPlace.placeId,
              name: selectedPlace.name,
              address: selectedPlace.address,
              category,
              lat: selectedPlace.lat,
              lng: selectedPlace.lng,
              notes,
            });
            setPins((prev) => [saved, ...prev]);
            setSelectedPlace(null);
            setActivePinId(saved.id);
            return;
          }
        }
        // Guest local session pin
        const localPin: DbMapPinRow = {
          id: -Date.now(),
          placeId: selectedPlace.placeId,
          name: selectedPlace.name,
          address: selectedPlace.address,
          category,
          lat: selectedPlace.lat,
          lng: selectedPlace.lng,
          notes,
          createdAt: new Date().toISOString(),
        };
        setPins((prev) => [localPin, ...prev]);
        setSelectedPlace(null);
        setActivePinId(localPin.id);
      } finally {
        setIsSavingPin(false);
      }
    },
    [getIdToken, selectedPlace, user]
  );

  const handleDeletePin = useCallback(
    async (id: number) => {
      setPins((prev) => prev.filter((p) => p.id !== id));
      setActivePinId((prev) => (prev === id ? null : prev));
      if (user && id > 0) {
        const token = await getIdToken();
        if (token) {
          deleteDbMapPin(token, id).catch(() => {});
        }
      }
    },
    [getIdToken, user]
  );

  if (!apiKey) {
    return (
      <div
        className={`${
          isImmersiveMode ? 'w-full h-full' : 'h-[calc(100vh-8.5rem)] min-h-[540px]'
        } flex items-center justify-center p-6`}
      >
        <div className="max-w-md bg-[#13161C] border border-[#22D3EE]/25 rounded-xl p-6 text-center">
          <MapPin className="w-8 h-8 text-[#22D3EE] mx-auto mb-3" />
          <h3 className="font-serif text-xl text-[#F5F7FA] mb-2">
            Google Maps Key Required
          </h3>
          <p className="text-xs text-[#8C96A8] leading-relaxed">
            Configure <code className="text-[#67E8F9]">VITE_GOOGLE_MAPS_API_KEY</code> in
            your environment to load the interactive Site &amp; Story Map, Places search, and
            Routes planner.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        isImmersiveMode
          ? 'w-full h-full relative bg-[#0B0D10]'
          : 'h-[calc(100vh-8.5rem)] min-h-[540px] grid grid-cols-1 lg:grid-cols-12'
      }
    >
      {/* Left Sidebar: Saved Locations & Route Planner (hidden in Full-Screen Immersive Mode) */}
      {!isImmersiveMode && (
        <aside className="lg:col-span-4 xl:col-span-3 bg-[#101319] border-r border-[#22D3EE]/20 flex flex-col overflow-hidden">
        {/* Multi-Stop Route Planner Card */}
        <div className="p-4 border-b border-white/10 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[#22D3EE] inline-flex items-center gap-1.5">
              <Navigation className="w-3.5 h-3.5" />
              Multi-Stop Route ({routeStops.length}/{MAX_ROUTE_WAYPOINTS})
            </h2>
            <div className="flex items-center gap-2">
              {routeStops.length >= 2 && (
                <button
                  type="button"
                  onClick={handleReverseRoute}
                  title="Reverse waypoint order"
                  className="text-[11px] text-[#8C96A8] hover:text-[#67E8F9] inline-flex items-center gap-1 cursor-pointer"
                >
                  <ArrowUpDown className="w-3 h-3" aria-hidden="true" />
                  Reverse
                </button>
              )}
              {routeStops.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    updateRouteStops(() => []);
                    setRouteMetrics(null);
                    setRouteError(null);
                    setLegsExpanded(false);
                  }}
                  className="text-[11px] text-[#8C96A8] hover:text-[#F5F7FA] cursor-pointer"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#0B0D10] rounded-lg border border-white/10">
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
                  onClick={() => setTravelMode(mode.id)}
                  className={`h-8 inline-flex items-center justify-center gap-1.5 text-xs font-medium rounded-md cursor-pointer ${
                    active
                      ? 'bg-[#22D3EE]/18 text-[#67E8F9] border border-[#22D3EE]/40'
                      : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                  {mode.label}
                </button>
              );
            })}
          </div>

          {/* Ordered Waypoints List */}
          {routeStops.length === 0 ? (
            <div className="px-3 py-2.5 bg-[#0B0D10] border border-dashed border-white/10 rounded-md text-xs text-[#8C96A8] space-y-2">
              <p>
                Add 2–{MAX_ROUTE_WAYPOINTS} waypoints from search results or saved pins to
                build a multi-stop field itinerary.
              </p>
              {onLaunchDispatchRun3D && (
                <button
                  type="button"
                  onClick={() => onLaunchDispatchRun3D()}
                  className="w-full h-8 px-2.5 inline-flex items-center justify-center gap-1.5 text-xs font-medium text-[#67E8F9] bg-[#131924] hover:bg-[#192231] border border-[#22D3EE]/35 rounded-md cursor-pointer"
                >
                  <Compass className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                  Explore Briefing in 3D
                </button>
              )}
            </div>
          ) : (
            <>
              <ol className="space-y-1.5 max-h-48 overflow-y-auto pr-0.5">
                {routeStops.map((stop, idx) => {
                  const isOrigin = idx === 0;
                  const isDest = idx === routeStops.length - 1 && routeStops.length > 1;
                  const isMiddle = !isOrigin && !isDest;
                  const isFocused = focusedWaypointId === stop.id;
                  return (
                    <li
                      key={stop.id}
                      onClick={() => onFocusWaypoint?.(stop.id)}
                      className={`px-2 py-1.5 rounded-md flex items-center gap-2 text-xs transition-colors cursor-pointer border ${
                        isFocused
                          ? 'bg-[#141D2A] border-[#22D3EE]/55'
                          : 'bg-[#0B0D10] border-white/10 hover:border-[#22D3EE]/30'
                      }`}
                    >
                      <span
                        className={`w-5 h-5 rounded-full font-mono text-[10px] font-semibold tabular-nums flex items-center justify-center shrink-0 ${
                          isOrigin
                            ? 'bg-emerald-400/20 border border-emerald-400/45 text-emerald-300'
                            : isDest
                              ? 'bg-[#22D3EE] text-[#071318]'
                              : stop.via
                                ? 'border border-dashed border-[#67E8F9]/60 text-[#67E8F9]'
                                : 'bg-[#22D3EE]/20 border border-[#22D3EE]/45 text-[#67E8F9]'
                        }`}
                      >
                        {idx + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[#F5F7FA] truncate leading-tight">
                          {stop.name}
                        </div>
                        <div className="text-[10px] text-[#8C96A8] leading-tight">
                          {isOrigin
                            ? 'Origin'
                            : isDest
                              ? 'Destination'
                              : stop.via
                                ? 'Pass-through (via)'
                                : 'Stopover'}
                        </div>
                      </div>
                      <div
                        className="flex items-center gap-0.5 shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {onLaunchDispatchRun3D && (
                          <button
                            type="button"
                            onClick={() => onLaunchDispatchRun3D(stop.id)}
                            title="Explore this checkpoint in Dispatch Run 3D"
                            className="px-1.5 h-5 rounded text-[9px] font-mono text-[#67E8F9] bg-[#131924] hover:bg-[#22D3EE]/20 border border-[#22D3EE]/30 cursor-pointer mr-0.5"
                          >
                            3D
                          </button>
                        )}
                        {isMiddle && (
                          <button
                            type="button"
                            onClick={() => handleToggleViaWaypoint(stop.id)}
                            title={
                              stop.via
                                ? 'Switch to stopover waypoint'
                                : 'Switch to pass-through (via) waypoint'
                            }
                            className={`px-1.5 h-5 rounded text-[9px] font-mono uppercase border cursor-pointer mr-0.5 ${
                              stop.via
                                ? 'bg-[#22D3EE]/15 border-[#22D3EE]/45 text-[#67E8F9]'
                                : 'bg-[#13161C] border-white/10 text-[#8C96A8] hover:text-[#F5F7FA]'
                            }`}
                          >
                            {stop.via ? 'Via' : 'Stop'}
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => handleMoveRouteStop(idx, -1)}
                          title="Move stop up"
                          className="p-0.5 text-[#8C96A8] hover:text-[#67E8F9] disabled:opacity-30 cursor-pointer"
                        >
                          <ArrowUp className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          disabled={idx === routeStops.length - 1}
                          onClick={() => handleMoveRouteStop(idx, 1)}
                          title="Move stop down"
                          className="p-0.5 text-[#8C96A8] hover:text-[#67E8F9] disabled:opacity-30 cursor-pointer"
                        >
                          <ArrowDown className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveRouteStop(stop.id)}
                          title="Remove stop"
                          className="p-0.5 text-[#8C96A8] hover:text-red-300 cursor-pointer"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ol>

              {onLaunchDispatchRun3D && (
                <button
                  type="button"
                  onClick={() =>
                    onLaunchDispatchRun3D(focusedWaypointId || routeStops[0]?.id)
                  }
                  className="w-full h-8 px-3 inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors cursor-pointer"
                >
                  <Compass className="w-3.5 h-3.5" aria-hidden="true" />
                  Launch Dispatch Run 3D ({routeStops.length} Stops)
                </button>
              )}
            </>
          )}

          {routeStops.length >= 4 && (
            <label
              className={`flex items-center justify-between gap-2 px-2.5 py-1.5 bg-[#0B0D10] border border-white/10 rounded-md ${
                hasIntermediateVia ? 'opacity-55 cursor-not-allowed' : 'cursor-pointer'
              }`}
              title={
                hasIntermediateVia
                  ? 'Disable pass-through (Via) waypoints to optimize stop order'
                  : 'Reorder intermediate stops for fastest total travel time'
              }
            >
              <span className="text-[11px] text-[#C7D0DF] inline-flex items-center gap-1.5">
                <Sparkles className="w-3 h-3 text-[#22D3EE]" aria-hidden="true" />
                {hasIntermediateVia
                  ? 'Optimize disabled (via waypoint active)'
                  : 'Optimize intermediate stop order'}
              </span>
              <input
                type="checkbox"
                checked={optimizeOrder && !hasIntermediateVia}
                disabled={hasIntermediateVia}
                onChange={(e) => setOptimizeOrder(e.target.checked)}
                className="accent-[#22D3EE] cursor-pointer disabled:cursor-not-allowed"
              />
            </label>
          )}

          {routeMetrics && (
            <div className="bg-[#131922] border border-[#22D3EE]/35 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-[#8C96A8]">
                    Total{' '}
                    {routeMetrics.travelMode === 'WALK'
                      ? 'Walk'
                      : routeMetrics.travelMode === 'BICYCLE'
                        ? 'Bike'
                        : 'Drive'}{' '}
                    · {routeMetrics.stopCount} Waypoints
                  </div>
                  <div className="text-base font-semibold text-[#67E8F9] tabular-nums">
                    {routeMetrics.durationText}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] uppercase tracking-wider text-[#8C96A8]">
                    Distance
                  </div>
                  <div className="text-sm font-medium text-[#F5F7FA] tabular-nums">
                    {routeMetrics.distanceText}
                  </div>
                </div>
              </div>

              {routeMetrics.optimizedOrderApplied && (
                <button
                  type="button"
                  onClick={handleApplyOptimizedOrder}
                  className="w-full h-7 px-2.5 inline-flex items-center justify-center gap-1.5 rounded bg-[#22D3EE]/15 hover:bg-[#22D3EE]/25 border border-[#22D3EE]/40 text-[11px] font-medium text-[#67E8F9] cursor-pointer"
                >
                  <Check className="w-3 h-3" aria-hidden="true" />
                  Apply optimized waypoint order
                </button>
              )}

              {routeMetrics.legs.length > 1 && (
                <div className="pt-2 border-t border-white/10">
                  <button
                    type="button"
                    onClick={() => setLegsExpanded((v) => !v)}
                    className="w-full flex items-center justify-between text-[11px] font-medium text-[#67E8F9] hover:text-[#F5F7FA] cursor-pointer"
                  >
                    <span>
                      Per-leg breakdown ({routeMetrics.legs.length} legs
                      {routeMetrics.optimizedOrderApplied ? ' · Optimized' : ''})
                    </span>
                    {legsExpanded ? (
                      <ChevronUp className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                  </button>
                  {legsExpanded && (
                    <ol className="mt-2 space-y-1.5 max-h-36 overflow-y-auto pr-0.5">
                      {routeMetrics.legs.map((leg, idx) => (
                        <li
                          key={`${leg.fromName}-${idx}`}
                          className="text-[11px] bg-[#0B0D10] border border-white/10 rounded px-2 py-1.5"
                        >
                          <div className="text-[#C7D0DF] truncate">
                            {idx + 1}. {leg.fromName} → {leg.toName}
                          </div>
                          <div className="text-[10px] font-mono text-[#67E8F9] tabular-nums mt-0.5">
                            {leg.durationText} · {leg.distanceText}
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </div>
          )}

          {routeError && (
            <div className="p-2.5 bg-red-950/50 border border-red-400/35 rounded-md text-xs text-red-200">
              {routeError}
            </div>
          )}
        </div>

        {/* Saved Locations List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[#8C96A8]">
              Saved Pins ({pins.length})
            </h3>
            {!user && (
              <button
                type="button"
                onClick={() => void signInWithGoogle()}
                className="text-[11px] text-[#67E8F9] hover:underline cursor-pointer"
              >
                Sign in to save
              </button>
            )}
          </div>

          {pins.length === 0 ? (
            <div className="p-4 bg-[#13161C] border border-dashed border-white/10 rounded-lg text-xs text-[#8C96A8] leading-relaxed">
              Use the Places search bar on the map to locate client job sites, story beats,
              or field stops. Add stops to build a multi-leg route.
            </div>
          ) : (
            pins.map((pin) => {
              const style = CATEGORY_STYLES[pin.category] || CATEGORY_STYLES.client_site;
              const isSelected = activePinId === pin.id;
              return (
                <div
                  key={pin.id}
                  onClick={() => {
                    setSelectedPlace(null);
                    setActivePinId(pin.id);
                  }}
                  className={`p-3 rounded-lg border transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-[#171E2A] border-[#22D3EE]/50'
                      : 'bg-[#13161C] border-white/10 hover:border-[#22D3EE]/30'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[10px] uppercase tracking-wider text-[#67E8F9] font-medium">
                        {style.label}
                      </div>
                      <div className="text-xs font-semibold text-[#F5F7FA] truncate mt-0.5">
                        {pin.name}
                      </div>
                      {pin.address && (
                        <div className="text-[11px] text-[#8C96A8] truncate mt-0.5">
                          {pin.address}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDeletePin(pin.id);
                      }}
                      className="p-1 text-[#8C96A8] hover:text-red-300 cursor-pointer"
                      title="Delete pin"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSetStartStop({
                          name: pin.name,
                          lat: pin.lat,
                          lng: pin.lng,
                          address: pin.address,
                          placeId: pin.placeId,
                        });
                      }}
                      className="h-6 px-2 text-[11px] bg-[#0B0D10] hover:bg-[#1E2532] border border-white/10 rounded text-[#C7D0DF] cursor-pointer"
                    >
                      Start
                    </button>
                    <button
                      type="button"
                      disabled={routeStops.length >= MAX_ROUTE_WAYPOINTS}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleAddRouteStop({
                          name: pin.name,
                          lat: pin.lat,
                          lng: pin.lng,
                          address: pin.address,
                          placeId: pin.placeId,
                        });
                      }}
                      className="h-6 px-2 inline-flex items-center gap-0.5 text-[11px] bg-[#0B0D10] hover:bg-[#1E2532] disabled:opacity-40 border border-[#22D3EE]/25 rounded text-[#67E8F9] cursor-pointer"
                    >
                      <Plus className="w-3 h-3" aria-hidden="true" />
                      Stop
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSendLocationToMockup(pin.name, pin.address || pin.name);
                      }}
                      className="h-6 px-2 text-[11px] inline-flex items-center gap-1 text-[#67E8F9] hover:text-[#F5F7FA] ml-auto cursor-pointer"
                    >
                      Mockup
                      <ArrowRight className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
        </aside>
      )}

      {/* Map Stage (expands to 100vw x 100vh clean viewport in Full-Screen Immersive Mode) */}
      <div
        className={
          isImmersiveMode
            ? 'relative w-full h-full'
            : 'lg:col-span-8 xl:col-span-9 relative h-full min-h-[460px]'
        }
      >
        <APIProvider apiKey={apiKey} language="en">
          <GoogleMap
            className="w-full h-full"
            defaultCenter={DEFAULT_CENTER}
            defaultZoom={12}
            mapId="DEMO_MAP_ID"
            gestureHandling="greedy"
            fullscreenControl={false}
            mapTypeControl={!isImmersiveMode}
            streetViewControl={!isImmersiveMode}
            internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
          >
            <MapWorkspaceInner
              pins={pins}
              selectedPlace={selectedPlace}
              activePinId={activePinId}
              routeStops={routeStops}
              focusedWaypointId={focusedWaypointId}
              onFocusWaypoint={onFocusWaypoint}
              optimizeOrder={optimizeOrder}
              travelMode={travelMode}
              onSelectPlace={setSelectedPlace}
              onSelectPin={setActivePinId}
              onRouteResult={handleRouteResult}
              onSaveSelectedPlace={handleSaveSelectedPlace}
              onDeletePin={handleDeletePin}
              onSetStartStop={handleSetStartStop}
              onAddRouteStop={handleAddRouteStop}
              onSendLocationToMockup={onSendLocationToMockup}
              isSavingPin={isSavingPin}
              isImmersiveMode={isImmersiveMode}
              onToggleImmersiveMode={onToggleImmersiveMode}
            />
          </GoogleMap>
        </APIProvider>
      </div>
    </div>
  );
}
