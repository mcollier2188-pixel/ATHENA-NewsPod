import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import type { Express, Request, Response } from 'express';
import {
  isVerifiedPrincipalToken,
  optionalAuth,
  type AuthRequest,
} from '../middleware/auth.ts';
import type {
  BroadcastFormat,
  RssClientAppFamily,
  RssDailyTelemetryBucket,
  RssEpisodeChapterNote,
  RssFeedAnalyticsSnapshot,
  RssFeedEpisodeSummary,
  RssFeedManifestPublic,
} from '../types.ts';

const RSS_ROOT_DIR = path.join(os.tmpdir(), 'dispatch-private-rss-feeds');
const TOKEN_INDEX_FILE = path.join(RSS_ROOT_DIR, 'token-index.json');
const FEED_ID_PATTERN = /^[A-Za-z0-9_-]{8,40}$/;
const FEED_TOKEN_PATTERN = /^[A-Za-z0-9_-]{24,64}$/;
const EPISODE_KEY_PATTERN = /^[a-f0-9]{24}$/;

const MAX_TITLE_LEN = 120;
const MAX_DESC_LEN = 600;
const MAX_AUTHOR_LEN = 100;
const MIN_PASSWORD_LEN = 4;
const MAX_PASSWORD_LEN = 128;
const MAX_EPISODES_PER_FEED = 100;
const MAX_ANALYTICS_DAYS = 120;

interface StoredRssDailyRecord {
  downloads: number;
  rssPolls: number;
  subscriberHashes: string[];
}

interface StoredRssAnalytics {
  daily: Record<string, StoredRssDailyRecord>;
  episodeDownloads: Record<string, number>;
  clientBreakdown: Record<RssClientAppFamily, number>;
  allSubscriberHashes: string[];
  totalLiveDownloads: number;
  totalLivePolls: number;
  lastActivityAt: string | null;
}

interface StoredRssEpisode {
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
}

interface StoredRssFeedManifest {
  feedId: string;
  feedToken: string;
  manageToken: string;
  ownerUid?: string;
  ownerEmail?: string;
  title: string;
  description: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string | null;
  passwordProtected?: boolean;
  passwordSalt?: string;
  passwordHash?: string;
  accessKeyToken?: string;
  episodes: StoredRssEpisode[];
  analytics?: StoredRssAnalytics;
}

export interface RssRouteDependencies {
  stitchServerWavBuffers: (buffers: Buffer[]) => Buffer | null;
  safeTimingEqual: (a?: string, b?: string) => boolean;
  formatApiError: (err: unknown) => { status: number; message: string };
}

function stripControlChars(input: string): string {
  // Strip invalid XML 1.0 control characters while preserving tab, LF, CR
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function escapeXml(raw: string): string {
  return stripControlChars(String(raw || ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeHtml(raw: string): string {
  return stripControlChars(String(raw || ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeCdata(raw: string): string {
  return stripControlChars(raw).replace(/]]>/g, ']]]]><![CDATA[>');
}

function deriveEpisodeKey(briefingId: string): string {
  return crypto
    .createHash('sha256')
    .update(`dispatch-rss-ep:${briefingId}`)
    .digest('hex')
    .slice(0, 24);
}

function hashFeedPassword(password: string, saltHex: string): string {
  return crypto.scryptSync(password, saltHex, 32).toString('hex');
}

function deriveAccessKeyToken(
  feedToken: string,
  passwordHashHex: string,
  manageToken: string
): string {
  return crypto
    .createHmac('sha256', `${manageToken}:${passwordHashHex}`)
    .update(`dispatch-rss-key:${feedToken}`)
    .digest('base64url')
    .slice(0, 24);
}

function isFeedManifestExpired(manifest: StoredRssFeedManifest): boolean {
  if (!manifest.expiresAt) return false;
  const expMs = new Date(manifest.expiresAt).getTime();
  if (Number.isNaN(expMs)) return false;
  return Date.now() > expMs;
}

function getUtcDateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function deriveSubscriberFingerprint(req: Request, feedId: string): string {
  const forwarded = req.headers['x-forwarded-for'];
  const rawIp =
    (typeof forwarded === 'string'
      ? forwarded.split(',')[0].trim()
      : Array.isArray(forwarded)
        ? forwarded[0]
        : '') ||
    req.socket?.remoteAddress ||
    'local';
  const ua = String(req.headers['user-agent'] || 'rss-reader').slice(0, 200);
  return crypto
    .createHash('sha256')
    .update(`dispatch-sub:${feedId}:${rawIp}:${ua}`)
    .digest('hex')
    .slice(0, 12);
}

function classifyPodcastClient(req: Request): RssClientAppFamily {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (
    ua.includes('applecoremedia') ||
    ua.includes('podcasts/') ||
    ua.includes('itunes') ||
    ua.includes('cfnetwork')
  ) {
    return 'Apple Podcasts';
  }
  if (ua.includes('overcast')) {
    return 'Overcast';
  }
  if (ua.includes('pocket casts') || ua.includes('pocketcasts') || ua.includes('shifty jelly')) {
    return 'Pocket Casts';
  }
  return 'Direct & Web RSS';
}

function ensureFeedAnalytics(manifest: StoredRssFeedManifest): StoredRssAnalytics {
  if (!manifest.analytics) {
    manifest.analytics = {
      daily: {},
      episodeDownloads: {},
      clientBreakdown: {
        'Apple Podcasts': 0,
        Overcast: 0,
        'Pocket Casts': 0,
        'Direct & Web RSS': 0,
      },
      allSubscriberHashes: [],
      totalLiveDownloads: 0,
      totalLivePolls: 0,
      lastActivityAt: null,
    };
  }
  return manifest.analytics;
}

function pruneAnalyticsDays(daily: Record<string, StoredRssDailyRecord>): void {
  const keys = Object.keys(daily).sort();
  if (keys.length <= MAX_ANALYTICS_DAYS) return;
  const toRemove = keys.slice(0, keys.length - MAX_ANALYTICS_DAYS);
  for (const key of toRemove) {
    delete daily[key];
  }
}

async function recordRssPollEvent(
  req: Request,
  manifest: StoredRssFeedManifest
): Promise<void> {
  try {
    const analytics = ensureFeedAnalytics(manifest);
    const todayKey = getUtcDateKey();
    const subHash = deriveSubscriberFingerprint(req, manifest.feedId);
    const clientFamily = classifyPodcastClient(req);

    if (!analytics.daily[todayKey]) {
      analytics.daily[todayKey] = {
        downloads: 0,
        rssPolls: 0,
        subscriberHashes: [],
      };
    }

    const bucket = analytics.daily[todayKey];
    bucket.rssPolls += 1;
    if (!bucket.subscriberHashes.includes(subHash) && bucket.subscriberHashes.length < 5000) {
      bucket.subscriberHashes.push(subHash);
    }
    if (
      !analytics.allSubscriberHashes.includes(subHash) &&
      analytics.allSubscriberHashes.length < 10000
    ) {
      analytics.allSubscriberHashes.push(subHash);
    }

    analytics.totalLivePolls += 1;
    analytics.clientBreakdown[clientFamily] =
      (analytics.clientBreakdown[clientFamily] || 0) + 1;
    analytics.lastActivityAt = new Date().toISOString();

    pruneAnalyticsDays(analytics.daily);
    await writeFeedManifest(manifest);
  } catch {
    // Telemetry writes should never block RSS feed delivery
  }
}

async function recordEpisodeDownloadEvent(
  req: Request,
  manifest: StoredRssFeedManifest,
  briefingId: string
): Promise<void> {
  try {
    const analytics = ensureFeedAnalytics(manifest);
    const todayKey = getUtcDateKey();
    const subHash = deriveSubscriberFingerprint(req, manifest.feedId);
    const clientFamily = classifyPodcastClient(req);

    if (!analytics.daily[todayKey]) {
      analytics.daily[todayKey] = {
        downloads: 0,
        rssPolls: 0,
        subscriberHashes: [],
      };
    }

    const bucket = analytics.daily[todayKey];
    bucket.downloads += 1;
    if (!bucket.subscriberHashes.includes(subHash) && bucket.subscriberHashes.length < 5000) {
      bucket.subscriberHashes.push(subHash);
    }
    if (
      !analytics.allSubscriberHashes.includes(subHash) &&
      analytics.allSubscriberHashes.length < 10000
    ) {
      analytics.allSubscriberHashes.push(subHash);
    }

    analytics.totalLiveDownloads += 1;
    analytics.episodeDownloads[briefingId] =
      (analytics.episodeDownloads[briefingId] || 0) + 1;
    analytics.clientBreakdown[clientFamily] =
      (analytics.clientBreakdown[clientFamily] || 0) + 1;
    analytics.lastActivityAt = new Date().toISOString();

    pruneAnalyticsDays(analytics.daily);
    await writeFeedManifest(manifest);
  } catch {
    // Telemetry writes should never block audio delivery
  }
}

function buildAnalyticsSnapshot(
  manifest: StoredRssFeedManifest
): RssFeedAnalyticsSnapshot {
  const analytics = ensureFeedAnalytics(manifest);
  const dailyBuckets: RssDailyTelemetryBucket[] = Object.entries(analytics.daily)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rec]) => ({
      date,
      subscribers: rec.subscriberHashes.length,
      downloads: rec.downloads,
      rssPolls: rec.rssPolls,
    }));

  return {
    feedId: manifest.feedId,
    totalLiveDownloads: analytics.totalLiveDownloads,
    totalLivePolls: analytics.totalLivePolls,
    uniqueLiveSubscribers: analytics.allSubscriberHashes.length,
    dailyBuckets,
    episodeDownloads: { ...analytics.episodeDownloads },
    clientBreakdown: {
      'Apple Podcasts': analytics.clientBreakdown['Apple Podcasts'] || 0,
      Overcast: analytics.clientBreakdown.Overcast || 0,
      'Pocket Casts': analytics.clientBreakdown['Pocket Casts'] || 0,
      'Direct & Web RSS': analytics.clientBreakdown['Direct & Web RSS'] || 0,
    },
    lastActivityAt: analytics.lastActivityAt,
  };
}

function verifyFeedPasswordOrAccessKey(
  req: Request,
  manifest: StoredRssFeedManifest,
  safeTimingEqual: (a?: string, b?: string) => boolean
): { authorized: boolean; usedQueryKey?: string } {
  if (
    !manifest.passwordProtected ||
    !manifest.passwordSalt ||
    !manifest.passwordHash
  ) {
    return { authorized: true };
  }

  // 1. Check optional signed access key (?key=...) for podcast apps without Basic Auth UI
  const rawQueryKey = req.query.key;
  const queryKey =
    typeof rawQueryKey === 'string' ? rawQueryKey.trim() : '';
  if (
    queryKey &&
    manifest.accessKeyToken &&
    safeTimingEqual(queryKey, manifest.accessKeyToken)
  ) {
    return { authorized: true, usedQueryKey: queryKey };
  }

  // 2. Check standard HTTP Basic Auth header (Authorization: Basic base64(user:pass))
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Basic ')) {
    const b64 = authHeader.slice('Basic '.length).trim();
    if (b64) {
      try {
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        const colonIdx = decoded.indexOf(':');
        // Allow either "username:password" or bare "password"
        const candidatePassword =
          colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded;
        if (
          candidatePassword.length > 0 &&
          candidatePassword.length <= MAX_PASSWORD_LEN
        ) {
          const candidateHash = hashFeedPassword(
            candidatePassword,
            manifest.passwordSalt
          );
          if (safeTimingEqual(candidateHash, manifest.passwordHash)) {
            return { authorized: true };
          }
        }
      } catch {
        // Malformed base64 header
      }
    }
  }

  return { authorized: false };
}

function normalizeExpiresAtInput(
  rawExpiresAt: unknown
): { valid: boolean; value: string | null; error?: string } {
  if (rawExpiresAt === null || rawExpiresAt === '') {
    return { valid: true, value: null };
  }
  if (typeof rawExpiresAt !== 'string') {
    return { valid: false, value: null, error: 'Invalid expiration date format.' };
  }
  const d = new Date(rawExpiresAt);
  if (Number.isNaN(d.getTime())) {
    return { valid: false, value: null, error: 'Provide a valid expiration date and time.' };
  }
  return { valid: true, value: d.toISOString() };
}

function parseWavDurationSeconds(buf: Buffer): number {
  if (buf.length < 44) return 0;
  if (
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return 0;
  }
  let byteRate = 0;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkId === 'fmt ' && dataStart + 16 <= buf.length) {
      byteRate = buf.readUInt32LE(dataStart + 8);
    } else if (chunkId === 'data') {
      dataSize = Math.min(chunkSize, Math.max(0, buf.length - dataStart));
      break;
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }
  if (!byteRate || !dataSize) return 0;
  return dataSize / byteRate;
}

function formatItunesDuration(totalSeconds: number): string {
  const safe = Math.max(1, Math.round(totalSeconds));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatTimestampMmSs(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function toRfc2822Date(isoString: string): string {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) {
    return new Date().toUTCString();
  }
  return d.toUTCString();
}

function resolvePublicOrigin(req: Request): string {
  const rawProto = req.headers['x-forwarded-proto'];
  const protoCandidate = Array.isArray(rawProto)
    ? rawProto[0]
    : typeof rawProto === 'string'
      ? rawProto.split(',')[0].trim()
      : req.protocol || 'https';
  const proto = protoCandidate === 'http' ? 'http' : 'https';

  const rawHost =
    req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  const hostCandidate = (
    Array.isArray(rawHost) ? rawHost[0] : String(rawHost).split(',')[0]
  )
    .trim()
    .replace(/[^A-Za-z0-9.:-]/g, '');

  const host = hostCandidate || 'localhost:3000';
  return `${proto}://${host}`;
}

function buildPublicManifest(
  manifest: StoredRssFeedManifest
): RssFeedManifestPublic {
  const sortedEpisodes = [...manifest.episodes].sort(
    (a, b) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );
  const isProtected = Boolean(
    manifest.passwordProtected && manifest.passwordHash
  );
  return {
    feedId: manifest.feedId,
    feedToken: manifest.feedToken,
    feedPath: `/api/rss/${manifest.feedToken}.xml`,
    coverPath: '/api/rss/cover.png',
    title: manifest.title,
    description: manifest.description,
    author: manifest.author,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    expiresAt: manifest.expiresAt ?? null,
    isExpired: isFeedManifestExpired(manifest),
    passwordProtected: isProtected,
    accessKeyToken: isProtected ? manifest.accessKeyToken : undefined,
    episodes: sortedEpisodes.map(
      (ep): RssFeedEpisodeSummary => ({
        ...ep,
        audioPath: `/api/rss/${manifest.feedToken}/episodes/${ep.episodeKey}.wav`,
      })
    ),
  };
}

function resolveFeedDir(feedId: string): string | null {
  if (!FEED_ID_PATTERN.test(feedId)) return null;
  const resolvedRoot = path.resolve(RSS_ROOT_DIR);
  const resolvedDir = path.resolve(resolvedRoot, feedId);
  if (!resolvedDir.startsWith(resolvedRoot + path.sep)) return null;
  return resolvedDir;
}

function resolveEpisodeWavPath(
  feedDir: string,
  episodeKey: string
): string | null {
  if (!EPISODE_KEY_PATTERN.test(episodeKey)) return null;
  const resolvedDir = path.resolve(feedDir);
  const resolvedWav = path.resolve(resolvedDir, `ep-${episodeKey}.wav`);
  if (!resolvedWav.startsWith(resolvedDir + path.sep)) return null;
  return resolvedWav;
}

async function readTokenIndex(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(TOKEN_INDEX_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // Missing or empty index
  }
  return {};
}

async function writeTokenIndex(index: Record<string, string>): Promise<void> {
  await fs.mkdir(RSS_ROOT_DIR, { recursive: true });
  const tmpFile = `${TOKEN_INDEX_FILE}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify(index, null, 2), 'utf8');
  await fs.rename(tmpFile, TOKEN_INDEX_FILE);
}

async function readFeedManifest(
  feedId: string
): Promise<StoredRssFeedManifest | null> {
  const dir = resolveFeedDir(feedId);
  if (!dir) return null;
  try {
    const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
    return JSON.parse(raw) as StoredRssFeedManifest;
  } catch {
    return null;
  }
}

async function writeFeedManifest(
  manifest: StoredRssFeedManifest
): Promise<void> {
  const dir = resolveFeedDir(manifest.feedId);
  if (!dir) throw new Error('Invalid feed identifier.');
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, 'manifest.json');
  const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

async function resolveFeedByToken(
  token: string,
  safeTimingEqual: (a?: string, b?: string) => boolean
): Promise<{ manifest: StoredRssFeedManifest; dir: string } | null> {
  if (!FEED_TOKEN_PATTERN.test(token)) return null;
  const index = await readTokenIndex();
  const feedId = index[token];
  if (!feedId) return null;
  const dir = resolveFeedDir(feedId);
  if (!dir) return null;
  const manifest = await readFeedManifest(feedId);
  if (!manifest) return null;
  if (!safeTimingEqual(manifest.feedToken, token)) return null;
  return { manifest, dir };
}

function canManageFeed(
  req: AuthRequest,
  manifest: StoredRssFeedManifest,
  safeTimingEqual: (a?: string, b?: string) => boolean
): boolean {
  const headerVal = req.headers['x-rss-manage-token'];
  const providedManageToken =
    typeof headerVal === 'string' ? headerVal.trim() : '';
  if (
    providedManageToken &&
    safeTimingEqual(providedManageToken, manifest.manageToken)
  ) {
    return true;
  }

  if (!req.user?.uid) {
    return false;
  }

  if (isVerifiedPrincipalToken(req.user)) {
    return true;
  }

  if (manifest.ownerUid && req.user.uid === manifest.ownerUid) {
    return true;
  }

  return false;
}

function buildEpisodePlainShowNotes(ep: StoredRssEpisode): string {
  const parts: string[] = [];
  if (ep.subtitle) {
    parts.push(ep.subtitle);
  }
  if (ep.takeaways.length > 0) {
    parts.push(
      'Key Takeaways:\n' + ep.takeaways.map((t) => `- ${t}`).join('\n')
    );
  }
  if (ep.chapters.length > 0) {
    parts.push(
      'Chapters:\n' +
        ep.chapters
          .map(
            (ch, idx) =>
              `${formatTimestampMmSs(ch.startSeconds)} - ${idx + 1}. ${ch.title}${ch.keyPoint ? `: ${ch.keyPoint}` : ''}`
          )
          .join('\n')
    );
  }
  if (ep.articleTitles.length > 0) {
    parts.push(
      'Sources:\n' + ep.articleTitles.map((s) => `- ${s}`).join('\n')
    );
  }
  return parts.join('\n\n');
}

function buildEpisodeHtmlShowNotes(ep: StoredRssEpisode): string {
  const blocks: string[] = [];
  if (ep.subtitle) {
    blocks.push(`<p>${escapeHtml(ep.subtitle)}</p>`);
  }
  if (ep.takeaways.length > 0) {
    const items = ep.takeaways
      .map((t) => `<li>${escapeHtml(t)}</li>`)
      .join('');
    blocks.push(`<h3>Key Takeaways</h3><ul>${items}</ul>`);
  }
  if (ep.chapters.length > 0) {
    const items = ep.chapters
      .map((ch) => {
        const ts = formatTimestampMmSs(ch.startSeconds);
        const kp = ch.keyPoint ? ` — ${escapeHtml(ch.keyPoint)}` : '';
        return `<li><strong>${escapeHtml(ts)}</strong> ${escapeHtml(ch.title)} (${escapeHtml(ch.category)})${kp}</li>`;
      })
      .join('');
    blocks.push(`<h3>Chapters</h3><ol>${items}</ol>`);
  }
  if (ep.articleTitles.length > 0) {
    const items = ep.articleTitles
      .map((s) => `<li>${escapeHtml(s)}</li>`)
      .join('');
    blocks.push(`<h3>Sources</h3><ul>${items}</ul>`);
  }
  return blocks.join('\n');
}

function buildRssXml(
  manifest: StoredRssFeedManifest,
  origin: string,
  propagatedKey?: string
): string {
  const keySuffix = propagatedKey
    ? `?key=${encodeURIComponent(propagatedKey)}`
    : '';
  const selfUrl = `${origin}/api/rss/${manifest.feedToken}.xml${keySuffix}`;
  const coverUrl = `${origin}/api/rss/cover.png`;
  const sortedEpisodes = [...manifest.episodes].sort(
    (a, b) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );

  const itemsXml = sortedEpisodes
    .map((ep) => {
      const enclosureUrl = `${origin}/api/rss/${manifest.feedToken}/episodes/${ep.episodeKey}.wav${keySuffix}`;
      const plainNotes = buildEpisodePlainShowNotes(ep);
      const htmlNotes = buildEpisodeHtmlShowNotes(ep);
      const guid = `dispatch:briefing:${ep.briefingId}`;
      const durationFormatted = formatItunesDuration(ep.durationSeconds);

      return [
        '    <item>',
        `      <title>${escapeXml(ep.title)}</title>`,
        `      <guid isPermaLink="false">${escapeXml(guid)}</guid>`,
        `      <pubDate>${escapeXml(toRfc2822Date(ep.publishedAt))}</pubDate>`,
        `      <description>${escapeXml(plainNotes || ep.subtitle || ep.title)}</description>`,
        `      <content:encoded><![CDATA[${escapeCdata(htmlNotes || `<p>${escapeHtml(ep.title)}</p>`)}]]></content:encoded>`,
        `      <enclosure url="${escapeXml(enclosureUrl)}" length="${Math.max(44, Math.floor(ep.byteLength))}" type="audio/wav" />`,
        `      <itunes:title>${escapeXml(ep.title)}</itunes:title>`,
        `      <itunes:subtitle>${escapeXml((ep.subtitle || ep.title).slice(0, 240))}</itunes:subtitle>`,
        `      <itunes:summary>${escapeXml(plainNotes.slice(0, 3900))}</itunes:summary>`,
        `      <itunes:duration>${escapeXml(durationFormatted)}</itunes:duration>`,
        '      <itunes:explicit>false</itunes:explicit>',
        '      <itunes:episodeType>full</itunes:episodeType>',
        '    </item>',
      ].join('\n');
    })
    .join('\n');

  const lastBuildDate = toRfc2822Date(manifest.updatedAt || manifest.createdAt);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
    '  <channel>',
    `    <title>${escapeXml(manifest.title)}</title>`,
    `    <link>${escapeXml(origin)}</link>`,
    `    <description>${escapeXml(manifest.description)}</description>`,
    '    <language>en-us</language>',
    `    <lastBuildDate>${escapeXml(lastBuildDate)}</lastBuildDate>`,
    '    <generator>Dispatch Private Podcast Engine</generator>',
    `    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml" />`,
    `    <itunes:author>${escapeXml(manifest.author)}</itunes:author>`,
    `    <itunes:summary>${escapeXml(manifest.description)}</itunes:summary>`,
    '    <itunes:type>episodic</itunes:type>',
    '    <itunes:explicit>false</itunes:explicit>',
    '    <itunes:block>yes</itunes:block>',
    `    <itunes:image href="${escapeXml(coverUrl)}" />`,
    '    <image>',
    `      <url>${escapeXml(coverUrl)}</url>`,
    `      <title>${escapeXml(manifest.title)}</title>`,
    `      <link>${escapeXml(origin)}</link>`,
    '    </image>',
    '    <itunes:category text="News">',
    '      <itunes:category text="Daily News" />',
    '    </itunes:category>',
    itemsXml,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

// Generate a valid 600x600 dark-editorial podcast cover PNG using Node built-in zlib
let cachedCoverPng: Buffer | null = null;

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function getPodcastCoverPng(): Buffer {
  if (cachedCoverPng) return cachedCoverPng;

  const size = 600;
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);

  const barHeights = [
    48, 86, 128, 72, 168, 224, 146, 256, 152, 212, 118, 174, 96, 122, 56,
  ];
  const barWidth = 14;
  const barGap = 14;
  const totalBarsWidth =
    barHeights.length * barWidth + (barHeights.length - 1) * barGap;
  const barsStartX = Math.floor((size - totalBarsWidth) / 2);
  const centerY = Math.floor(size / 2);

  for (let y = 0; y < size; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const dx = (x - size / 2) / (size / 2);
      const dy = (y - size / 2) / (size / 2);
      const distSq = dx * dx + dy * dy;
      const glow = Math.max(0, 1 - distSq * 0.9);

      let r = Math.round(11 + glow * 8);
      let g = Math.round(13 + glow * 26);
      let b = Math.round(16 + glow * 34);

      const onBorder =
        (x === 32 || x === size - 33) && y >= 32 && y <= size - 33
          ? true
          : (y === 32 || y === size - 33) && x >= 32 && x <= size - 33;
      if (onBorder) {
        r = 34;
        g = 112;
        b = 132;
      }

      if (y === centerY && x >= 68 && x <= size - 68) {
        r = 30;
        g = 62;
        b = 76;
      }

      if (x >= barsStartX && x < barsStartX + totalBarsWidth) {
        const relX = x - barsStartX;
        const slot = barWidth + barGap;
        const barIdx = Math.floor(relX / slot);
        const inBarX = relX % slot;
        if (barIdx >= 0 && barIdx < barHeights.length && inBarX < barWidth) {
          const halfH = Math.floor(barHeights[barIdx] / 2);
          if (Math.abs(y - centerY) <= halfH) {
            const isCenterBar = barIdx === 7 || barIdx === 5 || barIdx === 9;
            r = isCenterBar ? 103 : 34;
            g = isCenterBar ? 232 : 211;
            b = isCenterBar ? 249 : 238;
          }
        }
      }

      const px = rowStart + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw, { level: 6 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  cachedCoverPng = Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
  return cachedCoverPng;
}

export function registerRssRoutes(
  app: Express,
  deps: RssRouteDependencies
): void {
  const { stitchServerWavBuffers, safeTimingEqual, formatApiError } = deps;

  // Podcast artwork PNG endpoint
  app.get('/api/rss/cover.png', (_req, res) => {
    const png = getPodcastCoverPng();
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': png.length,
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(png);
  });

  app.head('/api/rss/cover.png', (_req, res) => {
    const png = getPodcastCoverPng();
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': png.length,
      'Cache-Control': 'public, max-age=86400',
    });
    res.end();
  });

  // 1. Create a new private RSS podcast feed (with optional expiration & password protection)
  app.post('/api/rss/feeds', optionalAuth, async (req: AuthRequest, res) => {
    try {
      const body = (req.body || {}) as {
        title?: string;
        description?: string;
        author?: string;
        expiresAt?: string | null;
        password?: string | null;
      };

      const title =
        String(body.title || '')
          .trim()
          .slice(0, MAX_TITLE_LEN) || 'My Daily Dispatch';
      const description =
        String(body.description || '')
          .trim()
          .slice(0, MAX_DESC_LEN) ||
        'Personalized audio news briefings stitched from your Dispatch Archive.';
      const author =
        String(body.author || '')
          .trim()
          .slice(0, MAX_AUTHOR_LEN) ||
        (typeof req.user?.name === 'string' && req.user.name.trim()) ||
        'Dispatch Personal Audio';

      let expiresAt: string | null = null;
      if (body.expiresAt !== undefined && body.expiresAt !== null && body.expiresAt !== '') {
        const expCheck = normalizeExpiresAtInput(body.expiresAt);
        if (!expCheck.valid) {
          res.status(400).json({ error: expCheck.error });
          return;
        }
        expiresAt = expCheck.value;
      }

      const feedId = crypto.randomBytes(9).toString('base64url');
      const feedToken = crypto.randomBytes(24).toString('base64url');
      const manageToken = crypto.randomBytes(24).toString('base64url');
      const nowIso = new Date().toISOString();

      let passwordProtected = false;
      let passwordSalt: string | undefined;
      let passwordHash: string | undefined;
      let accessKeyToken: string | undefined;

      if (typeof body.password === 'string' && body.password.trim().length > 0) {
        const cleanPass = body.password.trim();
        if (cleanPass.length < MIN_PASSWORD_LEN || cleanPass.length > MAX_PASSWORD_LEN) {
          res.status(400).json({
            error: `Password must be between ${MIN_PASSWORD_LEN} and ${MAX_PASSWORD_LEN} characters.`,
          });
          return;
        }
        passwordSalt = crypto.randomBytes(16).toString('hex');
        passwordHash = hashFeedPassword(cleanPass, passwordSalt);
        accessKeyToken = deriveAccessKeyToken(feedToken, passwordHash, manageToken);
        passwordProtected = true;
      }

      const manifest: StoredRssFeedManifest = {
        feedId,
        feedToken,
        manageToken,
        ownerUid: req.user?.uid,
        ownerEmail: req.user?.email,
        title,
        description,
        author,
        createdAt: nowIso,
        updatedAt: nowIso,
        expiresAt,
        passwordProtected,
        passwordSalt,
        passwordHash,
        accessKeyToken,
        episodes: [],
      };

      await writeFeedManifest(manifest);
      const index = await readTokenIndex();
      index[feedToken] = feedId;
      await writeTokenIndex(index);

      res.status(201).json({
        feed: buildPublicManifest(manifest),
        manageToken,
      });
    } catch (err) {
      const { status, message } = formatApiError(err);
      res.status(status).json({ error: message });
    }
  });

  // 2. Get feed status & episode roster (owner / manageToken authorized)
  app.get('/api/rss/feeds/:feedId', optionalAuth, async (req: AuthRequest, res) => {
    try {
      const { feedId } = req.params;
      const manifest = await readFeedManifest(feedId);
      if (!manifest) {
        res.status(404).json({ error: 'Private RSS feed not found.' });
        return;
      }
      if (!canManageFeed(req, manifest, safeTimingEqual)) {
        res.status(403).json({
          error: 'Not authorized to access this private RSS feed.',
        });
        return;
      }
      res.json({ feed: buildPublicManifest(manifest) });
    } catch (err) {
      const { status, message } = formatApiError(err);
      res.status(status).json({ error: message });
    }
  });

  // 3. Update feed title / description / author / expiration / password protection
  app.patch('/api/rss/feeds/:feedId', optionalAuth, async (req: AuthRequest, res) => {
    try {
      const { feedId } = req.params;
      const manifest = await readFeedManifest(feedId);
      if (!manifest) {
        res.status(404).json({ error: 'Private RSS feed not found.' });
        return;
      }
      if (!canManageFeed(req, manifest, safeTimingEqual)) {
        res.status(403).json({
          error: 'Not authorized to update this private RSS feed.',
        });
        return;
      }

      const body = (req.body || {}) as {
        title?: string;
        description?: string;
        author?: string;
        expiresAt?: string | null;
        passwordProtected?: boolean;
        password?: string | null;
      };

      if (typeof body.title === 'string') {
        const trimmed = body.title.trim().slice(0, MAX_TITLE_LEN);
        if (trimmed) manifest.title = trimmed;
      }
      if (typeof body.description === 'string') {
        const trimmed = body.description.trim().slice(0, MAX_DESC_LEN);
        if (trimmed) manifest.description = trimmed;
      }
      if (typeof body.author === 'string') {
        const trimmed = body.author.trim().slice(0, MAX_AUTHOR_LEN);
        if (trimmed) manifest.author = trimmed;
      }

      // Handle expiration updates
      if ('expiresAt' in body) {
        const expCheck = normalizeExpiresAtInput(body.expiresAt);
        if (!expCheck.valid) {
          res.status(400).json({ error: expCheck.error });
          return;
        }
        manifest.expiresAt = expCheck.value;
      }

      // Handle password protection updates
      if (body.passwordProtected === false) {
        manifest.passwordProtected = false;
        delete manifest.passwordSalt;
        delete manifest.passwordHash;
        delete manifest.accessKeyToken;
      } else if (typeof body.password === 'string') {
        const cleanPass = body.password.trim();
        if (
          cleanPass.length < MIN_PASSWORD_LEN ||
          cleanPass.length > MAX_PASSWORD_LEN
        ) {
          res.status(400).json({
            error: `Password must be between ${MIN_PASSWORD_LEN} and ${MAX_PASSWORD_LEN} characters.`,
          });
          return;
        }
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = hashFeedPassword(cleanPass, salt);
        manifest.passwordSalt = salt;
        manifest.passwordHash = hash;
        manifest.accessKeyToken = deriveAccessKeyToken(
          manifest.feedToken,
          hash,
          manifest.manageToken
        );
        manifest.passwordProtected = true;
      } else if (body.passwordProtected === true && !manifest.passwordHash) {
        res.status(400).json({
          error: 'Provide a password to enable password protection.',
        });
        return;
      }

      manifest.updatedAt = new Date().toISOString();
      await writeFeedManifest(manifest);
      res.json({ feed: buildPublicManifest(manifest) });
    } catch (err) {
      const { status, message } = formatApiError(err);
      res.status(status).json({ error: message });
    }
  });

  // 4. Upsert a stitched full-edition episode into the private RSS feed
  app.put(
    '/api/rss/feeds/:feedId/episodes/:briefingId',
    optionalAuth,
    async (req: AuthRequest, res) => {
      try {
        const { feedId, briefingId } = req.params;
        if (!briefingId || briefingId.length > 120) {
          res.status(400).json({ error: 'Invalid briefing identifier.' });
          return;
        }

        const manifest = await readFeedManifest(feedId);
        if (!manifest) {
          res.status(404).json({ error: 'Private RSS feed not found.' });
          return;
        }
        if (!canManageFeed(req, manifest, safeTimingEqual)) {
          res.status(403).json({
            error: 'Not authorized to sync episodes to this feed.',
          });
          return;
        }

        const feedDir = resolveFeedDir(feedId);
        if (!feedDir) {
          res.status(400).json({ error: 'Invalid feed path.' });
          return;
        }

        const body = (req.body || {}) as {
          title?: string;
          subtitle?: string;
          publishedAt?: string;
          takeaways?: string[];
          articleTitles?: string[];
          format?: BroadcastFormat;
          audioSignature?: string;
          segments?: Array<{
            title?: string;
            category?: string;
            keyPoint?: string;
            estimatedSeconds?: number;
            audioDurationSeconds?: number;
            audioBase64?: string;
          }>;
        };

        if (!Array.isArray(body.segments) || body.segments.length === 0) {
          res.status(400).json({
            error: 'Provide at least one briefing chapter to sync.',
          });
          return;
        }

        const wavBuffers: Buffer[] = [];
        const chapterNotes: RssEpisodeChapterNote[] = [];
        let cursorSeconds = 0;

        for (let i = 0; i < body.segments.length; i++) {
          const seg = body.segments[i];
          if (
            typeof seg.audioBase64 !== 'string' ||
            seg.audioBase64.length < 64
          ) {
            continue;
          }
          const wavBuf = Buffer.from(seg.audioBase64, 'base64');
          if (wavBuf.length < 44) continue;

          const parsedDur =
            parseWavDurationSeconds(wavBuf) ||
            Number(seg.audioDurationSeconds) ||
            Number(seg.estimatedSeconds) ||
            30;

          chapterNotes.push({
            title: String(seg.title || `Chapter ${i + 1}`).slice(0, 140),
            category: String(seg.category || 'News').slice(0, 60),
            startSeconds: Math.round(cursorSeconds),
            durationSeconds: Math.max(1, Math.round(parsedDur)),
            keyPoint: String(seg.keyPoint || '').slice(0, 320),
          });

          wavBuffers.push(wavBuf);
          cursorSeconds += parsedDur + 0.35;
        }

        if (wavBuffers.length === 0) {
          res.status(400).json({
            error:
              'This briefing has no recorded audio segments to publish yet.',
          });
          return;
        }

        const stitchedWav = stitchServerWavBuffers(wavBuffers);
        if (!stitchedWav || stitchedWav.length < 44) {
          res.status(400).json({
            error: 'Unable to stitch recorded chapter audio.',
          });
          return;
        }

        const episodeKey = deriveEpisodeKey(briefingId);
        const wavPath = resolveEpisodeWavPath(feedDir, episodeKey);
        if (!wavPath) {
          res.status(400).json({ error: 'Invalid episode audio path.' });
          return;
        }

        const tmpWav = `${wavPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        await fs.writeFile(tmpWav, stitchedWav);
        await fs.rename(tmpWav, wavPath);

        const totalDurationSeconds = Math.max(
          1,
          Math.round(parseWavDurationSeconds(stitchedWav) || cursorSeconds)
        );

        const episodeRecord: StoredRssEpisode = {
          briefingId,
          episodeKey,
          title:
            String(body.title || 'Daily Dispatch Edition')
              .trim()
              .slice(0, 180) || 'Daily Dispatch Edition',
          subtitle: String(body.subtitle || '').trim().slice(0, 320),
          publishedAt:
            typeof body.publishedAt === 'string' &&
            !Number.isNaN(new Date(body.publishedAt).getTime())
              ? body.publishedAt
              : new Date().toISOString(),
          durationSeconds: totalDurationSeconds,
          byteLength: stitchedWav.length,
          audioSignature: String(body.audioSignature || '').slice(0, 128),
          takeaways: Array.isArray(body.takeaways)
            ? body.takeaways.slice(0, 12).map((t) => String(t).slice(0, 320))
            : [],
          chapters: chapterNotes,
          articleTitles: Array.isArray(body.articleTitles)
            ? body.articleTitles.slice(0, 30).map((s) => String(s).slice(0, 180))
            : [],
          format: body.format === 'solo' ? 'solo' : 'podcast',
        };

        const existingIdx = manifest.episodes.findIndex(
          (ep) => ep.briefingId === briefingId
        );
        if (existingIdx >= 0) {
          manifest.episodes[existingIdx] = episodeRecord;
        } else {
          manifest.episodes.unshift(episodeRecord);
          if (manifest.episodes.length > MAX_EPISODES_PER_FEED) {
            const dropped = manifest.episodes.splice(MAX_EPISODES_PER_FEED);
            for (const oldEp of dropped) {
              const oldPath = resolveEpisodeWavPath(feedDir, oldEp.episodeKey);
              if (oldPath) {
                await fs.rm(oldPath, { force: true }).catch(() => {});
              }
            }
          }
        }

        manifest.updatedAt = new Date().toISOString();
        await writeFeedManifest(manifest);

        res.json({
          feed: buildPublicManifest(manifest),
          episode: {
            ...episodeRecord,
            audioPath: `/api/rss/${manifest.feedToken}/episodes/${episodeKey}.wav`,
          },
        });
      } catch (err) {
        const { status, message } = formatApiError(err);
        res.status(status).json({ error: message });
      }
    }
  );

  // 5. Remove a deleted archived briefing from the private RSS feed
  app.delete(
    '/api/rss/feeds/:feedId/episodes/:briefingId',
    optionalAuth,
    async (req: AuthRequest, res) => {
      try {
        const { feedId, briefingId } = req.params;
        const manifest = await readFeedManifest(feedId);
        if (!manifest) {
          res.status(404).json({ error: 'Private RSS feed not found.' });
          return;
        }
        if (!canManageFeed(req, manifest, safeTimingEqual)) {
          res.status(403).json({
            error: 'Not authorized to modify this private RSS feed.',
          });
          return;
        }

        const feedDir = resolveFeedDir(feedId);
        const existing = manifest.episodes.find(
          (ep) => ep.briefingId === briefingId
        );
        if (existing && feedDir) {
          const wavPath = resolveEpisodeWavPath(feedDir, existing.episodeKey);
          if (wavPath) {
            await fs.rm(wavPath, { force: true }).catch(() => {});
          }
          manifest.episodes = manifest.episodes.filter(
            (ep) => ep.briefingId !== briefingId
          );
          manifest.updatedAt = new Date().toISOString();
          await writeFeedManifest(manifest);
        }

        res.json({ feed: buildPublicManifest(manifest) });
      } catch (err) {
        const { status, message } = formatApiError(err);
        res.status(status).json({ error: message });
      }
    }
  );

  // 6. Regenerate private RSS feed URL token (immediately revokes old URL & rotates signed key)
  app.post(
    '/api/rss/feeds/:feedId/regenerate',
    optionalAuth,
    async (req: AuthRequest, res) => {
      try {
        const { feedId } = req.params;
        const manifest = await readFeedManifest(feedId);
        if (!manifest) {
          res.status(404).json({ error: 'Private RSS feed not found.' });
          return;
        }
        if (!canManageFeed(req, manifest, safeTimingEqual)) {
          res.status(403).json({
            error: 'Not authorized to regenerate this RSS feed URL.',
          });
          return;
        }

        const oldToken = manifest.feedToken;
        const nextToken = crypto.randomBytes(24).toString('base64url');
        manifest.feedToken = nextToken;
        if (manifest.passwordProtected && manifest.passwordHash) {
          manifest.accessKeyToken = deriveAccessKeyToken(
            nextToken,
            manifest.passwordHash,
            manifest.manageToken
          );
        }
        manifest.updatedAt = new Date().toISOString();

        await writeFeedManifest(manifest);
        const index = await readTokenIndex();
        delete index[oldToken];
        index[nextToken] = feedId;
        await writeTokenIndex(index);

        res.json({ feed: buildPublicManifest(manifest) });
      } catch (err) {
        const { status, message } = formatApiError(err);
        res.status(status).json({ error: message });
      }
    }
  );

  // 7. Public token-gated RSS 2.0 + Apple Podcasts XML endpoint (enforces expiration & password)
  const handleRssXmlRequest = async (
    req: Request,
    res: Response,
    isHead: boolean
  ) => {
    const token = req.params.token;
    const found = await resolveFeedByToken(token, safeTimingEqual);
    if (!found) {
      res
        .status(404)
        .type('text/plain')
        .send(
          'Private podcast feed not found or URL has been regenerated.'
        );
      return;
    }

    // Check expiration gate (410 Gone)
    if (isFeedManifestExpired(found.manifest)) {
      res
        .status(410)
        .type('text/plain')
        .send(
          'This private podcast RSS feed link has expired. Reactivate or extend the expiration date in Dispatch Archive > Export as RSS.'
        );
      return;
    }

    // Check password / signed access key gate (401 Unauthorized + WWW-Authenticate)
    const authResult = verifyFeedPasswordOrAccessKey(
      req,
      found.manifest,
      safeTimingEqual
    );
    if (!authResult.authorized) {
      res.setHeader(
        'WWW-Authenticate',
        'Basic realm="Dispatch Private Podcast Feed", charset="UTF-8"'
      );
      res
        .status(401)
        .type('text/plain')
        .send(
          'Password required for this private podcast RSS feed. Enter any username and your feed password, or use the signed app access key URL.'
        );
      return;
    }

    const origin = resolvePublicOrigin(req);
    const xml = buildRssXml(
      found.manifest,
      origin,
      authResult.usedQueryKey
    );
    const buf = Buffer.from(xml, 'utf8');
    const etag = `"${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 20)}"`;

    const headers: Record<string, string | number> = {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'private, no-cache, must-revalidate',
      ETag: etag,
      'X-Robots-Tag': 'noindex, nofollow',
    };

    if (req.query.download === '1') {
      const slug = found.manifest.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48);
      headers['Content-Disposition'] = `attachment; filename="${slug || 'dispatch-private-feed'}.xml"`;
    }

    res.writeHead(200, headers);
    if (isHead) {
      res.end();
    } else {
      res.end(buf);
      void recordRssPollEvent(req, found.manifest);
    }
  };

  app.get('/api/rss/:token.xml', (req, res) => {
    void handleRssXmlRequest(req, res, false);
  });

  app.head('/api/rss/:token.xml', (req, res) => {
    void handleRssXmlRequest(req, res, true);
  });

  // 7b. Authenticated Feed Performance Analytics Snapshot endpoint
  app.get(
    '/api/rss/feeds/:feedId/analytics',
    optionalAuth,
    async (req: AuthRequest, res) => {
      try {
        const { feedId } = req.params;
        const manifest = await readFeedManifest(feedId);
        if (!manifest) {
          res.status(404).json({ error: 'Private RSS feed not found.' });
          return;
        }
        if (!canManageFeed(req, manifest, safeTimingEqual)) {
          res.status(403).json({
            error: 'Not authorized to inspect analytics for this private RSS feed.',
          });
          return;
        }
        res.json({
          analytics: buildAnalyticsSnapshot(manifest),
        });
      } catch (err) {
        const { status, message } = formatApiError(err);
        res.status(status).json({ error: message });
      }
    }
  );

  // 8. Public token-gated stitched episode WAV endpoint (enforces expiration, password, & HTTP Range)
  const handleEpisodeAudioRequest = async (
    req: Request,
    res: Response,
    isHead: boolean
  ) => {
    const { token, episodeKey } = req.params;
    const found = await resolveFeedByToken(token, safeTimingEqual);
    if (!found) {
      res
        .status(404)
        .json({ error: 'Private podcast feed not found or revoked.' });
      return;
    }

    if (isFeedManifestExpired(found.manifest)) {
      res.status(410).json({
        error: 'This private podcast feed link has expired.',
        expired: true,
      });
      return;
    }

    const authResult = verifyFeedPasswordOrAccessKey(
      req,
      found.manifest,
      safeTimingEqual
    );
    if (!authResult.authorized) {
      res.setHeader(
        'WWW-Authenticate',
        'Basic realm="Dispatch Private Podcast Feed", charset="UTF-8"'
      );
      res.status(401).json({
        error: 'Password required to stream this private podcast episode.',
      });
      return;
    }

    const episode = found.manifest.episodes.find(
      (ep) => ep.episodeKey === episodeKey
    );
    if (!episode) {
      res
        .status(404)
        .json({ error: 'Episode not found in this private feed.' });
      return;
    }

    const wavPath = resolveEpisodeWavPath(found.dir, episodeKey);
    if (!wavPath) {
      res.status(404).json({ error: 'Invalid episode audio identifier.' });
      return;
    }

    try {
      const stat = await fs.stat(wavPath);
      const totalSize = stat.size;
      const etag = `"ep-${episodeKey}-${totalSize}-${Math.floor(stat.mtimeMs)}"`;

      if (isHead) {
        res.writeHead(200, {
          'Accept-Ranges': 'bytes',
          'Content-Length': totalSize,
          'Content-Type': 'audio/wav',
          'Cache-Control': 'private, max-age=3600',
          ETag: etag,
          'X-Robots-Tag': 'noindex, nofollow',
        });
        res.end();
        return;
      }

      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (!match || (!match[1] && !match[2])) {
          res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
          res.end();
          return;
        }

        let start: number;
        let end: number;
        if (match[1] === '') {
          const suffixLength = Number(match[2]);
          start = Math.max(0, totalSize - suffixLength);
          end = totalSize - 1;
        } else {
          start = Number(match[1]);
          end = match[2]
            ? Math.min(Number(match[2]), totalSize - 1)
            : totalSize - 1;
        }

        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          start < 0 ||
          start >= totalSize ||
          end < start
        ) {
          res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
          res.end();
          return;
        }

        const chunkSize = end - start + 1;
        const handle = await fs.open(wavPath, 'r');
        try {
          const slice = Buffer.alloc(chunkSize);
          await handle.read(slice, 0, chunkSize, start);
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': 'audio/wav',
            'Cache-Control': 'private, max-age=3600',
            ETag: etag,
            'X-Robots-Tag': 'noindex, nofollow',
          });
          res.end(slice);
          if (start === 0) {
            void recordEpisodeDownloadEvent(req, found.manifest, episode.briefingId);
          }
        } finally {
          await handle.close();
        }
        return;
      }

      const fullBuf = await fs.readFile(wavPath);
      res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Content-Length': fullBuf.length,
        'Content-Type': 'audio/wav',
        'Cache-Control': 'private, max-age=3600',
        ETag: etag,
        'X-Robots-Tag': 'noindex, nofollow',
      });
      res.end(fullBuf);
      void recordEpisodeDownloadEvent(req, found.manifest, episode.briefingId);
    } catch {
      res.status(404).json({ error: 'Episode audio file is unavailable.' });
    }
  };

  app.get('/api/rss/:token/episodes/:episodeKey.wav', (req, res) => {
    void handleEpisodeAudioRequest(req, res, false);
  });

  app.head('/api/rss/:token/episodes/:episodeKey.wav', (req, res) => {
    void handleEpisodeAudioRequest(req, res, true);
  });
}
