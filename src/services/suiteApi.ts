export type SuiteChatModelId =
  | 'gemini-3.5-flash-lite'
  | 'gemini-3.1-flash-lite'
  | 'gemini-4-hydrogen'
  | 'gemini-4-neon'
  | 'gemini-4-carbon';

export interface SuiteChatModelOption {
  id: SuiteChatModelId;
  label: string;
  tier: string;
  description: string;
}

export const SUITE_CHAT_MODELS: SuiteChatModelOption[] = [
  {
    id: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash-Lite',
    tier: 'Default · High Limit',
    description: 'Fast, high-quota default for everyday research, briefings, and structured chat.',
  },
  {
    id: 'gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash-Lite',
    tier: 'Ultra Fast',
    description: 'Instant iterations, quick rewrites, and low-latency fallback Q&A.',
  },
  {
    id: 'gemini-4-hydrogen',
    label: 'Gemini 4 Hydrogen',
    tier: 'Balanced',
    description: 'Everyday research, briefings, and fast conversational work.',
  },
  {
    id: 'gemini-4-neon',
    label: 'Gemini 4 Neon',
    tier: 'Interactive Pro',
    description: 'High-nuance creative drafting, structured problem solving, and code.',
  },
  {
    id: 'gemini-4-carbon',
    label: 'Gemini 4 Carbon',
    tier: 'Deep Reasoning',
    description: 'Complex strategy, architecture, and multi-step editorial analysis.',
  },
];

export interface DbChatMessageRow {
  id: number;
  threadId: string;
  role: 'user' | 'model';
  modelId: string;
  persona: string;
  content: string;
  createdAt: string;
}

export interface DbChatThreadSummary {
  threadId: string;
  title: string;
  lastMessage: string;
  modelId: string;
  messageCount: number;
  updatedAt: string;
}

export interface DbTranscriptionRow {
  id: number;
  title: string;
  transcriptText: string;
  durationSeconds: number;
  mimeType: string;
  createdAt: string;
}

export interface DbMediaItemRow {
  id: number;
  kind: 'image' | 'video' | 'music';
  modelId: string;
  prompt: string;
  aspectRatio: string;
  lyrics: string;
  previewNote: string;
  createdAt: string;
}

export interface DbMapPinRow {
  id: number;
  placeId: string;
  name: string;
  address: string;
  category: 'client_site' | 'story_beat' | 'field_stop' | string;
  lat: number;
  lng: number;
  notes: string;
  createdAt: string;
}

export interface DbGameScoreEntry {
  id: number;
  score: number;
  capsulesCollected: number;
  distanceMeters: number;
  bestCombo: number;
  createdAt: string;
  displayName: string;
}

export type AuditLogCategory =
  | 'auth'
  | 'governance'
  | 'system_config'
  | 'ai_desk'
  | 'media_lab'
  | 'mockup'
  | 'spatial'
  | 'share';

export type AuditAccountabilityDomain =
  | 'auth_history'
  | 'privilege_modifications'
  | 'system_config'
  | 'system_data_changes';

export type AuditSeverity = 'critical' | 'elevated' | 'standard';

export interface StudioSystemConfig {
  defaultShareTtlHours: 24 | 72 | 168;
  defaultChatModel: SuiteChatModelId;
  adaptiveQualityDefault: boolean;
  requireVerifiedEmailForShares: boolean;
  auditRetentionDays: 90 | 180 | 365;
  updatedAt: string;
  updatedByEmail: string;
}

export interface SystemConfigFieldDiff {
  key: string;
  label: string;
  before: string | number | boolean;
  after: string | number | boolean;
}

export type SessionAccessPatternLevel = 'nominal' | 'elevated' | 'critical';

export interface SessionAccessPatternAssessment {
  flagged: boolean;
  level: SessionAccessPatternLevel;
  label: string;
  reasons: string[];
  distinctIps24h: number;
  distinctDevices24h: number;
}

export interface DbUserProfile {
  id: number;
  uid: string;
  email: string;
  displayName: string;
  photoUrl: string;
  role: 'owner' | 'admin' | 'member';
  emailVerified: boolean;
  authProvider: string;
  accountStatus: 'active' | 'suspended';
  loginCount: number;
  lastLoginAt: string;
  lastActiveAt: string;
  lastTokenIssuedAt: string | null;
  sessionRevokedAfter?: string | null;
  lastSeenDevice: string;
  lastSeenIp: string;
  createdAt: string;
}

export interface OwnerAuditedUser extends DbUserProfile {
  sessionState: 'suspended' | 'revoked' | 'active_now' | 'recent_24h' | 'idle';
  recentIps: string[];
  recentDevices: string[];
  accessPattern: SessionAccessPatternAssessment;
  counts: {
    chatMessages: number;
    transcriptions: number;
    mediaItems: number;
    mapPins: number;
    savedMockups: number;
    gameRuns: number;
    activityLogs: number;
  };
}

export interface OwnerActivityLogEntry {
  id: string;
  userId: number | null;
  actorEmail: string;
  actorName: string;
  actorRole: 'owner' | 'admin' | 'member' | 'guest';
  category: AuditLogCategory;
  domain: AuditAccountabilityDomain;
  severity: AuditSeverity;
  action: string;
  summary: string;
  resourceType: string;
  resourceId: string;
  authStatus: 'verified' | 'unverified' | 'suspended';
  clientContext: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface OwnerAuditedShare {
  shareId: string;
  kind: 'briefing' | 'mockup';
  sharePath: string;
  title: string;
  subtitle: string;
  creatorEmail: string;
  createdAt: string;
  expiresAt: string;
  ttlHours: number;
  itemCount: number;
  hasAudio: boolean;
  sizeBytes: number;
}

export interface OwnerOverviewResponse {
  currentUser: DbUserProfile;
  totals: {
    users: number;
    verifiedUsers: number;
    activeUsers24h: number;
    suspendedUsers: number;
    unusualSessions?: number;
    chatMessages: number;
    transcriptions: number;
    mediaItems: number;
    mapPins: number;
    savedMockups: number;
    gameRuns: number;
    activityLogs: number;
  };
  users: OwnerAuditedUser[];
  recentLogs: OwnerActivityLogEntry[];
  shares: OwnerAuditedShare[];
  storage: {
    activeShareCount: number;
    briefingShareCount: number;
    mockupShareCount: number;
    expiredPendingCount: number;
    totalShareBytes: number;
  };
  systemConfig: StudioSystemConfig;
}

export interface SqlUserRepairDiagnostic {
  userId: number;
  uid: string;
  email: string;
  displayName: string;
  photoUrl: string;
  authProvider: string;
  emailVerified: boolean;
  storedRole: string;
  expectedRole: 'owner' | 'admin' | 'member';
  expectedIsOwner: boolean;
  storedAccountStatus: string;
  expectedAccountStatus: 'active' | 'suspended';
  sqlIssues: string[];
  sqlRepaired: boolean;
}

export interface SelfRepairAuthResponse {
  user: DbUserProfile;
  repaired: boolean;
  sqlIssues: string[];
}

export interface OwnerRepairAuthResponse {
  mode: 'scan' | 'repair';
  scannedAt: string;
  scannedCount: number;
  issueCount: number;
  repairedCount: number;
  users: SqlUserRepairDiagnostic[];
}

export interface DbSavedMockupSummary {
  id: number;
  versionNumber: number;
  label: string;
  changeNote: string;
  brandName: string;
  headlinePreview: string;
  primaryColor: string;
  accentColor: string;
  canvasMode: string;
  assetCount: number;
  contentHash: string;
  sourceUrl: string;
  updatedAt: string;
}

export interface DbSavedMockupRow extends DbSavedMockupSummary {
  projectJson: string;
}

export class SessionRevokedClientError extends Error {
  readonly code = 'SESSION_REVOKED';

  constructor(
    message = 'Your active studio session was revoked by an administrator. Sign in with Google again to continue.'
  ) {
    super(message);
    this.name = 'SessionRevokedClientError';
  }
}

async function parseJsonResponse<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  } & T;
  if (!res.ok) {
    if (res.status === 401 && data.code === 'SESSION_REVOKED') {
      const msg =
        data.error ||
        'Your active studio session was revoked by an administrator. Sign in with Google again to continue.';
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('athena:session-revoked', {
            detail: { message: msg },
          })
        );
      }
      throw new SessionRevokedClientError(msg);
    }
    throw new Error(data.error || `Request failed (${res.status}).`);
  }
  return data;
}

function authHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

// ---------- AI Suite Endpoints ----------

export async function sendSuiteChat(payload: {
  model: SuiteChatModelId;
  systemInstruction?: string;
  messages: Array<{ role: 'user' | 'model'; text: string }>;
}): Promise<{ reply: string; model: string }> {
  const res = await fetch('/api/suite/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseJsonResponse(res);
}

export async function transcribeAudioClip(payload: {
  audioBase64: string;
  mimeType: string;
  prompt?: string;
}): Promise<{ transcript: string; model: string }> {
  const res = await fetch('/api/suite/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseJsonResponse(res);
}

export async function generateOrEditImage(payload: {
  prompt: string;
  aspectRatio: string;
  imageSize: '1K' | '2K' | '4K';
  sourceImageBase64?: string;
  sourceMimeType?: string;
}): Promise<{
  imageDataUrl: string;
  mimeType: string;
  caption: string;
  model: string;
  aspectRatio: string;
}> {
  const res = await fetch('/api/suite/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseJsonResponse(res);
}

export async function generateOrAnimateVideo(payload: {
  prompt: string;
  aspectRatio: '16:9' | '9:16';
  duration: string;
  resolution: '720p' | '1080p';
  sourceImageBase64?: string;
  sourceMimeType?: string;
}): Promise<{
  videoBase64: string;
  mimeType: string;
  aspectRatio: string;
  duration: string;
  model: string;
}> {
  const res = await fetch('/api/suite/video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseJsonResponse(res);
}

export async function generateLyriaMusic(payload: {
  prompt: string;
  model: 'lyria-3-clip-preview' | 'lyria-3-pro-preview';
  referenceImageBase64?: string;
  referenceMimeType?: string;
}): Promise<{
  audioBase64: string;
  mimeType: string;
  lyrics: string;
  model: string;
}> {
  const res = await fetch('/api/suite/music', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseJsonResponse(res);
}

// ---------- Cloud SQL Persistence Endpoints (Authenticated) ----------

export async function fetchDbChatThreads(
  token: string
): Promise<DbChatThreadSummary[]> {
  const res = await fetch('/api/db/chat/threads', {
    headers: authHeaders(token),
  });
  const data = await parseJsonResponse<{ threads: DbChatThreadSummary[] }>(res);
  return data.threads ?? [];
}

export async function fetchDbChatMessages(
  token: string,
  threadId = 'default'
): Promise<DbChatMessageRow[]> {
  const res = await fetch(`/api/db/chat?threadId=${encodeURIComponent(threadId)}`, {
    headers: authHeaders(token),
  });
  const data = await parseJsonResponse<{ messages: DbChatMessageRow[] }>(res);
  return data.messages ?? [];
}

export async function saveDbChatMessage(
  token: string,
  payload: {
    threadId?: string;
    role: 'user' | 'model';
    modelId: string;
    persona: string;
    content: string;
  }
): Promise<DbChatMessageRow> {
  const res = await fetch('/api/db/chat', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  const data = await parseJsonResponse<{ message: DbChatMessageRow }>(res);
  return data.message;
}

export async function clearDbChatThread(
  token: string,
  threadId = 'default'
): Promise<void> {
  const res = await fetch(`/api/db/chat/${encodeURIComponent(threadId)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  await parseJsonResponse(res);
}

export async function fetchDbTranscriptions(
  token: string
): Promise<DbTranscriptionRow[]> {
  const res = await fetch('/api/db/transcriptions', {
    headers: authHeaders(token),
  });
  const data = await parseJsonResponse<{ transcriptions: DbTranscriptionRow[] }>(res);
  return data.transcriptions ?? [];
}

export async function saveDbTranscription(
  token: string,
  payload: {
    title: string;
    transcriptText: string;
    durationSeconds: number;
    mimeType: string;
  }
): Promise<DbTranscriptionRow> {
  const res = await fetch('/api/db/transcriptions', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  const data = await parseJsonResponse<{ transcription: DbTranscriptionRow }>(res);
  return data.transcription;
}

export async function deleteDbTranscription(token: string, id: number): Promise<void> {
  const res = await fetch(`/api/db/transcriptions/${id}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  await parseJsonResponse(res);
}

export async function fetchDbMediaItems(token: string): Promise<DbMediaItemRow[]> {
  const res = await fetch('/api/db/media', {
    headers: authHeaders(token),
  });
  const data = await parseJsonResponse<{ items: DbMediaItemRow[] }>(res);
  return data.items ?? [];
}

export async function saveDbMediaItem(
  token: string,
  payload: {
    kind: 'image' | 'video' | 'music';
    modelId: string;
    prompt: string;
    aspectRatio?: string;
    lyrics?: string;
    previewNote?: string;
  }
): Promise<DbMediaItemRow> {
  const res = await fetch('/api/db/media', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  const data = await parseJsonResponse<{ item: DbMediaItemRow }>(res);
  return data.item;
}

export async function fetchDbMapPins(token: string): Promise<DbMapPinRow[]> {
  const res = await fetch('/api/db/pins', {
    headers: authHeaders(token),
  });
  const data = await parseJsonResponse<{ pins: DbMapPinRow[] }>(res);
  return data.pins ?? [];
}

export async function saveDbMapPin(
  token: string,
  payload: {
    placeId?: string;
    name: string;
    address?: string;
    category: string;
    lat: number;
    lng: number;
    notes?: string;
  }
): Promise<DbMapPinRow> {
  const res = await fetch('/api/db/pins', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  const data = await parseJsonResponse<{ pin: DbMapPinRow }>(res);
  return data.pin;
}

export async function deleteDbMapPin(token: string, id: number): Promise<void> {
  const res = await fetch(`/api/db/pins/${id}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  await parseJsonResponse(res);
}

export async function fetchDbGameScores(token: string): Promise<{
  leaderboard: DbGameScoreEntry[];
  personalBest: number;
}> {
  const res = await fetch('/api/db/scores', {
    headers: authHeaders(token),
  });
  return parseJsonResponse(res);
}

export async function saveDbGameScore(
  token: string,
  payload: {
    score: number;
    capsulesCollected: number;
    distanceMeters: number;
    bestCombo: number;
  }
): Promise<{
  leaderboard: DbGameScoreEntry[];
  personalBest: number;
}> {
  const res = await fetch('/api/db/scores', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  return parseJsonResponse(res);
}

export async function fetchDbMockups(token: string): Promise<DbSavedMockupSummary[]> {
  const res = await fetch('/api/db/mockups', {
    headers: authHeaders(token),
  });
  const data = await parseJsonResponse<{ mockups: DbSavedMockupSummary[] }>(res);
  return data.mockups ?? [];
}

export async function fetchDbMockupById(
  token: string,
  id: number
): Promise<DbSavedMockupRow> {
  const res = await fetch(`/api/db/mockups/${id}`, {
    headers: authHeaders(token),
  });
  const data = await parseJsonResponse<{ mockup: DbSavedMockupRow }>(res);
  return data.mockup;
}

export async function saveDbMockup(
  token: string,
  payload: {
    label?: string;
    changeNote?: string;
    brandName?: string;
    headlinePreview?: string;
    primaryColor?: string;
    accentColor?: string;
    canvasMode?: string;
    assetCount?: number;
    contentHash?: string;
    sourceUrl: string;
    projectJson: string;
  }
): Promise<DbSavedMockupRow> {
  const res = await fetch('/api/db/mockups', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  const data = await parseJsonResponse<{ mockup: DbSavedMockupRow }>(res);
  return data.mockup;
}

export async function updateDbMockupMeta(
  token: string,
  id: number,
  payload: { label: string; changeNote?: string }
): Promise<DbSavedMockupSummary> {
  const res = await fetch(`/api/db/mockups/${id}`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  const data = await parseJsonResponse<{ mockup: DbSavedMockupSummary }>(res);
  return data.mockup;
}

export async function deleteDbMockup(token: string, id: number): Promise<void> {
  const res = await fetch(`/api/db/mockups/${id}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  await parseJsonResponse(res);
}

export async function fetchDbProfile(
  token: string,
  isExplicitSignIn = false
): Promise<DbUserProfile> {
  const url = isExplicitSignIn ? '/api/db/profile?event=signin' : '/api/db/profile';
  const res = await fetch(url, {
    headers: authHeaders(token),
  });
  const data = await parseJsonResponse<{ user: DbUserProfile }>(res);
  return data.user;
}

export async function recordClientAuthEvent(
  token: string,
  event: 'sign_out' | 'token_verified'
): Promise<void> {
  const res = await fetch('/api/db/auth-event', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ event }),
  });
  await parseJsonResponse(res);
}

export async function recordClientConfigEvent(
  token: string,
  payload: {
    settingKey: string;
    settingLabel: string;
    previousValue: string | number | boolean;
    nextValue: string | number | boolean;
    subsystem?: string;
  }
): Promise<void> {
  const res = await fetch('/api/db/config-event', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  await parseJsonResponse(res);
}

export async function fetchSuiteRuntimeConfig(): Promise<StudioSystemConfig> {
  const res = await fetch('/api/suite/runtime-config');
  const data = await parseJsonResponse<{ config: StudioSystemConfig }>(res);
  return data.config;
}

// ---------- Ultra Owner & Admin Governance Endpoints ----------

export async function fetchOwnerOverview(token: string): Promise<OwnerOverviewResponse> {
  const res = await fetch('/api/owner/overview', {
    headers: authHeaders(token),
  });
  return parseJsonResponse<OwnerOverviewResponse>(res);
}

export async function fetchOwnerSystemConfig(
  token: string
): Promise<StudioSystemConfig> {
  const res = await fetch('/api/owner/system-config', {
    headers: authHeaders(token),
  });
  const data = await parseJsonResponse<{ config: StudioSystemConfig }>(res);
  return data.config;
}

export async function updateOwnerSystemConfig(
  token: string,
  patch: Partial<{
    defaultShareTtlHours: 24 | 72 | 168;
    defaultChatModel: SuiteChatModelId;
    adaptiveQualityDefault: boolean;
    requireVerifiedEmailForShares: boolean;
    auditRetentionDays: 90 | 180 | 365;
  }>
): Promise<{
  config: StudioSystemConfig;
  changes: SystemConfigFieldDiff[];
  updated: boolean;
}> {
  const res = await fetch('/api/owner/system-config', {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify(patch),
  });
  return parseJsonResponse(res);
}

export async function fetchOwnerAuditLogs(
  token: string,
  params: {
    userId?: number | null;
    domain?: string;
    category?: string;
    authStatus?: string;
    windowHours?: number | null;
    fromIso?: string | null;
    toIso?: string | null;
    sortOrder?: 'desc' | 'asc';
    search?: string;
    limit?: number;
  } = {}
): Promise<OwnerActivityLogEntry[]> {
  const searchParams = new URLSearchParams();
  if (typeof params.userId === 'number' && params.userId > 0) {
    searchParams.set('userId', String(params.userId));
  }
  if (params.domain && params.domain !== 'all') {
    searchParams.set('domain', params.domain);
  }
  if (params.category && params.category !== 'all') {
    searchParams.set('category', params.category);
  }
  if (params.authStatus && params.authStatus !== 'all') {
    searchParams.set('authStatus', params.authStatus);
  }
  if (typeof params.windowHours === 'number' && params.windowHours > 0) {
    searchParams.set('windowHours', String(params.windowHours));
  }
  if (params.fromIso && params.fromIso.trim()) {
    searchParams.set('fromIso', params.fromIso.trim());
  }
  if (params.toIso && params.toIso.trim()) {
    searchParams.set('toIso', params.toIso.trim());
  }
  if (params.sortOrder) {
    searchParams.set('sortOrder', params.sortOrder);
  }
  if (params.search && params.search.trim()) {
    searchParams.set('search', params.search.trim());
  }
  if (params.limit) {
    searchParams.set('limit', String(params.limit));
  }
  const qs = searchParams.toString();
  const res = await fetch(`/api/owner/audit-logs${qs ? `?${qs}` : ''}`, {
    headers: authHeaders(token),
  });
  const data = await parseJsonResponse<{ logs: OwnerActivityLogEntry[] }>(res);
  return data.logs ?? [];
}

export async function fetchOwnerUserAuditDetail(
  token: string,
  userId: number
): Promise<{ user: OwnerAuditedUser; logs: OwnerActivityLogEntry[] }> {
  const res = await fetch(`/api/owner/users/${userId}/audit`, {
    headers: authHeaders(token),
  });
  return parseJsonResponse(res);
}

export async function updateOwnerUserRole(
  token: string,
  userId: number,
  role: 'admin' | 'member'
): Promise<DbUserProfile> {
  const res = await fetch(`/api/owner/users/${userId}/role`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ role }),
  });
  const data = await parseJsonResponse<{ user: DbUserProfile }>(res);
  return data.user;
}

export async function updateOwnerUserStatus(
  token: string,
  userId: number,
  accountStatus: 'active' | 'suspended'
): Promise<DbUserProfile> {
  const res = await fetch(`/api/owner/users/${userId}/status`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ accountStatus }),
  });
  const data = await parseJsonResponse<{ user: DbUserProfile }>(res);
  return data.user;
}

export async function forceLogoutOwnerUser(
  token: string,
  userId: number,
  payload: { firestoreCleared?: boolean; reason?: string } = {}
): Promise<{
  user: DbUserProfile;
  revokedAt: string;
  firestoreCleared: boolean;
}> {
  const res = await fetch(`/api/owner/users/${userId}/force-logout`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  return parseJsonResponse(res);
}

export async function extendOwnerShare(
  token: string,
  kind: 'briefing' | 'mockup',
  shareId: string,
  hours: 24 | 72 | 168 = 72
): Promise<{ shareId: string; kind: 'briefing' | 'mockup'; expiresAt: string }> {
  const res = await fetch(
    `/api/owner/shares/${encodeURIComponent(kind)}/${encodeURIComponent(shareId)}/extend`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ hours }),
    }
  );
  return parseJsonResponse(res);
}

export async function revokeOwnerShare(
  token: string,
  kind: 'briefing' | 'mockup',
  shareId: string
): Promise<void> {
  const res = await fetch(
    `/api/owner/shares/${encodeURIComponent(kind)}/${encodeURIComponent(shareId)}`,
    {
      method: 'DELETE',
      headers: authHeaders(token),
    }
  );
  await parseJsonResponse(res);
}

export async function purgeExpiredOwnerShares(
  token: string
): Promise<{ purgedCount: number }> {
  const res = await fetch('/api/owner/shares/purge-expired', {
    method: 'POST',
    headers: authHeaders(token),
  });
  return parseJsonResponse(res);
}

export interface OwnerRawShareSnapshot {
  shareId: string;
  kind: 'briefing' | 'mockup';
  sharePath: string;
  creatorUid?: string;
  creatorEmail?: string;
  createdAt: string;
  expiresAt: string;
  ttlHours: number;
  note?: string;
  briefingManifest?: Record<string, unknown>;
  mockupProject?: Record<string, unknown>;
}

export interface OwnerScrubAndRelinkResponse {
  oldShareId: string;
  newShareId: string;
  newSharePath: string;
  kind: 'briefing' | 'mockup';
  createdAt: string;
  expiresAt: string;
  ttlHours: number;
  hadServerManifest: boolean;
}

export async function fetchOwnerShareSecuritySnapshots(
  token: string
): Promise<{ snapshots: OwnerRawShareSnapshot[] }> {
  const res = await fetch('/api/owner/shares/security-snapshots', {
    headers: authHeaders(token),
  });
  return parseJsonResponse(res);
}

export async function logOwnerShareSecurityScan(
  token: string,
  summary: {
    scannedCount: number;
    flaggedCount: number;
    findingCount: number;
    criticalCount: number;
    backfilledToFirestore: number;
  }
): Promise<{ logged: boolean }> {
  const res = await fetch('/api/owner/shares/security-scan-log', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(summary),
  });
  return parseJsonResponse(res);
}

export async function scrubAndRelinkOwnerShare(
  token: string,
  kind: 'briefing' | 'mockup',
  shareId: string,
  payload: {
    ttlHours?: number;
    note?: string;
    title?: string;
    scrubbedFindingCount?: number;
    categories?: string[];
    briefingManifest?: Record<string, unknown>;
    mockupProject?: Record<string, unknown>;
  }
): Promise<OwnerScrubAndRelinkResponse> {
  const res = await fetch(
    `/api/owner/shares/${encodeURIComponent(kind)}/${encodeURIComponent(shareId)}/scrub-relink`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(payload),
    }
  );
  return parseJsonResponse(res);
}

export async function runSelfRepairAuth(
  token: string,
  payload: { displayName?: string; photoUrl?: string } = {}
): Promise<SelfRepairAuthResponse> {
  const res = await fetch('/api/db/repair-auth', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  return parseJsonResponse(res);
}

export async function runOwnerRepairAuth(
  token: string,
  payload: {
    mode: 'scan' | 'repair';
    targetUserId?: number;
    displayName?: string;
    photoUrl?: string;
  }
): Promise<OwnerRepairAuthResponse> {
  const res = await fetch('/api/owner/repair-auth', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  return parseJsonResponse(res);
}

export async function logOwnerFirestoreRepairSync(
  token: string,
  payload: {
    source?: 'repair_auth' | 'sync_auth' | 'profile_repair';
    autoTriggered?: boolean;
    targetUserId?: number;
    createdAccounts?: Array<{
      uid: string;
      email: string;
      role: string;
    }>;
    firestoreSummary: {
      scanned: number;
      created: number;
      repaired: number;
      corruptedRecreated?: number;
      orphansRemoved?: number;
      misflaggedOwners: number;
    };
  }
): Promise<void> {
  const res = await fetch('/api/owner/repair-auth', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      mode: 'log_firestore_sync',
      ...payload,
    }),
  });
  await parseJsonResponse(res);
}
