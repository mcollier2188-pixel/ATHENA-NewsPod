import type { Express, Request, Response } from 'express';
import type { GoogleGenAI } from '@google/genai';
import {
  describeClientContext,
  extractClientSessionTelemetry,
  extractTokenAuthMetadata,
  isVerifiedPrincipalToken,
  requireAuth,
  type AuthRequest,
} from '../middleware/auth.ts';
import {
  clearUserChatThread,
  DEFAULT_STUDIO_SYSTEM_CONFIG,
  deleteUserMapPin,
  deleteUserMockup,
  deleteUserTranscription,
  forceLogoutUserSession,
  getOrCreateUser,
  getPlatformAuditTotals,
  getStudioSystemConfig,
  getUserAuditDetail,
  getUserMockupById,
  getUserSnapshotById,
  listTopGameScores,
  listUserActivityLogs,
  listUserChatMessages,
  listUserChatThreads,
  listUserMapPins,
  listUserMediaItems,
  listUserSavedMockups,
  listUsersWithAuditMetrics,
  listUserTranscriptions,
  normalizeAccountStatus,
  normalizeUserRole,
  recordUserActivityLog,
  repairCallerOwnAuthRecord,
  saveUserChatMessage,
  saveUserGameScore,
  saveUserMapPin,
  saveUserMediaItem,
  saveUserMockup,
  saveUserTranscription,
  scanAndRepairUsersMetadata,
  SessionRevokedError,
  updateCollaboratorRole,
  updateStudioSystemConfig,
  updateUserAccountStatus,
  updateUserMockupMeta,
  type AuditedUserSummary,
  type StudioSystemConfig,
  type SuiteDefaultChatModel,
  type UserRole,
} from '../db/queries.ts';

export interface AuditedShareLink {
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

export interface ShareStorageSummary {
  activeShareCount: number;
  briefingShareCount: number;
  mockupShareCount: number;
  expiredPendingCount: number;
  totalShareBytes: number;
}

export interface RawServerShareSnapshot {
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

export interface ScrubAndRelinkServerFallback {
  ttlHours?: number;
  note?: string;
  creatorUid?: string;
  briefingManifest?: Record<string, unknown>;
  mockupProject?: Record<string, unknown>;
}

export interface ScrubAndRelinkServerResult {
  oldShareId: string;
  newShareId: string;
  newSharePath: string;
  kind: 'briefing' | 'mockup';
  createdAt: string;
  expiresAt: string;
  ttlHours: number;
  hadServerManifest: boolean;
}

export interface ShareGovernanceController {
  listActiveSharesAndFootprint: () => Promise<{
    shares: AuditedShareLink[];
    storage: ShareStorageSummary;
  }>;
  listRawShareSnapshots: () => Promise<RawServerShareSnapshot[]>;
  scrubAndRelinkShare: (
    kind: 'briefing' | 'mockup',
    oldShareId: string,
    fallbackPayload?: ScrubAndRelinkServerFallback
  ) => Promise<ScrubAndRelinkServerResult>;
  extendShare: (
    kind: 'briefing' | 'mockup',
    shareId: string,
    addHours: number
  ) => Promise<string>;
  revokeShareAsAdmin: (
    kind: 'briefing' | 'mockup',
    shareId: string
  ) => Promise<void>;
  purgeExpiredShares: () => Promise<{ purgedCount: number }>;
}

const ALLOWED_CHAT_MODELS = new Set([
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-4-hydrogen',
  'gemini-4-neon',
  'gemini-4-carbon',
]);

function buildChatFallbackModels(primaryModel: string): string[] {
  const ordered = [primaryModel, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
  return Array.from(new Set(ordered));
}

function shouldFallbackSuiteModel(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('404') ||
    msg.includes('NOT_FOUND') ||
    msg.includes('503') ||
    msg.includes('UNAVAILABLE')
  );
}

const ALLOWED_IMAGE_ASPECTS = new Set(['1:1', '16:9', '4:3', '9:16', '3:4']);
const ALLOWED_IMAGE_SIZES = new Set(['1K', '2K', '4K']);
const ALLOWED_VIDEO_ASPECTS = new Set(['16:9', '9:16']);
const ALLOWED_VIDEO_RESOLUTIONS = new Set(['360p', '720p', '1080p']);
const ALLOWED_MUSIC_MODELS = new Set(['lyria-3-clip-preview', 'lyria-3-pro-preview']);

let runtimeFallbackSystemConfig: StudioSystemConfig = {
  ...DEFAULT_STUDIO_SYSTEM_CONFIG,
};

function buildVerifiedTokenFallbackUser(
  req: AuthRequest
): Awaited<ReturnType<typeof getOrCreateUser>> {
  const decoded = req.user!;
  const tokenMeta = extractTokenAuthMetadata(decoded);
  const sessionTelemetry = extractClientSessionTelemetry(req);
  const isPrincipal = isVerifiedPrincipalToken(decoded);
  const now = new Date();
  const tokenDate =
    typeof tokenMeta.tokenAuthTimeSec === 'number' && tokenMeta.tokenAuthTimeSec > 0
      ? new Date(tokenMeta.tokenAuthTimeSec * 1000)
      : now;

  return {
    id: isPrincipal ? 1 : 2,
    uid: decoded.uid,
    email: decoded.email || `${decoded.uid}@dispatch.local`,
    displayName: typeof decoded.name === 'string' ? decoded.name : '',
    photoUrl: typeof decoded.picture === 'string' ? decoded.picture : '',
    role: isPrincipal ? 'owner' : 'member',
    emailVerified: tokenMeta.emailVerified,
    authProvider: tokenMeta.authProvider,
    accountStatus: 'active',
    loginCount: 1,
    lastLoginAt: now,
    lastActiveAt: now,
    lastTokenIssuedAt: tokenDate,
    sessionRevokedAfter: null,
    lastSeenDevice: sessionTelemetry.deviceSummary,
    lastSeenIp:
      sessionTelemetry.ipAddress !== 'Unknown IP' ? sessionTelemetry.ipAddress : '',
    createdAt: now,
  };
}

class AccountSuspendedError extends Error {
  constructor() {
    super('Account access has been suspended by a Studio Administrator.');
  }
}

async function syncAuthedUser(
  req: AuthRequest,
  opts: { isExplicitSignIn?: boolean; allowSuspended?: boolean } = {}
) {
  if (!req.user?.uid) {
    throw new Error('Unauthorized user session.');
  }
  const tokenMeta = extractTokenAuthMetadata(req.user);
  const sessionTelemetry = extractClientSessionTelemetry(req);

  let user: Awaited<ReturnType<typeof getOrCreateUser>>;
  try {
    user = await getOrCreateUser(
      req.user.uid,
      req.user.email || `${req.user.uid}@dispatch.local`,
      typeof req.user.name === 'string' ? req.user.name : '',
      typeof req.user.picture === 'string' ? req.user.picture : '',
      tokenMeta.emailVerified,
      {
        authProvider: tokenMeta.authProvider,
        tokenAuthTimeSec: tokenMeta.tokenAuthTimeSec,
        isExplicitSignIn: opts.isExplicitSignIn,
        clientContext: sessionTelemetry.clientContext,
        lastSeenDevice: sessionTelemetry.deviceSummary,
        lastSeenIp: sessionTelemetry.ipAddress,
      }
    );
  } catch (err) {
    if (err instanceof SessionRevokedError) {
      throw err;
    }
    // Preserve verified Firebase identity & Principal Ultra Owner privileges when deployed
    // to standalone Cloud Run instances without an attached Cloud SQL Unix socket.
    user = buildVerifiedTokenFallbackUser(req);
  }

  if (
    !opts.allowSuspended &&
    !isVerifiedPrincipalToken(req.user) &&
    normalizeAccountStatus(user.accountStatus) === 'suspended'
  ) {
    throw new AccountSuspendedError();
  }

  return user;
}

async function requireAdminOrOwnerCaller(
  req: AuthRequest,
  res: Response
): Promise<{
  user: Awaited<ReturnType<typeof getOrCreateUser>>;
  role: UserRole;
  clientContext: string;
} | null> {
  let currentUser: Awaited<ReturnType<typeof getOrCreateUser>>;
  try {
    currentUser = await syncAuthedUser(req, { allowSuspended: true });
  } catch (error: unknown) {
    if (error instanceof SessionRevokedError) {
      res.status(401).json({ error: error.message, code: error.code });
      return null;
    }
    throw error;
  }

  const isPrincipal = isVerifiedPrincipalToken(req.user);
  if (!isPrincipal && normalizeAccountStatus(currentUser.accountStatus) === 'suspended') {
    res.status(403).json({
      error: 'Forbidden: Your studio account is currently suspended.',
    });
    return null;
  }

  const role: UserRole = isPrincipal
    ? 'owner'
    : normalizeUserRole(currentUser.role);
  if (role !== 'owner' && role !== 'admin') {
    res.status(403).json({
      error:
        'Forbidden: Ultra Owner or Studio Admin privileges are required to access user audit and governance data.',
    });
    return null;
  }

  return {
    user: currentUser,
    role,
    clientContext: describeClientContext(req),
  };
}

function sendDbError(res: Response, error: unknown, fallbackMessage: string) {
  if (error instanceof SessionRevokedError) {
    res.status(401).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof AccountSuspendedError) {
    res.status(403).json({ error: error.message });
    return;
  }
  const msg = error instanceof Error ? error.message : fallbackMessage;
  res.status(500).json({ error: msg });
}

export function registerSuiteRoutes(
  app: Express,
  getGeminiClient: () => GoogleGenAI,
  formatApiError: (err: unknown) => { status: number; message: string },
  shareGovernance: ShareGovernanceController
) {
  // 1. Multi-model Gemini Chatbot (default gemini-3.5-flash-lite with automatic fallback to gemini-3.1-flash-lite)
  app.post('/api/suite/chat', async (req: Request, res: Response) => {
    try {
      const {
        model = 'gemini-3.5-flash-lite',
        systemInstruction,
        messages,
      } = req.body as {
        model?: string;
        systemInstruction?: string;
        messages?: Array<{ role: 'user' | 'model'; text: string }>;
      };

      const selectedModel = ALLOWED_CHAT_MODELS.has(model)
        ? model
        : 'gemini-3.5-flash-lite';

      if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: 'Provide at least one message to chat.' });
        return;
      }

      const latest = messages[messages.length - 1];
      if (!latest || latest.role !== 'user' || !latest.text?.trim()) {
        res.status(400).json({ error: 'The latest message must be a non-empty user prompt.' });
        return;
      }

      const ai = getGeminiClient();
      const history = messages.slice(0, -1).map((m) => ({
        role: m.role === 'model' ? 'model' : 'user',
        parts: [{ text: String(m.text || '') }],
      }));

      const candidateModels = buildChatFallbackModels(selectedModel);
      let reply = '';
      let usedModel = selectedModel;
      let lastErr: unknown;

      for (let i = 0; i < candidateModels.length; i++) {
        const candidateModel = candidateModels[i];
        try {
          const chat = ai.chats.create({
            model: candidateModel,
            history,
            config: {
              systemInstruction:
                systemInstruction?.trim() ||
                'You are a knowledgeable, crisp Dispatch studio assistant. Give clear, structured, actionable answers.',
            },
          });

          const response = await chat.sendMessage({
            message: latest.text.trim(),
          });

          reply = (response.text ?? '').trim();
          usedModel = candidateModel;
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          if (i < candidateModels.length - 1 && shouldFallbackSuiteModel(err)) {
            await new Promise((r) => setTimeout(r, 350));
            continue;
          }
          throw err;
        }
      }

      if (lastErr) {
        throw lastErr;
      }

      if (!reply) {
        res.status(502).json({ error: 'Model returned an empty response.' });
        return;
      }

      res.json({ reply, model: usedModel });
    } catch (err) {
      const { status, message } = formatApiError(err);
      res.status(status).json({ error: message });
    }
  });

  // 2. Audio Transcription (gemini-3.5-transcribe)
  app.post('/api/suite/transcribe', async (req: Request, res: Response) => {
    try {
      const { audioBase64, mimeType = 'audio/webm', prompt } = req.body as {
        audioBase64?: string;
        mimeType?: string;
        prompt?: string;
      };

      if (!audioBase64 || typeof audioBase64 !== 'string' || audioBase64.length < 32) {
        res.status(400).json({ error: 'Recorded or uploaded audio data is required.' });
        return;
      }

      const cleanBase64 = audioBase64.includes(',')
        ? audioBase64.split(',').pop() || ''
        : audioBase64;
      const safeMime =
        typeof mimeType === 'string' && mimeType.startsWith('audio/')
          ? mimeType.split(';')[0]
          : 'audio/webm';

      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: 'gemini-3.5-transcribe',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: safeMime,
                data: cleanBase64,
              },
            },
            {
              text:
                prompt?.trim() ||
                'Transcribe this audio accurately with clear punctuation and paragraph breaks.',
            },
          ],
        },
      });

      const transcript = (response.text ?? '').trim();
      if (!transcript) {
        res.status(422).json({ error: 'No speech could be transcribed from that audio clip.' });
        return;
      }

      res.json({ transcript, model: 'gemini-3.5-transcribe' });
    } catch (err) {
      const { status, message } = formatApiError(err);
      res.status(status).json({ error: message });
    }
  });

  // 3. Image Creation & Editing (gemini-nano-banana-2.1 via Interactions API)
  app.post('/api/suite/image', async (req: Request, res: Response) => {
    try {
      const {
        prompt,
        aspectRatio = '16:9',
        imageSize = '1K',
        sourceImageBase64,
        sourceMimeType = 'image/png',
      } = req.body as {
        prompt?: string;
        aspectRatio?: string;
        imageSize?: string;
        sourceImageBase64?: string;
        sourceMimeType?: string;
      };

      if (!prompt || !prompt.trim()) {
        res.status(400).json({ error: 'Enter a prompt to generate or edit an image.' });
        return;
      }

      const safeAspect = ALLOWED_IMAGE_ASPECTS.has(aspectRatio) ? aspectRatio : '16:9';
      const safeSize = ALLOWED_IMAGE_SIZES.has(imageSize) ? imageSize : '1K';
      const ai = getGeminiClient();

      const hasSourceImage =
        typeof sourceImageBase64 === 'string' && sourceImageBase64.length > 64;
      const cleanImageBase64 = hasSourceImage
        ? sourceImageBase64.includes(',')
          ? sourceImageBase64.split(',').pop() || ''
          : sourceImageBase64
        : '';

      const interaction = await ai.interactions.create({
        model: 'gemini-nano-banana-2.1',
        input: hasSourceImage
          ? [
              {
                type: 'image',
                data: cleanImageBase64,
                mime_type: sourceMimeType || 'image/png',
              },
              {
                type: 'text',
                text: prompt.trim(),
              },
            ]
          : prompt.trim(),
        response_modalities: ['image', 'text'],
        generation_config: {
          image_config: {
            aspect_ratio: safeAspect,
            image_size: safeSize,
          },
        },
      });

      let imageBase64 = '';
      let mimeType = 'image/png';
      let caption = '';

      if (interaction.output_image?.data) {
        imageBase64 = interaction.output_image.data;
        mimeType = interaction.output_image.mime_type || 'image/png';
      }

      if (!imageBase64 && Array.isArray(interaction.steps)) {
        for (const step of interaction.steps) {
          if (step.type === 'model_output' && Array.isArray(step.content)) {
            for (const c of step.content) {
              if (c.type === 'image' && c.data) {
                imageBase64 = c.data;
                mimeType = c.mime_type || 'image/png';
              } else if (c.type === 'text' && c.text) {
                caption += c.text;
              }
            }
          }
        }
      }

      if (!imageBase64) {
        res.status(502).json({
          error:
            caption.trim() ||
            'Image model did not return image bytes for that prompt. Try adjusting the description.',
        });
        return;
      }

      res.json({
        imageDataUrl: `data:${mimeType};base64,${imageBase64}`,
        mimeType,
        caption: caption.trim() || (interaction.output_text ?? '').trim(),
        model: 'gemini-nano-banana-2.1',
        aspectRatio: safeAspect,
      });
    } catch (err) {
      const { status, message } = formatApiError(err);
      res.status(status).json({ error: message });
    }
  });

  // 4. Text-to-Video & Image-to-Video (gemini-omni-1.2-flash via Interactions API)
  app.post('/api/suite/video', async (req: Request, res: Response) => {
    try {
      const {
        prompt,
        aspectRatio = '16:9',
        duration = '6s',
        resolution = '720p',
        sourceImageBase64,
        sourceMimeType = 'image/png',
      } = req.body as {
        prompt?: string;
        aspectRatio?: string;
        duration?: string;
        resolution?: string;
        sourceImageBase64?: string;
        sourceMimeType?: string;
      };

      if (!prompt || !prompt.trim()) {
        res.status(400).json({ error: 'Enter a motion prompt to generate a video.' });
        return;
      }

      const safeAspect = ALLOWED_VIDEO_ASPECTS.has(aspectRatio) ? aspectRatio : '16:9';
      const safeRes = ALLOWED_VIDEO_RESOLUTIONS.has(resolution) ? resolution : '720p';
      const durationNum = Math.min(10, Math.max(3, parseInt(duration, 10) || 6));
      const safeDuration = `${durationNum}s`;

      const hasSourceImage =
        typeof sourceImageBase64 === 'string' && sourceImageBase64.length > 64;
      const cleanImageBase64 = hasSourceImage
        ? sourceImageBase64.includes(',')
          ? sourceImageBase64.split(',').pop() || ''
          : sourceImageBase64
        : '';

      const ai = getGeminiClient();
      const interaction = await ai.interactions.create(
        {
          model: 'gemini-omni-1.2-flash',
          input: hasSourceImage
            ? [
                {
                  type: 'image',
                  mime_type: sourceMimeType || 'image/png',
                  data: cleanImageBase64,
                },
                {
                  type: 'text',
                  text: prompt.trim(),
                },
              ]
            : prompt.trim(),
          background: false,
          store: false,
          stream: false,
          response_format: {
            type: 'video',
            aspect_ratio: safeAspect,
            duration: safeDuration,
            resolution: safeRes,
          } as Record<string, unknown>,
        },
        { timeout: 300000 }
      );

      let videoBase64 = interaction.output_video?.data || '';
      let mimeType = interaction.output_video?.mime_type || 'video/mp4';

      if (!videoBase64 && Array.isArray(interaction.steps)) {
        for (const step of interaction.steps) {
          if (step.type === 'model_output' && Array.isArray(step.content)) {
            const vid = step.content.find((c) => c.type === 'video' && c.data);
            if (vid && vid.type === 'video' && vid.data) {
              videoBase64 = vid.data;
              mimeType = vid.mime_type || 'video/mp4';
            }
          }
        }
      }

      if (!videoBase64) {
        res.status(502).json({
          error: 'Video generation completed without returning video data. Please try another prompt.',
        });
        return;
      }

      res.json({
        videoBase64,
        mimeType,
        aspectRatio: safeAspect,
        duration: safeDuration,
        model: 'gemini-omni-1.2-flash',
      });
    } catch (err) {
      const { status, message } = formatApiError(err);
      res.status(status).json({ error: message });
    }
  });

  // 5. Music Generation (lyria-3-clip-preview / lyria-3-pro-preview)
  app.post('/api/suite/music', async (req: Request, res: Response) => {
    try {
      const {
        prompt,
        model = 'lyria-3-clip-preview',
        referenceImageBase64,
        referenceMimeType = 'image/jpeg',
      } = req.body as {
        prompt?: string;
        model?: string;
        referenceImageBase64?: string;
        referenceMimeType?: string;
      };

      if (!prompt || !prompt.trim()) {
        res.status(400).json({ error: 'Describe the mood, genre, or instrumentation for your music track.' });
        return;
      }

      const selectedModel = ALLOWED_MUSIC_MODELS.has(model)
        ? model
        : 'lyria-3-clip-preview';

      const hasImage =
        typeof referenceImageBase64 === 'string' && referenceImageBase64.length > 64;
      const cleanImageBase64 = hasImage
        ? referenceImageBase64.includes(',')
          ? referenceImageBase64.split(',').pop() || ''
          : referenceImageBase64
        : '';

      const ai = getGeminiClient();
      const responseStream = await ai.models.generateContentStream({
        model: selectedModel,
        contents: hasImage
          ? {
              parts: [
                { text: prompt.trim() },
                {
                  inlineData: {
                    data: cleanImageBase64,
                    mimeType: referenceMimeType || 'image/jpeg',
                  },
                },
              ],
            }
          : prompt.trim(),
      });

      const audioChunks: Buffer[] = [];
      let lyrics = '';
      let mimeType = 'audio/wav';

      for await (const chunk of responseStream) {
        const parts = chunk.candidates?.[0]?.content?.parts;
        if (!parts) continue;
        for (const part of parts) {
          if (part.inlineData?.data) {
            if (audioChunks.length === 0 && part.inlineData.mimeType) {
              mimeType = part.inlineData.mimeType;
            }
            audioChunks.push(Buffer.from(part.inlineData.data, 'base64'));
          }
          if (part.text && !lyrics) {
            lyrics = part.text;
          }
        }
      }

      if (audioChunks.length === 0) {
        res.status(502).json({
          error: 'Lyria did not return audio data for that prompt. Try simplifying or refining the musical prompt.',
        });
        return;
      }

      const combinedBase64 = Buffer.concat(audioChunks).toString('base64');
      res.json({
        audioBase64: combinedBase64,
        mimeType,
        lyrics: lyrics.trim(),
        model: selectedModel,
      });
    } catch (err) {
      const { status, message } = formatApiError(err);
      res.status(status).json({ error: message });
    }
  });

  app.get('/api/suite/runtime-config', async (_req: Request, res: Response) => {
    try {
      const config = await getStudioSystemConfig();
      runtimeFallbackSystemConfig = config;
      res.json({ config });
    } catch {
      res.json({ config: runtimeFallbackSystemConfig });
    }
  });

  // =========================================================================
  // Cloud SQL Persistence Routes (Protected by Firebase Auth ID Token)
  // =========================================================================

  app.get('/api/db/profile', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const isExplicitSignIn = req.query.event === 'signin';
      const user = await syncAuthedUser(req, {
        isExplicitSignIn,
        allowSuspended: true,
      });
      res.json({ user });
    } catch (error: unknown) {
      sendDbError(res, error, 'Could not load profile.');
    }
  });

  app.post('/api/db/auth-event', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req, { allowSuspended: true });
      const body = (req.body || {}) as { event?: string };
      const eventType =
        body.event === 'token_verified' ? 'token_verified' : 'sign_out';
      const sessionTelemetry = extractClientSessionTelemetry(req);

      await recordUserActivityLog({
        userId: user.id,
        actorEmail: user.email,
        actorName: user.displayName,
        actorRole: user.role,
        category: 'auth',
        action: eventType === 'sign_out' ? 'auth.sign_out' : 'auth.token_verified',
        summary:
          eventType === 'sign_out'
            ? `Signed out of studio session (${user.authProvider || 'google.com'})`
            : `Verified active Firebase ID token (${user.authProvider || 'google.com'})`,
        resourceType: 'session',
        resourceId: String(user.id),
        authStatus:
          normalizeAccountStatus(user.accountStatus) === 'suspended'
            ? 'suspended'
            : user.emailVerified
              ? 'verified'
              : 'unverified',
        clientContext: sessionTelemetry.clientContext,
        metadata: {
          operation: eventType,
          table: 'users',
          uid: user.uid,
          authProvider: user.authProvider || 'google.com',
          emailVerified: Boolean(user.emailVerified),
          loginCount: user.loginCount,
          eventTimestampIso: new Date().toISOString(),
          role: user.role,
          deviceSummary: sessionTelemetry.deviceSummary,
          ...(sessionTelemetry.ipAddress !== 'Unknown IP'
            ? { ipAddress: sessionTelemetry.ipAddress }
            : {}),
        },
      });

      res.json({ recorded: true });
    } catch (error: unknown) {
      sendDbError(res, error, 'Could not record authentication event.');
    }
  });

  app.post('/api/db/config-event', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req);
      const body = (req.body || {}) as {
        settingKey?: string;
        settingLabel?: string;
        previousValue?: string | number | boolean;
        nextValue?: string | number | boolean;
        subsystem?: string;
      };
      const settingKey = (body.settingKey || 'workspace.preference')
        .trim()
        .slice(0, 80);
      const settingLabel = (body.settingLabel || settingKey).trim().slice(0, 120);
      const prevStr = String(body.previousValue ?? '—').slice(0, 120);
      const nextStr = String(body.nextValue ?? '—').slice(0, 120);
      const subsystem = (body.subsystem || describeClientContext(req))
        .trim()
        .slice(0, 120);

      await recordUserActivityLog({
        userId: user.id,
        actorEmail: user.email,
        actorName: user.displayName,
        actorRole: user.role,
        category: 'system_config',
        action: 'config.preference_updated',
        summary: `Updated ${settingLabel} (${prevStr} → ${nextStr})`,
        resourceType: 'config_setting',
        resourceId: settingKey,
        authStatus: user.emailVerified ? 'verified' : 'unverified',
        clientContext: subsystem,
        metadata: {
          operation: 'config_preference_update',
          settingKey,
          settingLabel,
          previousValue: prevStr,
          nextValue: nextStr,
          subsystem,
        },
      });

      res.json({ recorded: true });
    } catch (error: unknown) {
      sendDbError(res, error, 'Could not record configuration audit event.');
    }
  });

  app.post('/api/db/repair-auth', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user?.uid) {
        res.status(401).json({ error: 'Unauthorized user session.' });
        return;
      }
      const tokenMeta = extractTokenAuthMetadata(req.user);
      const body = (req.body || {}) as { displayName?: string; photoUrl?: string };
      const displayName =
        typeof body.displayName === 'string' && body.displayName.trim()
          ? body.displayName.trim().slice(0, 140)
          : typeof req.user.name === 'string'
            ? req.user.name.slice(0, 140)
            : '';
      const photoUrl =
        typeof body.photoUrl === 'string' && body.photoUrl.trim()
          ? body.photoUrl.trim().slice(0, 2048)
          : typeof req.user.picture === 'string'
            ? req.user.picture.slice(0, 2048)
            : '';

      const sessionTelemetry = extractClientSessionTelemetry(req);
      try {
        const result = await repairCallerOwnAuthRecord(
          {
            uid: req.user.uid,
            email: req.user.email || `${req.user.uid}@dispatch.local`,
            displayName,
            photoUrl,
            emailVerified: tokenMeta.emailVerified,
            authProvider: tokenMeta.authProvider,
            tokenAuthTimeSec: tokenMeta.tokenAuthTimeSec,
            lastSeenDevice: sessionTelemetry.deviceSummary,
            lastSeenIp: sessionTelemetry.ipAddress,
          },
          sessionTelemetry.clientContext
        );

        res.json(result);
      } catch {
        const fallbackUser = buildVerifiedTokenFallbackUser(req);
        res.json({
          repaired: false,
          sqlIssues: [],
          user: fallbackUser,
        });
      }
    } catch (error: unknown) {
      sendDbError(res, error, 'Could not complete authentication repair.');
    }
  });

  app.get('/api/db/chat/threads', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req);
      const threads = await listUserChatThreads(user.uid);
      res.json({ threads });
    } catch (error: unknown) {
      sendDbError(res, error, 'Failed to load chat threads.');
    }
  });

  app.get('/api/db/chat', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req);
      const threadId =
        typeof req.query.threadId === 'string' && req.query.threadId.trim()
          ? req.query.threadId.trim()
          : 'default';
      const items = await listUserChatMessages(user.uid, threadId);
      res.json({ messages: items });
    } catch (error: unknown) {
      sendDbError(res, error, 'Failed to load chat history.');
    }
  });

  app.post('/api/db/chat', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req);
      const {
        threadId = 'default',
        role,
        modelId = 'gemini-3.5-flash-lite',
        persona = 'Managing Editor',
        content,
      } = req.body as {
        threadId?: string;
        role?: 'user' | 'model';
        modelId?: string;
        persona?: string;
        content?: string;
      };
      if (!content || (role !== 'user' && role !== 'model')) {
        res.status(400).json({ error: 'Valid role and content are required.' });
        return;
      }
      const saved = await saveUserChatMessage(user.id, {
        threadId,
        role,
        modelId,
        persona,
        content,
      });
      if (role === 'user') {
        await recordUserActivityLog({
          userId: user.id,
          actorEmail: user.email,
          actorName: user.displayName,
          actorRole: user.role,
          category: 'ai_desk',
          action: 'chat.message_saved',
          summary: `Sent AI Desk prompt (${modelId}): "${content.trim().slice(0, 72)}"`,
          resourceType: 'chat_message',
          resourceId: String(saved.id),
          authStatus: user.emailVerified ? 'verified' : 'unverified',
          clientContext: describeClientContext(req),
          metadata: {
            operation: 'insert',
            table: 'chat_messages',
            messageId: saved.id,
            threadId,
            modelId,
            persona,
          },
        });
      }
      res.json({ message: saved });
    } catch (error: unknown) {
      sendDbError(res, error, 'Failed to save message.');
    }
  });

  app.delete('/api/db/chat/:threadId', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req);
      const threadId = req.params.threadId || 'default';
      await clearUserChatThread(user.id, threadId);
      await recordUserActivityLog({
        userId: user.id,
        actorEmail: user.email,
        actorName: user.displayName,
        actorRole: user.role,
        category: 'ai_desk',
        action: 'chat.thread_cleared',
        summary: `Cleared AI Desk conversation thread "${threadId}"`,
        resourceType: 'chat_thread',
        resourceId: threadId,
        authStatus: user.emailVerified ? 'verified' : 'unverified',
        clientContext: describeClientContext(req),
        metadata: {
          operation: 'delete',
          table: 'chat_messages',
          threadId,
        },
      });
      res.json({ cleared: true });
    } catch (error: unknown) {
      sendDbError(res, error, 'Failed to clear thread.');
    }
  });

  app.get('/api/db/transcriptions', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req);
      const items = await listUserTranscriptions(user.uid);
      res.json({ transcriptions: items });
    } catch (error: unknown) {
      sendDbError(res, error, 'Failed to load transcriptions.');
    }
  });

  app.post('/api/db/transcriptions', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req);
      const { title, transcriptText, durationSeconds = 0, mimeType = 'audio/webm' } =
        req.body as {
          title?: string;
          transcriptText?: string;
          durationSeconds?: number;
          mimeType?: string;
        };
      if (!transcriptText?.trim()) {
        res.status(400).json({ error: 'Transcript text is required.' });
        return;
      }
      const cleanTitle = (title || 'Voice Note').trim().slice(0, 120);
      const saved = await saveUserTranscription(user.id, {
        title: cleanTitle,
        transcriptText: transcriptText.trim(),
        durationSeconds,
        mimeType,
      });
      await recordUserActivityLog({
        userId: user.id,
        actorEmail: user.email,
        actorName: user.displayName,
        actorRole: user.role,
        category: 'ai_desk',
        action: 'transcription.saved',
        summary: `Saved audio transcription "${cleanTitle}" (${Math.round(durationSeconds)}s)`,
        resourceType: 'transcription',
        resourceId: String(saved.id),
        authStatus: user.emailVerified ? 'verified' : 'unverified',
        clientContext: describeClientContext(req),
        metadata: {
          operation: 'insert',
          table: 'transcriptions',
          transcriptionId: saved.id,
          title: cleanTitle,
          durationSeconds: Math.round(durationSeconds),
          mimeType,
        },
      });
      res.json({ transcription: saved });
    } catch (error: unknown) {
      sendDbError(res, error, 'Failed to save transcription.');
    }
  });

  app.delete('/api/db/transcriptions/:id', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req);
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'Invalid transcription ID.' });
        return;
      }
      await deleteUserTranscription(user.id, id);
      await recordUserActivityLog({
        userId: user.id,
        actorEmail: user.email,
        actorName: user.displayName,
        actorRole: user.role,
        category: 'ai_desk',
        action: 'transcription.deleted',
        summary: `Deleted audio transcription #${id}`,
        resourceType: 'transcription',
        resourceId: String(id),
        authStatus: user.emailVerified ? 'verified' : 'unverified',
        clientContext: describeClientContext(req),
        metadata: {
          operation: 'delete',
          table: 'transcriptions',
          transcriptionId: id,
        },
      });
      res.json({ deleted: true });
    } catch (error: unknown) {
      sendDbError(res, error, 'Failed to delete transcription.');
    }
  });

  app.get('/api/db/media', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req);
      const items = await listUserMediaItems(user.uid);
      res.json({ items });
    } catch (error: unknown) {
      sendDbError(res, error, 'Failed to load media history.');
    }
  });

  app.post('/api/db/media', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req);
      const { kind, modelId, prompt, aspectRatio, lyrics, previewNote } = req.body as {
        kind?: 'image' | 'video' | 'music';
        modelId?: string;
        prompt?: string;
        aspectRatio?: string;
        lyrics?: string;
        previewNote?: string;
      };
      if (!kind || !modelId || !prompt) {
        res.status(400).json({ error: 'kind, modelId, and prompt are required.' });
        return;
      }
      const item = await saveUserMediaItem(user.id, {
        kind,
        modelId,
        prompt,
        aspectRatio,
        lyrics,
        previewNote,
      });
      await recordUserActivityLog({
        userId: user.id,
        actorEmail: user.email,
        actorName: user.displayName,
        actorRole: user.role,
        category: 'media_lab',
        action: 'media.saved',
        summary: `Generated ${kind} asset (${modelId}): "${prompt.trim().slice(0, 72)}"`,
        resourceType: 'media',
        resourceId: String(item.id),
        authStatus: user.emailVerified ? 'verified' : 'unverified',
        clientContext: describeClientContext(req),
        metadata: {
          operation: 'insert',
          table: 'media_items',
          mediaId: item.id,
          kind,
          modelId,
          aspectRatio: aspectRatio || '16:9',
        },
      });
      res.json({ item });
    } catch (error: unknown) {
      sendDbError(res, error, 'Failed to save media item.');
    }
  });

  app.get('/api/db/pins', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req);
      const pins = await listUserMapPins(user.uid);
      res.json({ pins });
    } catch (error: unknown) {
      sendDbError(res, error, 'Failed to load saved map pins.');
    }
  });

  app.post('/api/db/pins', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req);
      const { placeId, name, address, category = 'client_site', lat, lng, notes } =
        req.body as {
          placeId?: string;
          name?: string;
          address?: string;
          category?: string;
          lat?: number;
          lng?: number;
          notes?: string;
        };
      if (!name?.trim() || typeof lat !== 'number' || typeof lng !== 'number') {
        res.status(400).json({ error: 'Name and valid coordinates are required.' });
        return;
      }
      const pin = await saveUserMapPin(user.id, {
        placeId,
        name: name.trim(),
        address,
        category,
        lat,
        lng,
        notes,
      });
      await recordUserActivityLog({
        userId: user.id,
        actorEmail: user.email,
        actorName: user.displayName,
        actorRole: user.role,
        category: 'spatial',
        action: 'spatial.pin_saved',
        summary: `Saved ${category.replace('_', ' ')} map pin "${pin.name}"`,
        resourceType: 'map_pin',
        resourceId: String(pin.id),
        authStatus: user.emailVerified ? 'verified' : 'unverified',
        clientContext: describeClientContext(req),
        metadata: {
          operation: 'insert',
          table: 'map_pins',
          pinId: pin.id,
          name: pin.name,
          category,
          lat: Number(lat.toFixed(5)),
          lng: Number(lng.toFixed(5)),
        },
      });
      res.json({ pin });
    } catch (error: unknown) {
      sendDbError(res, error, 'Failed to save map pin.');
    }
  });

  app.delete('/api/db/pins/:id', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req);
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'Invalid pin ID.' });
        return;
      }
      await deleteUserMapPin(user.id, id);
      await recordUserActivityLog({
        userId: user.id,
        actorEmail: user.email,
        actorName: user.displayName,
        actorRole: user.role,
        category: 'spatial',
        action: 'spatial.pin_deleted',
        summary: `Removed saved map pin #${id}`,
        resourceType: 'map_pin',
        resourceId: String(id),
        authStatus: user.emailVerified ? 'verified' : 'unverified',
        clientContext: describeClientContext(req),
        metadata: {
          operation: 'delete',
          table: 'map_pins',
          pinId: id,
        },
      });
      res.json({ deleted: true });
    } catch (error: unknown) {
      sendDbError(res, error, 'Failed to delete map pin.');
    }
  });

  app.get('/api/db/scores', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req);
      const data = await listTopGameScores(user.uid);
      res.json(data);
    } catch (error: unknown) {
      sendDbError(res, error, 'Failed to load game scores.');
    }
  });

  app.post('/api/db/scores', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req);
      const { score, capsulesCollected = 0, distanceMeters = 0, bestCombo = 1 } =
        req.body as {
          score?: number;
          capsulesCollected?: number;
          distanceMeters?: number;
          bestCombo?: number;
        };
      if (typeof score !== 'number' || score < 0) {
        res.status(400).json({ error: 'Valid score is required.' });
        return;
      }
      const saved = await saveUserGameScore(user.id, {
        score,
        capsulesCollected,
        distanceMeters,
        bestCombo,
      });
      await recordUserActivityLog({
        userId: user.id,
        actorEmail: user.email,
        actorName: user.displayName,
        actorRole: user.role,
        category: 'spatial',
        action: 'spatial.score_recorded',
        summary: `Completed Dispatch Run 3D (${Math.round(score).toLocaleString()} pts · ${Math.round(distanceMeters)}m)`,
        resourceType: 'game_score',
        resourceId: String(saved.id),
        authStatus: user.emailVerified ? 'verified' : 'unverified',
        clientContext: describeClientContext(req),
        metadata: {
          operation: 'insert',
          table: 'game_scores',
          scoreId: saved.id,
          score: Math.round(score),
          distanceMeters: Math.round(distanceMeters),
          capsulesCollected: Math.round(capsulesCollected),
          bestCombo: Math.round(bestCombo),
        },
      });
      const updated = await listTopGameScores(user.uid);
      res.json({ saved, ...updated });
    } catch (error: unknown) {
      sendDbError(res, error, 'Failed to save game score.');
    }
  });

  app.get('/api/db/mockups', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req);
      const mockups = await listUserSavedMockups(user.uid);
      res.json({ mockups });
    } catch (error: unknown) {
      sendDbError(res, error, 'Failed to load saved versions.');
    }
  });

  app.get('/api/db/mockups/:id', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req);
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ error: 'Invalid mockup version ID.' });
        return;
      }
      const mockup = await getUserMockupById(user.uid, id);
      if (!mockup) {
        res.status(404).json({ error: 'Mockup iteration not found.' });
        return;
      }
      res.json({ mockup });
    } catch (error: unknown) {
      sendDbError(res, error, 'Failed to load mockup version.');
    }
  });

  app.post('/api/db/mockups', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req);
      const {
        label = '',
        changeNote = '',
        brandName,
        headlinePreview,
        primaryColor,
        accentColor,
        canvasMode,
        assetCount,
        contentHash = '',
        sourceUrl = '',
        projectJson,
      } = req.body as {
        label?: string;
        changeNote?: string;
        brandName?: string;
        headlinePreview?: string;
        primaryColor?: string;
        accentColor?: string;
        canvasMode?: string;
        assetCount?: number;
        contentHash?: string;
        sourceUrl?: string;
        projectJson?: string;
      };

      if (!projectJson || typeof projectJson !== 'string') {
        res.status(400).json({ error: 'Project snapshot data is required.' });
        return;
      }

      let parsedBrandName = typeof brandName === 'string' ? brandName : '';
      let parsedHeadline = typeof headlinePreview === 'string' ? headlinePreview : '';
      let parsedPrimary = typeof primaryColor === 'string' ? primaryColor : '#1E3A5F';
      let parsedAccent = typeof accentColor === 'string' ? accentColor : '#22D3EE';
      let parsedCanvasMode = typeof canvasMode === 'string' ? canvasMode : 'light';
      let parsedAssetCount = typeof assetCount === 'number' ? assetCount : 0;
      let parsedSourceUrl = typeof sourceUrl === 'string' ? sourceUrl : '';

      try {
        const parsed = JSON.parse(projectJson) as {
          sourceUrl?: string;
          brand?: {
            name?: string;
            logoDataUrl?: string;
            palette?: { primary?: string; accent?: string; canvasMode?: string };
          };
          hero?: { headline?: string; photoDataUrl?: string };
          projects?: Array<{ photoDataUrl?: string }>;
          mediaCollection?: unknown[];
        };
        if (!parsed || typeof parsed !== 'object' || !parsed.brand) {
          res.status(400).json({ error: 'Snapshot data must include valid mockup brand settings.' });
          return;
        }
        if (!parsedBrandName && parsed.brand.name) parsedBrandName = parsed.brand.name;
        if (!parsedHeadline && parsed.hero?.headline) parsedHeadline = parsed.hero.headline;
        if (parsed.brand.palette?.primary && !primaryColor) {
          parsedPrimary = parsed.brand.palette.primary;
        }
        if (parsed.brand.palette?.accent && !accentColor) {
          parsedAccent = parsed.brand.palette.accent;
        }
        if (parsed.brand.palette?.canvasMode && !canvasMode) {
          parsedCanvasMode = parsed.brand.palette.canvasMode;
        }
        if (!parsedSourceUrl && parsed.sourceUrl) parsedSourceUrl = parsed.sourceUrl;
        if (typeof assetCount !== 'number') {
          let count = 0;
          if (parsed.brand.logoDataUrl) count += 1;
          if (parsed.hero?.photoDataUrl) count += 1;
          if (Array.isArray(parsed.projects)) {
            count += parsed.projects.filter((p) => Boolean(p?.photoDataUrl)).length;
          }
          if (Array.isArray(parsed.mediaCollection)) {
            count += parsed.mediaCollection.length;
          }
          parsedAssetCount = count;
        }
      } catch {
        res.status(400).json({ error: 'Invalid mockup JSON snapshot.' });
        return;
      }

      const saved = await saveUserMockup(user.id, {
        label,
        changeNote,
        brandName: parsedBrandName,
        headlinePreview: parsedHeadline,
        primaryColor: parsedPrimary,
        accentColor: parsedAccent,
        canvasMode: parsedCanvasMode,
        assetCount: parsedAssetCount,
        contentHash,
        sourceUrl: parsedSourceUrl,
        projectJson,
      });
      await recordUserActivityLog({
        userId: user.id,
        actorEmail: user.email,
        actorName: user.displayName,
        actorRole: user.role,
        category: 'mockup',
        action: 'mockup.version_saved',
        summary: `Saved Site Mockup iteration "${saved.label}" (v${saved.versionNumber})`,
        resourceType: 'mockup',
        resourceId: String(saved.id),
        authStatus: user.emailVerified ? 'verified' : 'unverified',
        clientContext: describeClientContext(req),
        metadata: {
          operation: 'insert',
          table: 'saved_mockups',
          mockupId: saved.id,
          versionNumber: saved.versionNumber,
          label: saved.label,
          brandName: saved.brandName,
          canvasMode: saved.canvasMode,
          assetCount: saved.assetCount,
        },
      });
      res.json({ mockup: saved });
    } catch (error: unknown) {
      sendDbError(res, error, 'Failed to save mockup version.');
    }
  });

  app.patch('/api/db/mockups/:id', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req);
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ error: 'Invalid mockup version ID.' });
        return;
      }
      const { label, changeNote } = req.body as { label?: string; changeNote?: string };
      if (!label?.trim()) {
        res.status(400).json({ error: 'Version label cannot be empty.' });
        return;
      }
      const updated = await updateUserMockupMeta(user.id, id, {
        label: label.trim(),
        changeNote,
      });
      if (!updated) {
        res.status(404).json({ error: 'Mockup iteration not found.' });
        return;
      }
      await recordUserActivityLog({
        userId: user.id,
        actorEmail: user.email,
        actorName: user.displayName,
        actorRole: user.role,
        category: 'mockup',
        action: 'mockup.meta_updated',
        summary: `Renamed Site Mockup iteration #${id} to "${updated.label}"`,
        resourceType: 'mockup',
        resourceId: String(id),
        authStatus: user.emailVerified ? 'verified' : 'unverified',
        clientContext: describeClientContext(req),
        metadata: {
          operation: 'update',
          table: 'saved_mockups',
          mockupId: id,
          versionNumber: updated.versionNumber,
          nextLabel: updated.label,
        },
      });
      res.json({ mockup: updated });
    } catch (error: unknown) {
      sendDbError(res, error, 'Failed to update version details.');
    }
  });

  app.delete('/api/db/mockups/:id', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await syncAuthedUser(req);
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ error: 'Invalid mockup version ID.' });
        return;
      }
      await deleteUserMockup(user.id, id);
      await recordUserActivityLog({
        userId: user.id,
        actorEmail: user.email,
        actorName: user.displayName,
        actorRole: user.role,
        category: 'mockup',
        action: 'mockup.version_deleted',
        summary: `Deleted Site Mockup iteration #${id}`,
        resourceType: 'mockup',
        resourceId: String(id),
        authStatus: user.emailVerified ? 'verified' : 'unverified',
        clientContext: describeClientContext(req),
        metadata: {
          operation: 'delete',
          table: 'saved_mockups',
          mockupId: id,
        },
      });
      res.json({ deleted: true });
    } catch (error: unknown) {
      sendDbError(res, error, 'Failed to delete mockup version.');
    }
  });

  // =========================================================================
  // Ultra Owner & Admin Governance Routes (/api/owner/*)
  // =========================================================================

  app.get('/api/owner/overview', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const caller = await requireAdminOrOwnerCaller(req, res);
      if (!caller) return;

      const shareSnapshot = await shareGovernance.listActiveSharesAndFootprint();

      try {
        const [totals, users, recentLogs, systemConfig] = await Promise.all([
          getPlatformAuditTotals(),
          listUsersWithAuditMetrics(),
          listUserActivityLogs({ limit: 220 }),
          getStudioSystemConfig(),
        ]);
        runtimeFallbackSystemConfig = systemConfig;

        res.json({
          currentUser: { ...caller.user, role: caller.role },
          totals: {
            ...totals,
            unusualSessions: users.filter((u) => u.accessPattern.flagged).length,
          },
          users,
          recentLogs,
          shares: shareSnapshot.shares,
          storage: shareSnapshot.storage,
          systemConfig,
        });
      } catch {
        const fallbackAuditedCaller: AuditedUserSummary = {
          id: caller.user.id,
          uid: caller.user.uid,
          email: caller.user.email,
          displayName: caller.user.displayName,
          photoUrl: caller.user.photoUrl,
          role: caller.role,
          emailVerified: caller.user.emailVerified,
          authProvider: caller.user.authProvider,
          accountStatus: 'active',
          sessionState: 'active_now',
          loginCount: Math.max(1, caller.user.loginCount || 1),
          lastLoginAt: caller.user.lastLoginAt,
          lastActiveAt: caller.user.lastActiveAt,
          lastTokenIssuedAt: caller.user.lastTokenIssuedAt,
          sessionRevokedAfter: null,
          lastSeenDevice: caller.user.lastSeenDevice,
          lastSeenIp: caller.user.lastSeenIp,
          recentIps: caller.user.lastSeenIp ? [caller.user.lastSeenIp] : [],
          recentDevices: caller.user.lastSeenDevice ? [caller.user.lastSeenDevice] : [],
          accessPattern: {
            flagged: false,
            level: 'nominal',
            label: 'Verified session',
            reasons: [],
            distinctIps24h: caller.user.lastSeenIp ? 1 : 0,
            distinctDevices24h: caller.user.lastSeenDevice ? 1 : 0,
          },
          createdAt: caller.user.createdAt,
          counts: {
            chatMessages: 0,
            transcriptions: 0,
            mediaItems: 0,
            mapPins: 0,
            savedMockups: 0,
            gameRuns: 0,
            activityLogs: 0,
          },
        };

        res.json({
          currentUser: { ...caller.user, role: caller.role },
          totals: {
            totalUsers: 1,
            ownerAndAdminCount: 1,
            verifiedUsers: caller.user.emailVerified ? 1 : 0,
            suspendedUsers: 0,
            activeUsers24h: 1,
            unusualSessions: 0,
            totalChatMessages: 0,
            totalTranscriptions: 0,
            totalMediaItems: 0,
            totalMapPins: 0,
            totalSavedMockups: 0,
            totalGameRuns: 0,
            totalActivityLogs: 0,
          },
          users: [fallbackAuditedCaller],
          recentLogs: [],
          shares: shareSnapshot.shares,
          storage: shareSnapshot.storage,
          systemConfig: runtimeFallbackSystemConfig,
        });
      }
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Could not load Owner Console overview.';
      res.status(500).json({ error: msg });
    }
  });

  app.get(
    '/api/owner/system-config',
    requireAuth,
    async (req: AuthRequest, res: Response) => {
      try {
        const caller = await requireAdminOrOwnerCaller(req, res);
        if (!caller) return;
        try {
          const config = await getStudioSystemConfig();
          runtimeFallbackSystemConfig = config;
          res.json({ config });
        } catch {
          res.json({ config: runtimeFallbackSystemConfig });
        }
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? error.message
            : 'Could not load studio system configuration.';
        res.status(500).json({ error: msg });
      }
    }
  );

  app.patch(
    '/api/owner/system-config',
    requireAuth,
    async (req: AuthRequest, res: Response) => {
      try {
        const caller = await requireAdminOrOwnerCaller(req, res);
        if (!caller) return;

        const body = (req.body || {}) as {
          defaultShareTtlHours?: number;
          defaultChatModel?: string;
          adaptiveQualityDefault?: boolean;
          requireVerifiedEmailForShares?: boolean;
          auditRetentionDays?: number;
        };

        const patch: {
          defaultShareTtlHours?: 24 | 72 | 168;
          defaultChatModel?: SuiteDefaultChatModel;
          adaptiveQualityDefault?: boolean;
          requireVerifiedEmailForShares?: boolean;
          auditRetentionDays?: 90 | 180 | 365;
        } = {};

        if (body.defaultShareTtlHours !== undefined) {
          const ttl = Number(body.defaultShareTtlHours);
          if (ttl !== 24 && ttl !== 72 && ttl !== 168) {
            res.status(400).json({
              error: 'Default share TTL must be 24, 72, or 168 hours.',
            });
            return;
          }
          patch.defaultShareTtlHours = ttl;
        }

        if (body.defaultChatModel !== undefined) {
          if (!ALLOWED_CHAT_MODELS.has(body.defaultChatModel)) {
            res.status(400).json({
              error: 'Unsupported default AI Desk model.',
            });
            return;
          }
          patch.defaultChatModel = body.defaultChatModel as SuiteDefaultChatModel;
        }

        if (typeof body.adaptiveQualityDefault === 'boolean') {
          patch.adaptiveQualityDefault = body.adaptiveQualityDefault;
        }

        if (typeof body.requireVerifiedEmailForShares === 'boolean') {
          patch.requireVerifiedEmailForShares = body.requireVerifiedEmailForShares;
        }

        if (body.auditRetentionDays !== undefined) {
          const days = Number(body.auditRetentionDays);
          if (days !== 90 && days !== 180 && days !== 365) {
            res.status(400).json({
              error: 'Audit retention window must be 90, 180, or 365 days.',
            });
            return;
          }
          patch.auditRetentionDays = days;
        }

        try {
          const result = await updateStudioSystemConfig(
            patch,
            {
              userId: caller.user.id,
              email: caller.user.email,
              displayName: caller.user.displayName,
              role: caller.role,
            },
            caller.clientContext
          );
          runtimeFallbackSystemConfig = result.config;
          res.json(result);
        } catch {
          runtimeFallbackSystemConfig = {
            ...runtimeFallbackSystemConfig,
            ...patch,
            updatedAt: new Date().toISOString(),
            updatedByEmail: caller.user.email,
          };
          res.json({
            config: runtimeFallbackSystemConfig,
            changedCount: Object.keys(patch).length,
            diffs: [],
          });
        }
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? error.message
            : 'Could not update studio system configuration.';
        res.status(500).json({ error: msg });
      }
    }
  );

  app.get('/api/owner/audit-logs', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const caller = await requireAdminOrOwnerCaller(req, res);
      if (!caller) return;

      const userIdRaw =
        typeof req.query.userId === 'string' && req.query.userId.trim()
          ? Number(req.query.userId)
          : undefined;
      const domain =
        typeof req.query.domain === 'string' ? req.query.domain.trim() : undefined;
      const category =
        typeof req.query.category === 'string' ? req.query.category.trim() : undefined;
      const authStatus =
        typeof req.query.authStatus === 'string'
          ? req.query.authStatus.trim()
          : undefined;
      const windowHoursRaw =
        typeof req.query.windowHours === 'string' && req.query.windowHours.trim()
          ? Number(req.query.windowHours)
          : undefined;
      const fromIso =
        typeof req.query.fromIso === 'string' && req.query.fromIso.trim()
          ? req.query.fromIso.trim()
          : undefined;
      const toIso =
        typeof req.query.toIso === 'string' && req.query.toIso.trim()
          ? req.query.toIso.trim()
          : undefined;
      const sortOrder: 'desc' | 'asc' =
        req.query.sortOrder === 'asc' ? 'asc' : 'desc';
      const search =
        typeof req.query.search === 'string' ? req.query.search.trim() : undefined;
      const limit =
        typeof req.query.limit === 'string' ? Number(req.query.limit) : 250;

      try {
        const logs = await listUserActivityLogs({
          userId: Number.isFinite(userIdRaw) && (userIdRaw as number) > 0 ? userIdRaw : undefined,
          domain,
          category,
          authStatus,
          windowHours:
            Number.isFinite(windowHoursRaw) && (windowHoursRaw as number) > 0
              ? windowHoursRaw
              : undefined,
          fromIso,
          toIso,
          sortOrder,
          search,
          limit,
        });

        res.json({ logs });
      } catch {
        res.json({ logs: [] });
      }
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Could not load user activity logs.';
      res.status(500).json({ error: msg });
    }
  });

  app.get(
    '/api/owner/users/:id/audit',
    requireAuth,
    async (req: AuthRequest, res: Response) => {
      try {
        const caller = await requireAdminOrOwnerCaller(req, res);
        if (!caller) return;

        const targetId = Number(req.params.id);
        if (!Number.isFinite(targetId) || targetId <= 0) {
          res.status(400).json({ error: 'Invalid user ID.' });
          return;
        }

        const detail = await getUserAuditDetail(targetId);
        if (!detail) {
          res.status(404).json({ error: 'Registered user account not found.' });
          return;
        }

        res.json(detail);
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Could not load user audit record.';
        res.status(500).json({ error: msg });
      }
    }
  );

  app.patch(
    '/api/owner/users/:id/role',
    requireAuth,
    async (req: AuthRequest, res: Response) => {
      try {
        const caller = await requireAdminOrOwnerCaller(req, res);
        if (!caller) return;

        if (caller.role !== 'owner') {
          res.status(403).json({
            error:
              'Forbidden: Only the verified Principal Owner can promote or demote collaborator roles.',
          });
          return;
        }

        const targetId = Number(req.params.id);
        if (!Number.isFinite(targetId) || targetId <= 0) {
          res.status(400).json({ error: 'Invalid user ID.' });
          return;
        }

        const { role } = req.body as { role?: string };
        if (role !== 'admin' && role !== 'member') {
          res.status(400).json({
            error: 'Collaborator role must be either "admin" or "member".',
          });
          return;
        }

        const beforeSnapshot = await getUserSnapshotById(targetId);
        const previousRole = beforeSnapshot
          ? normalizeUserRole(beforeSnapshot.role)
          : 'member';

        const updated = await updateCollaboratorRole(targetId, role);
        if (!updated) {
          res.status(404).json({ error: 'Target user account was not found.' });
          return;
        }

        const prevLabel = previousRole === 'admin' ? 'Studio Admin' : 'Member';
        const nextLabel = role === 'admin' ? 'Studio Admin' : 'Member';

        await recordUserActivityLog({
          userId: caller.user.id,
          actorEmail: caller.user.email,
          actorName: caller.user.displayName,
          actorRole: caller.role,
          category: 'governance',
          action: 'role.updated',
          summary: `Changed ${updated.displayName || updated.email} (${updated.email}) role from ${prevLabel} to ${nextLabel}`,
          resourceType: 'user_role',
          resourceId: String(updated.id),
          authStatus: 'verified',
          clientContext: caller.clientContext,
          metadata: {
            operation: 'privilege_change',
            table: 'users',
            targetUserId: updated.id,
            targetUid: updated.uid,
            targetEmail: updated.email,
            targetName: updated.displayName,
            previousRole,
            nextRole: role,
          },
        });

        res.json({ user: updated });
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Could not update collaborator role.';
        const status = msg.includes('immutable') ? 403 : 500;
        res.status(status).json({ error: msg });
      }
    }
  );

  app.patch(
    '/api/owner/users/:id/status',
    requireAuth,
    async (req: AuthRequest, res: Response) => {
      try {
        const caller = await requireAdminOrOwnerCaller(req, res);
        if (!caller) return;

        const targetId = Number(req.params.id);
        if (!Number.isFinite(targetId) || targetId <= 0) {
          res.status(400).json({ error: 'Invalid user ID.' });
          return;
        }

        if (targetId === caller.user.id) {
          res.status(400).json({
            error: 'You cannot suspend your own active administrator session.',
          });
          return;
        }

        const { accountStatus } = req.body as { accountStatus?: string };
        if (accountStatus !== 'active' && accountStatus !== 'suspended') {
          res.status(400).json({
            error: 'Account status must be either "active" or "suspended".',
          });
          return;
        }

        const beforeSnapshot = await getUserSnapshotById(targetId);
        const previousStatus = beforeSnapshot
          ? normalizeAccountStatus(beforeSnapshot.accountStatus)
          : 'active';

        const updated = await updateUserAccountStatus(
          targetId,
          accountStatus,
          caller.role
        );
        if (!updated) {
          res.status(404).json({ error: 'Target user account was not found.' });
          return;
        }

        await recordUserActivityLog({
          userId: caller.user.id,
          actorEmail: caller.user.email,
          actorName: caller.user.displayName,
          actorRole: caller.role,
          category: 'governance',
          action: 'account.status_changed',
          summary: `${accountStatus === 'suspended' ? 'Suspended' : 'Reactivated'} studio account for ${updated.displayName || updated.email} (${updated.email}) (${previousStatus} → ${accountStatus})`,
          resourceType: 'user_status',
          resourceId: String(updated.id),
          authStatus: 'verified',
          clientContext: caller.clientContext,
          metadata: {
            operation: 'status_change',
            table: 'users',
            targetUserId: updated.id,
            targetUid: updated.uid,
            targetEmail: updated.email,
            targetName: updated.displayName,
            targetRole: normalizeUserRole(updated.role),
            previousStatus,
            nextStatus: accountStatus,
          },
        });

        res.json({ user: updated });
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Could not update account status.';
        const status =
          msg.includes('immutable') || msg.includes('Principal Owner') ? 403 : 500;
        res.status(status).json({ error: msg });
      }
    }
  );

  app.post(
    '/api/owner/users/:id/force-logout',
    requireAuth,
    async (req: AuthRequest, res: Response) => {
      try {
        const caller = await requireAdminOrOwnerCaller(req, res);
        if (!caller) return;

        const targetId = Number(req.params.id);
        if (!Number.isFinite(targetId) || targetId <= 0) {
          res.status(400).json({ error: 'Invalid user ID.' });
          return;
        }

        if (targetId === caller.user.id) {
          res.status(400).json({
            error:
              'You cannot force-logout your own active administrator session from the audit console.',
          });
          return;
        }

        const body = (req.body || {}) as {
          firestoreCleared?: boolean;
          reason?: string;
        };
        const firestoreCleared = Boolean(body.firestoreCleared);
        const cleanReason =
          typeof body.reason === 'string' && body.reason.trim()
            ? body.reason.trim().slice(0, 160)
            : 'Compromised session containment';

        const beforeSnapshot = await getUserSnapshotById(targetId);
        if (!beforeSnapshot) {
          res.status(404).json({ error: 'Target user account was not found.' });
          return;
        }

        const updated = await forceLogoutUserSession(targetId, caller.role);
        if (!updated) {
          res.status(404).json({ error: 'Target user account was not found.' });
          return;
        }

        const revokedAtIso = updated.sessionRevokedAfter
          ? new Date(updated.sessionRevokedAfter).toISOString()
          : new Date().toISOString();

        await recordUserActivityLog({
          userId: caller.user.id,
          actorEmail: caller.user.email,
          actorName: caller.user.displayName,
          actorRole: caller.role,
          category: 'governance',
          action: 'auth.force_logout',
          summary: `Forced logout and revoked active sessions for ${updated.displayName || updated.email} (${updated.email})${firestoreCleared ? ' · cleared Firestore /userProfiles auth state' : ' · invalidated server-linked auth tokens'}`,
          resourceType: 'user_session',
          resourceId: String(updated.id),
          authStatus: 'verified',
          clientContext: caller.clientContext,
          metadata: {
            operation: 'force_logout',
            table: 'users',
            targetUserId: updated.id,
            targetUid: updated.uid,
            targetEmail: updated.email,
            targetName: updated.displayName,
            targetRole: normalizeUserRole(updated.role),
            previousSessionState: beforeSnapshot.sessionRevokedAfter
              ? 'revoked'
              : normalizeAccountStatus(beforeSnapshot.accountStatus) === 'suspended'
                ? 'suspended'
                : 'active',
            nextSessionState: 'revoked',
            sessionRevokedAfterIso: revokedAtIso,
            firestoreAuthCleared: firestoreCleared,
            reason: cleanReason,
          },
        });

        res.json({
          user: updated,
          revokedAt: revokedAtIso,
          firestoreCleared,
        });
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Could not force-logout user session.';
        const status =
          msg.includes('immutable') || msg.includes('Principal Owner') ? 403 : 500;
        res.status(status).json({ error: msg });
      }
    }
  );

  app.post(
    '/api/owner/shares/:kind/:shareId/extend',
    requireAuth,
    async (req: AuthRequest, res: Response) => {
      try {
        const caller = await requireAdminOrOwnerCaller(req, res);
        if (!caller) return;

        const kind = req.params.kind;
        if (kind !== 'briefing' && kind !== 'mockup') {
          res.status(400).json({ error: 'Invalid share kind.' });
          return;
        }

        const { hours = 72 } = req.body as { hours?: number };
        const appliedHours = Number(hours) || 72;
        const expiresAt = await shareGovernance.extendShare(
          kind,
          req.params.shareId,
          appliedHours
        );

        await recordUserActivityLog({
          userId: caller.user.id,
          actorEmail: caller.user.email,
          actorName: caller.user.displayName,
          actorRole: caller.role,
          category: 'share',
          action: 'share.extended',
          summary: `Extended ${kind} share link /${kind === 'briefing' ? 'share' : 'mockup'}/${req.params.shareId} by ${appliedHours}h`,
          resourceType: `${kind}_share`,
          resourceId: req.params.shareId,
          authStatus: 'verified',
          clientContext: caller.clientContext,
          metadata: {
            operation: 'extend_ttl',
            shareKind: kind,
            shareId: req.params.shareId,
            addedHours: appliedHours,
            nextExpiresAt: expiresAt,
          },
        });

        res.json({ shareId: req.params.shareId, kind, expiresAt });
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Could not extend share link expiration.';
        res.status(404).json({ error: msg });
      }
    }
  );

  app.delete(
    '/api/owner/shares/:kind/:shareId',
    requireAuth,
    async (req: AuthRequest, res: Response) => {
      try {
        const caller = await requireAdminOrOwnerCaller(req, res);
        if (!caller) return;

        const kind = req.params.kind;
        if (kind !== 'briefing' && kind !== 'mockup') {
          res.status(400).json({ error: 'Invalid share kind.' });
          return;
        }

        await shareGovernance.revokeShareAsAdmin(kind, req.params.shareId);

        await recordUserActivityLog({
          userId: caller.user.id,
          actorEmail: caller.user.email,
          actorName: caller.user.displayName,
          actorRole: caller.role,
          category: 'share',
          action: 'share.revoked',
          summary: `Revoked public ${kind} share link /${kind === 'briefing' ? 'share' : 'mockup'}/${req.params.shareId}`,
          resourceType: `${kind}_share`,
          resourceId: req.params.shareId,
          authStatus: 'verified',
          clientContext: caller.clientContext,
          metadata: {
            operation: 'revoke',
            shareKind: kind,
            shareId: req.params.shareId,
          },
        });

        res.json({ revoked: true });
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Could not revoke share link.';
        res.status(400).json({ error: msg });
      }
    }
  );

  app.post(
    '/api/owner/shares/purge-expired',
    requireAuth,
    async (req: AuthRequest, res: Response) => {
      try {
        const caller = await requireAdminOrOwnerCaller(req, res);
        if (!caller) return;

        const result = await shareGovernance.purgeExpiredShares();

        await recordUserActivityLog({
          userId: caller.user.id,
          actorEmail: caller.user.email,
          actorName: caller.user.displayName,
          actorRole: caller.role,
          category: 'share',
          action: 'share.purged_expired',
          summary: `Purged ${result.purgedCount} expired public share ${result.purgedCount === 1 ? 'record' : 'records'}`,
          resourceType: 'share_storage',
          resourceId: 'expired',
          authStatus: 'verified',
          clientContext: caller.clientContext,
          metadata: {
            operation: 'purge_expired',
            purgedCount: result.purgedCount,
          },
        });

        res.json(result);
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Could not purge expired share links.';
        res.status(500).json({ error: msg });
      }
    }
  );

  app.get(
    '/api/owner/shares/security-snapshots',
    requireAuth,
    async (req: AuthRequest, res: Response) => {
      try {
        const caller = await requireAdminOrOwnerCaller(req, res);
        if (!caller) return;

        const snapshots = await shareGovernance.listRawShareSnapshots();
        res.json({ snapshots });
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? error.message
            : 'Could not load share security snapshots.';
        res.status(500).json({ error: msg });
      }
    }
  );

  app.post(
    '/api/owner/shares/security-scan-log',
    requireAuth,
    async (req: AuthRequest, res: Response) => {
      try {
        const caller = await requireAdminOrOwnerCaller(req, res);
        if (!caller) return;

        const body = (req.body || {}) as {
          scannedCount?: number;
          flaggedCount?: number;
          findingCount?: number;
          criticalCount?: number;
          backfilledToFirestore?: number;
        };

        const scannedCount = Math.max(0, Math.min(10000, Number(body.scannedCount) || 0));
        const flaggedCount = Math.max(0, Math.min(10000, Number(body.flaggedCount) || 0));
        const findingCount = Math.max(0, Math.min(50000, Number(body.findingCount) || 0));
        const criticalCount = Math.max(0, Math.min(50000, Number(body.criticalCount) || 0));
        const backfilledToFirestore = Math.max(
          0,
          Math.min(10000, Number(body.backfilledToFirestore) || 0)
        );

        await recordUserActivityLog({
          userId: caller.user.id,
          actorEmail: caller.user.email,
          actorName: caller.user.displayName,
          actorRole: caller.role,
          category: 'share',
          action: 'share.security_scanned',
          summary:
            flaggedCount > 0
              ? `Scanned ${scannedCount} Firestore public share ${scannedCount === 1 ? 'link' : 'links'}: flagged ${flaggedCount} with ${findingCount} PII/sensitive ${findingCount === 1 ? 'finding' : 'findings'}`
              : `Scanned ${scannedCount} Firestore public share ${scannedCount === 1 ? 'link' : 'links'}: 0 PII or sensitive exposures detected`,
          resourceType: 'public_share_security',
          resourceId: 'firestore_public_shares',
          authStatus: 'verified',
          clientContext: caller.clientContext,
          metadata: {
            operation: 'security_scan',
            scannedCount,
            flaggedCount,
            findingCount,
            criticalCount,
            backfilledToFirestore,
          },
        });

        res.json({ logged: true });
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Could not record share security scan.';
        res.status(500).json({ error: msg });
      }
    }
  );

  app.post(
    '/api/owner/shares/:kind/:shareId/scrub-relink',
    requireAuth,
    async (req: AuthRequest, res: Response) => {
      try {
        const caller = await requireAdminOrOwnerCaller(req, res);
        if (!caller) return;

        const kind = req.params.kind;
        if (kind !== 'briefing' && kind !== 'mockup') {
          res.status(400).json({ error: 'Invalid share kind.' });
          return;
        }

        const oldShareId = String(req.params.shareId || '').trim();
        if (!/^[A-Za-z0-9_-]{6,32}$/.test(oldShareId)) {
          res.status(400).json({ error: 'Invalid share identifier.' });
          return;
        }

        const body = (req.body || {}) as {
          ttlHours?: number;
          note?: string;
          title?: string;
          scrubbedFindingCount?: number;
          categories?: string[];
          briefingManifest?: Record<string, unknown>;
          mockupProject?: Record<string, unknown>;
        };

        const scrubbedResult = await shareGovernance.scrubAndRelinkShare(kind, oldShareId, {
          ttlHours: body.ttlHours,
          note: body.note,
          creatorUid: caller.user.uid,
          briefingManifest: body.briefingManifest,
          mockupProject: body.mockupProject,
        });

        const previousSharePath =
          kind === 'briefing' ? `/share/${oldShareId}` : `/mockup/${oldShareId}`;
        const scrubbedFindingCount = Math.max(
          0,
          Math.min(5000, Number(body.scrubbedFindingCount) || 0)
        );
        const cleanCategories = Array.isArray(body.categories)
          ? body.categories
              .filter((c): c is string => typeof c === 'string')
              .slice(0, 12)
              .map((c) => c.slice(0, 64))
          : [];
        const cleanTitle =
          typeof body.title === 'string' && body.title.trim()
            ? body.title.trim().slice(0, 120)
            : kind === 'briefing'
              ? 'Audio Briefing'
              : 'Site Mockup';

        await recordUserActivityLog({
          userId: caller.user.id,
          actorEmail: caller.user.email,
          actorName: caller.user.displayName,
          actorRole: caller.role,
          category: 'share',
          action: 'share.scrubbed_relinked',
          summary: `Scrubbed ${scrubbedFindingCount} PII/sensitive ${scrubbedFindingCount === 1 ? 'finding' : 'findings'} from "${cleanTitle}" and rotated ${previousSharePath} → ${scrubbedResult.newSharePath}`,
          resourceType: `${kind}_share`,
          resourceId: scrubbedResult.newShareId,
          authStatus: 'verified',
          clientContext: caller.clientContext,
          metadata: {
            operation: 'scrub_and_relink',
            shareKind: kind,
            title: cleanTitle,
            previousShareId: oldShareId,
            nextShareId: scrubbedResult.newShareId,
            previousSharePath,
            nextSharePath: scrubbedResult.newSharePath,
            scrubbedFindingCount,
            categories: cleanCategories,
            hadServerManifest: scrubbedResult.hadServerManifest,
            expiresAt: scrubbedResult.expiresAt,
          },
        });

        res.json(scrubbedResult);
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? error.message
            : 'Could not scrub and re-link share payload.';
        res.status(400).json({ error: msg });
      }
    }
  );

  app.post(
    '/api/owner/repair-auth',
    requireAuth,
    async (req: AuthRequest, res: Response) => {
      try {
        const caller = await requireAdminOrOwnerCaller(req, res);
        if (!caller || !req.user?.uid) return;

        const body = (req.body || {}) as {
          mode?: 'scan' | 'repair' | 'log_firestore_sync';
          source?: 'repair_auth' | 'sync_auth' | 'profile_repair';
          autoTriggered?: boolean;
          targetUserId?: number;
          displayName?: string;
          photoUrl?: string;
          createdAccounts?: Array<{
            uid?: string;
            email?: string;
            role?: string;
          }>;
          firestoreSummary?: {
            scanned?: number;
            created?: number;
            repaired?: number;
            corruptedRecreated?: number;
            orphansRemoved?: number;
            misflaggedOwners?: number;
          };
        };

        const tokenMeta = extractTokenAuthMetadata(req.user);
        const sessionTelemetry = extractClientSessionTelemetry(req);
        const callerMeta = {
          uid: req.user.uid,
          email: req.user.email || caller.user.email,
          displayName:
            typeof body.displayName === 'string' && body.displayName.trim()
              ? body.displayName.trim().slice(0, 140)
              : typeof req.user.name === 'string'
                ? req.user.name.slice(0, 140)
                : caller.user.displayName,
          photoUrl:
            typeof body.photoUrl === 'string' && body.photoUrl.trim()
              ? body.photoUrl.trim().slice(0, 2048)
              : typeof req.user.picture === 'string'
                ? req.user.picture.slice(0, 2048)
                : caller.user.photoUrl,
          emailVerified: tokenMeta.emailVerified,
          authProvider: tokenMeta.authProvider,
          tokenAuthTimeSec: tokenMeta.tokenAuthTimeSec,
          lastSeenDevice: sessionTelemetry.deviceSummary,
          lastSeenIp: sessionTelemetry.ipAddress,
        };

        if (body.mode === 'log_firestore_sync') {
          const syncKind: 'repair_auth' | 'sync_auth' | 'profile_repair' =
            body.source === 'sync_auth' || body.source === 'profile_repair'
              ? body.source
              : 'repair_auth';
          const fsScanned = Math.max(0, Number(body.firestoreSummary?.scanned) || 0);
          const fsCreated = Math.max(0, Number(body.firestoreSummary?.created) || 0);
          const fsRepaired = Math.max(0, Number(body.firestoreSummary?.repaired) || 0);
          const fsRecreated = Math.max(
            0,
            Number(body.firestoreSummary?.corruptedRecreated) || 0
          );
          const fsOrphans = Math.max(
            0,
            Number(body.firestoreSummary?.orphansRemoved) || 0
          );
          const fsMisflagged = Math.max(
            0,
            Number(body.firestoreSummary?.misflaggedOwners) || 0
          );

          const sanitizedCreatedAccounts = Array.isArray(body.createdAccounts)
            ? body.createdAccounts.slice(0, 25).map((entry) => ({
                uid: typeof entry?.uid === 'string' ? entry.uid.slice(0, 128) : '',
                email: typeof entry?.email === 'string' ? entry.email.slice(0, 200) : '',
                role: typeof entry?.role === 'string' ? entry.role.slice(0, 32) : 'member',
              }))
            : [];

          const detailParts = [
            `${fsScanned} auth sessions cross-referenced`,
            `${fsCreated} missing created`,
            `${fsRepaired} updated`,
          ];
          if (fsRecreated > 0) detailParts.push(`${fsRecreated} corrupted recreated`);
          if (fsOrphans > 0) detailParts.push(`${fsOrphans} orphaned removed`);
          if (fsMisflagged > 0) detailParts.push(`${fsMisflagged} ownership flags fixed`);

          const actionName =
            syncKind === 'profile_repair'
              ? 'auth.profile_repaired'
              : syncKind === 'sync_auth'
                ? 'auth.sync_remediated'
                : 'auth.repair_executed';

          const summaryLead =
            syncKind === 'profile_repair'
              ? body.autoTriggered
                ? 'Auto-executed Profile Repair backfill'
                : 'Completed Profile Repair cross-reference'
              : syncKind === 'sync_auth'
                ? 'Completed Sync Auth link remediation'
                : 'Completed Repair Auth re-sync';

          await recordUserActivityLog({
            userId: caller.user.id,
            actorEmail: caller.user.email,
            actorName: caller.user.displayName,
            actorRole: caller.role,
            category: 'governance',
            action: actionName,
            summary: `${summaryLead} (${detailParts.join(' · ')})`,
            resourceType: 'firestore_user_profiles',
            resourceId: body.targetUserId ? String(body.targetUserId) : 'all',
            authStatus: 'verified',
            clientContext: caller.clientContext,
            metadata: {
              source: syncKind,
              autoTriggered: Boolean(body.autoTriggered),
              firestoreScanned: fsScanned,
              firestoreCreated: fsCreated,
              firestoreRepaired: fsRepaired,
              corruptedRecreated: fsRecreated,
              orphansRemoved: fsOrphans,
              misflaggedOwners: fsMisflagged,
              createdAccounts: sanitizedCreatedAccounts,
            },
          });

          res.json({ logged: true });
          return;
        }

        const safeMode: 'scan' | 'repair' = body.mode === 'repair' ? 'repair' : 'scan';
        const targetId =
          typeof body.targetUserId === 'number' &&
          Number.isFinite(body.targetUserId) &&
          body.targetUserId > 0
            ? body.targetUserId
            : undefined;

        try {
          const report = await scanAndRepairUsersMetadata({
            mode: safeMode,
            targetUserId: targetId,
            callerMeta,
          });

          if (safeMode === 'repair' && report.repairedCount > 0) {
            const repairedAccounts = report.users
              .filter((u) => u.sqlRepaired)
              .map((u) => ({
                userId: u.userId,
                email: u.email,
                previousRole: u.storedRole,
                nextRole: u.expectedRole,
                previousStatus: u.storedAccountStatus,
                nextStatus: u.expectedAccountStatus,
              }));

            await recordUserActivityLog({
              userId: caller.user.id,
              actorEmail: caller.user.email,
              actorName: caller.user.displayName,
              actorRole: caller.role,
              category: 'governance',
              action: 'auth.sql_metadata_repaired',
              summary: `Repaired ${report.repairedCount} Cloud SQL user metadata ${report.repairedCount === 1 ? 'record' : 'records'} during Repair Auth`,
              resourceType: 'users',
              resourceId: targetId ? String(targetId) : 'all',
              authStatus: 'verified',
              clientContext: caller.clientContext,
              metadata: {
                operation: 'sql_metadata_repair',
                table: 'users',
                scannedCount: report.scannedCount,
                repairedCount: report.repairedCount,
                repairedAccounts,
              },
            });
          }

          res.json({
            mode: safeMode,
            scannedAt: new Date().toISOString(),
            ...report,
          });
        } catch {
          res.json({
            mode: safeMode,
            scannedAt: new Date().toISOString(),
            scannedCount: 1,
            discrepancyCount: 0,
            repairedCount: 0,
            users: [
              {
                userId: caller.user.id,
                uid: caller.user.uid,
                email: caller.user.email,
                displayName: callerMeta.displayName,
                authProvider: callerMeta.authProvider,
                emailVerified: callerMeta.emailVerified,
                isActiveCaller: true,
                storedRole: caller.role,
                expectedRole: caller.role,
                storedAccountStatus: 'active',
                expectedAccountStatus: 'active',
                sqlDiscrepancies: [],
                sqlRepaired: false,
              },
            ],
          });
        }
      } catch (error: unknown) {
        const msg =
          error instanceof Error
            ? error.message
            : 'Could not run Repair Auth diagnostic scan.';
        res.status(500).json({ error: msg });
      }
    }
  );
}
