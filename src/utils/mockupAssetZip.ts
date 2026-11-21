import JSZip from 'jszip';
import type { MockupMediaCategory, SiteMockupProject } from '../types';
import { resolvePaletteTextColors } from './colorContrast';
import { estimateDataUrlKb } from './imageUpload';

export interface ExportableMockupAsset {
  id: string;
  label: string;
  category: MockupMediaCategory;
  sourceSlot: string;
  folder: string;
  filename: string;
  zipPath: string;
  mimeType: string;
  ext: string;
  sizeKb: number;
  width?: number;
  height?: number;
  dataUrl: string;
}

export interface BuiltMockupAssetZip {
  blob: Blob;
  filename: string;
  assetCount: number;
  totalKb: number;
  entries: ExportableMockupAsset[];
}

export interface DecodedDataUrl {
  mimeType: string;
  ext: string;
  bytes: Uint8Array;
}

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};

const CATEGORY_FOLDER: Record<MockupMediaCategory, string> = {
  logo: '01-logo',
  hero: '02-hero',
  project: '03-projects',
  'site-photo': '04-site-photos',
};

export function sanitizeAssetSlug(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || fallback;
}

export function decodeImageDataUrl(dataUrl: string): DecodedDataUrl | null {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
  if (!match) return null;

  const mimeType = (match[1] || 'image/png').toLowerCase();
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || '';
  const ext = MIME_TO_EXT[mimeType] || 'png';

  try {
    if (isBase64) {
      const cleaned = payload.replace(/\s+/g, '');
      const binary =
        typeof atob === 'function'
          ? atob(cleaned)
          : Buffer.from(cleaned, 'base64').toString('binary');
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return { mimeType, ext, bytes };
    }

    const decodedText = decodeURIComponent(payload);
    const bytes = new TextEncoder().encode(decodedText);
    return { mimeType, ext, bytes };
  } catch {
    return null;
  }
}

function reserveUniquePath(
  usedPaths: Set<string>,
  folder: string,
  baseSlug: string,
  ext: string
): { filename: string; zipPath: string } {
  let candidateName = `${baseSlug}.${ext}`;
  let candidatePath = `${folder}/${candidateName}`;
  let suffix = 2;

  while (usedPaths.has(candidatePath.toLowerCase())) {
    candidateName = `${baseSlug}-${suffix}.${ext}`;
    candidatePath = `${folder}/${candidateName}`;
    suffix += 1;
  }

  usedPaths.add(candidatePath.toLowerCase());
  return { filename: candidateName, zipPath: candidatePath };
}

/**
 * Collects every uploaded visual asset belonging to the mockup project
 * (company logo, hero photo, completed project photos, and project media collection)
 * into a deterministic, deduplicated handover inventory.
 */
export function collectProjectAssets(
  project: SiteMockupProject
): ExportableMockupAsset[] {
  const brandSlug = sanitizeAssetSlug(project.brand.name, 'client');
  const entries: ExportableMockupAsset[] = [];
  const usedPaths = new Set<string>();
  const seenDataUrls = new Map<string, ExportableMockupAsset>();

  const pushAsset = (params: {
    id: string;
    label: string;
    category: MockupMediaCategory;
    sourceSlot: string;
    baseSlug: string;
    dataUrl?: string;
    width?: number;
    height?: number;
    sizeKb?: number;
  }) => {
    if (!params.dataUrl) return;
    const decoded = decodeImageDataUrl(params.dataUrl);
    if (!decoded || decoded.bytes.byteLength === 0) return;

    const existing = seenDataUrls.get(params.dataUrl);
    if (existing) {
      if (!existing.sourceSlot.includes(params.sourceSlot)) {
        existing.sourceSlot = `${existing.sourceSlot}, ${params.sourceSlot}`;
      }
      if (!existing.width && params.width) existing.width = params.width;
      if (!existing.height && params.height) existing.height = params.height;
      return;
    }

    const folder = CATEGORY_FOLDER[params.category];
    const { filename, zipPath } = reserveUniquePath(
      usedPaths,
      folder,
      params.baseSlug,
      decoded.ext
    );

    const entry: ExportableMockupAsset = {
      id: params.id,
      label: params.label,
      category: params.category,
      sourceSlot: params.sourceSlot,
      folder,
      filename,
      zipPath,
      mimeType: decoded.mimeType,
      ext: decoded.ext,
      sizeKb: params.sizeKb ?? estimateDataUrlKb(params.dataUrl),
      width: params.width,
      height: params.height,
      dataUrl: params.dataUrl,
    };

    entries.push(entry);
    seenDataUrls.set(params.dataUrl, entry);
  };

  if (project.brand.logoDataUrl) {
    pushAsset({
      id: 'slot-logo',
      label: `${project.brand.name || 'Brand'} Logo`,
      category: 'logo',
      sourceSlot: 'Company Logo',
      baseSlug: `${brandSlug}-logo`,
      dataUrl: project.brand.logoDataUrl,
    });
  }

  if (project.hero.photoDataUrl) {
    pushAsset({
      id: 'slot-hero',
      label: 'Hero Site Photo',
      category: 'hero',
      sourceSlot: 'Hero Showcase',
      baseSlug: `${brandSlug}-hero`,
      dataUrl: project.hero.photoDataUrl,
    });
  }

  project.projects.forEach((prj, idx) => {
    if (!prj.photoDataUrl) return;
    const num = String(idx + 1).padStart(2, '0');
    const slug = sanitizeAssetSlug(prj.title || `project-${num}`, `project-${num}`);
    pushAsset({
      id: `slot-project-${prj.id}`,
      label: prj.title || `Project ${num}`,
      category: 'project',
      sourceSlot: `Project ${num}`,
      baseSlug: `${num}-${slug}`,
      dataUrl: prj.photoDataUrl,
    });
  });

  (project.mediaCollection || []).forEach((item, idx) => {
    if (!item.dataUrl) return;
    const num = String(idx + 1).padStart(2, '0');
    const slug = sanitizeAssetSlug(item.label || `asset-${num}`, `asset-${num}`);
    pushAsset({
      id: item.id,
      label: item.label || `Media Asset ${num}`,
      category: item.category || 'site-photo',
      sourceSlot: 'Media Collection',
      baseSlug: `${num}-${slug}`,
      dataUrl: item.dataUrl,
      width: item.width,
      height: item.height,
      sizeKb: item.sizeKb,
    });
  });

  return entries;
}

function buildHandoverReadme(
  project: SiteMockupProject,
  entries: ExportableMockupAsset[],
  exportedAtIso: string
): string {
  const resolvedText = resolvePaletteTextColors(project.brand.palette);

  const lines: string[] = [
    '============================================================',
    `CLIENT HANDOVER ASSET PACK — ${(project.brand.name || 'Site Mockup').toUpperCase()}`,
    '============================================================',
    `Exported:      ${exportedAtIso}`,
    `Industry:      ${project.brand.industry || '—'}`,
    `Service Area:  ${project.brand.serviceArea || '—'}`,
    `Source URL:    ${project.sourceUrl || '—'}`,
    `Total Assets:  ${entries.length}`,
    '',
    'BRAND PALETTE & WCAG TEXT TOKENS',
    '------------------------------------------------------------',
    `Primary Color:      ${project.brand.palette.primary.toUpperCase()}`,
    `Accent Color:       ${project.brand.palette.accent.toUpperCase()}`,
    `Canvas Mode:        ${project.brand.palette.canvasMode}`,
    `Text on Primary:    ${resolvedText.onPrimary}`,
    `Text on Accent:     ${resolvedText.onAccent}`,
    `Hero Kicker Text:   ${resolvedText.heroKickerText}`,
    `Accent Link Text:   ${resolvedText.accentText}`,
  ];

  if (project.brandSwatches && project.brandSwatches.length > 0) {
    lines.push('', 'BRAND SWATCH LIBRARY', '------------------------------------------------------------');
    project.brandSwatches.forEach((sw) => {
      lines.push(`- ${sw.hex.toUpperCase()}  ${sw.name} (${sw.role}) — ${sw.usageNote}`);
    });
  }

  lines.push('', 'INCLUDED ASSET FILES', '------------------------------------------------------------');
  entries.forEach((entry, idx) => {
    const dimLabel =
      entry.width && entry.height ? ` · ${entry.width}x${entry.height}` : '';
    lines.push(
      `${String(idx + 1).padStart(2, '0')}. ${entry.zipPath}  [${entry.sourceSlot} · ~${entry.sizeKb} KB${dimLabel}]`
    );
  });

  lines.push('');
  return lines.join('\n');
}

export async function buildMockupAssetsZip(
  project: SiteMockupProject
): Promise<BuiltMockupAssetZip> {
  const entries = collectProjectAssets(project);
  if (entries.length === 0) {
    throw new Error('Upload at least one logo or site photo before exporting a ZIP.');
  }

  const zip = new JSZip();
  const exportedAtIso = new Date().toISOString();

  for (const entry of entries) {
    const decoded = decodeImageDataUrl(entry.dataUrl);
    if (!decoded) continue;
    zip.file(entry.zipPath, decoded.bytes, { binary: true });
  }

  zip.file('handover-manifest.txt', buildHandoverReadme(project, entries, exportedAtIso));

  const resolvedText = resolvePaletteTextColors(project.brand.palette);

  zip.file(
    'brand-assets.json',
    JSON.stringify(
      {
        brandName: project.brand.name,
        sourceUrl: project.sourceUrl || null,
        exportedAt: exportedAtIso,
        palette: {
          primary: project.brand.palette.primary.toUpperCase(),
          accent: project.brand.palette.accent.toUpperCase(),
          canvasMode: project.brand.palette.canvasMode,
          textColors: resolvedText,
        },
        brandSwatches: project.brandSwatches || [],
        assets: entries.map((e) => ({
          path: e.zipPath,
          label: e.label,
          category: e.category,
          sourceSlot: e.sourceSlot,
          mimeType: e.mimeType,
          sizeKb: e.sizeKb,
          width: e.width ?? null,
          height: e.height ?? null,
        })),
      },
      null,
      2
    )
  );

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const brandSlug = sanitizeAssetSlug(project.brand.name, 'site-mockup');
  const filename = `${brandSlug}-handover-assets.zip`;
  const totalKb = Math.max(1, Math.round(blob.size / 1024));

  return {
    blob,
    filename,
    assetCount: entries.length,
    totalKb,
    entries,
  };
}

export async function exportMockupAssetsZip(
  project: SiteMockupProject
): Promise<{ filename: string; assetCount: number; totalKb: number }> {
  const built = await buildMockupAssetsZip(project);
  const url = URL.createObjectURL(built.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = built.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1800);

  return {
    filename: built.filename,
    assetCount: built.assetCount,
    totalKb: built.totalKb,
  };
}

export function downloadSingleMockupAsset(dataUrl: string, label: string): boolean {
  const decoded = decodeImageDataUrl(dataUrl);
  if (!decoded) return false;

  const bytesCopy = new Uint8Array(decoded.bytes.byteLength);
  bytesCopy.set(decoded.bytes);
  const blob = new Blob([bytesCopy.buffer], { type: decoded.mimeType });
  const url = URL.createObjectURL(blob);
  const slug = sanitizeAssetSlug(label, 'site-asset');
  const link = document.createElement('a');
  link.href = url;
  link.download = `${slug}.${decoded.ext}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  return true;
}
