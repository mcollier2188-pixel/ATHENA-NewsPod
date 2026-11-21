export type RouteTravelMode = 'DRIVE' | 'WALK' | 'BICYCLE';

export interface RouteWaypoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  address?: string;
  placeId?: string;
  /** When true on an intermediate waypoint, route passes through without splitting into a separate stopover leg. */
  via?: boolean;
}

export interface RouteLegSummary {
  fromName: string;
  toName: string;
  distanceMeters: number;
  durationSeconds: number;
  distanceText: string;
  durationText: string;
}

export interface ComputedMultiStopRoute {
  distanceMeters: number;
  durationSeconds: number;
  distanceText: string;
  durationText: string;
  stopCount: number;
  intermediateCount: number;
  travelMode: RouteTravelMode;
  legs: RouteLegSummary[];
  orderedWaypoints: RouteWaypoint[];
  optimizedOrderApplied: boolean;
  polylines: google.maps.Polyline[];
  path: Array<google.maps.LatLng | google.maps.LatLngLiteral>;
  viewport: google.maps.LatLngBounds | null;
}

export interface ComputeMultiStopRouteParams {
  routesLib: google.maps.RoutesLibrary;
  geometryLib?: google.maps.GeometryLibrary | null;
  waypoints: RouteWaypoint[];
  travelMode: RouteTravelMode;
  optimizeWaypointOrder?: boolean;
  polylineOptions?: google.maps.PolylineOptions;
  /** Optional vertex budget for Ramer-Douglas-Peucker path decimation to reduce GPU stroke tessellation. */
  maxPathVertices?: number;
  /** Optional existing Polyline instance to mutate in-place via setPath() instead of allocating a new overlay. */
  existingPolyline?: google.maps.Polyline | null;
}

/**
 * Origin + destination + up to 10 intermediate waypoints (12 total stops)
 * stays within the standard Routes API billing tier while supporting rich multi-stop itineraries.
 */
export const MAX_ROUTE_WAYPOINTS = 12;

interface CachedRouteEntry {
  distanceMeters: number;
  durationSeconds: number;
  distanceText: string;
  durationText: string;
  stopCount: number;
  intermediateCount: number;
  travelMode: RouteTravelMode;
  legs: RouteLegSummary[];
  orderedWaypoints: RouteWaypoint[];
  optimizedOrderApplied: boolean;
  rawPath: google.maps.LatLngLiteral[];
  boundsLiteral: {
    south: number;
    west: number;
    north: number;
    east: number;
  } | null;
}

const MAX_ROUTE_CACHE_SIZE = 20;
const routeLruCache = new Map<string, CachedRouteEntry>();

function buildRouteCacheKey(
  waypoints: RouteWaypoint[],
  travelMode: RouteTravelMode,
  shouldOptimize: boolean
): string {
  const stopsPart = waypoints
    .map(
      (wp, idx) =>
        `${wp.lat.toFixed(5)},${wp.lng.toFixed(5)},${idx > 0 && idx < waypoints.length - 1 && wp.via ? '1' : '0'},${wp.name}`
    )
    .join('|');
  return `${travelMode}::${shouldOptimize ? 'opt' : 'seq'}::${stopsPart}`;
}

function toLatLngLiteral(
  pt: google.maps.LatLng | google.maps.LatLngLiteral
): google.maps.LatLngLiteral {
  const lat =
    typeof (pt as google.maps.LatLng).lat === 'function'
      ? (pt as google.maps.LatLng).lat()
      : Number((pt as google.maps.LatLngLiteral).lat);
  const lng =
    typeof (pt as google.maps.LatLng).lng === 'function'
      ? (pt as google.maps.LatLng).lng()
      : Number((pt as google.maps.LatLngLiteral).lng);
  return { lat, lng };
}

/**
 * Iterative Ramer-Douglas-Peucker polyline simplification to cap dense multi-stop paths
 * at `maxVertices` while preserving exact start/end points and sharp road curvature.
 */
export function simplifyLatLngPath(
  points: google.maps.LatLngLiteral[],
  maxVertices: number
): google.maps.LatLngLiteral[] {
  const n = points.length;
  if (n <= maxVertices || maxVertices < 8) return points;

  // Compute bounding span to choose a proportional starting epsilon
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  const diag = Math.hypot(maxLat - minLat, maxLng - minLng) || 0.01;

  const keep = new Uint8Array(n);
  const stack: number[] = [];

  const runRdp = (epsSq: number): number => {
    keep.fill(0);
    keep[0] = 1;
    keep[n - 1] = 1;
    let keptCount = 2;

    stack.length = 0;
    stack.push(0, n - 1);

    while (stack.length > 0) {
      const end = stack.pop()!;
      const start = stack.pop()!;
      if (end - start <= 1) continue;

      const ax = points[start].lng;
      const ay = points[start].lat;
      const bx = points[end].lng;
      const by = points[end].lat;
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;

      let maxDistSq = -1;
      let splitIdx = -1;

      for (let i = start + 1; i < end; i++) {
        const px = points[i].lng;
        const py = points[i].lat;
        let distSq: number;
        if (lenSq === 0) {
          const ex = px - ax;
          const ey = py - ay;
          distSq = ex * ex + ey * ey;
        } else {
          let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          const projX = ax + t * dx;
          const projY = ay + t * dy;
          const ex = px - projX;
          const ey = py - projY;
          distSq = ex * ex + ey * ey;
        }
        if (distSq > maxDistSq) {
          maxDistSq = distSq;
          splitIdx = i;
        }
      }

      if (maxDistSq > epsSq && splitIdx !== -1) {
        keep[splitIdx] = 1;
        keptCount++;
        stack.push(start, splitIdx, splitIdx, end);
      }
    }

    return keptCount;
  };

  let eps = (diag / maxVertices) * 0.65;
  for (let attempt = 0; attempt < 5; attempt++) {
    const count = runRdp(eps * eps);
    if (count <= maxVertices) break;
    eps *= 1.85;
  }

  const simplified: google.maps.LatLngLiteral[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) simplified.push(points[i]);
  }
  return simplified;
}

export function isMapsQuotaError(err: unknown): boolean {
  const msg = String(
    err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  );
  return /429|RESOURCE_EXHAUSTED|OVER_QUERY_LIMIT|REQUEST_DENIED|quota|rate.?limit/i.test(
    msg
  );
}

export function formatDistanceMeters(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return '—';
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  const mi = meters * 0.000621371;
  return `${mi.toFixed(1)} mi (${km.toFixed(1)} km)`;
}

export function parseDurationSeconds(raw: unknown): number {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : 0;
  }
  if (typeof raw === 'string') {
    const match = /(\d+(?:\.\d+)?)/.exec(raw);
    return match ? Number(match[1]) : 0;
  }
  if (raw && typeof raw === 'object' && 'seconds' in raw) {
    return Number((raw as { seconds?: number }).seconds ?? 0);
  }
  return 0;
}

export function formatDurationSeconds(raw: unknown): string {
  const seconds = parseDurationSeconds(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${h} hr ${rem} min` : `${h} hr`;
}

function resolveSdkTravelMode(
  routesLib: google.maps.RoutesLibrary,
  mode: RouteTravelMode
): unknown {
  const libTravelMode = (
    routesLib as unknown as { TravelMode?: Record<string, unknown> }
  ).TravelMode;

  if (libTravelMode) {
    if (mode === 'DRIVE') {
      return libTravelMode.DRIVING ?? libTravelMode.DRIVE ?? 'DRIVING';
    }
    if (mode === 'WALK') {
      return libTravelMode.WALKING ?? libTravelMode.WALK ?? 'WALKING';
    }
    if (mode === 'BICYCLE') {
      return libTravelMode.BICYCLING ?? libTravelMode.BICYCLE ?? 'BICYCLING';
    }
  }

  if (mode === 'WALK') return 'WALKING';
  if (mode === 'BICYCLE') return 'BICYCLING';
  return 'DRIVING';
}

function buildWaypointInput(
  wp: RouteWaypoint,
  isIntermediate: boolean
): Record<string, unknown> {
  if (!isIntermediate) {
    return { lat: wp.lat, lng: wp.lng };
  }
  const entry: Record<string, unknown> = {
    location: { lat: wp.lat, lng: wp.lng },
  };
  if (wp.via) {
    entry.via = true;
  }
  return entry;
}

function materializeCachedRoute(
  entry: CachedRouteEntry,
  polylineOptions?: google.maps.PolylineOptions,
  maxPathVertices?: number,
  existingPolyline?: google.maps.Polyline | null
): ComputedMultiStopRoute {
  const decimatedPath =
    maxPathVertices && maxPathVertices > 0
      ? simplifyLatLngPath(entry.rawPath, maxPathVertices)
      : entry.rawPath;

  const defaultStroke: google.maps.PolylineOptions = {
    geodesic: true,
    clickable: false,
    strokeColor: '#22D3EE',
    strokeOpacity: 0.95,
    strokeWeight: 5,
    ...polylineOptions,
  };

  let polylines: google.maps.Polyline[] = [];
  if (decimatedPath.length > 0) {
    if (existingPolyline) {
      existingPolyline.setOptions(defaultStroke);
      existingPolyline.setPath(decimatedPath);
      polylines = [existingPolyline];
    } else {
      polylines = [
        new google.maps.Polyline({
          path: decimatedPath,
          ...defaultStroke,
        }),
      ];
    }
  } else if (existingPolyline) {
    existingPolyline.setPath([]);
  }

  const viewport = entry.boundsLiteral
    ? new google.maps.LatLngBounds(
        { lat: entry.boundsLiteral.south, lng: entry.boundsLiteral.west },
        { lat: entry.boundsLiteral.north, lng: entry.boundsLiteral.east }
      )
    : null;

  return {
    distanceMeters: entry.distanceMeters,
    durationSeconds: entry.durationSeconds,
    distanceText: entry.distanceText,
    durationText: entry.durationText,
    stopCount: entry.stopCount,
    intermediateCount: entry.intermediateCount,
    travelMode: entry.travelMode,
    legs: entry.legs,
    orderedWaypoints: entry.orderedWaypoints,
    optimizedOrderApplied: entry.optimizedOrderApplied,
    polylines,
    path: decimatedPath,
    viewport,
  };
}

/**
 * Computes a multi-stop route using the modern Maps JavaScript SDK Routes library
 * (`google.maps.routes.Route.computeRoutes`), with LRU caching, path decimation,
 * and single-Polyline draw-call consolidation.
 */
export async function computeMultiStopRoute({
  routesLib,
  geometryLib,
  waypoints,
  travelMode,
  optimizeWaypointOrder = false,
  polylineOptions,
  maxPathVertices,
  existingPolyline,
}: ComputeMultiStopRouteParams): Promise<ComputedMultiStopRoute> {
  if (waypoints.length < 2) {
    throw new Error('At least 2 waypoints are required to compute a route.');
  }

  const originStop = waypoints[0];
  const destinationStop = waypoints[waypoints.length - 1];
  const middleStops = waypoints.slice(1, -1);

  const hasViaIntermediate = middleStops.some((stop) => Boolean(stop.via));
  const shouldOptimize =
    Boolean(optimizeWaypointOrder) &&
    middleStops.length >= 2 &&
    !hasViaIntermediate;

  const cacheKey = buildRouteCacheKey(waypoints, travelMode, shouldOptimize);
  const cached = routeLruCache.get(cacheKey);
  if (cached) {
    // Refresh LRU order
    routeLruCache.delete(cacheKey);
    routeLruCache.set(cacheKey, cached);
    return materializeCachedRoute(
      cached,
      polylineOptions,
      maxPathVertices,
      existingPolyline
    );
  }

  const fields = [
    'path',
    'polyline',
    'distanceMeters',
    'durationMillis',
    'duration',
    'viewport',
    'legs',
  ];
  if (shouldOptimize) {
    fields.push('optimizedIntermediateWaypointIndex');
  }

  const request: Record<string, unknown> = {
    origin: buildWaypointInput(originStop, false),
    destination: buildWaypointInput(destinationStop, false),
    travelMode: resolveSdkTravelMode(routesLib, travelMode),
    fields,
  };

  if (middleStops.length > 0) {
    request.intermediates = middleStops.map((stop) =>
      buildWaypointInput(stop, true)
    );
    if (shouldOptimize) {
      request.optimizeWaypointOrder = true;
    }
  }

  type RouteSdkShape = {
    computeRoutes?: (
      req: Record<string, unknown>
    ) => Promise<{ routes?: Array<Record<string, unknown>> }>;
    decode?: (encoded: string) => google.maps.LatLng[];
    new (): {
      computeRoutes: (
        req: Record<string, unknown>
      ) => Promise<{ routes?: Array<Record<string, unknown>> }>;
    };
  };

  const RouteClass = routesLib.Route as unknown as RouteSdkShape;
  const response =
    typeof RouteClass.computeRoutes === 'function'
      ? await RouteClass.computeRoutes(request)
      : await new RouteClass().computeRoutes(request);

  const firstRoute = response?.routes?.[0];
  if (!firstRoute) {
    throw new Error('No route found connecting these waypoints.');
  }

  // Extract decoded path into a single unified coordinate array
  let decodedPoints: Array<google.maps.LatLng | google.maps.LatLngLiteral> = [];
  if (Array.isArray(firstRoute.path) && firstRoute.path.length > 0) {
    decodedPoints = firstRoute.path as google.maps.LatLng[];
  } else {
    const encoded = (
      firstRoute.polyline as { encodedPolyline?: string } | undefined
    )?.encodedPolyline;
    if (encoded) {
      if (typeof RouteClass.decode === 'function') {
        decodedPoints = RouteClass.decode(encoded);
      } else if (geometryLib?.encoding?.decodePath) {
        decodedPoints = geometryLib.encoding.decodePath(encoded);
      }
    }
  }

  // Fallback: if SDK only exposes createPolylines(), coalesce all leg paths into 1 flat path
  if (decodedPoints.length === 0) {
    const createPolylinesFn = firstRoute.createPolylines as
      | (() => google.maps.Polyline[])
      | undefined;
    if (typeof createPolylinesFn === 'function') {
      try {
        const tempLines = createPolylinesFn.call(firstRoute);
        if (Array.isArray(tempLines)) {
          for (const seg of tempLines) {
            const mvcPath = seg.getPath?.();
            if (mvcPath) {
              const len = mvcPath.getLength();
              for (let i = 0; i < len; i++) {
                decodedPoints.push(mvcPath.getAt(i));
              }
            }
            seg.setMap(null);
          }
        }
      } catch {
        // Ignore fallback extraction errors
      }
    }
  }

  const rawPath: google.maps.LatLngLiteral[] = decodedPoints.map(toLatLngLiteral);

  // Extract serializable viewport bounds
  let boundsLiteral: CachedRouteEntry['boundsLiteral'] = null;
  const rawVp = firstRoute.viewport as
    | google.maps.LatLngBounds
    | {
        southwest?: google.maps.LatLngLiteral;
        northeast?: google.maps.LatLngLiteral;
        low?: { latitude: number; longitude: number };
        high?: { latitude: number; longitude: number };
      }
    | undefined;

  if (rawVp) {
    if ('southwest' in rawVp && rawVp.southwest && rawVp.northeast) {
      boundsLiteral = {
        south: rawVp.southwest.lat,
        west: rawVp.southwest.lng,
        north: rawVp.northeast.lat,
        east: rawVp.northeast.lng,
      };
    } else if ('low' in rawVp && rawVp.low && rawVp.high) {
      boundsLiteral = {
        south: rawVp.low.latitude,
        west: rawVp.low.longitude,
        north: rawVp.high.latitude,
        east: rawVp.high.longitude,
      };
    } else if (typeof (rawVp as google.maps.LatLngBounds).getNorthEast === 'function') {
      const sw = (rawVp as google.maps.LatLngBounds).getSouthWest();
      const ne = (rawVp as google.maps.LatLngBounds).getNorthEast();
      boundsLiteral = {
        south: sw.lat(),
        west: sw.lng(),
        north: ne.lat(),
        east: ne.lng(),
      };
    }
  }

  // Reconcile optimized intermediate order if returned
  const rawOptIndices = Array.isArray(firstRoute.optimizedIntermediateWaypointIndex)
    ? (firstRoute.optimizedIntermediateWaypointIndex as number[])
    : null;
  const validOptIndices =
    shouldOptimize &&
    rawOptIndices &&
    rawOptIndices.length === middleStops.length &&
    rawOptIndices.every((idx) => idx >= 0 && idx < middleStops.length)
      ? rawOptIndices
      : null;

  const orderedMiddle = validOptIndices
    ? validOptIndices.map((idx) => middleStops[idx])
    : middleStops;

  const orderedWaypoints: RouteWaypoint[] = [
    originStop,
    ...orderedMiddle,
    destinationStop,
  ];

  const legBoundaryStops = orderedWaypoints.filter(
    (wp, idx) => idx === 0 || idx === orderedWaypoints.length - 1 || !wp.via
  );

  const rawLegs = Array.isArray(firstRoute.legs)
    ? (firstRoute.legs as Array<Record<string, unknown>>)
    : [];

  const legs: RouteLegSummary[] = rawLegs.map((leg, idx) => {
    const legDist = Number(leg.distanceMeters ?? 0);
    const legDurSec =
      typeof leg.durationMillis === 'number'
        ? leg.durationMillis / 1000
        : parseDurationSeconds(leg.duration);
    return {
      fromName: legBoundaryStops[idx]?.name || `Stop ${idx + 1}`,
      toName: legBoundaryStops[idx + 1]?.name || `Stop ${idx + 2}`,
      distanceMeters: legDist,
      durationSeconds: legDurSec,
      distanceText: formatDistanceMeters(legDist),
      durationText: formatDurationSeconds(legDurSec),
    };
  });

  const totalDistanceMeters = Number(firstRoute.distanceMeters ?? 0);
  const totalDurationSeconds =
    typeof firstRoute.durationMillis === 'number'
      ? firstRoute.durationMillis / 1000
      : parseDurationSeconds(firstRoute.duration);

  const cacheEntry: CachedRouteEntry = {
    distanceMeters: totalDistanceMeters,
    durationSeconds: totalDurationSeconds,
    distanceText: formatDistanceMeters(totalDistanceMeters),
    durationText: formatDurationSeconds(totalDurationSeconds),
    stopCount: orderedWaypoints.length,
    intermediateCount: middleStops.length,
    travelMode,
    legs,
    orderedWaypoints,
    optimizedOrderApplied: Boolean(validOptIndices),
    rawPath,
    boundsLiteral,
  };

  if (routeLruCache.size >= MAX_ROUTE_CACHE_SIZE) {
    const oldestKey = routeLruCache.keys().next().value;
    if (oldestKey !== undefined) {
      routeLruCache.delete(oldestKey);
    }
  }
  routeLruCache.set(cacheKey, cacheEntry);

  return materializeCachedRoute(
    cacheEntry,
    polylineOptions,
    maxPathVertices,
    existingPolyline
  );
}
