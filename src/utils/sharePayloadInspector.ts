export type ShareFindingCategory =
  | 'secret_credential'
  | 'financial_card'
  | 'pii_government_id'
  | 'unauthorized_field'
  | 'internal_network'
  | 'pii_email'
  | 'pii_phone'
  | 'pii_address';

export type ShareFindingSeverity = 'critical' | 'high' | 'medium';

export interface ShareSecurityFinding {
  id: string;
  category: ShareFindingCategory;
  categoryLabel: string;
  severity: ShareFindingSeverity;
  fieldPath: string;
  maskedPreview: string;
  reason: string;
  remediation: string;
}

export interface SharePayloadInspectionReport {
  clean: boolean;
  highestSeverity: ShareFindingSeverity | 'none';
  findingCount: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  categories: ShareFindingCategory[];
  findings: ShareSecurityFinding[];
}

const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'me.com',
  'yahoo.com',
  'yahoo.co.uk',
  'proton.me',
  'protonmail.com',
  'aol.com',
]);

const UNAUTHORIZED_OBJECT_KEYS = new Set([
  'creatorEmail',
  'creatorUid',
  'ownerEmail',
  'manageToken',
  'lockedSections',
  'mediaCollection',
  'password',
  'passcode',
  'secret',
  'apiKey',
  'api_key',
  'privateKey',
  'private_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'internalNotes',
  'sessionToken',
]);

const NON_PROSE_ENUM_KEYS = new Set([
  'shareId',
  'kind',
  'sharePath',
  'status',
  'ownerId',
  'createdAt',
  'updatedAt',
  'expiresAt',
  'createdAtIso',
  'expiresAtIso',
  'briefingCreatedAt',
  'clientUpdatedAt',
  'lastImportedAt',
  'scrubbedAtIso',
  'relinkedFromShareId',
  'relinkedToShareId',
  'format',
  'tone',
  'voiceTone',
  'voiceName',
  'coHostVoiceName',
  'fontMood',
  'canvasMode',
  'primary',
  'accent',
  'onPrimary',
  'onAccent',
  'accentText',
  'heroKickerText',
  'hex',
  'role',
  'headingFont',
  'bodyFont',
  'monoFont',
  'headingCategory',
  'bodyCategory',
  'audioUrl',
  'downloadUrl',
  'projectId',
  'id',
]);

const MEDIA_REF_KEYS = new Set([
  'logoRef',
  'photoRef',
  'logoDataUrl',
  'photoDataUrl',
  'dataUrl',
  'audioBase64',
]);

// Regex detectors (evaluated with fresh RegExp or reset lastIndex)
const SECRET_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'Secret API key', regex: /\b(?:sk|rk)_(?:live|test|proj)_[0-9A-Za-z_-]{16,}\b/g },
  { label: 'Provider secret key', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{25,}\b/g },
  { label: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'Slack token', regex: /\bxox[baprs]-[0-9A-Za-z-]{15,}\b/g },
  {
    label: 'Signed JWT token',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  { label: 'Bearer authorization token', regex: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}\b/gi },
  { label: 'PEM private key header', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    label: 'Inline credential assignment',
    regex: /\b(?:password|passwd|api[_-]?key|client[_-]?secret|auth[_-]?token)\s*[:=]\s*['"]?[^\s'",;]{6,}['"]?/gi,
  },
];

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

const US_SSN_REGEX = /\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g;

const UK_NINO_REGEX =
  /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi;

const CARD_CANDIDATE_REGEX = /\b(?:\d[ -]*?){13,19}\b/g;

const PHONE_REGEX =
  /(?:\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}|\b07\d{3}[\s.-]?\d{6}\b|\(\d{3}\)\s?\d{3}[\s.-]\d{4}\b|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b)/g;

const UK_POSTCODE_REGEX = /\b[A-Z]{1,2}\d[A-Z\d]?\s+\d[A-Z]{2}\b/g;

const STREET_ADDRESS_REGEX =
  /\b\d{1,5}\s+[A-Z][a-zA-Z0-9.'-]+(?:\s+[A-Z][a-zA-Z0-9.'-]+){0,3}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Close|Gardens|Place|Pl)\b/g;

const INTERNAL_NETWORK_REGEX =
  /(?:https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(?::\d+)?[^\s"'<>]*|\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})\b)/gi;

const ISO_DATE_LIKE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/;

export function passesLuhnCheck(rawCandidate: string): boolean {
  const digits = rawCandidate.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  // Reject trivial repeated digits
  if (/^(\d)\1+$/.test(digits)) return false;
  // Require standard Major Industry Identifier prefix (3=Amex/Diners, 4=Visa, 5=Mastercard, 6=Discover)
  const first = digits[0];
  if (first !== '3' && first !== '4' && first !== '5' && first !== '6') return false;

  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '[masked-email]';
  if (local.length <= 2) return `${local[0] || '*'}***@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

function maskSecret(val: string): string {
  const clean = val.trim();
  if (clean.length <= 8) return '••••••••';
  return `${clean.slice(0, 4)}••••••${clean.slice(-3)}`;
}

function maskDigitsKeepEnds(val: string): string {
  const clean = val.trim();
  if (clean.length <= 4) return '••••';
  return `${clean.slice(0, 2)}••••••${clean.slice(-2)}`;
}

function maskTextPreview(val: string, maxVisible = 28): string {
  const clean = val.replace(/\s+/g, ' ').trim();
  if (!clean) return '[empty]';
  if (clean.length <= 8) return `${clean.slice(0, 2)}•••`;
  const prefix = clean.slice(0, Math.min(12, Math.floor(maxVisible / 2)));
  return `${prefix}••• (${clean.length} chars)`;
}

function isRedactedPlaceholder(val: string): boolean {
  return /^\[redacted-[a-z-]+\]$/i.test(val.trim());
}

export interface InspectShareOptions {
  knownStudioEmails?: Set<string>;
}

export function inspectSharePayloadForPiiAndSecrets(
  record: Record<string, unknown>,
  options: InspectShareOptions = {}
): SharePayloadInspectionReport {
  const findings: ShareSecurityFinding[] = [];
  const seenKeys = new Set<string>();

  const pushFinding = (finding: Omit<ShareSecurityFinding, 'id'>) => {
    const dedupeKey = `${finding.category}:${finding.fieldPath}:${finding.maskedPreview}`;
    if (seenKeys.has(dedupeKey)) return;
    seenKeys.add(dedupeKey);
    findings.push({
      ...finding,
      id: `f_${findings.length + 1}_${finding.category}`,
    });
  };

  const inspectString = (value: string, fieldPath: string, leafKey: string) => {
    const trimmed = value.trim();
    if (!trimmed || isRedactedPlaceholder(trimmed)) return;
    if (NON_PROSE_ENUM_KEYS.has(leafKey)) return;

    // Skip base64 data URLs for prose regexes (only check if an inline URL leaks localhost/private IP)
    if (MEDIA_REF_KEYS.has(leafKey) || trimmed.startsWith('data:')) {
      if (!trimmed.startsWith('data:')) {
        INTERNAL_NETWORK_REGEX.lastIndex = 0;
        const netMatch = INTERNAL_NETWORK_REGEX.exec(trimmed);
        if (netMatch) {
          pushFinding({
            category: 'internal_network',
            categoryLabel: 'Internal Network Endpoint',
            severity: 'high',
            fieldPath,
            maskedPreview: netMatch[0].slice(0, 36),
            reason: 'Private or loopback network address serialized in media URL.',
            remediation: 'Clear internal media URL from public share payload.',
          });
        }
      }
      return;
    }

    // 1. Unauthorized private text fields accidentally non-empty in public share payload
    if (leafKey === 'siteNotes') {
      pushFinding({
        category: 'unauthorized_field',
        categoryLabel: 'Private Studio Notes',
        severity: 'high',
        fieldPath,
        maskedPreview: maskTextPreview(trimmed),
        reason: 'Internal workspace siteNotes were serialized into a public-facing mockup share.',
        remediation: 'Strip private siteNotes to an empty string and rotate share link.',
      });
    } else if (leafKey === 'listenerFocus' && trimmed.length > 0) {
      pushFinding({
        category: 'unauthorized_field',
        categoryLabel: 'Private Listener Prompt',
        severity: 'medium',
        fieldPath,
        maskedPreview: maskTextPreview(trimmed),
        reason: 'Personal listenerFocus prompt instructions were serialized into the public briefing.',
        remediation: 'Clear listenerFocus prompt from public briefing payload and rotate link.',
      });
    }

    // 2. API keys, tokens, credentials
    for (const pattern of SECRET_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(trimmed)) !== null) {
        pushFinding({
          category: 'secret_credential',
          categoryLabel: 'Credential / Secret Token',
          severity: 'critical',
          fieldPath,
          maskedPreview: maskSecret(match[0]),
          reason: `${pattern.label} detected inside public share field.`,
          remediation: 'Redact credential token to [redacted-secret] and invalidate compromised link.',
        });
      }
    }

    // 3. Government / National IDs (US SSN & UK National Insurance)
    US_SSN_REGEX.lastIndex = 0;
    let ssnMatch: RegExpExecArray | null;
    while ((ssnMatch = US_SSN_REGEX.exec(trimmed)) !== null) {
      pushFinding({
        category: 'pii_government_id',
        categoryLabel: 'Government / Tax ID',
        severity: 'critical',
        fieldPath,
        maskedPreview: `•••-••-${ssnMatch[0].slice(-4)}`,
        reason: 'Social Security / taxpayer identifier pattern detected in public payload.',
        remediation: 'Redact identifier to [redacted-id] and rotate capability URL.',
      });
    }

    UK_NINO_REGEX.lastIndex = 0;
    let ninoMatch: RegExpExecArray | null;
    while ((ninoMatch = UK_NINO_REGEX.exec(trimmed)) !== null) {
      pushFinding({
        category: 'pii_government_id',
        categoryLabel: 'National Insurance ID',
        severity: 'critical',
        fieldPath,
        maskedPreview: maskDigitsKeepEnds(ninoMatch[0]),
        reason: 'UK National Insurance identifier pattern detected in public payload.',
        remediation: 'Redact identifier to [redacted-id] and rotate capability URL.',
      });
    }

    // 4. Luhn-verified Payment Cards
    CARD_CANDIDATE_REGEX.lastIndex = 0;
    let cardMatch: RegExpExecArray | null;
    while ((cardMatch = CARD_CANDIDATE_REGEX.exec(trimmed)) !== null) {
      const candidate = cardMatch[0];
      if (!ISO_DATE_LIKE_RE.test(candidate) && passesLuhnCheck(candidate)) {
        const digits = candidate.replace(/\D/g, '');
        pushFinding({
          category: 'financial_card',
          categoryLabel: 'Payment Card (Luhn)',
          severity: 'critical',
          fieldPath,
          maskedPreview: `•••• •••• •••• ${digits.slice(-4)}`,
          reason: 'Luhn-valid payment card sequence serialized in public share payload.',
          remediation: 'Redact card digits to [redacted-card] and revoke leaked share URL.',
        });
      }
    }

    // 5. Email Addresses
    EMAIL_REGEX.lastIndex = 0;
    let emailMatch: RegExpExecArray | null;
    while ((emailMatch = EMAIL_REGEX.exec(trimmed)) !== null) {
      const fullEmail = emailMatch[0];
      const domain = (emailMatch[1] || '').toLowerCase();
      if (domain === 'example.com' || domain === 'dispatch.local') continue;
      const isPersonalOrAccount =
        PERSONAL_EMAIL_DOMAINS.has(domain) ||
        Boolean(options.knownStudioEmails?.has(fullEmail.toLowerCase())) ||
        leafKey !== 'email';
      pushFinding({
        category: 'pii_email',
        categoryLabel: isPersonalOrAccount ? 'Personal / Account Email' : 'Serialized Contact Email',
        severity: isPersonalOrAccount ? 'high' : 'medium',
        fieldPath,
        maskedPreview: maskEmail(fullEmail),
        reason: isPersonalOrAccount
          ? 'Personal or studio account email address exposed in public share payload.'
          : 'Direct contact email address serialized inside public mockup brand payload.',
        remediation:
          leafKey === 'email'
            ? 'Clear brand.email field and re-issue clean share URL.'
            : 'Redact inline email to [redacted-email] and re-issue clean share URL.',
      });
    }

    // 6. Phone Numbers
    if (!ISO_DATE_LIKE_RE.test(trimmed) && leafKey !== 'sourceUrl') {
      PHONE_REGEX.lastIndex = 0;
      let phoneMatch: RegExpExecArray | null;
      while ((phoneMatch = PHONE_REGEX.exec(trimmed)) !== null) {
        const rawPhone = phoneMatch[0];
        const digitCount = rawPhone.replace(/\D/g, '').length;
        if (digitCount < 10 || digitCount > 15) continue;
        // Skip if already flagged as a Luhn card
        if (digitCount >= 13 && passesLuhnCheck(rawPhone)) continue;
        pushFinding({
          category: 'pii_phone',
          categoryLabel: leafKey === 'phone' ? 'Serialized Phone Number' : 'Inline Phone PII',
          severity: leafKey === 'phone' ? 'medium' : 'high',
          fieldPath,
          maskedPreview: maskDigitsKeepEnds(rawPhone),
          reason:
            leafKey === 'phone'
              ? 'Telephone number serialized inside public mockup brand payload.'
              : 'Direct telephone number detected inside public share text.',
          remediation:
            leafKey === 'phone'
              ? 'Clear brand.phone field and re-issue clean share URL.'
              : 'Redact inline phone number to [redacted-phone] and rotate share URL.',
        });
      }
    }

    // 7. Street / Postal Addresses
    if (leafKey === 'address') {
      pushFinding({
        category: 'pii_address',
        categoryLabel: 'Physical Address PII',
        severity: 'medium',
        fieldPath,
        maskedPreview: maskTextPreview(trimmed, 24),
        reason: 'Physical street or premises address serialized inside public mockup brand payload.',
        remediation: 'Clear brand.address field and re-issue clean share URL.',
      });
    } else if (leafKey !== 'sourceUrl') {
      UK_POSTCODE_REGEX.lastIndex = 0;
      const ukPost = UK_POSTCODE_REGEX.exec(trimmed);
      STREET_ADDRESS_REGEX.lastIndex = 0;
      const street = STREET_ADDRESS_REGEX.exec(trimmed);
      const matchedAddr = street?.[0] || ukPost?.[0];
      if (matchedAddr) {
        pushFinding({
          category: 'pii_address',
          categoryLabel: 'Inline Street / Postcode',
          severity: 'medium',
          fieldPath,
          maskedPreview: maskTextPreview(matchedAddr, 20),
          reason: 'Physical street address or postal code detected inside public share copy.',
          remediation: 'Redact inline address to [redacted-address] and rotate share URL.',
        });
      }
    }

    // 8. Internal / Private Network Endpoints
    INTERNAL_NETWORK_REGEX.lastIndex = 0;
    let netMatch: RegExpExecArray | null;
    while ((netMatch = INTERNAL_NETWORK_REGEX.exec(trimmed)) !== null) {
      pushFinding({
        category: 'internal_network',
        categoryLabel: 'Internal Network Endpoint',
        severity: 'high',
        fieldPath,
        maskedPreview: netMatch[0].slice(0, 36),
        reason: 'Private RFC1918 IP or localhost endpoint serialized in public share payload.',
        remediation: 'Strip or redact internal network endpoint and rotate share URL.',
      });
    }
  };

  const walk = (node: unknown, currentPath: string, leafKey: string, depth: number) => {
    if (depth > 10 || node === null || node === undefined) return;

    if (typeof node === 'string') {
      inspectString(node, currentPath, leafKey);
      return;
    }

    if (Array.isArray(node)) {
      for (let idx = 0; idx < node.length; idx++) {
        walk(node[idx], `${currentPath}[${idx}]`, leafKey, depth + 1);
      }
      return;
    }

    if (typeof node === 'object') {
      // Skip Firestore Timestamp-like objects ({ seconds, nanoseconds } or toDate())
      const asObj = node as Record<string, unknown>;
      if (typeof asObj.toDate === 'function' || ('seconds' in asObj && 'nanoseconds' in asObj)) {
        return;
      }

      for (const [key, childVal] of Object.entries(asObj)) {
        const nextPath = currentPath ? `${currentPath}.${key}` : key;

        if (UNAUTHORIZED_OBJECT_KEYS.has(key) && childVal !== undefined && childVal !== null && childVal !== '') {
          const preview =
            typeof childVal === 'string'
              ? key.toLowerCase().includes('email')
                ? maskEmail(childVal)
                : maskSecret(childVal)
              : `[object: ${Object.keys(childVal as object).length} keys]`;
          pushFinding({
            category: 'unauthorized_field',
            categoryLabel: 'Unauthorized Metadata Key',
            severity:
              key === 'manageToken' ||
              key.toLowerCase().includes('secret') ||
              key.toLowerCase().includes('key') ||
              key.toLowerCase().includes('token') ||
              key.toLowerCase().includes('password')
                ? 'critical'
                : 'high',
            fieldPath: nextPath,
            maskedPreview: preview,
            reason: `Restricted internal property "${key}" was serialized into the share record.`,
            remediation: `Delete "${key}" from share payload and re-issue a fresh capability link.`,
          });
          continue;
        }

        walk(childVal, nextPath, key, depth + 1);
      }
    }
  };

  walk(record, '', '', 0);

  let criticalCount = 0;
  let highCount = 0;
  let mediumCount = 0;
  const categorySet = new Set<ShareFindingCategory>();

  for (const f of findings) {
    categorySet.add(f.category);
    if (f.severity === 'critical') criticalCount += 1;
    else if (f.severity === 'high') highCount += 1;
    else mediumCount += 1;
  }

  const highestSeverity: ShareFindingSeverity | 'none' =
    criticalCount > 0
      ? 'critical'
      : highCount > 0
        ? 'high'
        : mediumCount > 0
          ? 'medium'
          : 'none';

  return {
    clean: findings.length === 0,
    highestSeverity,
    findingCount: findings.length,
    criticalCount,
    highCount,
    mediumCount,
    categories: Array.from(categorySet),
    findings,
  };
}

export function scrubProseString(raw: string, leafKey = ''): string {
  if (!raw || NON_PROSE_ENUM_KEYS.has(leafKey)) return raw;
  if (MEDIA_REF_KEYS.has(leafKey) || raw.startsWith('data:')) {
    if (!raw.startsWith('data:')) {
      INTERNAL_NETWORK_REGEX.lastIndex = 0;
      if (INTERNAL_NETWORK_REGEX.test(raw)) return '';
    }
    return raw;
  }

  if (
    leafKey === 'siteNotes' ||
    leafKey === 'listenerFocus' ||
    leafKey === 'email' ||
    leafKey === 'phone' ||
    leafKey === 'address'
  ) {
    return '';
  }

  let next = raw;

  // 1. Scrub credentials & tokens
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    next = next.replace(pattern.regex, '[redacted-secret]');
  }

  // 2. Scrub SSN & UK NINO
  US_SSN_REGEX.lastIndex = 0;
  next = next.replace(US_SSN_REGEX, '[redacted-id]');
  UK_NINO_REGEX.lastIndex = 0;
  next = next.replace(UK_NINO_REGEX, '[redacted-id]');

  // 3. Scrub Luhn-verified payment cards
  CARD_CANDIDATE_REGEX.lastIndex = 0;
  next = next.replace(CARD_CANDIDATE_REGEX, (candidate) => {
    if (!ISO_DATE_LIKE_RE.test(candidate) && passesLuhnCheck(candidate)) {
      return '[redacted-card]';
    }
    return candidate;
  });

  // 4. Scrub emails (skip example.com)
  EMAIL_REGEX.lastIndex = 0;
  next = next.replace(EMAIL_REGEX, (full, domain: string) => {
    const cleanDomain = (domain || '').toLowerCase();
    if (cleanDomain === 'example.com' || cleanDomain === 'dispatch.local') return full;
    return '[redacted-email]';
  });

  // 5. Scrub phone numbers
  if (leafKey !== 'sourceUrl' && !ISO_DATE_LIKE_RE.test(next)) {
    PHONE_REGEX.lastIndex = 0;
    next = next.replace(PHONE_REGEX, (candidate) => {
      const digitCount = candidate.replace(/\D/g, '').length;
      if (digitCount < 10 || digitCount > 15) return candidate;
      return '[redacted-phone]';
    });
  }

  // 6. Scrub street addresses & UK postcodes
  if (leafKey !== 'sourceUrl') {
    STREET_ADDRESS_REGEX.lastIndex = 0;
    next = next.replace(STREET_ADDRESS_REGEX, '[redacted-address]');
    UK_POSTCODE_REGEX.lastIndex = 0;
    next = next.replace(UK_POSTCODE_REGEX, '[redacted-address]');
  }

  // 7. Scrub internal network URLs / private IPs
  INTERNAL_NETWORK_REGEX.lastIndex = 0;
  if (leafKey === 'sourceUrl') {
    if (INTERNAL_NETWORK_REGEX.test(next)) {
      return '';
    }
  } else {
    INTERNAL_NETWORK_REGEX.lastIndex = 0;
    next = next.replace(INTERNAL_NETWORK_REGEX, '[redacted-endpoint]');
  }

  return next;
}

export function scrubShareValueDeep<T>(value: T, leafKey = '', depth = 0): T {
  if (depth > 10 || value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return scrubProseString(value, leafKey) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => scrubShareValueDeep(item, leafKey, depth + 1)) as unknown as T;
  }

  if (typeof value === 'object') {
    const asObj = value as Record<string, unknown>;
    if (typeof asObj.toDate === 'function' || ('seconds' in asObj && 'nanoseconds' in asObj)) {
      return value;
    }

    const cleaned: Record<string, unknown> = {};
    for (const [key, childVal] of Object.entries(asObj)) {
      if (UNAUTHORIZED_OBJECT_KEYS.has(key)) {
        continue;
      }
      cleaned[key] = scrubShareValueDeep(childVal, key, depth + 1);
    }
    return cleaned as T;
  }

  return value;
}
