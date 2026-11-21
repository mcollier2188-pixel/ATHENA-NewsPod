import type { Request, Response, NextFunction } from 'express';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { adminAuth } from '../lib/firebase-admin.ts';

export const PRINCIPAL_OWNER_EMAIL = 'mcollier2188@gmail.com';

export interface AuthRequest extends Request {
  user?: DecodedIdToken;
}

export function isVerifiedPrincipalToken(
  decoded?: DecodedIdToken | null
): boolean {
  return Boolean(
    decoded &&
      decoded.email_verified === true &&
      typeof decoded.email === 'string' &&
      decoded.email.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL
  );
}

export function extractTokenAuthMetadata(decoded?: DecodedIdToken | null): {
  emailVerified: boolean;
  authProvider: string;
  tokenAuthTimeSec?: number;
} {
  const emailVerified = Boolean(decoded?.email_verified);
  const rawProvider =
    decoded?.firebase && typeof decoded.firebase.sign_in_provider === 'string'
      ? decoded.firebase.sign_in_provider
      : 'google.com';
  const tokenAuthTimeSec =
    typeof decoded?.auth_time === 'number' && Number.isFinite(decoded.auth_time)
      ? decoded.auth_time
      : typeof decoded?.iat === 'number' && Number.isFinite(decoded.iat)
        ? decoded.iat
        : undefined;

  return {
    emailVerified,
    authProvider: rawProvider,
    tokenAuthTimeSec,
  };
}

export interface ClientSessionTelemetry {
  deviceSummary: string;
  ipAddress: string;
  clientContext: string;
}

export function extractClientIp(req: Request): string {
  const forwardedHeader = req.headers['x-forwarded-for'];
  const forwardedRaw = Array.isArray(forwardedHeader)
    ? forwardedHeader[0]
    : typeof forwardedHeader === 'string'
      ? forwardedHeader.split(',')[0]
      : '';

  const cfIpHeader = req.headers['cf-connecting-ip'];
  const cfIp = Array.isArray(cfIpHeader) ? cfIpHeader[0] : cfIpHeader;

  const realIpHeader = req.headers['x-real-ip'];
  const realIp = Array.isArray(realIpHeader) ? realIpHeader[0] : realIpHeader;

  const rawCandidate = String(
    forwardedRaw || cfIp || realIp || req.ip || req.socket?.remoteAddress || ''
  )
    .trim()
    .slice(0, 80);

  if (!rawCandidate) return 'Unknown IP';

  let cleaned = rawCandidate;
  if (cleaned.startsWith('[') && cleaned.includes(']')) {
    cleaned = cleaned.slice(1, cleaned.indexOf(']'));
  }
  if (cleaned.toLowerCase().startsWith('::ffff:')) {
    cleaned = cleaned.slice('::ffff:'.length);
  }
  if (cleaned === '::1') {
    cleaned = '127.0.0.1';
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(cleaned)) {
    cleaned = cleaned.split(':')[0] || cleaned;
  }

  if (!/^[0-9a-fA-F:.]{2,45}$/.test(cleaned)) {
    return 'Unknown IP';
  }

  return cleaned;
}

export function extractDeviceSummary(req: Request): string {
  const ua = String(req.headers['user-agent'] || '').slice(0, 320);
  if (!ua) return 'Web Client';

  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari';
  else if (/curl\/|HTTPie|PostmanRuntime/i.test(ua)) browser = 'CLI / API';

  let os = '';
  if (/CrOS/i.test(ua)) os = 'ChromeOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPad/i.test(ua)) os = 'iPadOS';
  else if (/iPhone|iPod/i.test(ua)) os = 'iOS';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let formFactor = 'Desktop';
  if (browser === 'CLI / API') {
    formFactor = 'CLI';
  } else if (/iPad|Tablet/i.test(ua)) {
    formFactor = 'Tablet';
  } else if (/Mobile|Android|iPhone|iPod/i.test(ua)) {
    formFactor = 'Mobile';
  }

  const base = os ? `${browser} · ${os}` : browser;
  return formFactor === 'CLI' ? base : `${base} (${formFactor})`;
}

export function extractClientSessionTelemetry(req: Request): ClientSessionTelemetry {
  const deviceSummary = extractDeviceSummary(req).slice(0, 80);
  const ipAddress = extractClientIp(req).slice(0, 45);
  const clientContext = (
    ipAddress && ipAddress !== 'Unknown IP'
      ? `${deviceSummary} · ${ipAddress}`
      : deviceSummary
  ).slice(0, 120);

  return {
    deviceSummary,
    ipAddress,
    clientContext,
  };
}

export function describeClientContext(req: Request): string {
  return extractClientSessionTelemetry(req).clientContext;
}

export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Missing sign-in token.' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    res.status(401).json({ error: 'Unauthorized: Empty sign-in token.' });
    return;
  }

  try {
    const decodedToken = await adminAuth.verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Error verifying Firebase ID token:', error);
    res.status(401).json({ error: 'Unauthorized: Session expired or invalid token.' });
  }
};

export const optionalAuth = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next();
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    next();
    return;
  }

  try {
    req.user = await adminAuth.verifyIdToken(token);
  } catch {
    // Proceed as unauthenticated caller when optional token is expired or invalid
  }
  next();
};
