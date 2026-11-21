export type ActiveView =
  | 'articles'
  | 'briefing'
  | 'chat'
  | 'archive'
  | 'mockup'
  | 'media'
  | 'spatial'
  | 'owner';

export type UserRole = 'owner' | 'admin' | 'member';

export type CommuteDuration = 3 | 5 | 10;
export type BroadcastFormat = 'solo' | 'podcast';
export type BriefingTone = 'executive' | 'conversational' | 'analytical' | 'upbeat';
export type VoiceTone = 'professional' | 'casual' | 'energetic' | 'soothing';
export type VoiceName = 'Kore' | 'Puck' | 'Charon' | 'Fenrir' | 'Zephyr';
export type SourceType = 'article' | 'pdf' | 'docx' | 'txt' | 'markdown';

export interface VoiceOption {
  name: VoiceName;
  descriptor: string;
  register: string;
}

export const VOICE_OPTIONS: VoiceOption[] = [
  { name: 'Kore', descriptor: 'Clear, poised studio anchor', register: 'Mid-bright' },
  { name: 'Puck', descriptor: 'Warm, agile conversationalist', register: 'Lively' },
  { name: 'Charon', descriptor: 'Measured documentary baritone', register: 'Deep' },
  { name: 'Fenrir', descriptor: 'Direct, incisive desk correspondent', register: 'Crisp' },
  { name: 'Zephyr', descriptor: 'Calm, articulate morning narrator', register: 'Smooth' },
];

export interface SourcePassage {
  id: string;
  index: number; // 1-based passage index
  text: string;
}

export interface CitationRef {
  marker: number; // 1-based citation number [1], [2]...
  sourceId: string;
  sourceTitle: string;
  passageIndex: number; // 1-based passage index inside the source
  excerpt: string;
}

export interface NewsArticle {
  id: string;
  title: string;
  source: string;
  sourceType?: SourceType;
  fileSizeLabel?: string;
  category: string;
  tags?: string[];
  url?: string;
  summary: string;
  keyFacts: string[];
  content: string;
  passages?: SourcePassage[];
  estimatedReadMinutes: number;
  selected: boolean;
  readLater?: boolean;
  shelvedAt?: string;
  addedAt: string;
  imageUrl?: string;
}

export interface BriefingPreferences {
  durationMinutes: CommuteDuration;
  format: BroadcastFormat;
  tone: BriefingTone;
  voiceTone: VoiceTone;
  voiceName: VoiceName;
  coHostVoiceName: VoiceName;
  dynamicPanel: boolean;
  segmentCoHostVoices: Record<string, VoiceName>;
  listenerFocus: string;
  personalizedIntroduction?: string;
}

export interface ScriptLine {
  speaker: string;
  text: string;
}

export interface BriefingSegment {
  id: string;
  title: string;
  category: string;
  sourceTitles: string[];
  keyPoint: string;
  estimatedSeconds: number;
  lines: ScriptLine[];
  citations?: CitationRef[];
  coHostVoiceName?: VoiceName;
  audioBase64?: string;
  audioDurationSeconds?: number;
  audioStale?: boolean;
}

export interface AudioBriefing {
  id: string;
  createdAt: string;
  editionTitle: string;
  editionSubtitle: string;
  takeaways: string[];
  takeawayCitations?: CitationRef[];
  preferences: BriefingPreferences;
  articleTitles: string[];
  segments: BriefingSegment[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: string;
  citations?: CitationRef[];
  audioBase64?: string;
}

export interface PlaybackPosition {
  briefingId: string;
  segmentIndex: number;
  currentTime: number;
  duration: number;
  playbackRate: number;
  updatedAt: string;
}

export interface InspectedSourceTarget {
  sourceId: string;
  passageIndex?: number;
  excerpt?: string;
}

export type ShareTtlHours = 24 | 72 | 168;

export interface SharedBriefingSegment {
  id: string;
  title: string;
  category: string;
  sourceTitles: string[];
  keyPoint: string;
  estimatedSeconds: number;
  audioDurationSeconds?: number;
  lines: ScriptLine[];
  coHostVoiceName?: VoiceName;
  hasAudio: boolean;
  audioUrl?: string;
}

export interface SharedBriefingManifest {
  shareId: string;
  createdAt: string;
  expiresAt: string;
  ttlHours: ShareTtlHours;
  editionTitle: string;
  editionSubtitle: string;
  briefingCreatedAt: string;
  takeaways: string[];
  preferences: BriefingPreferences;
  articleTitles: string[];
  segments: SharedBriefingSegment[];
  hasAudio: boolean;
  recordedChapters: number;
  totalDurationSeconds: number;
  downloadUrl?: string;
}

export interface CreateShareResult {
  shareId: string;
  sharePath: string;
  createdAt: string;
  expiresAt: string;
  ttlHours: ShareTtlHours;
  hasAudio: boolean;
  recordedChapters: number;
  totalChapters: number;
  totalDurationSeconds: number;
  manageToken?: string;
}

export interface RssEpisodeChapterNote {
  title: string;
  category: string;
  startSeconds: number;
  durationSeconds: number;
  keyPoint: string;
}

export interface RssFeedEpisodeSummary {
  briefingId: string;
  episodeKey: string;
  title: string;
  subtitle: string;
  publishedAt: string;
  durationSeconds: number;
  byteLength: number;
  audioSignature: string;
  takeaways: string[];
  chapters: RssEpisodeChapterNote[];
  articleTitles: string[];
  format: BroadcastFormat;
  audioPath: string;
}

export interface RssFeedManifestPublic {
  feedId: string;
  feedToken: string;
  feedPath: string;
  coverPath: string;
  title: string;
  description: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  episodes: RssFeedEpisodeSummary[];
}

export interface LocalRssFeedConfig {
  feedId: string;
  feedToken: string;
  manageToken: string;
  title: string;
  description: string;
  author: string;
  autoSync: boolean;
  lastSyncedAt: string | null;
  syncedSignatures: Record<string, string>;
}

export type MockupCanvasMode = 'light' | 'dark';
export type MockupFontMood = 'industrial' | 'editorial' | 'modern';
export type MockupViewport = 'desktop' | 'tablet' | 'mobile';
export type MockupSectionKey = 'services' | 'projects' | 'about' | 'quote';
export type MockupSwatchRole = 'primary' | 'accent' | 'surface' | 'neutral';

export interface MockupColorSwatch {
  hex: string;
  name: string;
  role: MockupSwatchRole;
  usageNote: string;
}

export interface MockupPalette {
  primary: string;
  accent: string;
  canvasMode: MockupCanvasMode;
  onPrimary?: string;
  onAccent?: string;
  accentText?: string;
  heroKickerText?: string;
}

export interface MockupService {
  id: string;
  title: string;
  description: string;
  deliverable: string;
}

export interface MockupProjectItem {
  id: string;
  title: string;
  location: string;
  metric: string;
  summary: string;
  photoDataUrl?: string;
}

export type MockupMediaCategory = 'logo' | 'hero' | 'project' | 'site-photo';

export interface MockupMediaAsset {
  id: string;
  label: string;
  category: MockupMediaCategory;
  dataUrl: string;
  width?: number;
  height?: number;
  sizeKb?: number;
  addedAt: string;
}

export interface MockupFontPairing {
  id: string;
  name: string;
  headingFont: string;
  bodyFont: string;
  monoFont?: string;
  headingCategory: 'sans-serif' | 'serif' | 'display';
  bodyCategory: 'sans-serif' | 'serif';
  rationale: string;
  mood: MockupFontMood;
  sourceNote?: string;
}

export interface SiteMockupProject {
  id: string;
  sourceUrl: string;
  lastImportedAt?: string;
  updatedAt: string;
  brand: {
    name: string;
    industry: string;
    serviceArea: string;
    phone: string;
    email: string;
    hours: string;
    address: string;
    logoDataUrl?: string;
    palette: MockupPalette;
    fontMood: MockupFontMood;
    fontPairing?: MockupFontPairing;
  };
  brandSwatches?: MockupColorSwatch[];
  suggestedFontPairings?: MockupFontPairing[];
  hero: {
    kicker: string;
    headline: string;
    subheadline: string;
    primaryCta: string;
    secondaryCta: string;
    trustHighlights: string[];
    photoDataUrl?: string;
  };
  services: MockupService[];
  projects: MockupProjectItem[];
  about: {
    heading: string;
    story: string;
    credentials: string[];
  };
  quoteForm: {
    heading: string;
    subtext: string;
    submitLabel: string;
  };
  sectionVisibility: Record<MockupSectionKey, boolean>;
  sectionOrder?: MockupSectionKey[];
  lockedSections?: Partial<Record<MockupSectionKey, boolean>>;
  mediaCollection?: MockupMediaAsset[];
  siteNotes: string;
}

export interface MockupSnapshot {
  id: string;
  label: string;
  savedAt: string;
  project: SiteMockupProject;
}

export interface SharedMockupManifest {
  shareId: string;
  createdAt: string;
  expiresAt: string;
  ttlHours: ShareTtlHours;
  note: string;
  project: SiteMockupProject;
}

export interface CreateMockupShareResult {
  shareId: string;
  sharePath: string;
  createdAt: string;
  expiresAt: string;
  ttlHours: ShareTtlHours;
  manageToken?: string;
}
