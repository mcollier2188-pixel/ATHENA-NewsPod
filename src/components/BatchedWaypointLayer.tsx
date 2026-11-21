import { useEffect, useRef } from 'react';
import { useMap } from '@vis.gl/react-google-maps';
import type { RouteWaypoint } from '../services/routingService';

export interface BatchedWaypointLayerProps {
  waypoints: RouteWaypoint[];
  focusedWaypointId?: string | null;
  onSelectWaypoint?: (id: string) => void;
  badgeRadius?: number;
}

type BadgeVariant = 'origin' | 'destination' | 'stop' | 'via';

interface SpriteAtlas {
  canvas: HTMLCanvasElement;
  cellSize: number;
  dpr: number;
  offsets: Record<BadgeVariant, number>;
}

let cachedAtlas: SpriteAtlas | null = null;

/**
 * Pre-renders the 4 waypoint marker variants (origin, destination, stop, via)
 * into a single tiny offscreen sprite atlas so all map waypoints blit in one batched pass.
 */
function getWaypointSpriteAtlas(radius: number, dpr: number): SpriteAtlas {
  const clampedDpr = Math.min(2, Math.max(1, dpr));
  const cellLogical = (radius + 6) * 2;
  const cellPx = Math.ceil(cellLogical * clampedDpr);

  if (
    cachedAtlas &&
    cachedAtlas.cellSize === cellPx &&
    cachedAtlas.dpr === clampedDpr
  ) {
    return cachedAtlas;
  }

  const variants: BadgeVariant[] = ['origin', 'destination', 'stop', 'via'];
  const canvas = document.createElement('canvas');
  canvas.width = cellPx * variants.length;
  canvas.height = cellPx;
  const ctx = canvas.getContext('2d');

  const offsets: Record<BadgeVariant, number> = {
    origin: 0,
    destination: cellPx,
    stop: cellPx * 2,
    via: cellPx * 3,
  };

  if (ctx) {
    ctx.scale(clampedDpr, clampedDpr);
    const center = cellLogical / 2;

    variants.forEach((variant, idx) => {
      const cx = idx * cellLogical + center;
      const cy = center;

      ctx.save();
      // Subtle crisp drop shadow baked once into sprite atlas (zero runtime shadowBlur cost!)
      ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1.5;

      ctx.beginPath();
      const r = variant === 'via' ? radius - 1 : radius;
      ctx.arc(cx, cy, r, 0, Math.PI * 2);

      if (variant === 'origin') {
        ctx.fillStyle = '#34D399';
      } else if (variant === 'destination') {
        ctx.fillStyle = '#22D3EE';
      } else if (variant === 'via') {
        ctx.fillStyle = '#0E1116';
      } else {
        ctx.fillStyle = '#0E7490';
      }
      ctx.fill();
      ctx.restore();

      // Crisp border stroke
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      if (variant === 'origin' || variant === 'destination') {
        ctx.strokeStyle = '#071318';
      } else if (variant === 'via') {
        ctx.setLineDash([3, 2.5]);
        ctx.strokeStyle = '#67E8F9';
      } else {
        ctx.strokeStyle = '#67E8F9';
      }
      ctx.stroke();
      ctx.restore();
    });
  }

  cachedAtlas = {
    canvas,
    cellSize: cellPx,
    dpr: clampedDpr,
    offsets,
  };
  return cachedAtlas;
}

/**
 * Renders all route waypoints onto a SINGLE hardware-accelerated HTML5 <canvas>
 * mounted via Google Maps OverlayView instead of spawning N separate DOM marker subtrees.
 */
export function BatchedWaypointLayer({
  waypoints,
  focusedWaypointId = null,
  onSelectWaypoint,
  badgeRadius = 12,
}: BatchedWaypointLayerProps) {
  const map = useMap();

  const waypointsRef = useRef<RouteWaypoint[]>(waypoints);
  const focusedIdRef = useRef<string | null>(focusedWaypointId);
  const onSelectRef = useRef<((id: string) => void) | undefined>(onSelectWaypoint);
  const requestDrawRef = useRef<(() => void) | null>(null);

  waypointsRef.current = waypoints;
  focusedIdRef.current = focusedWaypointId;
  onSelectRef.current = onSelectWaypoint;

  useEffect(() => {
    if (!map || typeof google === 'undefined' || !google.maps?.OverlayView) return;

    let disposed = false;
    let rafId = 0;

    interface ProjectedHitPoint {
      id: string;
      x: number;
      y: number;
      r: number;
    }

    let hitPoints: ProjectedHitPoint[] = [];
    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.pointerEvents = 'none';
    canvas.style.top = '0';
    canvas.style.left = '0';

    class SingleCanvasWaypointOverlay extends google.maps.OverlayView {
      onAdd() {
        const panes = this.getPanes();
        const targetPane = panes?.overlayMouseTarget || panes?.overlayLayer;
        targetPane?.appendChild(canvas);
      }

      draw() {
        scheduleDraw();
      }

      onRemove() {
        if (canvas.parentNode) {
          canvas.parentNode.removeChild(canvas);
        }
      }
    }

    const overlay = new SingleCanvasWaypointOverlay();

    const performDraw = () => {
      rafId = 0;
      if (disposed) return;

      const projection = overlay.getProjection();
      const mapDiv = map.getDiv();
      if (!projection || !mapDiv) return;

      const width = mapDiv.clientWidth || 0;
      const height = mapDiv.clientHeight || 0;
      if (width <= 0 || height <= 0) return;

      // Anchor the canvas cleanly over the visible map viewport using container pixel origin
      const topLeftLatLng = projection.fromContainerPixelToLatLng(
        new google.maps.Point(0, 0)
      );
      const topLeftDivPx = topLeftLatLng
        ? projection.fromLatLngToDivPixel(topLeftLatLng)
        : null;

      const offsetX = topLeftDivPx ? topLeftDivPx.x : 0;
      const offsetY = topLeftDivPx ? topLeftDivPx.y : 0;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const targetW = Math.round(width * dpr);
      const targetH = Math.round(height * dpr);

      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      canvas.style.transform = `translate3d(${offsetX}px, ${offsetY}px, 0)`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const list = waypointsRef.current;
      if (list.length === 0) {
        hitPoints = [];
        return;
      }

      const atlas = getWaypointSpriteAtlas(badgeRadius, dpr);
      const halfLogical = atlas.cellSize / dpr / 2;
      const pad = badgeRadius + 16;
      const nextHits: ProjectedHitPoint[] = [];

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `700 ${badgeRadius <= 12 ? 10 : 11}px ui-monospace, SFMono-Regular, Menlo, monospace`;

      for (let i = 0; i < list.length; i++) {
        const wp = list[i];
        const containerPt = projection.fromLatLngToContainerPixel(
          new google.maps.LatLng(wp.lat, wp.lng)
        );
        if (!containerPt) continue;

        const x = containerPt.x;
        const y = containerPt.y;

        // Viewport frustum culling: skip off-screen waypoints completely
        if (x < -pad || x > width + pad || y < -pad || y > height + pad) {
          continue;
        }

        const isOrigin = i === 0;
        const isDest = i === list.length - 1 && list.length > 1;
        const isVia = !isOrigin && !isDest && Boolean(wp.via);
        const variant: BadgeVariant = isOrigin
          ? 'origin'
          : isDest
            ? 'destination'
            : isVia
              ? 'via'
              : 'stop';

        // Focused outer ring
        if (focusedIdRef.current && wp.id === focusedIdRef.current) {
          ctx.beginPath();
          ctx.arc(x, y, badgeRadius + 4.5, 0, Math.PI * 2);
          ctx.strokeStyle = '#67E8F9';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Single blitted badge sprite from pre-baked atlas
        const sx = atlas.offsets[variant];
        ctx.drawImage(
          atlas.canvas,
          sx,
          0,
          atlas.cellSize,
          atlas.cellSize,
          x - halfLogical,
          y - halfLogical,
          halfLogical * 2,
          halfLogical * 2
        );

        // Crisp stop index label
        ctx.fillStyle =
          variant === 'origin' || variant === 'destination'
            ? '#071318'
            : variant === 'via'
              ? '#67E8F9'
              : '#F5F7FA';
        ctx.fillText(String(i + 1), x, y + 0.5);

        nextHits.push({ id: wp.id, x, y, r: badgeRadius + 4 });
      }

      hitPoints = nextHits;
    };

    const scheduleDraw = () => {
      if (disposed || rafId !== 0) return;
      rafId = requestAnimationFrame(performDraw);
    };

    requestDrawRef.current = scheduleDraw;
    overlay.setMap(map);

    const boundsListener = map.addListener('bounds_changed', scheduleDraw);
    const clickListener = map.addListener(
      'click',
      (e: google.maps.MapMouseEvent) => {
        if (!onSelectRef.current || !e.latLng || hitPoints.length === 0) return;
        const proj = overlay.getProjection();
        if (!proj) return;
        const pt = proj.fromLatLngToContainerPixel(e.latLng);
        if (!pt) return;

        for (let i = hitPoints.length - 1; i >= 0; i--) {
          const hp = hitPoints[i];
          const dx = pt.x - hp.x;
          const dy = pt.y - hp.y;
          if (dx * dx + dy * dy <= hp.r * hp.r) {
            onSelectRef.current(hp.id);
            break;
          }
        }
      }
    );

    return () => {
      disposed = true;
      requestDrawRef.current = null;
      if (rafId) cancelAnimationFrame(rafId);
      boundsListener.remove();
      clickListener.remove();
      overlay.setMap(null);
    };
  }, [badgeRadius, map]);

  // Trigger coalesced canvas redraw whenever waypoints or focused selection change
  useEffect(() => {
    requestDrawRef.current?.();
  }, [waypoints, focusedWaypointId]);

  return null;
}
