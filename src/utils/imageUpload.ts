export interface CompressedImageResult {
  dataUrl: string;
  sizeKb: number;
  originalSizeKb: number;
  savedPercent: number;
  width: number;
  height: number;
  mimeType: string;
}

export function estimateDataUrlKb(dataUrl?: string): number {
  if (!dataUrl) return 0;
  const commaIdx = dataUrl.indexOf(',');
  const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  return Math.max(1, Math.round((base64.length * 3) / 4 / 1024));
}

export function formatStorageKb(kb: number): string {
  if (kb >= 1024) {
    return `${(kb / 1024).toFixed(1)} MB`;
  }
  return `${Math.max(0, Math.round(kb))} KB`;
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode this image file.'));
    img.src = src;
  });
}

export async function compressImageFile(
  file: File,
  options: {
    maxWidth: number;
    maxHeight: number;
    preserveAlpha?: boolean;
    quality?: number;
    maxSizeKb?: number;
    canvas?: HTMLCanvasElement | null;
  }
): Promise<CompressedImageResult> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose an image file (JPG, PNG, or WebP).');
  }

  if (file.size > 20 * 1024 * 1024) {
    throw new Error('Image is larger than 20 MB. Pick a smaller photo.');
  }

  const originalSizeKb = Math.max(1, Math.round(file.size / 1024));
  const objectUrl = URL.createObjectURL(file);

  try {
    const img = await loadImageElement(objectUrl);
    const naturalW = img.naturalWidth || img.width;
    const naturalH = img.naturalHeight || img.height;
    if (!naturalW || !naturalH) {
      throw new Error('Image dimensions could not be read.');
    }

    const scale = Math.min(
      1,
      options.maxWidth / naturalW,
      options.maxHeight / naturalH
    );
    const targetW = Math.max(1, Math.round(naturalW * scale));
    const targetH = Math.max(1, Math.round(naturalH * scale));

    // Reuse supplied hidden <canvas> element when provided, otherwise create an off-screen canvas
    const canvas = options.canvas ?? document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Browser canvas is unavailable for image compression.');
    }

    const isAlphaFormat =
      options.preserveAlpha &&
      (file.type === 'image/png' ||
        file.type === 'image/webp' ||
        file.type === 'image/svg+xml');

    ctx.clearRect(0, 0, targetW, targetH);
    if (!isAlphaFormat) {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, targetW, targetH);
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, targetW, targetH);

    let mimeType = isAlphaFormat ? 'image/png' : 'image/jpeg';
    let quality = options.quality ?? 0.82;
    let dataUrl = canvas.toDataURL(mimeType, quality);
    let sizeKb = estimateDataUrlKb(dataUrl);
    const targetMaxKb = options.maxSizeKb ?? (isAlphaFormat ? 180 : 240);

    // If transparent PNG logo exceeds target budget, switch to WebP with alpha
    if (isAlphaFormat && sizeKb > targetMaxKb) {
      const webpCandidate = canvas.toDataURL('image/webp', 0.86);
      if (webpCandidate.startsWith('data:image/webp')) {
        mimeType = 'image/webp';
        dataUrl = webpCandidate;
        sizeKb = estimateDataUrlKb(dataUrl);
      }
    }

    // Step down quality smoothly if photo still exceeds target KB budget
    if (!isAlphaFormat && sizeKb > targetMaxKb) {
      const steps = [0.74, 0.66, 0.58, 0.5];
      for (const q of steps) {
        if (q >= quality) continue;
        const candidate = canvas.toDataURL('image/jpeg', q);
        const candidateKb = estimateDataUrlKb(candidate);
        dataUrl = candidate;
        sizeKb = candidateKb;
        if (sizeKb <= targetMaxKb) break;
      }
    }

    const savedPercent =
      originalSizeKb > 0
        ? Math.max(0, Math.round(((originalSizeKb - sizeKb) / originalSizeKb) * 100))
        : 0;

    return {
      dataUrl,
      sizeKb,
      originalSizeKb,
      savedPercent,
      width: targetW,
      height: targetH,
      mimeType,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function compressDataUrl(
  sourceDataUrl: string,
  options: {
    maxWidth?: number;
    maxHeight?: number;
    quality?: number;
    maxSizeKb?: number;
  } = {}
): Promise<CompressedImageResult> {
  const originalSizeKb = estimateDataUrlKb(sourceDataUrl);
  const maxWidth = options.maxWidth ?? 1440;
  const maxHeight = options.maxHeight ?? 1080;
  const targetMaxKb = options.maxSizeKb ?? 240;

  const img = await loadImageElement(sourceDataUrl);
  const naturalW = img.naturalWidth || img.width;
  const naturalH = img.naturalHeight || img.height;
  if (!naturalW || !naturalH) {
    throw new Error('Image dimensions could not be read.');
  }

  const scale = Math.min(1, maxWidth / naturalW, maxHeight / naturalH);
  const targetW = Math.max(1, Math.round(naturalW * scale));
  const targetH = Math.max(1, Math.round(naturalH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Browser canvas is unavailable for image compression.');
  }

  ctx.fillStyle = '#0B0D10';
  ctx.fillRect(0, 0, targetW, targetH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, targetW, targetH);

  let quality = options.quality ?? 0.84;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);
  let sizeKb = estimateDataUrlKb(dataUrl);

  if (sizeKb > targetMaxKb) {
    const steps = [0.76, 0.68, 0.6, 0.52];
    for (const q of steps) {
      if (q >= quality) continue;
      const candidate = canvas.toDataURL('image/jpeg', q);
      const candidateKb = estimateDataUrlKb(candidate);
      dataUrl = candidate;
      sizeKb = candidateKb;
      if (sizeKb <= targetMaxKb) break;
    }
  }

  const savedPercent =
    originalSizeKb > 0
      ? Math.max(0, Math.round(((originalSizeKb - sizeKb) / originalSizeKb) * 100))
      : 0;

  return {
    dataUrl,
    sizeKb,
    originalSizeKb,
    savedPercent,
    width: targetW,
    height: targetH,
    mimeType: 'image/jpeg',
  };
}

