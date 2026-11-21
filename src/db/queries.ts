import { and, count, desc, eq, max } from 'drizzle-orm';
import { db } from './index.ts';
import {
  chatMessages,
  gameScores,
  mapPins,
  mediaItems,
  savedMockups,
  transcriptions,
  userActivityLogs,
  users,
} from './schema.ts';

export type UserRole = 'owner' | 'admin' | 'member';
export type AccountStatus = 'active' | 'suspended';
export type UserSessionState =
  | 'suspended'
  | 'revoked'
  | 'active_now'
  | 'recent_24h'
  | 'idle';

export class SessionRevokedError extends Error {
  readonly code = 'SESSION_REVOKED';

  constructor(
    message = 'Your active studio session was revoked by an administrator. Sign in with Google again to continue.'
  ) {
    super(message);
    this.name = 'SessionRevokedError';
  }
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
export type SessionAccessPatternLevel = 'nominal' | 'elevated' | 'critical';

export interface SessionAccessPatternAssessment {
  flagged: boolean;
  level: SessionAccessPatternLevel;
  label: string;
  reasons: string[];
  distinctIps24h: number;
  distinctDevices24h: number;
}

export type SuiteDefaultChatModel =
  | 'gemini-4-carbon'
  | 'gemini-4-neon'
  | 'gemini-4-hydrogen'
  | 'gemini-3.1-flash-lite';

export interface StudioSystemConfig {
  defaultShareTtlHours: 24 | 72 | 168;
  defaultChatModel: SuiteDefaultChatModel;
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

export const PRINCIPAL_OWNER_EMAIL = 'mcollier2188@gmail.com';

export const DEFAULT_STUDIO_SYSTEM_CONFIG: StudioSystemConfig = {
  defaultShareTtlHours: 72,
  defaultChatModel: 'gemini-4-hydrogen',
  adaptiveQualityDefault: true,
  requireVerifiedEmailForShares: true,
  auditRetentionDays: 180,
  updatedAt: new Date(0).toISOString(),
  updatedByEmail: PRINCIPAL_OWNER_EMAIL,
};

export function safeParseMetadataJson(raw?: string | null): Record<string, unknown> {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

export function classifyAuditAccountabilityDomain(
  category: AuditLogCategory,
  action: string
): AuditAccountabilityDomain {
  const cleanAction = (action || '').toLowerCase();
  if (category === 'system_config' || cleanAction.startsWith('config.')) {
    return 'system_config';
  }
  if (
    category === 'governance' ||
    cleanAction.startsWith('role.') ||
    cleanAction.startsWith('account.') ||
    cleanAction === 'auth.force_logout' ||
    cleanAction === 'auth.sync_remediated' ||
    cleanAction === 'auth.repair_executed' ||
    cleanAction === 'auth.sql_metadata_repaired'
  ) {
    return 'privilege_modifications';
  }
  if (category === 'auth' || cleanAction.startsWith('auth.')) {
    return 'auth_history';
  }
  return 'system_data_changes';
}

export function classifyAuditSeverity(
  category: AuditLogCategory,
  action: string,
  authStatus: string,
  metadata: Record<string, unknown>
): AuditSeverity {
  const cleanAction = (action || '').toLowerCase();
  const misflaggedOwners = Number(metadata.misflaggedOwners) || 0;
  const orphansRemoved = Number(metadata.orphansRemoved) || 0;

  if (
    authStatus === 'suspended' ||
    cleanAction === 'auth.blocked_suspended' ||
    cleanAction === 'auth.blocked_revoked_session' ||
    cleanAction === 'auth.force_logout' ||
    cleanAction === 'role.updated' ||
    cleanAction === 'role.principal_auto_verified' ||
    cleanAction === 'account.status_changed' ||
    cleanAction === 'share.revoked' ||
    cleanAction === 'share.scrubbed_relinked' ||
    cleanAction === 'share.purged_expired' ||
    (cleanAction === 'config.system_updated' &&
      metadata.securityPolicyRelaxed === true) ||
    misflaggedOwners > 0 ||
    orphansRemoved > 0
  ) {
    return 'critical';
  }

  if (
    category === 'governance' ||
    cleanAction === 'config.system_updated' ||
    cleanAction === 'auth.repair_synced' ||
    cleanAction === 'share.extended' ||
    (cleanAction === 'share.security_scanned' &&
      (Number(metadata.flaggedCount) || 0) > 0) ||
    cleanAction.endsWith('.deleted') ||
    cleanAction.endsWith('_deleted') ||
    cleanAction.endsWith('_cleared') ||
    authStatus === 'unverified'
  ) {
    return 'elevated';
  }

  return 'standard';
}

export function normalizeUserRole(raw?: string | null): UserRole {
  if (raw === 'owner' || raw === 'admin') return raw;
  return 'member';
}

export function normalizeAccountStatus(raw?: string | null): AccountStatus {
  return raw === 'suspended' ? 'suspended' : 'active';
}

export function computeUserSessionState(
  accountStatus: AccountStatus,
  lastActiveAt: Date | string | null | undefined,
  sessionRevokedAfter?: Date | string | null
): UserSessionState {
  if (accountStatus === 'suspended') return 'suspended';
  if (sessionRevokedAfter) {
    const revokedMs = new Date(sessionRevokedAfter).getTime();
    if (Number.isFinite(revokedMs) && revokedMs > 0) {
      return 'revoked';
    }
  }
  const activeMs = lastActiveAt ? new Date(lastActiveAt).getTime() : 0;
  if (!Number.isFinite(activeMs) || activeMs <= 0) return 'idle';
  const ageMs = Date.now() - activeMs;
  if (ageMs <= 15 * 60 * 1000) return 'active_now';
  if (ageMs <= 24 * 3600 * 1000) return 'recent_24h';
  return 'idle';
}

const SYNTHETIC_CONTEXT_LABELS = new Set([
  'studio runtime bootstrap',
  'site mockup workbench',
  'ai desk transcriber',
  'media lab',
  'spatial & maps hub',
  'ai desk',
  'dispatch run 3d',
  'google.com',
  'password',
]);

function looksLikeIpToken(candidate: string): boolean {
  const clean = candidate.trim();
  if (!clean || clean.length < 3 || clean.length > 45) return false;
  if (!/^[0-9a-fA-F:.]+$/.test(clean)) return false;
  return clean.includes('.') || clean.includes(':');
}

export function parseClientContextTelemetry(
  rawContext?: string | null,
  metadata?: Record<string, unknown>
): { device: string; ip: string } {
  const metaDevice =
    typeof metadata?.deviceSummary === 'string' ? metadata.deviceSummary.trim() : '';
  const metaIp =
    typeof metadata?.ipAddress === 'string' &&
    metadata.ipAddress.trim() !== 'Unknown IP'
      ? metadata.ipAddress.trim()
      : '';

  const contextStr = (rawContext || '').trim();
  if (!contextStr || SYNTHETIC_CONTEXT_LABELS.has(contextStr.toLowerCase())) {
    return { device: metaDevice, ip: metaIp };
  }

  const parts = contextStr
    .split('·')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    const tail = parts[parts.length - 1] || '';
    if (looksLikeIpToken(tail)) {
      const parsedDevice = parts.slice(0, -1).join(' · ');
      return {
        device: metaDevice || parsedDevice,
        ip: metaIp || tail,
      };
    }
  }

  return {
    device: metaDevice || contextStr,
    ip: metaIp,
  };
}

export interface RecordActivityLogInput {
  userId?: number | null;
  actorEmail: string;
  actorName?: string;
  actorRole?: string;
  category: AuditLogCategory;
  action: string;
  summary: string;
  resourceType?: string;
  resourceId?: string;
  authStatus?: 'verified' | 'unverified' | 'suspended';
  clientContext?: string;
  metadata?: Record<string, unknown>;
}

export async function recordUserActivityLog(input: RecordActivityLogInput): Promise<void> {
  try {
    await db.insert(userActivityLogs).values({
      userId: input.userId ?? null,
      actorEmail: (input.actorEmail || 'unknown@dispatch.local').trim().slice(0, 180),
      actorName: (input.actorName || '').trim().slice(0, 140),
      actorRole: (input.actorRole || 'member').trim().slice(0, 32),
      category: input.category,
      action: input.action.trim().slice(0, 80),
      summary: input.summary.trim().slice(0, 400),
      resourceType: (input.resourceType || '').trim().slice(0, 64),
      resourceId: (input.resourceId || '').trim().slice(0, 96),
      authStatus: input.authStatus || 'verified',
      clientContext: (input.clientContext || '').trim().slice(0, 120),
      metadataJson: input.metadata ? JSON.stringify(input.metadata).slice(0, 2000) : '{}',
    });
  } catch (error) {
    console.error('Failed to record user activity log:', error);
  }
}

export interface SyncUserAuthOptions {
  authProvider?: string;
  tokenAuthTimeSec?: number;
  isExplicitSignIn?: boolean;
  clientContext?: string;
  lastSeenDevice?: string;
  lastSeenIp?: string;
}

export async function getOrCreateUser(
  uid: string,
  email: string,
  displayName = '',
  photoUrl = '',
  emailVerified = false,
  authOptions: SyncUserAuthOptions = {}
) {
  try {
    const cleanEmail = (email || `${uid}@dispatch.local`).trim();
    const isPrincipalOwner = Boolean(
      emailVerified && cleanEmail.toLowerCase() === PRINCIPAL_OWNER_EMAIL
    );
    const now = new Date();
    const provider = (authOptions.authProvider || 'google.com').trim().slice(0, 64);
    const cleanSeenDevice = (authOptions.lastSeenDevice || '').trim().slice(0, 80);
    const cleanSeenIp =
      authOptions.lastSeenIp && authOptions.lastSeenIp.trim() !== 'Unknown IP'
        ? authOptions.lastSeenIp.trim().slice(0, 45)
        : '';
    const tokenIssuedDate =
      typeof authOptions.tokenAuthTimeSec === 'number' &&
      authOptions.tokenAuthTimeSec > 0
        ? new Date(authOptions.tokenAuthTimeSec * 1000)
        : null;

    const existingRows = await db
      .select()
      .from(users)
      .where(eq(users.uid, uid))
      .limit(1);
    const existing = existingRows[0];

    if (!existing) {
      const inserted = await db
        .insert(users)
        .values({
          uid,
          email: cleanEmail,
          displayName: displayName.trim(),
          photoUrl: photoUrl.trim(),
          role: isPrincipalOwner ? 'owner' : 'member',
          emailVerified,
          authProvider: provider,
          accountStatus: 'active',
          loginCount: 1,
          lastLoginAt: now,
          lastActiveAt: now,
          lastTokenIssuedAt: tokenIssuedDate ?? now,
          lastSeenDevice: cleanSeenDevice,
          lastSeenIp: cleanSeenIp,
        })
        .onConflictDoUpdate({
          target: users.uid,
          set: {
            email: cleanEmail,
            displayName: displayName.trim(),
            photoUrl: photoUrl.trim(),
            emailVerified,
            authProvider: provider,
            lastLoginAt: now,
            lastActiveAt: now,
            ...(cleanSeenDevice ? { lastSeenDevice: cleanSeenDevice } : {}),
            ...(cleanSeenIp ? { lastSeenIp: cleanSeenIp } : {}),
            ...(tokenIssuedDate ? { lastTokenIssuedAt: tokenIssuedDate } : {}),
            ...(isPrincipalOwner ? { role: 'owner', accountStatus: 'active' } : {}),
          },
        })
        .returning();

      const created = inserted[0];
      if (created) {
        await recordUserActivityLog({
          userId: created.id,
          actorEmail: created.email,
          actorName: created.displayName,
          actorRole: created.role,
          category: 'auth',
          action: 'auth.account_registered',
          summary: `Registered studio account via ${provider} (${emailVerified ? 'verified email' : 'unverified email'})`,
          resourceType: 'user',
          resourceId: String(created.id),
          authStatus: emailVerified ? 'verified' : 'unverified',
          clientContext: authOptions.clientContext,
          metadata: {
            operation: 'account_register',
            table: 'users',
            uid: created.uid,
            authProvider: provider,
            emailVerified,
            loginCount: 1,
            loginTimestampIso: now.toISOString(),
            tokenIssuedAtIso: (tokenIssuedDate ?? now).toISOString(),
            assignedRole: created.role,
            accountStatus: created.accountStatus,
            ...(cleanSeenDevice ? { deviceSummary: cleanSeenDevice } : {}),
            ...(cleanSeenIp ? { ipAddress: cleanSeenIp } : {}),
          },
        });
      }
      return created;
    }

    const prevTokenMs = existing.lastTokenIssuedAt
      ? new Date(existing.lastTokenIssuedAt).getTime()
      : 0;
    const nextTokenMs = tokenIssuedDate ? tokenIssuedDate.getTime() : 0;
    const prevActiveMs = existing.lastActiveAt
      ? new Date(existing.lastActiveAt).getTime()
      : 0;

    // Enforce server-authoritative Force Logout revocation against pre-revocation tokens
    const revokedAfterMs = existing.sessionRevokedAfter
      ? new Date(existing.sessionRevokedAfter).getTime()
      : 0;

    if (!isPrincipalOwner && Number.isFinite(revokedAfterMs) && revokedAfterMs > 0) {
      if (nextTokenMs <= 0 || nextTokenMs <= revokedAfterMs) {
        if (now.getTime() - prevActiveMs > 60 * 1000) {
          await recordUserActivityLog({
            userId: existing.id,
            actorEmail: existing.email,
            actorName: existing.displayName,
            actorRole: normalizeUserRole(existing.role),
            category: 'auth',
            action: 'auth.blocked_revoked_session',
            summary: `Rejected revoked session token for ${existing.email} (token issued prior to admin Force Logout)`,
            resourceType: 'session',
            resourceId: String(existing.id),
            authStatus: emailVerified ? 'verified' : 'unverified',
            clientContext: authOptions.clientContext,
            metadata: {
              operation: 'revoked_token_rejected',
              table: 'users',
              uid: existing.uid,
              tokenIssuedAtIso: tokenIssuedDate ? tokenIssuedDate.toISOString() : null,
              sessionRevokedAfterIso: new Date(revokedAfterMs).toISOString(),
              ...(cleanSeenDevice ? { deviceSummary: cleanSeenDevice } : {}),
              ...(cleanSeenIp ? { ipAddress: cleanSeenIp } : {}),
            },
          });
        }
        throw new SessionRevokedError();
      }
    }

    const clearedRevocationOnFreshSignIn = Boolean(
      existing.sessionRevokedAfter && (isPrincipalOwner || nextTokenMs > revokedAfterMs)
    );

    const isFreshAuthSession = Boolean(
      clearedRevocationOnFreshSignIn ||
        authOptions.isExplicitSignIn ||
        (nextTokenMs > 0 && nextTokenMs - prevTokenMs > 60 * 1000) ||
        now.getTime() - prevActiveMs > 30 * 60 * 1000
    );

    const previousRole = normalizeUserRole(existing.role);
    const previousStatus = normalizeAccountStatus(existing.accountStatus);
    const nextRole: UserRole = isPrincipalOwner ? 'owner' : previousRole;
    const nextStatus: AccountStatus = isPrincipalOwner ? 'active' : previousStatus;
    const nextLoginCount = isFreshAuthSession
      ? Math.max(1, (existing.loginCount || 1) + 1)
      : Math.max(1, existing.loginCount || 1);

    const updatedRows = await db
      .update(users)
      .set({
        email: cleanEmail,
        displayName: displayName.trim() || existing.displayName,
        photoUrl: photoUrl.trim() || existing.photoUrl,
        role: nextRole,
        emailVerified,
        authProvider: provider || existing.authProvider,
        accountStatus: nextStatus,
        loginCount: nextLoginCount,
        lastActiveAt: now,
        ...(clearedRevocationOnFreshSignIn ? { sessionRevokedAfter: null } : {}),
        ...(cleanSeenDevice ? { lastSeenDevice: cleanSeenDevice } : {}),
        ...(cleanSeenIp ? { lastSeenIp: cleanSeenIp } : {}),
        ...(isFreshAuthSession ? { lastLoginAt: now } : {}),
        ...(tokenIssuedDate ? { lastTokenIssuedAt: tokenIssuedDate } : {}),
      })
      .where(eq(users.id, existing.id))
      .returning();

    const userRow = updatedRows[0] ?? existing;

    if (
      isPrincipalOwner &&
      (existing.role !== 'owner' || previousStatus !== 'active')
    ) {
      await recordUserActivityLog({
        userId: userRow.id,
        actorEmail: userRow.email,
        actorName: userRow.displayName,
        actorRole: 'owner',
        category: 'governance',
        action: 'role.principal_auto_verified',
        summary: `Restored Principal Owner privileges via verified Google Sign-In (${existing.role} → owner)`,
        resourceType: 'user_role',
        resourceId: String(userRow.id),
        authStatus: 'verified',
        clientContext: authOptions.clientContext,
        metadata: {
          operation: 'principal_auto_restore',
          table: 'users',
          targetUserId: userRow.id,
          targetUid: userRow.uid,
          targetEmail: userRow.email,
          previousRole: existing.role,
          nextRole: 'owner',
          previousStatus: existing.accountStatus,
          nextStatus: 'active',
          ...(cleanSeenDevice ? { deviceSummary: cleanSeenDevice } : {}),
          ...(cleanSeenIp ? { ipAddress: cleanSeenIp } : {}),
        },
      });
    }

    if (isFreshAuthSession) {
      await recordUserActivityLog({
        userId: userRow.id,
        actorEmail: userRow.email,
        actorName: userRow.displayName,
        actorRole: nextRole,
        category: 'auth',
        action: nextStatus === 'suspended' ? 'auth.blocked_suspended' : 'auth.sign_in',
        summary:
          nextStatus === 'suspended'
            ? `Blocked session attempt for suspended account (${provider})`
            : `Authenticated studio session #${nextLoginCount} via ${provider}`,
        resourceType: 'session',
        resourceId: String(userRow.id),
        authStatus:
          nextStatus === 'suspended'
            ? 'suspended'
            : emailVerified
              ? 'verified'
              : 'unverified',
        clientContext: authOptions.clientContext,
        metadata: {
          operation: nextStatus === 'suspended' ? 'session_blocked' : 'sign_in',
          table: 'users',
          uid: userRow.uid,
          authProvider: provider,
          emailVerified,
          loginCount: nextLoginCount,
          loginTimestampIso: now.toISOString(),
          tokenIssuedAtIso: (
            tokenIssuedDate ??
            userRow.lastTokenIssuedAt ??
            now
          ).toISOString(),
          role: nextRole,
          accountStatus: nextStatus,
          ...(cleanSeenDevice ? { deviceSummary: cleanSeenDevice } : {}),
          ...(cleanSeenIp ? { ipAddress: cleanSeenIp } : {}),
        },
      });
    }

    return userRow;
  } catch (error) {
    if (error instanceof SessionRevokedError) {
      throw error;
    }
    console.error('Database user upsert failed:', error);
    throw new Error('Could not synchronize user profile. Please try again.', {
      cause: error,
    });
  }
}

export async function listUserChatMessages(uid: string, threadId?: string) {
  try {
    const userRow = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
    if (!userRow[0]) return [];
    const conditions = threadId
      ? and(eq(chatMessages.userId, userRow[0].id), eq(chatMessages.threadId, threadId))
      : eq(chatMessages.userId, userRow[0].id);
    return await db
      .select()
      .from(chatMessages)
      .where(conditions)
      .orderBy(chatMessages.createdAt)
      .limit(120);
  } catch (error) {
    console.error('Failed to list chat messages:', error);
    throw new Error('Could not load saved conversation history.', { cause: error });
  }
}

export async function saveUserChatMessage(
  userId: number,
  payload: {
    threadId: string;
    role: 'user' | 'model';
    modelId: string;
    persona: string;
    content: string;
  }
) {
  try {
    const rows = await db
      .insert(chatMessages)
      .values({
        userId,
        threadId: payload.threadId,
        role: payload.role,
        modelId: payload.modelId,
        persona: payload.persona,
        content: payload.content,
      })
      .returning();
    return rows[0];
  } catch (error) {
    console.error('Failed to save chat message:', error);
    throw new Error('Could not save chat message.', { cause: error });
  }
}

export async function clearUserChatThread(userId: number, threadId: string) {
  try {
    await db
      .delete(chatMessages)
      .where(and(eq(chatMessages.userId, userId), eq(chatMessages.threadId, threadId)));
  } catch (error) {
    console.error('Failed to clear chat thread:', error);
    throw new Error('Could not clear conversation.', { cause: error });
  }
}

export async function listUserChatThreads(uid: string) {
  try {
    const userRow = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
    if (!userRow[0]) return [];
    const rows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.userId, userRow[0].id))
      .orderBy(chatMessages.createdAt)
      .limit(500);

    const grouped: Record<
      string,
      {
        threadId: string;
        title: string;
        lastMessage: string;
        modelId: string;
        messageCount: number;
        updatedAt: Date;
      }
    > = {};

    for (const row of rows) {
      const existing = grouped[row.threadId];
      if (!existing) {
        grouped[row.threadId] = {
          threadId: row.threadId,
          title:
            row.role === 'user'
              ? row.content.slice(0, 56)
              : row.threadId === 'default'
                ? 'Main Studio Thread'
                : row.threadId,
          lastMessage: row.content.slice(0, 96),
          modelId: row.modelId,
          messageCount: 1,
          updatedAt: row.createdAt,
        };
      } else {
        if (
          row.role === 'user' &&
          (existing.title === 'Main Studio Thread' || existing.title === row.threadId)
        ) {
          existing.title = row.content.slice(0, 56);
        }
        existing.lastMessage = row.content.slice(0, 96);
        existing.modelId = row.modelId;
        existing.messageCount += 1;
        existing.updatedAt = row.createdAt;
      }
    }

    return Object.values(grouped).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  } catch (error) {
    console.error('Failed to list chat threads:', error);
    throw new Error('Could not load saved conversation threads.', { cause: error });
  }
}

export async function listUserTranscriptions(uid: string) {
  try {
    const userRow = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
    if (!userRow[0]) return [];
    return await db
      .select()
      .from(transcriptions)
      .where(eq(transcriptions.userId, userRow[0].id))
      .orderBy(desc(transcriptions.createdAt))
      .limit(40);
  } catch (error) {
    console.error('Failed to list transcriptions:', error);
    throw new Error('Could not load saved transcriptions.', { cause: error });
  }
}

export async function saveUserTranscription(
  userId: number,
  payload: {
    title: string;
    transcriptText: string;
    durationSeconds: number;
    mimeType: string;
  }
) {
  try {
    const rows = await db
      .insert(transcriptions)
      .values({
        userId,
        title: payload.title,
        transcriptText: payload.transcriptText,
        durationSeconds: Math.max(0, Math.round(payload.durationSeconds)),
        mimeType: payload.mimeType || 'audio/webm',
      })
      .returning();
    return rows[0];
  } catch (error) {
    console.error('Failed to save transcription:', error);
    throw new Error('Could not save audio transcription.', { cause: error });
  }
}

export async function deleteUserTranscription(userId: number, id: number) {
  try {
    await db
      .delete(transcriptions)
      .where(and(eq(transcriptions.id, id), eq(transcriptions.userId, userId)));
  } catch (error) {
    console.error('Failed to delete transcription:', error);
    throw new Error('Could not delete transcription.', { cause: error });
  }
}

export async function listUserMediaItems(uid: string) {
  try {
    const userRow = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
    if (!userRow[0]) return [];
    return await db
      .select()
      .from(mediaItems)
      .where(eq(mediaItems.userId, userRow[0].id))
      .orderBy(desc(mediaItems.createdAt))
      .limit(40);
  } catch (error) {
    console.error('Failed to list media items:', error);
    throw new Error('Could not load saved media history.', { cause: error });
  }
}

export async function saveUserMediaItem(
  userId: number,
  payload: {
    kind: 'image' | 'video' | 'music';
    modelId: string;
    prompt: string;
    aspectRatio?: string;
    lyrics?: string;
    previewNote?: string;
  }
) {
  try {
    const rows = await db
      .insert(mediaItems)
      .values({
        userId,
        kind: payload.kind,
        modelId: payload.modelId,
        prompt: payload.prompt.slice(0, 1200),
        aspectRatio: payload.aspectRatio || '16:9',
        lyrics: (payload.lyrics || '').slice(0, 4000),
        previewNote: (payload.previewNote || '').slice(0, 400),
      })
      .returning();
    return rows[0];
  } catch (error) {
    console.error('Failed to save media item:', error);
    throw new Error('Could not save media creation record.', { cause: error });
  }
}

export async function listUserMapPins(uid: string) {
  try {
    const userRow = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
    if (!userRow[0]) return [];
    return await db
      .select()
      .from(mapPins)
      .where(eq(mapPins.userId, userRow[0].id))
      .orderBy(desc(mapPins.createdAt))
      .limit(60);
  } catch (error) {
    console.error('Failed to list map pins:', error);
    throw new Error('Could not load saved map pins.', { cause: error });
  }
}

export async function saveUserMapPin(
  userId: number,
  payload: {
    placeId?: string;
    name: string;
    address?: string;
    category: string;
    lat: number;
    lng: number;
    notes?: string;
  }
) {
  try {
    const rows = await db
      .insert(mapPins)
      .values({
        userId,
        placeId: payload.placeId || '',
        name: payload.name.slice(0, 180),
        address: (payload.address || '').slice(0, 280),
        category: payload.category || 'client_site',
        lat: payload.lat,
        lng: payload.lng,
        notes: (payload.notes || '').slice(0, 500),
      })
      .returning();
    return rows[0];
  } catch (error) {
    console.error('Failed to save map pin:', error);
    throw new Error('Could not save location pin.', { cause: error });
  }
}

export async function deleteUserMapPin(userId: number, id: number) {
  try {
    await db
      .delete(mapPins)
      .where(and(eq(mapPins.id, id), eq(mapPins.userId, userId)));
  } catch (error) {
    console.error('Failed to delete map pin:', error);
    throw new Error('Could not remove location pin.', { cause: error });
  }
}

export async function listTopGameScores(uid?: string) {
  try {
    const rawRows = await db
      .select({
        id: gameScores.id,
        score: gameScores.score,
        capsulesCollected: gameScores.capsulesCollected,
        distanceMeters: gameScores.distanceMeters,
        bestCombo: gameScores.bestCombo,
        createdAt: gameScores.createdAt,
        displayName: users.displayName,
        email: users.email,
      })
      .from(gameScores)
      .innerJoin(users, eq(gameScores.userId, users.id))
      .orderBy(desc(gameScores.score))
      .limit(10);

    // Strip raw email addresses so member leaderboards never expose PII
    const leaderboard = rawRows.map((row) => ({
      id: row.id,
      score: row.score,
      capsulesCollected: row.capsulesCollected,
      distanceMeters: row.distanceMeters,
      bestCombo: row.bestCombo,
      createdAt: row.createdAt,
      displayName:
        row.displayName?.trim() ||
        (row.email && !row.email.endsWith('@dispatch.local')
          ? row.email.split('@')[0]
          : 'Dispatch Runner'),
    }));

    let personalBest = 0;
    if (uid) {
      const userRow = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
      if (userRow[0]) {
        const bestRow = await db
          .select({ score: gameScores.score })
          .from(gameScores)
          .where(eq(gameScores.userId, userRow[0].id))
          .orderBy(desc(gameScores.score))
          .limit(1);
        personalBest = bestRow[0]?.score ?? 0;
      }
    }

    return { leaderboard, personalBest };
  } catch (error) {
    console.error('Failed to load game scores:', error);
    throw new Error('Could not load arcade leaderboard.', { cause: error });
  }
}

export async function saveUserGameScore(
  userId: number,
  payload: {
    score: number;
    capsulesCollected: number;
    distanceMeters: number;
    bestCombo: number;
  }
) {
  try {
    const rows = await db
      .insert(gameScores)
      .values({
        userId,
        score: Math.max(0, Math.round(payload.score)),
        capsulesCollected: Math.max(0, Math.round(payload.capsulesCollected)),
        distanceMeters: Math.max(0, Math.round(payload.distanceMeters)),
        bestCombo: Math.max(1, Math.round(payload.bestCombo)),
      })
      .returning();
    return rows[0];
  } catch (error) {
    console.error('Failed to save game score:', error);
    throw new Error('Could not record arcade score.', { cause: error });
  }
}

export async function listUserSavedMockups(uid: string) {
  try {
    const userRow = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
    if (!userRow[0]) return [];
    return await db
      .select({
        id: savedMockups.id,
        versionNumber: savedMockups.versionNumber,
        label: savedMockups.label,
        changeNote: savedMockups.changeNote,
        brandName: savedMockups.brandName,
        headlinePreview: savedMockups.headlinePreview,
        primaryColor: savedMockups.primaryColor,
        accentColor: savedMockups.accentColor,
        canvasMode: savedMockups.canvasMode,
        assetCount: savedMockups.assetCount,
        contentHash: savedMockups.contentHash,
        sourceUrl: savedMockups.sourceUrl,
        updatedAt: savedMockups.updatedAt,
      })
      .from(savedMockups)
      .where(eq(savedMockups.userId, userRow[0].id))
      .orderBy(desc(savedMockups.updatedAt), desc(savedMockups.id))
      .limit(50);
  } catch (error) {
    console.error('Failed to list saved mockups:', error);
    throw new Error('Could not load saved mockup versions.', { cause: error });
  }
}

export async function getUserMockupById(uid: string, id: number) {
  try {
    const userRow = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
    if (!userRow[0]) return null;
    const rows = await db
      .select({
        id: savedMockups.id,
        versionNumber: savedMockups.versionNumber,
        label: savedMockups.label,
        changeNote: savedMockups.changeNote,
        brandName: savedMockups.brandName,
        headlinePreview: savedMockups.headlinePreview,
        primaryColor: savedMockups.primaryColor,
        accentColor: savedMockups.accentColor,
        canvasMode: savedMockups.canvasMode,
        assetCount: savedMockups.assetCount,
        contentHash: savedMockups.contentHash,
        sourceUrl: savedMockups.sourceUrl,
        projectJson: savedMockups.projectJson,
        updatedAt: savedMockups.updatedAt,
      })
      .from(savedMockups)
      .where(and(eq(savedMockups.id, id), eq(savedMockups.userId, userRow[0].id)))
      .limit(1);
    return rows[0] ?? null;
  } catch (error) {
    console.error('Failed to get mockup version by id:', error);
    throw new Error('Could not load that mockup iteration.', { cause: error });
  }
}

export async function saveUserMockup(
  userId: number,
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
) {
  try {
    const maxRow = await db
      .select({ maxVer: max(savedMockups.versionNumber) })
      .from(savedMockups)
      .where(eq(savedMockups.userId, userId));
    const nextVersionNumber = (maxRow[0]?.maxVer ?? 0) + 1;
    const cleanBrand = (payload.brandName || '').trim().slice(0, 140);
    const resolvedLabel =
      (payload.label || '').trim().slice(0, 120) ||
      (cleanBrand ? `${cleanBrand} · v${nextVersionNumber}` : `Iteration v${nextVersionNumber}`);

    const rows = await db
      .insert(savedMockups)
      .values({
        userId,
        versionNumber: nextVersionNumber,
        label: resolvedLabel,
        changeNote: (payload.changeNote || '').trim().slice(0, 280),
        brandName: cleanBrand,
        headlinePreview: (payload.headlinePreview || '').trim().slice(0, 200),
        primaryColor: (payload.primaryColor || '#1E3A5F').trim().slice(0, 32),
        accentColor: (payload.accentColor || '#22D3EE').trim().slice(0, 32),
        canvasMode: payload.canvasMode === 'dark' ? 'dark' : 'light',
        assetCount: Math.max(0, Math.round(Number(payload.assetCount) || 0)),
        contentHash: (payload.contentHash || '').trim().slice(0, 64),
        sourceUrl: (payload.sourceUrl || '').trim().slice(0, 300),
        projectJson: payload.projectJson,
      })
      .returning();
    return rows[0];
  } catch (error) {
    console.error('Failed to save mockup:', error);
    throw new Error('Could not save mockup iteration.', { cause: error });
  }
}

export async function updateUserMockupMeta(
  userId: number,
  id: number,
  payload: { label: string; changeNote?: string }
) {
  try {
    const rows = await db
      .update(savedMockups)
      .set({
        label: payload.label.trim().slice(0, 120),
        ...(typeof payload.changeNote === 'string'
          ? { changeNote: payload.changeNote.trim().slice(0, 280) }
          : {}),
      })
      .where(and(eq(savedMockups.id, id), eq(savedMockups.userId, userId)))
      .returning({
        id: savedMockups.id,
        versionNumber: savedMockups.versionNumber,
        label: savedMockups.label,
        changeNote: savedMockups.changeNote,
        brandName: savedMockups.brandName,
        headlinePreview: savedMockups.headlinePreview,
        primaryColor: savedMockups.primaryColor,
        accentColor: savedMockups.accentColor,
        canvasMode: savedMockups.canvasMode,
        assetCount: savedMockups.assetCount,
        contentHash: savedMockups.contentHash,
        sourceUrl: savedMockups.sourceUrl,
        updatedAt: savedMockups.updatedAt,
      });
    return rows[0] ?? null;
  } catch (error) {
    console.error('Failed to update mockup metadata:', error);
    throw new Error('Could not update version details.', { cause: error });
  }
}

export async function deleteUserMockup(userId: number, id: number) {
  try {
    await db
      .delete(savedMockups)
      .where(and(eq(savedMockups.id, id), eq(savedMockups.userId, userId)));
  } catch (error) {
    console.error('Failed to delete cloud mockup:', error);
    throw new Error('Could not delete mockup iteration.', { cause: error });
  }
}

// ---------- Ultra Owner & Admin Audit Queries ----------

export interface AuditedUserSummary {
  id: number;
  uid: string;
  email: string;
  displayName: string;
  photoUrl: string;
  role: UserRole;
  emailVerified: boolean;
  authProvider: string;
  accountStatus: AccountStatus;
  sessionState: UserSessionState;
  loginCount: number;
  lastLoginAt: Date;
  lastActiveAt: Date;
  lastTokenIssuedAt: Date | null;
  sessionRevokedAfter: Date | null;
  lastSeenDevice: string;
  lastSeenIp: string;
  recentIps: string[];
  recentDevices: string[];
  accessPattern: SessionAccessPatternAssessment;
  createdAt: Date;
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

export interface AuditActivityLogItem {
  id: string;
  userId: number | null;
  actorEmail: string;
  actorName: string;
  actorRole: UserRole | 'guest';
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
  createdAt: Date;
}

export async function listUsersWithAuditMetrics(): Promise<AuditedUserSummary[]> {
  try {
    const [
      allUsers,
      chatCounts,
      transcriptCounts,
      mediaCounts,
      pinCounts,
      mockupCounts,
      scoreCounts,
      logCounts,
      recentSessionLogs,
    ] = await Promise.all([
      db.select().from(users).orderBy(desc(users.lastActiveAt), desc(users.id)).limit(250),
      db
        .select({ userId: chatMessages.userId, total: count() })
        .from(chatMessages)
        .groupBy(chatMessages.userId),
      db
        .select({ userId: transcriptions.userId, total: count() })
        .from(transcriptions)
        .groupBy(transcriptions.userId),
      db
        .select({ userId: mediaItems.userId, total: count() })
        .from(mediaItems)
        .groupBy(mediaItems.userId),
      db
        .select({ userId: mapPins.userId, total: count() })
        .from(mapPins)
        .groupBy(mapPins.userId),
      db
        .select({ userId: savedMockups.userId, total: count() })
        .from(savedMockups)
        .groupBy(savedMockups.userId),
      db
        .select({ userId: gameScores.userId, total: count() })
        .from(gameScores)
        .groupBy(gameScores.userId),
      db
        .select({ userId: userActivityLogs.userId, total: count() })
        .from(userActivityLogs)
        .groupBy(userActivityLogs.userId),
      db
        .select({
          userId: userActivityLogs.userId,
          action: userActivityLogs.action,
          clientContext: userActivityLogs.clientContext,
          metadataJson: userActivityLogs.metadataJson,
          createdAt: userActivityLogs.createdAt,
        })
        .from(userActivityLogs)
        .orderBy(desc(userActivityLogs.createdAt), desc(userActivityLogs.id))
        .limit(450),
    ]);

    const toMap = (rows: Array<{ userId: number | null; total: number }>) => {
      const m = new Map<number, number>();
      for (const r of rows) {
        if (typeof r.userId === 'number') {
          m.set(r.userId, Number(r.total) || 0);
        }
      }
      return m;
    };

    const chatMap = toMap(chatCounts);
    const transcriptMap = toMap(transcriptCounts);
    const mediaMap = toMap(mediaCounts);
    const pinMap = toMap(pinCounts);
    const mockupMap = toMap(mockupCounts);
    const scoreMap = toMap(scoreCounts);
    const logMap = toMap(logCounts);

    const nowMs = Date.now();
    const window24hMs = 24 * 3600 * 1000;
    const window7dMs = 7 * 24 * 3600 * 1000;

    interface UserLogRollup {
      recentIps: string[];
      recentDevices: string[];
      ips24h: Set<string>;
      devices24h: Set<string>;
      blockedAttempts7d: number;
    }

    const telemetryByUserId = new Map<number, UserLogRollup>();
    for (const logRow of recentSessionLogs) {
      if (typeof logRow.userId !== 'number') continue;
      let rollup = telemetryByUserId.get(logRow.userId);
      if (!rollup) {
        rollup = {
          recentIps: [],
          recentDevices: [],
          ips24h: new Set<string>(),
          devices24h: new Set<string>(),
          blockedAttempts7d: 0,
        };
        telemetryByUserId.set(logRow.userId, rollup);
      }

      const meta = safeParseMetadataJson(logRow.metadataJson);
      const parsed = parseClientContextTelemetry(logRow.clientContext, meta);
      const createdMs = logRow.createdAt ? new Date(logRow.createdAt).getTime() : 0;
      const isWithin24h = Number.isFinite(createdMs) && nowMs - createdMs <= window24hMs;
      const isWithin7d = Number.isFinite(createdMs) && nowMs - createdMs <= window7dMs;

      if (parsed.ip && !rollup.recentIps.includes(parsed.ip) && rollup.recentIps.length < 5) {
        rollup.recentIps.push(parsed.ip);
      }
      if (
        parsed.device &&
        !rollup.recentDevices.includes(parsed.device) &&
        rollup.recentDevices.length < 5
      ) {
        rollup.recentDevices.push(parsed.device);
      }

      if (isWithin24h) {
        if (parsed.ip) rollup.ips24h.add(parsed.ip);
        if (parsed.device) rollup.devices24h.add(parsed.device);
      }
      if (isWithin7d && logRow.action === 'auth.blocked_suspended') {
        rollup.blockedAttempts7d += 1;
      }
    }

    const roleRank: Record<UserRole, number> = {
      owner: 0,
      admin: 1,
      member: 2,
    };

    return allUsers
      .map((u) => {
        const isPrincipal = u.email.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL;
        const effectiveRole: UserRole = isPrincipal
          ? 'owner'
          : normalizeUserRole(u.role);
        const effectiveStatus: AccountStatus = isPrincipal
          ? 'active'
          : normalizeAccountStatus(u.accountStatus);
        const effectiveVerified = Boolean(u.emailVerified || isPrincipal);
        const lastActiveAt = u.lastActiveAt || u.lastLoginAt || u.createdAt;
        const effectiveRevokedAfter = isPrincipal ? null : u.sessionRevokedAfter ?? null;
        const sessionState = computeUserSessionState(
          effectiveStatus,
          lastActiveAt,
          effectiveRevokedAfter
        );

        const rollup = telemetryByUserId.get(u.id);
        const storedDevice = (u.lastSeenDevice || '').trim();
        const storedIp = (u.lastSeenIp || '').trim();

        const recentIps: string[] = [];
        if (storedIp) recentIps.push(storedIp);
        if (rollup) {
          for (const ip of rollup.recentIps) {
            if (!recentIps.includes(ip) && recentIps.length < 5) {
              recentIps.push(ip);
            }
          }
        }

        const recentDevices: string[] = [];
        if (storedDevice) recentDevices.push(storedDevice);
        if (rollup) {
          for (const dev of rollup.recentDevices) {
            if (!recentDevices.includes(dev) && recentDevices.length < 5) {
              recentDevices.push(dev);
            }
          }
        }

        const lastSeenDevice = recentDevices[0] || 'Web Client';
        const lastSeenIp = recentIps[0] || 'Not recorded yet';

        const activeAgeMs = nowMs - new Date(lastActiveAt).getTime();
        const ips24h = new Set<string>(rollup ? Array.from(rollup.ips24h) : []);
        const devices24h = new Set<string>(rollup ? Array.from(rollup.devices24h) : []);
        if (Number.isFinite(activeAgeMs) && activeAgeMs <= window24hMs) {
          if (storedIp) ips24h.add(storedIp);
          if (storedDevice) devices24h.add(storedDevice);
        }

        const criticalReasons: string[] = [];
        const elevatedReasons: string[] = [];
        const blocked7d = rollup?.blockedAttempts7d ?? 0;

        if (blocked7d > 0) {
          criticalReasons.push(
            `${blocked7d} blocked access ${blocked7d === 1 ? 'attempt' : 'attempts'} while suspended`
          );
        }
        if (ips24h.size >= 3) {
          criticalReasons.push(`${ips24h.size} distinct IP addresses in 24h`);
        } else if (ips24h.size === 2) {
          elevatedReasons.push('2 distinct IP addresses in 24h');
        }

        if (devices24h.size >= 2) {
          elevatedReasons.push(`${devices24h.size} device/OS profiles in 24h`);
        }
        if (
          !effectiveVerified &&
          effectiveStatus === 'active' &&
          (sessionState === 'active_now' || sessionState === 'recent_24h')
        ) {
          elevatedReasons.push('Active session with unverified email token');
        }

        const level: SessionAccessPatternLevel =
          criticalReasons.length > 0
            ? 'critical'
            : elevatedReasons.length > 0
              ? 'elevated'
              : 'nominal';
        const reasons =
          level === 'nominal'
            ? ['Consistent device & IP posture']
            : [...criticalReasons, ...elevatedReasons];

        const accessPattern: SessionAccessPatternAssessment = {
          flagged: level !== 'nominal',
          level,
          label:
            level === 'critical'
              ? 'Critical Access Pattern'
              : level === 'elevated'
                ? 'Unusual Access Pattern'
                : 'Consistent Posture',
          reasons,
          distinctIps24h: ips24h.size,
          distinctDevices24h: devices24h.size,
        };

        const chatTotal = chatMap.get(u.id) ?? 0;
        const transcriptTotal = transcriptMap.get(u.id) ?? 0;
        const mediaTotal = mediaMap.get(u.id) ?? 0;
        const pinTotal = pinMap.get(u.id) ?? 0;
        const mockupTotal = mockupMap.get(u.id) ?? 0;
        const scoreTotal = scoreMap.get(u.id) ?? 0;
        const explicitLogs = logMap.get(u.id) ?? 0;

        // Include historical workspace actions if they predate user_activity_logs
        const totalActivityEstimate = Math.max(
          explicitLogs,
          1 + chatTotal + transcriptTotal + mediaTotal + pinTotal + mockupTotal + scoreTotal
        );

        return {
          id: u.id,
          uid: u.uid,
          email: u.email,
          displayName: u.displayName,
          photoUrl: u.photoUrl,
          role: effectiveRole,
          emailVerified: effectiveVerified,
          authProvider: u.authProvider || 'google.com',
          accountStatus: effectiveStatus,
          sessionState,
          loginCount: Math.max(1, u.loginCount || 1),
          lastLoginAt: u.lastLoginAt,
          lastActiveAt,
          lastTokenIssuedAt: u.lastTokenIssuedAt ?? null,
          sessionRevokedAfter: effectiveRevokedAfter,
          lastSeenDevice,
          lastSeenIp,
          recentIps,
          recentDevices,
          accessPattern,
          createdAt: u.createdAt,
          counts: {
            chatMessages: chatTotal,
            transcriptions: transcriptTotal,
            mediaItems: mediaTotal,
            mapPins: pinTotal,
            savedMockups: mockupTotal,
            gameRuns: scoreTotal,
            activityLogs: totalActivityEstimate,
          },
        };
      })
      .sort((a, b) => {
        if (roleRank[a.role] !== roleRank[b.role]) {
          return roleRank[a.role] - roleRank[b.role];
        }
        return new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime();
      });
  } catch (error) {
    console.error('Failed to list audited users:', error);
    throw new Error('Could not load studio user directory.', { cause: error });
  }
}

export interface ListActivityLogsFilter {
  userId?: number;
  domain?: string;
  category?: string;
  authStatus?: string;
  windowHours?: number;
  fromIso?: string;
  toIso?: string;
  sortOrder?: 'desc' | 'asc';
  search?: string;
  limit?: number;
}

export async function listUserActivityLogs(
  filter: ListActivityLogsFilter = {}
): Promise<AuditActivityLogItem[]> {
  try {
    const safeLimit = Math.min(2000, Math.max(10, Number(filter.limit) || 160));

    const [
      explicitLogs,
      allUsers,
      recentMockups,
      recentTranscriptions,
      recentMedia,
      recentPins,
      recentChats,
      recentScores,
    ] = await Promise.all([
      filter.userId
        ? db
            .select()
            .from(userActivityLogs)
            .where(eq(userActivityLogs.userId, filter.userId))
            .orderBy(desc(userActivityLogs.createdAt), desc(userActivityLogs.id))
            .limit(safeLimit)
        : db
            .select()
            .from(userActivityLogs)
            .orderBy(desc(userActivityLogs.createdAt), desc(userActivityLogs.id))
            .limit(safeLimit),
      db.select().from(users).limit(250),
      filter.userId
        ? db
            .select({
              id: savedMockups.id,
              userId: savedMockups.userId,
              label: savedMockups.label,
              versionNumber: savedMockups.versionNumber,
              updatedAt: savedMockups.updatedAt,
            })
            .from(savedMockups)
            .where(eq(savedMockups.userId, filter.userId))
            .orderBy(desc(savedMockups.updatedAt))
            .limit(40)
        : db
            .select({
              id: savedMockups.id,
              userId: savedMockups.userId,
              label: savedMockups.label,
              versionNumber: savedMockups.versionNumber,
              updatedAt: savedMockups.updatedAt,
            })
            .from(savedMockups)
            .orderBy(desc(savedMockups.updatedAt))
            .limit(40),
      filter.userId
        ? db
            .select({
              id: transcriptions.id,
              userId: transcriptions.userId,
              title: transcriptions.title,
              durationSeconds: transcriptions.durationSeconds,
              createdAt: transcriptions.createdAt,
            })
            .from(transcriptions)
            .where(eq(transcriptions.userId, filter.userId))
            .orderBy(desc(transcriptions.createdAt))
            .limit(40)
        : db
            .select({
              id: transcriptions.id,
              userId: transcriptions.userId,
              title: transcriptions.title,
              durationSeconds: transcriptions.durationSeconds,
              createdAt: transcriptions.createdAt,
            })
            .from(transcriptions)
            .orderBy(desc(transcriptions.createdAt))
            .limit(40),
      filter.userId
        ? db
            .select({
              id: mediaItems.id,
              userId: mediaItems.userId,
              kind: mediaItems.kind,
              modelId: mediaItems.modelId,
              prompt: mediaItems.prompt,
              createdAt: mediaItems.createdAt,
            })
            .from(mediaItems)
            .where(eq(mediaItems.userId, filter.userId))
            .orderBy(desc(mediaItems.createdAt))
            .limit(40)
        : db
            .select({
              id: mediaItems.id,
              userId: mediaItems.userId,
              kind: mediaItems.kind,
              modelId: mediaItems.modelId,
              prompt: mediaItems.prompt,
              createdAt: mediaItems.createdAt,
            })
            .from(mediaItems)
            .orderBy(desc(mediaItems.createdAt))
            .limit(40),
      filter.userId
        ? db
            .select({
              id: mapPins.id,
              userId: mapPins.userId,
              name: mapPins.name,
              category: mapPins.category,
              createdAt: mapPins.createdAt,
            })
            .from(mapPins)
            .where(eq(mapPins.userId, filter.userId))
            .orderBy(desc(mapPins.createdAt))
            .limit(40)
        : db
            .select({
              id: mapPins.id,
              userId: mapPins.userId,
              name: mapPins.name,
              category: mapPins.category,
              createdAt: mapPins.createdAt,
            })
            .from(mapPins)
            .orderBy(desc(mapPins.createdAt))
            .limit(40),
      filter.userId
        ? db
            .select({
              id: chatMessages.id,
              userId: chatMessages.userId,
              role: chatMessages.role,
              modelId: chatMessages.modelId,
              content: chatMessages.content,
              createdAt: chatMessages.createdAt,
            })
            .from(chatMessages)
            .where(and(eq(chatMessages.userId, filter.userId), eq(chatMessages.role, 'user')))
            .orderBy(desc(chatMessages.createdAt))
            .limit(40)
        : db
            .select({
              id: chatMessages.id,
              userId: chatMessages.userId,
              role: chatMessages.role,
              modelId: chatMessages.modelId,
              content: chatMessages.content,
              createdAt: chatMessages.createdAt,
            })
            .from(chatMessages)
            .where(eq(chatMessages.role, 'user'))
            .orderBy(desc(chatMessages.createdAt))
            .limit(40),
      filter.userId
        ? db
            .select({
              id: gameScores.id,
              userId: gameScores.userId,
              score: gameScores.score,
              distanceMeters: gameScores.distanceMeters,
              createdAt: gameScores.createdAt,
            })
            .from(gameScores)
            .where(eq(gameScores.userId, filter.userId))
            .orderBy(desc(gameScores.createdAt))
            .limit(30)
        : db
            .select({
              id: gameScores.id,
              userId: gameScores.userId,
              score: gameScores.score,
              distanceMeters: gameScores.distanceMeters,
              createdAt: gameScores.createdAt,
            })
            .from(gameScores)
            .orderBy(desc(gameScores.createdAt))
            .limit(30),
    ]);

    const userById = new Map(
      allUsers.map((u) => {
        const isPrincipal = u.email.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL;
        return [
          u.id,
          {
            ...u,
            effectiveRole: (isPrincipal
              ? 'owner'
              : normalizeUserRole(u.role)) as UserRole,
            effectiveVerified: Boolean(u.emailVerified || isPrincipal),
            effectiveStatus: isPrincipal
              ? 'active'
              : normalizeAccountStatus(u.accountStatus),
          },
        ];
      })
    );

    const seenResourceKeys = new Set<string>();
    const hasExplicitRegistrationForUser = new Set<number>();
    const latestExplicitSignInByUser = new Map<number, number>();
    let hasExplicitSystemConfigEvent = false;

    const merged: AuditActivityLogItem[] = explicitLogs.map((row) => {
      if (row.resourceType && row.resourceId) {
        seenResourceKeys.add(`${row.resourceType}:${row.resourceId}`);
      }
      if (row.action === 'auth.account_registered' && typeof row.userId === 'number') {
        hasExplicitRegistrationForUser.add(row.userId);
      }
      if (row.category === 'system_config' || row.action.startsWith('config.')) {
        hasExplicitSystemConfigEvent = true;
      }
      if (
        (row.action === 'auth.sign_in' || row.action === 'auth.blocked_suspended') &&
        typeof row.userId === 'number'
      ) {
        const ts = new Date(row.createdAt).getTime();
        const prev = latestExplicitSignInByUser.get(row.userId) ?? 0;
        if (ts > prev) latestExplicitSignInByUser.set(row.userId, ts);
      }
      const normalizedRole: UserRole | 'guest' =
        row.actorRole === 'owner' || row.actorRole === 'admin' || row.actorRole === 'member'
          ? row.actorRole
          : 'guest';
      const normalizedAuth: 'verified' | 'unverified' | 'suspended' =
        row.authStatus === 'suspended'
          ? 'suspended'
          : row.authStatus === 'unverified'
            ? 'unverified'
            : 'verified';
      const category = ((row.category as AuditLogCategory) || 'auth') as AuditLogCategory;
      const metadata = safeParseMetadataJson(row.metadataJson);
      const domain = classifyAuditAccountabilityDomain(category, row.action);
      const severity = classifyAuditSeverity(category, row.action, normalizedAuth, metadata);

      return {
        id: `log-${row.id}`,
        userId: row.userId ?? null,
        actorEmail: row.actorEmail,
        actorName: row.actorName,
        actorRole: normalizedRole,
        category,
        domain,
        severity,
        action: row.action,
        summary: row.summary,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        authStatus: normalizedAuth,
        clientContext: row.clientContext,
        metadata,
        createdAt: row.createdAt,
      };
    });

    const pushSynthesized = (
      userId: number,
      item: {
        id: string;
        category: AuditLogCategory;
        action: string;
        summary: string;
        resourceType: string;
        resourceId: string;
        clientContext: string;
        metadata?: Record<string, unknown>;
        createdAt: Date;
      }
    ) => {
      const actor = userById.get(userId);
      if (!actor) return;
      const dedupeKey = `${item.resourceType}:${item.resourceId}`;
      if (item.resourceType && item.resourceId && seenResourceKeys.has(dedupeKey)) {
        return;
      }
      seenResourceKeys.add(dedupeKey);
      const authStatus: 'verified' | 'unverified' | 'suspended' =
        actor.effectiveStatus === 'suspended'
          ? 'suspended'
          : actor.effectiveVerified
            ? 'verified'
            : 'unverified';
      const metadata = item.metadata ?? {};
      const domain = classifyAuditAccountabilityDomain(item.category, item.action);
      const severity = classifyAuditSeverity(item.category, item.action, authStatus, metadata);

      merged.push({
        ...item,
        userId,
        actorEmail: actor.email,
        actorName: actor.displayName,
        actorRole: actor.effectiveRole,
        domain,
        severity,
        authStatus,
        metadata,
      });
    };

    // Synthesize baseline studio system configuration initialization when no config event exists yet
    if (!hasExplicitSystemConfigEvent && !filter.userId) {
      const earliestUserCreatedMs = allUsers.reduce((minMs, u) => {
        const ts = u.createdAt ? new Date(u.createdAt).getTime() : Number.POSITIVE_INFINITY;
        return Number.isFinite(ts) && ts > 0 && ts < minMs ? ts : minMs;
      }, Number.POSITIVE_INFINITY);
      const anchorDate = Number.isFinite(earliestUserCreatedMs)
        ? new Date(Math.max(1000, earliestUserCreatedMs - 1000))
        : new Date();
      const principalRow = allUsers.find(
        (u) => u.email.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL
      );

      merged.push({
        id: 'syn-sysconfig-init',
        userId: principalRow?.id ?? null,
        actorEmail: principalRow?.email || PRINCIPAL_OWNER_EMAIL,
        actorName: principalRow?.displayName || 'Principal Owner',
        actorRole: 'owner',
        category: 'system_config',
        domain: 'system_config',
        severity: 'standard',
        action: 'config.initialized',
        summary:
          'Initialized studio system configuration (72h share TTL · Gemini 4 Hydrogen · 3D Adaptive Quality enabled · 180d audit retention)',
        resourceType: 'system_config',
        resourceId: 'studio_runtime',
        authStatus: 'verified',
        clientContext: 'Studio Runtime Bootstrap',
        metadata: {
          operation: 'config_init',
          settingKey: 'studio_runtime',
          defaultShareTtlHours: DEFAULT_STUDIO_SYSTEM_CONFIG.defaultShareTtlHours,
          defaultChatModel: DEFAULT_STUDIO_SYSTEM_CONFIG.defaultChatModel,
          adaptiveQualityDefault: DEFAULT_STUDIO_SYSTEM_CONFIG.adaptiveQualityDefault,
          requireVerifiedEmailForShares:
            DEFAULT_STUDIO_SYSTEM_CONFIG.requireVerifiedEmailForShares,
          auditRetentionDays: DEFAULT_STUDIO_SYSTEM_CONFIG.auditRetentionDays,
        },
        createdAt: anchorDate,
      });
    }

    // Synthesize historical account registration + latest login events for existing accounts
    for (const u of allUsers) {
      if (filter.userId && u.id !== filter.userId) continue;
      if (!hasExplicitRegistrationForUser.has(u.id)) {
        pushSynthesized(u.id, {
          id: `syn-reg-${u.id}`,
          category: 'auth',
          action: 'auth.account_registered',
          summary: `Registered studio account via ${u.authProvider || 'google.com'}`,
          resourceType: 'user',
          resourceId: String(u.id),
          clientContext: u.authProvider || 'google.com',
          metadata: {
            operation: 'account_register',
            table: 'users',
            uid: u.uid,
            authProvider: u.authProvider || 'google.com',
            emailVerified: Boolean(u.emailVerified),
            loginCount: 1,
            loginTimestampIso: new Date(u.createdAt).toISOString(),
            role: u.role,
          },
          createdAt: u.createdAt,
        });
      }

      const lastLoginMs = u.lastLoginAt ? new Date(u.lastLoginAt).getTime() : 0;
      const createdMs = u.createdAt ? new Date(u.createdAt).getTime() : 0;
      const latestExplicitMs = latestExplicitSignInByUser.get(u.id) ?? 0;
      const loginCount = Math.max(1, u.loginCount || 1);
      if (
        lastLoginMs > 0 &&
        (loginCount > 1 || Math.abs(lastLoginMs - createdMs) > 60 * 1000) &&
        Math.abs(lastLoginMs - latestExplicitMs) > 60 * 1000
      ) {
        pushSynthesized(u.id, {
          id: `syn-login-${u.id}`,
          category: 'auth',
          action: 'auth.sign_in',
          summary: `Authenticated studio session #${loginCount} via ${u.authProvider || 'google.com'}`,
          resourceType: 'session',
          resourceId: `latest-${u.id}`,
          clientContext: u.authProvider || 'google.com',
          metadata: {
            operation: 'sign_in',
            table: 'users',
            uid: u.uid,
            authProvider: u.authProvider || 'google.com',
            emailVerified: Boolean(u.emailVerified),
            loginCount,
            loginTimestampIso: new Date(u.lastLoginAt).toISOString(),
            tokenIssuedAtIso: u.lastTokenIssuedAt
              ? new Date(u.lastTokenIssuedAt).toISOString()
              : new Date(u.lastLoginAt).toISOString(),
            role: u.role,
          },
          createdAt: u.lastLoginAt,
        });
      }
    }

    for (const m of recentMockups) {
      pushSynthesized(m.userId, {
        id: `syn-mockup-${m.id}`,
        category: 'mockup',
        action: 'mockup.version_saved',
        summary: `Saved Site Mockup iteration "${m.label}" (v${m.versionNumber})`,
        resourceType: 'mockup',
        resourceId: String(m.id),
        clientContext: 'Site Mockup Workbench',
        metadata: {
          operation: 'insert',
          table: 'saved_mockups',
          mockupId: m.id,
          versionNumber: m.versionNumber,
          label: m.label,
        },
        createdAt: m.updatedAt,
      });
    }

    for (const t of recentTranscriptions) {
      pushSynthesized(t.userId, {
        id: `syn-tr-${t.id}`,
        category: 'ai_desk',
        action: 'transcription.saved',
        summary: `Saved audio transcription "${t.title}" (${t.durationSeconds}s)`,
        resourceType: 'transcription',
        resourceId: String(t.id),
        clientContext: 'AI Desk Transcriber',
        metadata: {
          operation: 'insert',
          table: 'transcriptions',
          transcriptionId: t.id,
          title: t.title,
          durationSeconds: t.durationSeconds,
        },
        createdAt: t.createdAt,
      });
    }

    for (const media of recentMedia) {
      pushSynthesized(media.userId, {
        id: `syn-media-${media.id}`,
        category: 'media_lab',
        action: 'media.saved',
        summary: `Generated ${media.kind} asset with ${media.modelId}: "${media.prompt.slice(0, 72)}"`,
        resourceType: 'media',
        resourceId: String(media.id),
        clientContext: 'Media Lab',
        metadata: {
          operation: 'insert',
          table: 'media_items',
          mediaId: media.id,
          kind: media.kind,
          modelId: media.modelId,
        },
        createdAt: media.createdAt,
      });
    }

    for (const pin of recentPins) {
      pushSynthesized(pin.userId, {
        id: `syn-pin-${pin.id}`,
        category: 'spatial',
        action: 'spatial.pin_saved',
        summary: `Saved ${pin.category.replace('_', ' ')} map pin "${pin.name}"`,
        resourceType: 'map_pin',
        resourceId: String(pin.id),
        clientContext: 'Spatial & Maps Hub',
        metadata: {
          operation: 'insert',
          table: 'map_pins',
          pinId: pin.id,
          name: pin.name,
          category: pin.category,
        },
        createdAt: pin.createdAt,
      });
    }

    for (const chat of recentChats) {
      pushSynthesized(chat.userId, {
        id: `syn-chat-${chat.id}`,
        category: 'ai_desk',
        action: 'chat.message_saved',
        summary: `Sent AI Desk prompt (${chat.modelId}): "${chat.content.slice(0, 72)}"`,
        resourceType: 'chat_message',
        resourceId: String(chat.id),
        clientContext: 'AI Desk',
        metadata: {
          operation: 'insert',
          table: 'chat_messages',
          messageId: chat.id,
          modelId: chat.modelId,
        },
        createdAt: chat.createdAt,
      });
    }

    for (const run of recentScores) {
      pushSynthesized(run.userId, {
        id: `syn-score-${run.id}`,
        category: 'spatial',
        action: 'spatial.score_recorded',
        summary: `Completed Dispatch Run 3D (${run.score.toLocaleString()} pts · ${run.distanceMeters}m)`,
        resourceType: 'game_score',
        resourceId: String(run.id),
        clientContext: 'Dispatch Run 3D',
        metadata: {
          operation: 'insert',
          table: 'game_scores',
          scoreId: run.id,
          score: run.score,
          distanceMeters: run.distanceMeters,
        },
        createdAt: run.createdAt,
      });
    }

    const q = (filter.search || '').trim().toLowerCase();
    const domainFilter =
      filter.domain && filter.domain !== 'all' ? filter.domain : null;
    const catFilter =
      filter.category && filter.category !== 'all' ? filter.category : null;
    const authFilter =
      filter.authStatus && filter.authStatus !== 'all' ? filter.authStatus : null;
    const windowMs =
      typeof filter.windowHours === 'number' &&
      Number.isFinite(filter.windowHours) &&
      filter.windowHours > 0
        ? filter.windowHours * 3600 * 1000
        : null;
    const fromMs =
      filter.fromIso && Number.isFinite(new Date(filter.fromIso).getTime())
        ? new Date(filter.fromIso).getTime()
        : null;
    const toMs =
      filter.toIso && Number.isFinite(new Date(filter.toIso).getTime())
        ? new Date(filter.toIso).getTime()
        : null;
    const sortAsc = filter.sortOrder === 'asc';
    const nowMs = Date.now();

    return merged
      .filter((item) => {
        if (domainFilter && item.domain !== domainFilter) return false;
        if (catFilter && item.category !== catFilter) return false;
        if (authFilter && item.authStatus !== authFilter) return false;
        const itemMs = new Date(item.createdAt).getTime();
        if (windowMs !== null) {
          if (!Number.isFinite(itemMs) || nowMs - itemMs > windowMs) return false;
        }
        if (fromMs !== null && (!Number.isFinite(itemMs) || itemMs < fromMs)) {
          return false;
        }
        if (toMs !== null && (!Number.isFinite(itemMs) || itemMs > toMs)) {
          return false;
        }
        if (!q) return true;
        const metadataStr = JSON.stringify(item.metadata || {}).toLowerCase();
        return (
          item.actorEmail.toLowerCase().includes(q) ||
          item.actorName.toLowerCase().includes(q) ||
          item.action.toLowerCase().includes(q) ||
          item.summary.toLowerCase().includes(q) ||
          item.resourceType.toLowerCase().includes(q) ||
          item.resourceId.toLowerCase().includes(q) ||
          item.clientContext.toLowerCase().includes(q) ||
          metadataStr.includes(q)
        );
      })
      .sort((a, b) => {
        const diff =
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        if (diff !== 0) {
          return sortAsc ? diff : -diff;
        }
        return sortAsc ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id);
      })
      .slice(0, safeLimit);
  } catch (error) {
    console.error('Failed to list user activity logs:', error);
    throw new Error('Could not load user activity audit logs.', { cause: error });
  }
}

function sanitizeStudioConfigObject(
  raw: Record<string, unknown>,
  fallbackUpdatedAt: string,
  fallbackUpdatedBy: string
): StudioSystemConfig {
  const ttlRaw = Number(raw.defaultShareTtlHours);
  const defaultShareTtlHours: 24 | 72 | 168 =
    ttlRaw === 24 || ttlRaw === 72 || ttlRaw === 168
      ? ttlRaw
      : DEFAULT_STUDIO_SYSTEM_CONFIG.defaultShareTtlHours;

  const modelRaw = String(raw.defaultChatModel || '');
  const defaultChatModel: SuiteDefaultChatModel =
    modelRaw === 'gemini-4-carbon' ||
    modelRaw === 'gemini-4-neon' ||
    modelRaw === 'gemini-4-hydrogen' ||
    modelRaw === 'gemini-3.1-flash-lite'
      ? modelRaw
      : DEFAULT_STUDIO_SYSTEM_CONFIG.defaultChatModel;

  const adaptiveQualityDefault =
    typeof raw.adaptiveQualityDefault === 'boolean'
      ? raw.adaptiveQualityDefault
      : DEFAULT_STUDIO_SYSTEM_CONFIG.adaptiveQualityDefault;

  const requireVerifiedEmailForShares =
    typeof raw.requireVerifiedEmailForShares === 'boolean'
      ? raw.requireVerifiedEmailForShares
      : DEFAULT_STUDIO_SYSTEM_CONFIG.requireVerifiedEmailForShares;

  const retentionRaw = Number(raw.auditRetentionDays);
  const auditRetentionDays: 90 | 180 | 365 =
    retentionRaw === 90 || retentionRaw === 180 || retentionRaw === 365
      ? retentionRaw
      : DEFAULT_STUDIO_SYSTEM_CONFIG.auditRetentionDays;

  return {
    defaultShareTtlHours,
    defaultChatModel,
    adaptiveQualityDefault,
    requireVerifiedEmailForShares,
    auditRetentionDays,
    updatedAt:
      typeof raw.updatedAt === 'string' && raw.updatedAt
        ? raw.updatedAt
        : fallbackUpdatedAt,
    updatedByEmail:
      typeof raw.updatedByEmail === 'string' && raw.updatedByEmail
        ? raw.updatedByEmail
        : fallbackUpdatedBy,
  };
}

export async function getStudioSystemConfig(): Promise<StudioSystemConfig> {
  try {
    const rows = await db
      .select()
      .from(userActivityLogs)
      .where(eq(userActivityLogs.action, 'config.system_updated'))
      .orderBy(desc(userActivityLogs.createdAt), desc(userActivityLogs.id))
      .limit(1);

    const latest = rows[0];
    if (!latest) {
      return {
        ...DEFAULT_STUDIO_SYSTEM_CONFIG,
        updatedAt: new Date().toISOString(),
      };
    }

    const parsedMeta = safeParseMetadataJson(latest.metadataJson);
    const nextConfigRaw =
      parsedMeta.nextConfig &&
      typeof parsedMeta.nextConfig === 'object' &&
      !Array.isArray(parsedMeta.nextConfig)
        ? (parsedMeta.nextConfig as Record<string, unknown>)
        : parsedMeta;

    return sanitizeStudioConfigObject(
      nextConfigRaw,
      new Date(latest.createdAt).toISOString(),
      latest.actorEmail || PRINCIPAL_OWNER_EMAIL
    );
  } catch (error) {
    console.error('Failed to read studio system config:', error);
    return {
      ...DEFAULT_STUDIO_SYSTEM_CONFIG,
      updatedAt: new Date().toISOString(),
    };
  }
}

export async function updateStudioSystemConfig(
  patch: Partial<{
    defaultShareTtlHours: 24 | 72 | 168;
    defaultChatModel: SuiteDefaultChatModel;
    adaptiveQualityDefault: boolean;
    requireVerifiedEmailForShares: boolean;
    auditRetentionDays: 90 | 180 | 365;
  }>,
  actor: {
    userId: number;
    email: string;
    displayName: string;
    role: UserRole;
  },
  clientContext = ''
): Promise<{
  config: StudioSystemConfig;
  changes: SystemConfigFieldDiff[];
  updated: boolean;
}> {
  const current = await getStudioSystemConfig();
  const nowIso = new Date().toISOString();
  const candidate = sanitizeStudioConfigObject(
    {
      ...current,
      ...patch,
      updatedAt: nowIso,
      updatedByEmail: actor.email,
    },
    nowIso,
    actor.email
  );

  const changes: SystemConfigFieldDiff[] = [];
  if (current.defaultShareTtlHours !== candidate.defaultShareTtlHours) {
    changes.push({
      key: 'defaultShareTtlHours',
      label: 'Default Share Link TTL',
      before: `${current.defaultShareTtlHours}h`,
      after: `${candidate.defaultShareTtlHours}h`,
    });
  }
  if (current.defaultChatModel !== candidate.defaultChatModel) {
    changes.push({
      key: 'defaultChatModel',
      label: 'Default AI Desk Model',
      before: current.defaultChatModel,
      after: candidate.defaultChatModel,
    });
  }
  if (current.adaptiveQualityDefault !== candidate.adaptiveQualityDefault) {
    changes.push({
      key: 'adaptiveQualityDefault',
      label: 'Spatial 3D Adaptive Quality Default',
      before: current.adaptiveQualityDefault ? 'enabled' : 'disabled',
      after: candidate.adaptiveQualityDefault ? 'enabled' : 'disabled',
    });
  }
  if (
    current.requireVerifiedEmailForShares !==
    candidate.requireVerifiedEmailForShares
  ) {
    changes.push({
      key: 'requireVerifiedEmailForShares',
      label: 'Verified Email Share Policy',
      before: current.requireVerifiedEmailForShares ? 'required' : 'optional',
      after: candidate.requireVerifiedEmailForShares ? 'required' : 'optional',
    });
  }
  if (current.auditRetentionDays !== candidate.auditRetentionDays) {
    changes.push({
      key: 'auditRetentionDays',
      label: 'Audit Log Retention Window',
      before: `${current.auditRetentionDays}d`,
      after: `${candidate.auditRetentionDays}d`,
    });
  }

  if (changes.length === 0) {
    return { config: current, changes: [], updated: false };
  }

  const diffPreview = changes
    .map((c) => `${c.label}: ${String(c.before)} → ${String(c.after)}`)
    .join(' · ');

  await recordUserActivityLog({
    userId: actor.userId,
    actorEmail: actor.email,
    actorName: actor.displayName,
    actorRole: actor.role,
    category: 'system_config',
    action: 'config.system_updated',
    summary: `Updated studio system configuration (${diffPreview})`,
    resourceType: 'system_config',
    resourceId: 'studio_runtime',
    authStatus: 'verified',
    clientContext,
    metadata: {
      operation: 'system_config_update',
      changedKeys: changes.map((c) => c.key),
      changes,
      previousValue:
        changes.length === 1
          ? `${changes[0].key}=${String(changes[0].before)}`
          : changes.map((c) => `${c.key}=${String(c.before)}`).join(', '),
      nextValue:
        changes.length === 1
          ? `${changes[0].key}=${String(changes[0].after)}`
          : changes.map((c) => `${c.key}=${String(c.after)}`).join(', '),
      securityPolicyRelaxed:
        current.requireVerifiedEmailForShares === true &&
        candidate.requireVerifiedEmailForShares === false,
      nextConfig: candidate,
    },
  });

  return { config: candidate, changes, updated: true };
}

export async function getUserAuditDetail(targetUserId: number) {
  const allUsers = await listUsersWithAuditMetrics();
  const userProfile = allUsers.find((u) => u.id === targetUserId) ?? null;
  if (!userProfile) return null;
  const logs = await listUserActivityLogs({ userId: targetUserId, limit: 100 });
  return {
    user: userProfile,
    logs,
  };
}

export async function getUserSnapshotById(targetUserId: number) {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateCollaboratorRole(
  targetUserId: number,
  nextRole: 'admin' | 'member'
) {
  try {
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);
    const target = existing[0];
    if (!target) {
      return null;
    }
    if (
      target.role === 'owner' ||
      target.email.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL
    ) {
      throw new Error('Principal Owner privileges are immutable and cannot be revoked.');
    }

    const updated = await db
      .update(users)
      .set({ role: nextRole })
      .where(eq(users.id, targetUserId))
      .returning();
    return updated[0] ?? null;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('Principal Owner privileges are immutable')
    ) {
      throw error;
    }
    console.error('Failed to update collaborator role:', error);
    throw new Error('Could not update member role.', { cause: error });
  }
}

export async function updateUserAccountStatus(
  targetUserId: number,
  nextStatus: AccountStatus,
  callerRole: UserRole
) {
  try {
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);
    const target = existing[0];
    if (!target) {
      return null;
    }
    if (
      target.role === 'owner' ||
      target.email.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL
    ) {
      throw new Error(
        'Principal Owner account status is immutable and cannot be suspended.'
      );
    }
    if (normalizeUserRole(target.role) === 'admin' && callerRole !== 'owner') {
      throw new Error(
        'Only the verified Principal Owner can suspend or reactivate a Studio Admin.'
      );
    }

    const updated = await db
      .update(users)
      .set({ accountStatus: nextStatus })
      .where(eq(users.id, targetUserId))
      .returning();
    return updated[0] ?? null;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('immutable') ||
        error.message.includes('Principal Owner'))
    ) {
      throw error;
    }
    console.error('Failed to update account status:', error);
    throw new Error('Could not update account status.', { cause: error });
  }
}

export async function forceLogoutUserSession(
  targetUserId: number,
  callerRole: UserRole
) {
  try {
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);
    const target = existing[0];
    if (!target) {
      return null;
    }
    if (
      target.role === 'owner' ||
      target.email.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL
    ) {
      throw new Error(
        'Principal Owner sessions are immutable and cannot be force-logged out.'
      );
    }
    if (normalizeUserRole(target.role) === 'admin' && callerRole !== 'owner') {
      throw new Error(
        'Only the verified Principal Owner can force-logout a Studio Admin session.'
      );
    }

    const revokedAt = new Date();
    const updated = await db
      .update(users)
      .set({
        sessionRevokedAfter: revokedAt,
      })
      .where(eq(users.id, targetUserId))
      .returning();
    return updated[0] ?? null;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('immutable') ||
        error.message.includes('Principal Owner'))
    ) {
      throw error;
    }
    console.error('Failed to force-logout user session:', error);
    throw new Error('Could not revoke user session.', { cause: error });
  }
}

export async function getPlatformAuditTotals() {
  try {
    const [
      allUsers,
      chatTotal,
      transcriptTotal,
      mediaTotal,
      pinTotal,
      mockupTotal,
      scoreTotal,
      logTotal,
    ] = await Promise.all([
      db.select().from(users),
      db.select({ total: count() }).from(chatMessages),
      db.select({ total: count() }).from(transcriptions),
      db.select({ total: count() }).from(mediaItems),
      db.select({ total: count() }).from(mapPins),
      db.select({ total: count() }).from(savedMockups),
      db.select({ total: count() }).from(gameScores),
      db.select({ total: count() }).from(userActivityLogs),
    ]);

    const nowMs = Date.now();
    let verifiedUsers = 0;
    let activeUsers24h = 0;
    let suspendedUsers = 0;

    for (const u of allUsers) {
      const isPrincipal = u.email.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL;
      const status = isPrincipal ? 'active' : normalizeAccountStatus(u.accountStatus);
      if (u.emailVerified || isPrincipal) verifiedUsers += 1;
      if (status === 'suspended') {
        suspendedUsers += 1;
      } else {
        const activeTs = new Date(
          u.lastActiveAt || u.lastLoginAt || u.createdAt
        ).getTime();
        if (Number.isFinite(activeTs) && nowMs - activeTs <= 24 * 3600 * 1000) {
          activeUsers24h += 1;
        }
      }
    }

    const chatCount = Number(chatTotal[0]?.total ?? 0);
    const transcriptCount = Number(transcriptTotal[0]?.total ?? 0);
    const mediaCount = Number(mediaTotal[0]?.total ?? 0);
    const pinCount = Number(pinTotal[0]?.total ?? 0);
    const mockupCount = Number(mockupTotal[0]?.total ?? 0);
    const gameCount = Number(scoreTotal[0]?.total ?? 0);
    const explicitLogCount = Number(logTotal[0]?.total ?? 0);

    return {
      users: allUsers.length,
      verifiedUsers,
      activeUsers24h,
      suspendedUsers,
      chatMessages: chatCount,
      transcriptions: transcriptCount,
      mediaItems: mediaCount,
      mapPins: pinCount,
      savedMockups: mockupCount,
      gameRuns: gameCount,
      activityLogs: Math.max(
        explicitLogCount,
        allUsers.length +
          chatCount +
          transcriptCount +
          mediaCount +
          pinCount +
          mockupCount +
          gameCount
      ),
    };
  } catch (error) {
    console.error('Failed to compute platform audit totals:', error);
    throw new Error('Could not load database summary metrics.', { cause: error });
  }
}

export interface CallerGoogleSignInMeta {
  uid: string;
  email: string;
  displayName: string;
  photoUrl: string;
  emailVerified: boolean;
  authProvider: string;
  tokenAuthTimeSec?: number;
  lastSeenDevice?: string;
  lastSeenIp?: string;
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
  expectedRole: UserRole;
  expectedIsOwner: boolean;
  storedAccountStatus: string;
  expectedAccountStatus: AccountStatus;
  sqlIssues: string[];
  sqlRepaired: boolean;
}

export async function scanAndRepairUsersMetadata(options: {
  mode: 'scan' | 'repair';
  targetUserId?: number;
  callerMeta: CallerGoogleSignInMeta;
}): Promise<{
  scannedCount: number;
  issueCount: number;
  repairedCount: number;
  users: SqlUserRepairDiagnostic[];
}> {
  try {
    const rawUsers = options.targetUserId
      ? await db
          .select()
          .from(users)
          .where(eq(users.id, options.targetUserId))
          .limit(1)
      : await db
          .select()
          .from(users)
          .orderBy(desc(users.lastActiveAt), desc(users.id))
          .limit(250);

    const diagnostics: SqlUserRepairDiagnostic[] = [];
    let issueCount = 0;
    let repairedCount = 0;
    const now = new Date();

    for (const u of rawUsers) {
      const isCallerRow = u.uid === options.callerMeta.uid;
      const effectiveEmail = (
        isCallerRow && options.callerMeta.email ? options.callerMeta.email : u.email
      ).trim();
      const effectiveVerified = isCallerRow
        ? options.callerMeta.emailVerified
        : Boolean(u.emailVerified);

      const isVerifiedPrincipal = Boolean(
        effectiveVerified && effectiveEmail.toLowerCase() === PRINCIPAL_OWNER_EMAIL
      );

      const sqlIssues: string[] = [];
      let expectedRole: UserRole;
      let expectedAccountStatus: AccountStatus;

      if (isVerifiedPrincipal) {
        expectedRole = 'owner';
        expectedAccountStatus = 'active';
        if (u.role !== 'owner') {
          sqlIssues.push(
            `Principal Owner role mis-flagged as "${u.role}" in Cloud SQL`
          );
        }
        if (normalizeAccountStatus(u.accountStatus) !== 'active') {
          sqlIssues.push(
            `Principal Owner status mis-flagged as "${u.accountStatus}" in Cloud SQL`
          );
        }
        if (!u.emailVerified) {
          sqlIssues.push('Principal Owner emailVerified flag was false in Cloud SQL');
        }
      } else {
        if (u.role === 'owner') {
          expectedRole = 'member';
          sqlIssues.push(
            'Non-principal account erroneously flagged with "owner" privileges in Cloud SQL'
          );
        } else {
          expectedRole = normalizeUserRole(u.role);
        }
        expectedAccountStatus = normalizeAccountStatus(u.accountStatus);
      }

      const nextDisplayName =
        isCallerRow && options.callerMeta.displayName.trim()
          ? options.callerMeta.displayName.trim().slice(0, 140)
          : u.displayName;
      const nextPhotoUrl =
        isCallerRow && options.callerMeta.photoUrl.trim()
          ? options.callerMeta.photoUrl.trim().slice(0, 2048)
          : u.photoUrl;
      const nextProvider =
        isCallerRow && options.callerMeta.authProvider.trim()
          ? options.callerMeta.authProvider.trim().slice(0, 64)
          : u.authProvider || 'google.com';

      if (isCallerRow) {
        if (u.email.trim().toLowerCase() !== effectiveEmail.toLowerCase()) {
          sqlIssues.push('Cloud SQL email differed from live Google Sign-In email');
        }
        if (
          !isVerifiedPrincipal &&
          Boolean(u.emailVerified) !== options.callerMeta.emailVerified
        ) {
          sqlIssues.push(
            'Cloud SQL emailVerified differed from live Google Sign-In token'
          );
        }
        if (
          options.callerMeta.displayName.trim() &&
          u.displayName.trim() !== nextDisplayName
        ) {
          sqlIssues.push('Display name out of sync with Google Sign-In profile');
        }
        if (options.callerMeta.photoUrl.trim() && u.photoUrl.trim() !== nextPhotoUrl) {
          sqlIssues.push('Profile photo URL out of sync with Google Sign-In profile');
        }
        if ((u.authProvider || 'google.com') !== nextProvider) {
          sqlIssues.push('Identity provider out of sync with Google Sign-In token');
        }
      }

      if (sqlIssues.length > 0) {
        issueCount += 1;
      }

      let sqlRepaired = false;
      if (options.mode === 'repair' && sqlIssues.length > 0) {
        const tokenIssuedDate =
          isCallerRow &&
          typeof options.callerMeta.tokenAuthTimeSec === 'number' &&
          options.callerMeta.tokenAuthTimeSec > 0
            ? new Date(options.callerMeta.tokenAuthTimeSec * 1000)
            : null;

        await db
          .update(users)
          .set({
            email: effectiveEmail,
            displayName: nextDisplayName,
            photoUrl: nextPhotoUrl,
            authProvider: nextProvider,
            emailVerified: isVerifiedPrincipal ? true : effectiveVerified,
            role: expectedRole,
            accountStatus: expectedAccountStatus,
            ...(isCallerRow ? { lastActiveAt: now } : {}),
            ...(tokenIssuedDate ? { lastTokenIssuedAt: tokenIssuedDate } : {}),
          })
          .where(eq(users.id, u.id));

        sqlRepaired = true;
        repairedCount += 1;
      }

      diagnostics.push({
        userId: u.id,
        uid: u.uid,
        email: options.mode === 'repair' ? effectiveEmail : u.email,
        displayName: options.mode === 'repair' ? nextDisplayName : u.displayName,
        photoUrl: options.mode === 'repair' ? nextPhotoUrl : u.photoUrl,
        authProvider: options.mode === 'repair' ? nextProvider : u.authProvider || 'google.com',
        emailVerified:
          options.mode === 'repair'
            ? isVerifiedPrincipal
              ? true
              : effectiveVerified
            : Boolean(u.emailVerified),
        storedRole: u.role,
        expectedRole,
        expectedIsOwner: expectedRole === 'owner',
        storedAccountStatus: u.accountStatus,
        expectedAccountStatus,
        sqlIssues,
        sqlRepaired,
      });
    }

    return {
      scannedCount: diagnostics.length,
      issueCount,
      repairedCount,
      users: diagnostics,
    };
  } catch (error) {
    console.error('Failed to scan/repair user metadata:', error);
    throw new Error('Could not complete user metadata repair scan.', { cause: error });
  }
}

export async function repairCallerOwnAuthRecord(
  callerMeta: CallerGoogleSignInMeta,
  clientContext = ''
) {
  const ensured = await getOrCreateUser(
    callerMeta.uid,
    callerMeta.email,
    callerMeta.displayName,
    callerMeta.photoUrl,
    callerMeta.emailVerified,
    {
      authProvider: callerMeta.authProvider,
      tokenAuthTimeSec: callerMeta.tokenAuthTimeSec,
      clientContext,
      lastSeenDevice: callerMeta.lastSeenDevice,
      lastSeenIp: callerMeta.lastSeenIp,
    }
  );

  const scanRes = await scanAndRepairUsersMetadata({
    mode: 'repair',
    targetUserId: ensured.id,
    callerMeta,
  });

  const refreshedRows = await db
    .select()
    .from(users)
    .where(eq(users.id, ensured.id))
    .limit(1);
  const finalUser = refreshedRows[0] ?? ensured;
  const diag = scanRes.users[0];

  await recordUserActivityLog({
    userId: finalUser.id,
    actorEmail: finalUser.email,
    actorName: finalUser.displayName,
    actorRole: finalUser.role,
    category: 'auth',
    action: 'auth.repair_synced',
    summary:
      diag && diag.sqlIssues.length > 0
        ? `Executed Repair Auth self-sync (${diag.sqlIssues.length} metadata ${diag.sqlIssues.length === 1 ? 'issue' : 'issues'} corrected · role: ${finalUser.role})`
        : `Verified Google Sign-In & profile sync via Repair Auth (role: ${finalUser.role})`,
    resourceType: 'user_auth',
    resourceId: String(finalUser.id),
    authStatus:
      finalUser.accountStatus === 'suspended'
        ? 'suspended'
        : finalUser.emailVerified
          ? 'verified'
          : 'unverified',
    clientContext,
    metadata: {
      operation: 'self_repair_auth',
      table: 'users',
      uid: finalUser.uid,
      previousRole: diag?.storedRole ?? finalUser.role,
      nextRole: finalUser.role,
      previousStatus: diag?.storedAccountStatus ?? finalUser.accountStatus,
      nextStatus: finalUser.accountStatus,
      issuesResolved: diag?.sqlIssues ?? [],
    },
  });

  return {
    user: finalUser,
    repaired: Boolean(diag?.sqlRepaired),
    sqlIssues: diag?.sqlIssues ?? [],
  };
}
