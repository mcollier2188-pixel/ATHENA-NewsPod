import type { StageRigMode, StageSlotIndex, Staged3DPayload } from './types';

export const SPATIAL_BUS_CHANNEL_NAME = 'athena_spatial_3d_bus';

export interface SpatialStageSyncState {
  senderId: string;
  rigMode: StageRigMode;
  activeSlot: StageSlotIndex;
  preset: string;
  mood: string;
  finish: string;
  explodePct: number;
  turntable: boolean;
  stagedPayload?: Staged3DPayload | null;
  stagedLegacyImage?: { dataUrl: string; label: string } | null;
}

export type SpatialBusMessage =
  | { type: 'STAGE_SYNC'; state: SpatialStageSyncState }
  | { type: 'REQUEST_STATE'; senderId: string };

export function isSpatialDisplayUrl(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('display') === 'spatial';
  } catch {
    return false;
  }
}

export function buildSpatialDisplayUrl(): string {
  try {
    const url = new URL('/spatial', window.location.origin);
    url.searchParams.set('display', 'spatial');
    return url.toString();
  } catch {
    return '/spatial?display=spatial';
  }
}

/**
 * Zero-latency local desktop BroadcastChannel wrapper (`athena_spatial_3d_bus`)
 * synchronizing 3D Stage Studio rigs, lighting, exploded-view kinematics, and media
 * across external display windows without server roundtrips.
 */
export class SpatialBroadcastBus {
  private channel: BroadcastChannel | null = null;
  readonly senderId: string;

  constructor(onMessage: (msg: SpatialBusMessage) => void) {
    this.senderId = `node_${Math.random().toString(36).slice(2, 9)}`;
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      this.channel = new BroadcastChannel(SPATIAL_BUS_CHANNEL_NAME);
      this.channel.onmessage = (event: MessageEvent<SpatialBusMessage>) => {
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'STAGE_SYNC' && data.state.senderId !== this.senderId) {
          onMessage(data);
        } else if (
          data.type === 'REQUEST_STATE' &&
          data.senderId !== this.senderId
        ) {
          onMessage(data);
        }
      };
    } catch {
      this.channel = null;
    }
  }

  publishSync(state: Omit<SpatialStageSyncState, 'senderId'>): void {
    if (!this.channel) return;
    try {
      const msg: SpatialBusMessage = {
        type: 'STAGE_SYNC',
        state: { ...state, senderId: this.senderId },
      };
      this.channel.postMessage(msg);
    } catch {
      // Ignore structured-clone payload quota or closed channel errors
    }
  }

  requestInitialState(): void {
    if (!this.channel) return;
    try {
      const msg: SpatialBusMessage = {
        type: 'REQUEST_STATE',
        senderId: this.senderId,
      };
      this.channel.postMessage(msg);
    } catch {
      // Ignore closed channel errors
    }
  }

  dispose(): void {
    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        // Ignore close errors
      }
      this.channel = null;
    }
  }
}
