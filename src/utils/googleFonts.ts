import type { MockupFontMood, MockupFontPairing } from '../types';

export const CURATED_FONT_PAIRINGS: MockupFontPairing[] = [
  {
    id: 'preset-industrial-precision',
    name: 'Industrial Precision',
    headingFont: 'Space Grotesk',
    bodyFont: 'Plus Jakarta Sans',
    monoFont: 'IBM Plex Mono',
    headingCategory: 'sans-serif',
    bodyCategory: 'sans-serif',
    rationale: 'Engineered geometric headings paired with crisp, legible workhorse body copy.',
    mood: 'industrial',
    sourceNote: 'Curated pairing',
  },
  {
    id: 'preset-modern-studio',
    name: 'Clean Modern Studio',
    headingFont: 'Outfit',
    bodyFont: 'Inter',
    monoFont: 'JetBrains Mono',
    headingCategory: 'sans-serif',
    bodyCategory: 'sans-serif',
    rationale: 'Confident contemporary headlines with ultra-clean screen readability for quotes & specs.',
    mood: 'modern',
    sourceNote: 'Curated pairing',
  },
  {
    id: 'preset-editorial-craft',
    name: 'Heritage Editorial',
    headingFont: 'Fraunces',
    bodyFont: 'DM Sans',
    monoFont: 'IBM Plex Mono',
    headingCategory: 'serif',
    bodyCategory: 'sans-serif',
    rationale: 'Warm, established serif authority balanced by uncluttered modern sans-serif copy.',
    mood: 'editorial',
    sourceNote: 'Curated pairing',
  },
  {
    id: 'preset-architectural-bold',
    name: 'Architectural Heavy',
    headingFont: 'Barlow',
    bodyFont: 'Work Sans',
    monoFont: 'Space Mono',
    headingCategory: 'sans-serif',
    bodyCategory: 'sans-serif',
    rationale: 'Condensed industrial signage character ideal for trades, construction, and engineering.',
    mood: 'industrial',
    sourceNote: 'Curated pairing',
  },
  {
    id: 'preset-bespoke-serif',
    name: 'Bespoke Journal',
    headingFont: 'Playfair Display',
    bodyFont: 'Source Sans 3',
    monoFont: 'IBM Plex Mono',
    headingCategory: 'serif',
    bodyCategory: 'sans-serif',
    rationale: 'High-contrast editorial display voice suited to hospitality, design, and bespoke services.',
    mood: 'editorial',
    sourceNote: 'Curated pairing',
  },
];

export const DEFAULT_PAIRING_BY_MOOD: Record<MockupFontMood, MockupFontPairing> = {
  industrial: CURATED_FONT_PAIRINGS[0],
  modern: CURATED_FONT_PAIRINGS[1],
  editorial: CURATED_FONT_PAIRINGS[2],
};

export const POPULAR_HEADING_FONTS: Array<{
  family: string;
  category: 'sans-serif' | 'serif' | 'display';
}> = [
  { family: 'Space Grotesk', category: 'sans-serif' },
  { family: 'Plus Jakarta Sans', category: 'sans-serif' },
  { family: 'Outfit', category: 'sans-serif' },
  { family: 'Barlow', category: 'sans-serif' },
  { family: 'Sora', category: 'sans-serif' },
  { family: 'Syne', category: 'display' },
  { family: 'Archivo', category: 'sans-serif' },
  { family: 'Montserrat', category: 'sans-serif' },
  { family: 'Manrope', category: 'sans-serif' },
  { family: 'Bricolage Grotesque', category: 'sans-serif' },
  { family: 'Fraunces', category: 'serif' },
  { family: 'Playfair Display', category: 'serif' },
  { family: 'Newsreader', category: 'serif' },
  { family: 'Lora', category: 'serif' },
  { family: 'Source Serif 4', category: 'serif' },
  { family: 'Libre Baskerville', category: 'serif' },
  { family: 'Oswald', category: 'display' },
];

export const POPULAR_BODY_FONTS: Array<{
  family: string;
  category: 'sans-serif' | 'serif';
}> = [
  { family: 'Plus Jakarta Sans', category: 'sans-serif' },
  { family: 'Inter', category: 'sans-serif' },
  { family: 'DM Sans', category: 'sans-serif' },
  { family: 'Work Sans', category: 'sans-serif' },
  { family: 'Source Sans 3', category: 'sans-serif' },
  { family: 'IBM Plex Sans', category: 'sans-serif' },
  { family: 'Manrope', category: 'sans-serif' },
  { family: 'Figtree', category: 'sans-serif' },
  { family: 'Rubik', category: 'sans-serif' },
  { family: 'Lora', category: 'serif' },
  { family: 'Merriweather', category: 'serif' },
];

export function resolveActiveFontPairing(
  fontMood: MockupFontMood,
  explicitPairing?: MockupFontPairing
): MockupFontPairing {
  if (explicitPairing?.headingFont && explicitPairing?.bodyFont) {
    return {
      ...explicitPairing,
      monoFont: explicitPairing.monoFont || 'IBM Plex Mono',
    };
  }
  return DEFAULT_PAIRING_BY_MOOD[fontMood] || CURATED_FONT_PAIRINGS[0];
}

export function buildFontStack(
  family: string,
  category: 'sans-serif' | 'serif' | 'display' | 'monospace'
): string {
  const clean = family.replace(/['"]/g, '').trim();
  if (!clean) {
    if (category === 'serif') return 'Georgia, "Times New Roman", serif';
    if (category === 'monospace') return 'ui-monospace, SFMono-Regular, Menlo, monospace';
    return '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  }
  if (category === 'serif') {
    return `"${clean}", Georgia, "Times New Roman", serif`;
  }
  if (category === 'monospace') {
    return `"${clean}", ui-monospace, SFMono-Regular, Menlo, monospace`;
  }
  return `"${clean}", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
}

export function buildMockupFontCssVars(pairing: MockupFontPairing): {
  headingStack: string;
  bodyStack: string;
  monoStack: string;
  cssVariables: Record<string, string>;
} {
  const headingStack = buildFontStack(pairing.headingFont, pairing.headingCategory);
  const bodyStack = buildFontStack(pairing.bodyFont, pairing.bodyCategory);
  const monoStack = buildFontStack(pairing.monoFont || 'IBM Plex Mono', 'monospace');

  return {
    headingStack,
    bodyStack,
    monoStack,
    cssVariables: {
      '--mockup-font-heading': headingStack,
      '--mockup-font-body': bodyStack,
      '--mockup-font-mono': monoStack,
    },
  };
}

export function buildGoogleFontsStylesheetHref(families: string[]): string | null {
  const unique = Array.from(
    new Set(
      families
        .map((f) => f.replace(/['"]/g, '').trim())
        .filter((f) => f.length > 0 && !/^(system-ui|sans-serif|serif|monospace|arial|helvetica|georgia)$/i.test(f))
    )
  );
  if (unique.length === 0) return null;

  const query = unique
    .map(
      (family) =>
        `family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@400;500;600;700`
    )
    .join('&');

  return `https://fonts.googleapis.com/css2?${query}&display=swap`;
}

const loadedFontFamilies = new Set<string>([
  'Fraunces',
  'IBM Plex Mono',
  'Plus Jakarta Sans',
]);

/**
 * Dynamically injects Google Fonts stylesheets into document.head (deduplicated)
 * so both live pairing previews and the applied mockup canvas render authentic glyphs.
 */
export function ensureGoogleFontsLoaded(families: string[]): void {
  if (typeof document === 'undefined') return;

  const toLoad = Array.from(
    new Set(
      families
        .map((f) => f.replace(/['"]/g, '').trim())
        .filter(
          (f) =>
            f.length > 0 &&
            !loadedFontFamilies.has(f) &&
            !/^(system-ui|sans-serif|serif|monospace|arial|helvetica|georgia)$/i.test(f)
        )
    )
  );

  if (toLoad.length === 0) return;

  const href = buildGoogleFontsStylesheetHref(toLoad);
  if (!href) return;

  toLoad.forEach((f) => loadedFontFamilies.add(f));

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.crossOrigin = 'anonymous';
  link.dataset.mockupGoogleFonts = toLoad.join(',');
  document.head.appendChild(link);
}
