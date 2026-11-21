export type StageRigMode = 'pavilion' | 'devices' | 'foilCard' | 'customModel';

export type StageRendererBackend = 'webgl2' | 'webgpu';

export interface PostProcessingConfig {
  enabled: boolean;
  bloomStrength: number;
  aoEnabled: boolean;
}

export interface CustomModelMetadata {
  fileName: string;
  meshCount: number;
  triangleCount: number;
  animationCount: number;
  isPlayingAnimation: boolean;
  isDefaultArtifact: boolean;
}

export type StageSlotIndex = 0 | 1 | 2;

export type StageMediaKind =
  | 'image'
  | 'video'
  | 'editorialCard'
  | 'mockupPreview';

export interface StageSlotMedia {
  kind: StageMediaKind;
  src: string;
  label: string;
  aspectRatio?: number;
  uvOffset?: [number, number];
  uvScale?: [number, number];
}

export interface Staged3DPayload {
  id: string;
  rigMode: StageRigMode;
  activeSlot: StageSlotIndex;
  slots: Partial<Record<StageSlotIndex, StageSlotMedia>>;
  sourceStudio?: string;
}

export interface Runtime3DCapabilities {
  webgpuSupported: boolean;
  webgpuAdapterLabel: string;
  maxBufferSizeMb: number;
  maxStorageBufferMb: number;
  featuresCount: number;
  hasFloat32Filterable: boolean;
  hasShaderF16: boolean;
  isSoftwareGl: boolean;
  rendererLabel: string;
  maxAnisotropy: number;
}

export interface InspectedPartInfo {
  partId: string;
  title: string;
  subtitle: string;
  materialSummary: string;
  slotIndex?: StageSlotIndex;
  focusPos: [number, number, number];
  focusTarget: [number, number, number];
}

export const STAGE_RIG_META: Record<
  StageRigMode,
  {
    label: string;
    shortLabel: string;
    heading: string;
    slotLabels: [string, string, string];
    slotAspects: [number, number, number];
  }
> = {
  pavilion: {
    label: 'Broadcast Pavilion',
    shortLabel: 'Pavilion',
    heading: 'Dispatch Pavilion & Broadcast Crane',
    slotLabels: ['Main Wall (16:9)', 'Aux Monitor (16:9)', 'Plinth Marquee (4:1)'],
    slotAspects: [16 / 9, 16 / 9, 4],
  },
  devices: {
    label: 'Laptop & Phone Rig',
    shortLabel: 'Devices',
    heading: 'Client Site Laptop & Smartphone Showcase',
    slotLabels: ['Laptop Display (16:10)', 'Mobile Screen (9:19.5)', 'Brand Plaque (4:1)'],
    slotAspects: [16 / 10, 9 / 19.5, 4],
  },
  foilCard: {
    label: 'Holographic Foil Card',
    shortLabel: 'Foil Card',
    heading: 'Holographic Editorial & Briefing Collector Slab',
    slotLabels: ['Front Foil Poster (3:4)', 'Rear Citation Spec (3:4)', 'Base Title Strip (4:1)'],
    slotAspects: [3 / 4, 3 / 4, 4],
  },
  customModel: {
    label: 'Custom GLB Studio',
    shortLabel: 'Custom GLB',
    heading: 'Custom .GLB / .GLTF Asset Inspection Plinth',
    slotLabels: ['Backdrop Plate (16:9)', 'Plinth Spec Plaque (4:1)', 'Floor Marquee (4:1)'],
    slotAspects: [16 / 9, 4, 4],
  },
};
