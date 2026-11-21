import type { SiteMockupProject } from '../types';
import { createStarterMockup, normalizeSectionOrder } from '../data/defaultMockup';

/**
 * Computes a deterministic 64-bit FNV-1a-style hex digest of a SiteMockupProject
 * while ignoring volatile timestamp metadata (`updatedAt`) so the Version History
 * sidebar can accurately identify whether a saved Cloud SQL snapshot matches the
 * active editor canvas.
 */
export function computeMockupContentHash(project: SiteMockupProject): string {
  const { updatedAt: _ignoredUpdatedAt, ...stableContent } = project;
  let serialized = '';
  try {
    serialized = JSON.stringify(stableContent);
  } catch {
    serialized = `${project.id}:${project.brand?.name || ''}`;
  }

  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < serialized.length; i++) {
    const code = serialized.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code ^ (i & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b);
  }

  const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `${hex1}${hex2}-${serialized.length.toString(36)}`;
}

/**
 * Counts unique media assets attached to the mockup (logo, hero photo, project photos,
 * and media collection items) for version summary metadata.
 */
export function countMockupUniqueAssets(project: SiteMockupProject): number {
  const urls = new Set<string>();
  if (project.brand?.logoDataUrl) urls.add(project.brand.logoDataUrl);
  if (project.hero?.photoDataUrl) urls.add(project.hero.photoDataUrl);
  for (const prj of project.projects || []) {
    if (prj?.photoDataUrl) urls.add(prj.photoDataUrl);
  }
  for (const item of project.mediaCollection || []) {
    if (item?.dataUrl) urls.add(item.dataUrl);
  }
  return urls.size;
}

/**
 * Normalizes a parsed SiteMockupProject loaded from a historical snapshot so
 * older versions missing newer fields hydrate safely without runtime undefined errors.
 */
export function normalizeRestoredMockupProject(
  raw: Partial<SiteMockupProject>,
  activeProjectId: string
): SiteMockupProject {
  const starter = createStarterMockup();
  return {
    ...starter,
    ...raw,
    id: activeProjectId || raw.id || starter.id,
    updatedAt: new Date().toISOString(),
    brand: {
      ...starter.brand,
      ...(raw.brand || {}),
      palette: {
        ...starter.brand.palette,
        ...(raw.brand?.palette || {}),
      },
    },
    brandSwatches:
      Array.isArray(raw.brandSwatches) && raw.brandSwatches.length > 0
        ? raw.brandSwatches
        : starter.brandSwatches,
    suggestedFontPairings: Array.isArray(raw.suggestedFontPairings)
      ? raw.suggestedFontPairings
      : [],
    hero: {
      ...starter.hero,
      ...(raw.hero || {}),
      trustHighlights: Array.isArray(raw.hero?.trustHighlights)
        ? raw.hero.trustHighlights
        : starter.hero.trustHighlights,
    },
    services: Array.isArray(raw.services) ? raw.services : starter.services,
    projects: Array.isArray(raw.projects) ? raw.projects : starter.projects,
    about: {
      ...starter.about,
      ...(raw.about || {}),
      credentials: Array.isArray(raw.about?.credentials)
        ? raw.about.credentials
        : starter.about.credentials,
    },
    quoteForm: {
      ...starter.quoteForm,
      ...(raw.quoteForm || {}),
    },
    sectionVisibility: {
      ...starter.sectionVisibility,
      ...(raw.sectionVisibility || {}),
    },
    sectionOrder: normalizeSectionOrder(raw.sectionOrder),
    lockedSections:
      raw.lockedSections && typeof raw.lockedSections === 'object'
        ? raw.lockedSections
        : {},
    mediaCollection: Array.isArray(raw.mediaCollection) ? raw.mediaCollection : [],
    siteNotes: typeof raw.siteNotes === 'string' ? raw.siteNotes : '',
  };
}
