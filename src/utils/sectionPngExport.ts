import { toBlob } from 'html-to-image';
import JSZip from 'jszip';
import type { MockupSectionKey } from '../types';
import { sanitizeAssetSlug } from './mockupAssetZip';

export type ExportableCanvasSectionKey = 'hero' | MockupSectionKey | 'footer';

export interface CanvasSectionExportSpec {
  key: ExportableCanvasSectionKey;
  elementId: string;
  label: string;
  slug: string;
}

export const CANVAS_SECTION_EXPORT_SPECS: Record<
  ExportableCanvasSectionKey,
  CanvasSectionExportSpec
> = {
  hero: {
    key: 'hero',
    elementId: 'mockup-top',
    label: 'Header & Hero',
    slug: 'hero',
  },
  services: {
    key: 'services',
    elementId: 'mockup-services',
    label: 'Core Services',
    slug: 'services',
  },
  projects: {
    key: 'projects',
    elementId: 'mockup-projects',
    label: 'Recent Projects',
    slug: 'projects',
  },
  about: {
    key: 'about',
    elementId: 'mockup-about',
    label: 'About & Story',
    slug: 'about',
  },
  quote: {
    key: 'quote',
    elementId: 'mockup-quote',
    label: 'Quote & Contact',
    slug: 'quote',
  },
  footer: {
    key: 'footer',
    elementId: 'mockup-footer',
    label: 'Site Footer',
    slug: 'footer',
  },
};

export interface CapturedSectionPng {
  key: ExportableCanvasSectionKey;
  label: string;
  filename: string;
  blob: Blob;
  previewUrl: string;
  width: number;
  height: number;
  sizeKb: number;
  transparentBackdrop: boolean;
  pixelRatio: number;
}

export interface SectionPngCaptureOptions {
  brandName: string;
  pixelRatio?: 1 | 2;
  transparentBackdrop?: boolean;
}

function readBlobImageDimensions(
  previewUrl: string
): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      resolve({
        width: img.naturalWidth || img.width || 0,
        height: img.naturalHeight || img.height || 0,
      });
    };
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = previewUrl;
  });
}

function shouldIncludeNode(node: HTMLElement): boolean {
  if (!node || typeof node !== 'object') return true;
  if ('dataset' in node && node.dataset?.exportIgnore === 'true') {
    return false;
  }
  return true;
}

/**
 * Captures a rendered section from the live MockupPreviewCanvas DOM as a
 * crisp transparent PNG asset (RGBA alpha channel, editor chrome stripped).
 */
export async function captureSectionAsTransparentPng(
  sectionKey: ExportableCanvasSectionKey,
  options: SectionPngCaptureOptions
): Promise<CapturedSectionPng> {
  const spec = CANVAS_SECTION_EXPORT_SPECS[sectionKey];
  const targetEl = document.getElementById(spec.elementId);
  if (!targetEl) {
    throw new Error(
      `${spec.label} is not currently visible on the canvas. Unhide it to export as PNG.`
    );
  }

  const pixelRatio = options.pixelRatio ?? 2;
  const transparentBackdrop = options.transparentBackdrop ?? true;

  const cloneStyle: Partial<CSSStyleDeclaration> = transparentBackdrop
    ? {
        backgroundColor: 'transparent',
        backgroundImage: 'none',
        borderTop: 'none',
        borderBottom: 'none',
        boxShadow: 'none',
        outline: 'none',
        margin: '0',
      }
    : {
        boxShadow: 'none',
        outline: 'none',
        margin: '0',
      };

  const baseOptions = {
    pixelRatio,
    cacheBust: false,
    backgroundColor: undefined,
    filter: shouldIncludeNode,
    style: cloneStyle,
  };

  let blob: Blob | null = null;
  try {
    blob = await toBlob(targetEl, baseOptions);
  } catch {
    // Graceful retry skipping external font stylesheet parsing if CORS blocks cssRules
    blob = await toBlob(targetEl, {
      ...baseOptions,
      skipFonts: true,
    });
  }

  if (!blob || blob.size === 0) {
    throw new Error(`Could not render ${spec.label} to a PNG image.`);
  }

  const previewUrl = URL.createObjectURL(blob);
  const dims = await readBlobImageDimensions(previewUrl);
  const brandSlug = sanitizeAssetSlug(options.brandName, 'mockup');
  const scaleTag = pixelRatio > 1 ? `@${pixelRatio}x` : '';
  const modeTag = transparentBackdrop ? '-transparent' : '';
  const filename = `${brandSlug}-${spec.slug}${modeTag}${scaleTag}.png`;

  return {
    key: sectionKey,
    label: spec.label,
    filename,
    blob,
    previewUrl,
    width: dims.width,
    height: dims.height,
    sizeKb: Math.max(1, Math.round(blob.size / 1024)),
    transparentBackdrop,
    pixelRatio,
  };
}

export function triggerPngBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1800);
}

/**
 * Downloads each captured section as its own individual PNG file, with a
 * slight stagger when multiple files are queued so browsers allow all downloads.
 */
export async function downloadCapturedSectionPngsIndividually(
  assets: CapturedSectionPng[]
): Promise<void> {
  for (let idx = 0; idx < assets.length; idx++) {
    const asset = assets[idx];
    triggerPngBlobDownload(asset.blob, asset.filename);
    if (idx < assets.length - 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 220));
    }
  }
}

/**
 * Bundles multiple captured transparent section PNGs into a single ZIP file
 * for convenient mobile or strict-browser handover.
 */
export async function downloadCapturedSectionPngsAsZip(
  assets: CapturedSectionPng[],
  brandName: string
): Promise<{ filename: string; totalKb: number }> {
  const zip = new JSZip();
  assets.forEach((asset, idx) => {
    const prefix = String(idx + 1).padStart(2, '0');
    zip.file(`${prefix}-${asset.filename}`, asset.blob, { binary: true });
  });

  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const brandSlug = sanitizeAssetSlug(brandName, 'mockup');
  const filename = `${brandSlug}-section-pngs.zip`;
  triggerPngBlobDownload(zipBlob, filename);

  return {
    filename,
    totalKb: Math.max(1, Math.round(zipBlob.size / 1024)),
  };
}
