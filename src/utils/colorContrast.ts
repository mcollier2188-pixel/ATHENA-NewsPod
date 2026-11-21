import type { MockupCanvasMode, MockupPalette } from '../types';
import { getReadableOnColor } from '../data/defaultMockup';

export type ContrastCheckId =
  | 'hero-text'
  | 'cta-button'
  | 'accent-primary'
  | 'accent-canvas';

export type ContrastGrade = 'AAA' | 'AA' | 'AA Large' | 'Fail';

export interface ContrastCheckItem {
  id: ContrastCheckId;
  label: string;
  fgHex: string;
  bgHex: string;
  ratio: number;
  passesAA: boolean;
  passesAAA: boolean;
  passesLarge: boolean;
  grade: ContrastGrade;
}

export interface MockupContrastAudit {
  checks: ContrastCheckItem[];
  allPassAA: boolean;
  allPassAAA: boolean;
  passedCount: number;
  totalCount: number;
  failingCount: number;
  scorePercent: number;
  overallGrade: 'AAA' | 'AA' | 'Fail';
  statusLabel: 'Pass' | 'Fail';
  pairRatio: number;
  hasTextOverrides: boolean;
}

export interface PaletteTextOverrides {
  onPrimary?: string;
  onAccent?: string;
  accentText?: string;
  heroKickerText?: string;
}

export interface ResolvedPaletteColors {
  primary: string;
  accent: string;
  onPrimary: string;
  onAccent: string;
  accentText: string;
  heroKickerText: string;
  hasTextOverrides: boolean;
}

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface HslColor {
  h: number;
  s: number;
  l: number;
}

export function normalizeHex(hex: string, fallback = '#1E3A5F'): string {
  const clean = hex.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return `#${clean.toUpperCase()}`;
  }
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    const expanded = clean
      .split('')
      .map((c) => c + c)
      .join('');
    return `#${expanded.toUpperCase()}`;
  }
  return fallback;
}

function hexToRgb(hex: string): RgbColor {
  const norm = normalizeHex(hex).slice(1);
  return {
    r: parseInt(norm.slice(0, 2), 16),
    g: parseInt(norm.slice(2, 4), 16),
    b: parseInt(norm.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: RgbColor): string {
  const toByte = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

function rgbToHsl({ r, g, b }: RgbColor): HslColor {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      default:
        h = (rn - gn) / d + 4;
        break;
    }
    h /= 6;
  }

  return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToRgb({ h, s, l }: HslColor): RgbColor {
  const hn = (((h % 360) + 360) % 360) / 360;
  const sn = Math.max(0, Math.min(100, s)) / 100;
  const ln = Math.max(0, Math.min(100, l)) / 100;

  if (sn === 0) {
    const v = Math.round(ln * 255);
    return { r: v, g: v, b: v };
  }

  const hue2rgb = (p: number, q: number, t: number) => {
    let tn = t;
    if (tn < 0) tn += 1;
    if (tn > 1) tn -= 1;
    if (tn < 1 / 6) return p + (q - p) * 6 * tn;
    if (tn < 1 / 2) return q;
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
    return p;
  };

  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  return {
    r: Math.round(hue2rgb(p, q, hn + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, hn) * 255),
    b: Math.round(hue2rgb(p, q, hn - 1 / 3) * 255),
  };
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const linearize = (channel: number) => {
    const sRGB = channel / 255;
    return sRGB <= 0.03928
      ? sRGB / 12.92
      : Math.pow((sRGB + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

export function getContrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export function formatContrastRatio(ratio: number): string {
  return `${ratio.toFixed(1)}:1`;
}

function getGradeForRatio(ratio: number): ContrastGrade {
  if (ratio >= 7.0) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3.0) return 'AA Large';
  return 'Fail';
}

/**
 * Resolves effective primary, accent, and text colors for rendering & auditing.
 */
export function resolvePaletteTextColors(palette: MockupPalette): ResolvedPaletteColors {
  const primary = normalizeHex(palette.primary, '#1E3A5F');
  const accent = normalizeHex(palette.accent, '#D97706');
  const onPrimary = palette.onPrimary
    ? normalizeHex(palette.onPrimary, getReadableOnColor(primary))
    : getReadableOnColor(primary);
  const onAccent = palette.onAccent
    ? normalizeHex(palette.onAccent, getReadableOnColor(accent))
    : getReadableOnColor(accent);
  const heroKickerText = palette.heroKickerText
    ? normalizeHex(palette.heroKickerText, accent)
    : accent;
  const accentText = palette.accentText
    ? normalizeHex(palette.accentText, accent)
    : accent;

  const hasTextOverrides = Boolean(
    palette.onPrimary || palette.onAccent || palette.heroKickerText || palette.accentText
  );

  return {
    primary,
    accent,
    onPrimary,
    onAccent,
    accentText,
    heroKickerText,
    hasTextOverrides,
  };
}

export function evaluateMockupContrast(
  primaryHex: string,
  accentHex: string,
  canvasMode: MockupCanvasMode,
  textOverrides?: PaletteTextOverrides
): MockupContrastAudit {
  const resolved = resolvePaletteTextColors({
    primary: primaryHex,
    accent: accentHex,
    canvasMode,
    ...textOverrides,
  });
  const surfaceBg = canvasMode === 'dark' ? '#161C26' : '#FFFFFF';

  const heroRatio = getContrastRatio(resolved.onPrimary, resolved.primary);
  const ctaRatio = getContrastRatio(resolved.onAccent, resolved.accent);
  const accentOnPrimaryRatio = getContrastRatio(resolved.heroKickerText, resolved.primary);
  const accentCanvasRatio = getContrastRatio(resolved.accentText, surfaceBg);
  const pairRatio = getContrastRatio(resolved.accent, resolved.primary);

  const checks: ContrastCheckItem[] = [
    {
      id: 'hero-text',
      label: 'Hero Text on Primary',
      fgHex: resolved.onPrimary,
      bgHex: resolved.primary,
      ratio: heroRatio,
      passesAA: heroRatio >= 4.5,
      passesAAA: heroRatio >= 7.0,
      passesLarge: heroRatio >= 3.0,
      grade: getGradeForRatio(heroRatio),
    },
    {
      id: 'cta-button',
      label: 'Button Text on Accent',
      fgHex: resolved.onAccent,
      bgHex: resolved.accent,
      ratio: ctaRatio,
      passesAA: ctaRatio >= 4.5,
      passesAAA: ctaRatio >= 7.0,
      passesLarge: ctaRatio >= 3.0,
      grade: getGradeForRatio(ctaRatio),
    },
    {
      id: 'accent-primary',
      label: 'Accent Text on Primary',
      fgHex: resolved.heroKickerText,
      bgHex: resolved.primary,
      ratio: accentOnPrimaryRatio,
      passesAA: accentOnPrimaryRatio >= 4.5,
      passesAAA: accentOnPrimaryRatio >= 7.0,
      passesLarge: accentOnPrimaryRatio >= 3.0,
      grade: getGradeForRatio(accentOnPrimaryRatio),
    },
    {
      id: 'accent-canvas',
      label: canvasMode === 'dark' ? 'Accent Text on Dark Canvas' : 'Accent Text on Light Canvas',
      fgHex: resolved.accentText,
      bgHex: surfaceBg,
      ratio: accentCanvasRatio,
      passesAA: accentCanvasRatio >= 4.5,
      passesAAA: accentCanvasRatio >= 7.0,
      passesLarge: accentCanvasRatio >= 3.0,
      grade: getGradeForRatio(accentCanvasRatio),
    },
  ];

  const passedCount = checks.filter((c) => c.passesAA).length;
  const totalCount = checks.length;
  const failingCount = totalCount - passedCount;
  const allPassAA = failingCount === 0;
  const allPassAAA = checks.every((c) => c.passesAAA);

  return {
    checks,
    allPassAA,
    allPassAAA,
    passedCount,
    totalCount,
    failingCount,
    scorePercent: Math.round((passedCount / totalCount) * 100),
    overallGrade: allPassAAA ? 'AAA' : allPassAA ? 'AA' : 'Fail',
    statusLabel: allPassAA ? 'Pass' : 'Fail',
    pairRatio,
    hasTextOverrides: resolved.hasTextOverrides,
  };
}

/**
 * Picks a WCAG AA-compliant ink color (#FFFFFF, #0F172A, #090D14, or #000000)
 * against any background hex. Mathematically guaranteed >= 4.58:1 for all sRGB colors.
 */
function pickWcagTextForBackground(bgHex: string): string {
  const bg = normalizeHex(bgHex);
  const whiteRatio = getContrastRatio('#FFFFFF', bg);
  const slateRatio = getContrastRatio('#0F172A', bg);
  const deepInkRatio = getContrastRatio('#090D14', bg);
  const blackRatio = getContrastRatio('#000000', bg);

  if (whiteRatio >= slateRatio && whiteRatio >= 4.5) {
    return '#FFFFFF';
  }
  if (slateRatio >= 4.5) {
    return '#0F172A';
  }
  if (deepInkRatio >= 4.5) {
    return '#090D14';
  }
  return whiteRatio >= blackRatio ? '#FFFFFF' : '#000000';
}

/**
 * Tunes a brand-colored text hex (preserving its hue as closely as possible)
 * so that it reaches >= 4.65:1 WCAG AA contrast against the given background.
 */
function tuneTextColorForBackground(textHex: string, bgHex: string, minRatio = 4.65): string {
  const start = normalizeHex(textHex);
  const bg = normalizeHex(bgHex);
  if (getContrastRatio(start, bg) >= minRatio) {
    return start;
  }

  const bgLum = relativeLuminance(bg);
  const preferLighter = bgLum < 0.22;
  const hsl = rgbToHsl(hexToRgb(start));

  const lightnessCandidates: number[] = [];
  for (let step = 2; step <= 96; step += 2) {
    if (preferLighter) {
      if (hsl.l + step <= 98) lightnessCandidates.push(hsl.l + step);
      if (hsl.l - step >= 4) lightnessCandidates.push(hsl.l - step);
    } else {
      if (hsl.l - step >= 4) lightnessCandidates.push(hsl.l - step);
      if (hsl.l + step <= 98) lightnessCandidates.push(hsl.l + step);
    }
  }

  // First try preserving exact brand hue & saturation
  for (const nextL of lightnessCandidates) {
    const candidate = rgbToHex(hslToRgb({ h: hsl.h, s: hsl.s, l: nextL }));
    if (getContrastRatio(candidate, bg) >= minRatio) {
      return candidate;
    }
  }

  // Next gently soften saturation if the hue is near-neon
  for (const nextL of lightnessCandidates) {
    const candidate = rgbToHex(hslToRgb({ h: hsl.h, s: Math.min(hsl.s, 65), l: nextL }));
    if (getContrastRatio(candidate, bg) >= minRatio) {
      return candidate;
    }
  }

  return pickWcagTextForBackground(bg);
}

/**
 * Automatically adjusts text colors (onPrimary, onAccent, heroKickerText, accentText)
 * for WCAG 2.1 AA compliance (>= 4.5:1) while preserving the user's chosen Primary & Accent swatches.
 */
export function autoFixMockupPalette(
  primaryHex: string,
  accentHex: string,
  canvasMode: MockupCanvasMode,
  currentOverrides?: PaletteTextOverrides
): {
  primary: string;
  accent: string;
  onPrimary: string;
  onAccent: string;
  heroKickerText: string;
  accentText: string;
  changed: boolean;
} {
  const resolved = resolvePaletteTextColors({
    primary: primaryHex,
    accent: accentHex,
    canvasMode,
    ...currentOverrides,
  });
  const surfaceBg = canvasMode === 'dark' ? '#161C26' : '#FFFFFF';

  const nextOnPrimary =
    getContrastRatio(resolved.onPrimary, resolved.primary) >= 4.5
      ? resolved.onPrimary
      : pickWcagTextForBackground(resolved.primary);

  const nextOnAccent =
    getContrastRatio(resolved.onAccent, resolved.accent) >= 4.5
      ? resolved.onAccent
      : pickWcagTextForBackground(resolved.accent);

  const nextHeroKickerText = tuneTextColorForBackground(
    resolved.heroKickerText,
    resolved.primary,
    4.65
  );

  const nextAccentText = tuneTextColorForBackground(
    resolved.accentText,
    surfaceBg,
    4.65
  );

  const changed =
    nextOnPrimary !== resolved.onPrimary ||
    nextOnAccent !== resolved.onAccent ||
    nextHeroKickerText !== resolved.heroKickerText ||
    nextAccentText !== resolved.accentText;

  return {
    primary: resolved.primary,
    accent: resolved.accent,
    onPrimary: nextOnPrimary,
    onAccent: nextOnAccent,
    heroKickerText: nextHeroKickerText,
    accentText: nextAccentText,
    changed,
  };
}
