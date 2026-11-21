import * as THREE from 'three';
import type { AudioBriefing, NewsArticle, SiteMockupProject } from '../types';

/**
 * Applies aspect-ratio-preserving UV `repeat` & `offset` (cover-fit by default)
 * plus optional user/gamepad UV pan & scale nudges so arbitrary media never stretches.
 */
export function applyAspectPreservingUV(
  tex: THREE.Texture,
  mediaAspect: number,
  targetAspect: number,
  uvOffset: [number, number] = [0, 0],
  uvScale: [number, number] = [1, 1]
): void {
  const safeMedia = mediaAspect > 0.05 ? mediaAspect : targetAspect;
  const safeTarget = targetAspect > 0.05 ? targetAspect : 16 / 9;

  let repeatX = 1;
  let repeatY = 1;

  if (safeMedia > safeTarget) {
    // Media is wider than target surface -> crop left/right cleanly
    repeatX = safeTarget / safeMedia;
  } else {
    // Media is taller than target surface -> crop top/bottom cleanly
    repeatY = safeMedia / safeTarget;
  }

  repeatX *= uvScale[0];
  repeatY *= uvScale[1];

  const offsetX = (1 - repeatX) * 0.5 + uvOffset[0];
  const offsetY = (1 - repeatY) * 0.5 + uvOffset[1];

  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.offset.set(offsetX, offsetY);
}

export interface LiveVideoTextureHandle {
  texture: THREE.VideoTexture;
  video: HTMLVideoElement;
  dispose: () => void;
}

/**
 * Mounts an HTML5 `<video>` directly into a 60fps `THREE.VideoTexture` with
 * automatic aspect-ratio normalization once video metadata resolves.
 */
export function createLiveVideoTexture(
  src: string,
  maxAnisotropy: number,
  targetAspect: number,
  uvOffset: [number, number] = [0, 0],
  onReady?: () => void
): LiveVideoTextureHandle {
  const video = document.createElement('video');
  video.src = src;
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';

  const texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = Math.max(1, maxAnisotropy);

  const handleMeta = () => {
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    applyAspectPreservingUV(texture, w / h, targetAspect, uvOffset);
    onReady?.();
  };

  video.addEventListener('loadedmetadata', handleMeta);
  video.addEventListener('canplay', () => {
    onReady?.();
  });

  void video.play().catch(() => {
    // Autoplay is permitted when muted; ignore transient abort on rapid slot swap
  });

  return {
    texture,
    video,
    dispose: () => {
      video.removeEventListener('loadedmetadata', handleMeta);
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch {
        // Ignore teardown errors
      }
      texture.dispose();
    },
  };
}

function wrapCanvasLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = words[0];

  for (let i = 1; i < words.length; i++) {
    const candidate = `${current} ${words[i]}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i];
      if (lines.length >= maxLines - 1) {
        for (let j = i + 1; j < words.length; j++) {
          const nextTry = `${current} ${words[j]}`;
          if (ctx.measureText(nextTry).width <= maxWidth - 28) {
            current = nextTry;
          } else {
            current = `${current}…`;
            break;
          }
        }
        break;
      }
    }
  }
  if (lines.length < maxLines && current) {
    lines.push(current);
  }
  return lines;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function loadOptionalImage(dataUrl?: string): Promise<HTMLImageElement | null> {
  if (!dataUrl) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/**
 * Synthesizes high-resolution Desktop (16:10), Mobile (9:19.5), and Plinth Plaque (4:1)
 * textures directly from the live `SiteMockupProject` for one-click 3D Device Preview.
 */
export async function renderMockupDeviceScreens(
  project: SiteMockupProject
): Promise<{
  desktopDataUrl: string;
  mobileDataUrl: string;
  plaqueDataUrl: string;
  label: string;
}> {
  const isDark = project.brand.palette.canvasMode === 'dark';
  const primary = project.brand.palette.primary || '#0F172A';
  const accent = project.brand.palette.accent || '#22D3EE';
  const bg = isDark ? '#0B0F17' : '#F8FAFC';
  const cardBg = isDark ? '#131A26' : '#FFFFFF';
  const fg = isDark ? '#F8FAFC' : '#0F172A';
  const muted = isDark ? '#94A3B8' : '#475569';
  const border = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.1)';

  const heroImg = await loadOptionalImage(project.hero.photoDataUrl);
  const brandName = project.brand.name || 'Client Studio';
  const headline =
    project.hero.headline || `${brandName} — Trusted Regional Specialists`;
  const subheadline =
    project.hero.subheadline ||
    `Serving ${project.brand.serviceArea || 'local & regional clients'} with dependable turnarounds.`;

  // 1. Desktop Laptop Display (1280 x 800, 16:10)
  const desk = document.createElement('canvas');
  desk.width = 1280;
  desk.height = 800;
  const dctx = desk.getContext('2d')!;

  dctx.fillStyle = bg;
  dctx.fillRect(0, 0, 1280, 800);

  // Top Nav Bar
  dctx.fillStyle = primary;
  dctx.fillRect(0, 0, 1280, 72);
  dctx.fillStyle = '#FFFFFF';
  dctx.font = '700 24px Georgia, serif';
  dctx.fillText(brandName.slice(0, 32), 56, 45);

  dctx.font = '500 15px system-ui, sans-serif';
  dctx.fillStyle = 'rgba(255,255,255,0.82)';
  dctx.fillText('Services     Projects     Credentials     Contact', 520, 44);

  drawRoundedRect(dctx, 1045, 18, 180, 36, 8);
  dctx.fillStyle = accent;
  dctx.fill();
  dctx.fillStyle = '#071318';
  dctx.font = '700 14px system-ui, sans-serif';
  dctx.fillText(
    (project.hero.primaryCta || 'Request Quote').slice(0, 18),
    1068,
    41
  );

  // Hero Split Left
  dctx.fillStyle = accent;
  dctx.font = '600 14px ui-monospace, monospace';
  dctx.fillText(
    `${(project.brand.serviceArea || 'Regional Coverage').toUpperCase()} · ${(project.brand.industry || 'Professional Services').toUpperCase()}`.slice(
      0,
      54
    ),
    56,
    134
  );

  dctx.fillStyle = fg;
  dctx.font = '700 44px Georgia, serif';
  const heroLines = wrapCanvasLines(dctx, headline, 610, 3);
  heroLines.forEach((line, idx) => {
    dctx.fillText(line, 56, 190 + idx * 52);
  });

  const subStartY = 198 + heroLines.length * 52;
  dctx.fillStyle = muted;
  dctx.font = '400 19px system-ui, sans-serif';
  const subLines = wrapCanvasLines(dctx, subheadline, 590, 2);
  subLines.forEach((line, idx) => {
    dctx.fillText(line, 56, subStartY + idx * 28);
  });

  // Hero Primary CTA Button
  const ctaY = subStartY + 76;
  drawRoundedRect(dctx, 56, ctaY, 210, 48, 10);
  dctx.fillStyle = accent;
  dctx.fill();
  dctx.fillStyle = '#071318';
  dctx.font = '700 16px system-ui, sans-serif';
  dctx.fillText(
    (project.hero.primaryCta || 'Book Consultation').slice(0, 20),
    80,
    ctaY + 30
  );

  drawRoundedRect(dctx, 282, ctaY, 190, 48, 10);
  dctx.strokeStyle = border;
  dctx.lineWidth = 2;
  dctx.stroke();
  dctx.fillStyle = fg;
  dctx.font = '600 15px system-ui, sans-serif';
  dctx.fillText(
    (project.brand.phone || 'Call Direct').slice(0, 18),
    308,
    ctaY + 30
  );

  // Hero Visual Frame Right
  drawRoundedRect(dctx, 710, 114, 514, 340, 16);
  dctx.save();
  dctx.clip();
  if (heroImg) {
    const imgRatio = heroImg.width / Math.max(1, heroImg.height);
    const boxRatio = 514 / 340;
    let dw = 514;
    let dh = 340;
    let dx = 710;
    let dy = 114;
    if (imgRatio > boxRatio) {
      dw = 340 * imgRatio;
      dx = 710 - (dw - 514) * 0.5;
    } else {
      dh = 514 / imgRatio;
      dy = 114 - (dh - 340) * 0.5;
    }
    dctx.drawImage(heroImg, dx, dy, dw, dh);
  } else {
    const grad = dctx.createLinearGradient(710, 114, 1224, 454);
    grad.addColorStop(0, primary);
    grad.addColorStop(1, '#1E293B');
    dctx.fillStyle = grad;
    dctx.fillRect(710, 114, 514, 340);
    dctx.fillStyle = accent;
    dctx.font = '700 26px Georgia, serif';
    dctx.fillText(brandName.slice(0, 26), 750, 280);
    dctx.fillStyle = 'rgba(255,255,255,0.75)';
    dctx.font = '500 16px ui-monospace, monospace';
    dctx.fillText(
      (project.projects[0]?.metric || 'Verified Client Delivery').slice(0, 34),
      750,
      316
    );
  }
  dctx.restore();

  // Bottom 3 Service Cards
  const topServices = project.services.slice(0, 3);
  topServices.forEach((srv, idx) => {
    const cx = 56 + idx * 396;
    const cy = 508;
    drawRoundedRect(dctx, cx, cy, 376, 236, 14);
    dctx.fillStyle = cardBg;
    dctx.fill();
    dctx.strokeStyle = border;
    dctx.lineWidth = 1.5;
    dctx.stroke();

    dctx.fillStyle = accent;
    dctx.font = '700 14px ui-monospace, monospace';
    dctx.fillText(`0${idx + 1} · SERVICE`, cx + 26, cy + 38);

    dctx.fillStyle = fg;
    dctx.font = '700 22px Georgia, serif';
    dctx.fillText(srv.title.slice(0, 26), cx + 26, cy + 76);

    dctx.fillStyle = muted;
    dctx.font = '400 15px system-ui, sans-serif';
    const srvLines = wrapCanvasLines(dctx, srv.description, 324, 3);
    srvLines.forEach((l, li) => {
      dctx.fillText(l, cx + 26, cy + 112 + li * 24);
    });

    if (srv.deliverable) {
      dctx.fillStyle = fg;
      dctx.font = '600 13px ui-monospace, monospace';
      dctx.fillText(`✓ ${srv.deliverable.slice(0, 32)}`, cx + 26, cy + 208);
    }
  });

  // 2. Mobile Companion Screen (540 x 1170, ~9:19.5)
  const mob = document.createElement('canvas');
  mob.width = 540;
  mob.height = 1170;
  const mctx = mob.getContext('2d')!;

  mctx.fillStyle = bg;
  mctx.fillRect(0, 0, 540, 1170);

  mctx.fillStyle = primary;
  mctx.fillRect(0, 0, 540, 92);
  mctx.fillStyle = '#FFFFFF';
  mctx.font = '700 22px Georgia, serif';
  mctx.fillText(brandName.slice(0, 22), 32, 58);

  // Mobile Hero Photo/Banner
  drawRoundedRect(mctx, 28, 118, 484, 240, 18);
  mctx.save();
  mctx.clip();
  if (heroImg) {
    mctx.drawImage(heroImg, 28, 118, 484, 240);
  } else {
    const mGrad = mctx.createLinearGradient(28, 118, 512, 358);
    mGrad.addColorStop(0, primary);
    mGrad.addColorStop(1, accent);
    mctx.fillStyle = mGrad;
    mctx.fillRect(28, 118, 484, 240);
  }
  mctx.restore();

  mctx.fillStyle = accent;
  mctx.font = '700 13px ui-monospace, monospace';
  mctx.fillText(
    (project.brand.serviceArea || 'Local Specialists').toUpperCase().slice(0, 34),
    32,
    402
  );

  mctx.fillStyle = fg;
  mctx.font = '700 32px Georgia, serif';
  const mobHeadLines = wrapCanvasLines(mctx, headline, 476, 3);
  mobHeadLines.forEach((l, idx) => {
    mctx.fillText(l, 32, 446 + idx * 38);
  });

  const mobCtaY = 466 + mobHeadLines.length * 38;
  drawRoundedRect(mctx, 32, mobCtaY, 476, 54, 12);
  mctx.fillStyle = accent;
  mctx.fill();
  mctx.fillStyle = '#071318';
  mctx.font = '700 18px system-ui, sans-serif';
  mctx.fillText(
    (project.hero.primaryCta || 'Get Instant Quote').slice(0, 24),
    158,
    mobCtaY + 34
  );

  topServices.slice(0, 2).forEach((srv, idx) => {
    const sy = mobCtaY + 84 + idx * 176;
    drawRoundedRect(mctx, 32, sy, 476, 156, 14);
    mctx.fillStyle = cardBg;
    mctx.fill();
    mctx.strokeStyle = border;
    mctx.lineWidth = 1.5;
    mctx.stroke();

    mctx.fillStyle = fg;
    mctx.font = '700 20px Georgia, serif';
    mctx.fillText(srv.title.slice(0, 28), 54, sy + 46);

    mctx.fillStyle = muted;
    mctx.font = '400 15px system-ui, sans-serif';
    const sl = wrapCanvasLines(mctx, srv.description, 428, 2);
    sl.forEach((line, li) => {
      mctx.fillText(line, 54, sy + 80 + li * 24);
    });

    mctx.fillStyle = accent;
    mctx.font = '600 13px ui-monospace, monospace';
    mctx.fillText(
      (srv.deliverable || 'Fast turnaround').slice(0, 34),
      54,
      sy + 136
    );
  });

  // 3. Plinth Brand Plaque (1024 x 256, 4:1)
  const plaque = document.createElement('canvas');
  plaque.width = 1024;
  plaque.height = 256;
  const pctx = plaque.getContext('2d')!;
  pctx.fillStyle = '#090D14';
  pctx.fillRect(0, 0, 1024, 256);
  pctx.strokeStyle = accent;
  pctx.lineWidth = 4;
  pctx.strokeRect(12, 12, 1000, 232);
  pctx.fillStyle = accent;
  pctx.font = '600 18px ui-monospace, monospace';
  pctx.fillText('CLIENT SITE MOCKUP · 3D DEVICE STAGE', 48, 76);
  pctx.fillStyle = '#F8FAFC';
  pctx.font = '700 44px Georgia, serif';
  pctx.fillText(brandName.slice(0, 32), 48, 144);
  pctx.fillStyle = '#94A3B8';
  pctx.font = '500 20px ui-monospace, monospace';
  pctx.fillText(
    `${project.brand.serviceArea || 'Regional'} · Primary ${primary} · Accent ${accent}`.slice(
      0,
      62
    ),
    48,
    198
  );

  return {
    desktopDataUrl: desk.toDataURL('image/png'),
    mobileDataUrl: mob.toDataURL('image/png'),
    plaqueDataUrl: plaque.toDataURL('image/png'),
    label: `${brandName} — Desktop & Mobile`,
  };
}

/**
 * Synthesizes a 3:4 Front Collector Foil Poster, 3:4 Rear Citation Telemetry Plate,
 * and 4:1 Base Marquee Strip from any Newsroom `NewsArticle` or `AudioBriefing`.
 */
export function renderEditorialFoilCard(
  input:
    | { kind: 'article'; article: NewsArticle }
    | { kind: 'briefing'; briefing: AudioBriefing }
): {
  frontDataUrl: string;
  backDataUrl: string;
  plaqueDataUrl: string;
  label: string;
} {
  const isBriefing = input.kind === 'briefing';
  const kicker = isBriefing
    ? `${input.briefing.preferences.format === 'podcast' ? 'TWO-HOST EDITION' : 'SOLO ANCHOR'} · ${input.briefing.segments.length} CHAPTERS`
    : `${(input.article.category || 'DISPATCH').toUpperCase()} · ${input.article.estimatedReadMinutes || 3} MIN READ`;

  const title = isBriefing ? input.briefing.editionTitle : input.article.title;
  const subtitle = isBriefing
    ? input.briefing.editionSubtitle
    : input.article.summary;
  const bullets = isBriefing
    ? input.briefing.takeaways.slice(0, 3)
    : (input.article.keyFacts?.length
        ? input.article.keyFacts
        : [input.article.summary]
      ).slice(0, 3);
  const footerMeta = isBriefing
    ? `Voices: ${input.briefing.preferences.voiceName}${
        input.briefing.preferences.format === 'podcast'
          ? ` & ${input.briefing.preferences.coHostVoiceName}`
          : ''
      }`
    : `Source: ${input.article.source || 'Newsroom Notebook'}`;

  // 1. Front Foil Poster (900 x 1200, 3:4)
  const front = document.createElement('canvas');
  front.width = 900;
  front.height = 1200;
  const fctx = front.getContext('2d')!;

  const grad = fctx.createLinearGradient(0, 0, 900, 1200);
  grad.addColorStop(0, '#0B1220');
  grad.addColorStop(0.5, '#111C2D');
  grad.addColorStop(1, '#090D16');
  fctx.fillStyle = grad;
  fctx.fillRect(0, 0, 900, 1200);

  // Crisp collector frame border
  drawRoundedRect(fctx, 28, 28, 844, 1144, 24);
  fctx.strokeStyle = '#22D3EE';
  fctx.lineWidth = 4;
  fctx.stroke();

  drawRoundedRect(fctx, 44, 44, 812, 1112, 18);
  fctx.strokeStyle = 'rgba(245, 158, 11, 0.45)';
  fctx.lineWidth = 2;
  fctx.stroke();

  // Header band
  fctx.fillStyle = '#67E8F9';
  fctx.font = '700 20px ui-monospace, monospace';
  fctx.fillText(kicker.slice(0, 48), 76, 110);

  fctx.fillStyle = 'rgba(34,211,238,0.35)';
  fctx.fillRect(76, 134, 748, 2);

  // Title
  fctx.fillStyle = '#F8FAFC';
  fctx.font = '700 50px Georgia, serif';
  const titleLines = wrapCanvasLines(fctx, title, 748, 4);
  titleLines.forEach((line, idx) => {
    fctx.fillText(line, 76, 212 + idx * 62);
  });

  // Subtitle
  const subY = 232 + titleLines.length * 62;
  fctx.fillStyle = '#CBD5E1';
  fctx.font = '400 25px system-ui, sans-serif';
  const subLines = wrapCanvasLines(fctx, subtitle, 748, 3);
  subLines.forEach((line, idx) => {
    fctx.fillText(line, 76, subY + idx * 36);
  });

  // Key Takeaways / Facts Box
  const boxY = 640;
  drawRoundedRect(fctx, 72, boxY, 756, 396, 18);
  fctx.fillStyle = 'rgba(13, 19, 31, 0.88)';
  fctx.fill();
  fctx.strokeStyle = 'rgba(103, 232, 249, 0.35)';
  fctx.lineWidth = 2;
  fctx.stroke();

  fctx.fillStyle = '#F59E0B';
  fctx.font = '700 18px ui-monospace, monospace';
  fctx.fillText(
    isBriefing ? 'KEY BRIEFING TAKEAWAYS' : 'CITED SOURCE HIGHLIGHTS',
    104,
    boxY + 46
  );

  bullets.forEach((pt, idx) => {
    const py = boxY + 98 + idx * 102;
    fctx.fillStyle = '#22D3EE';
    fctx.font = '700 20px ui-monospace, monospace';
    fctx.fillText(`0${idx + 1}.`, 104, py);

    fctx.fillStyle = '#E2E8F0';
    fctx.font = '500 21px system-ui, sans-serif';
    const bLines = wrapCanvasLines(fctx, pt.replace(/\[\d+\]/g, ''), 648, 2);
    bLines.forEach((bl, bli) => {
      fctx.fillText(bl, 152, py + bli * 28);
    });
  });

  fctx.fillStyle = '#94A3B8';
  fctx.font = '600 19px ui-monospace, monospace';
  fctx.fillText(footerMeta.slice(0, 52), 76, 1112);

  // 2. Rear Citation & Provenance Plate (900 x 1200, 3:4)
  const back = document.createElement('canvas');
  back.width = 900;
  back.height = 1200;
  const bctx = back.getContext('2d')!;
  bctx.fillStyle = '#090D14';
  bctx.fillRect(0, 0, 900, 1200);
  drawRoundedRect(bctx, 36, 36, 828, 1128, 22);
  bctx.strokeStyle = 'rgba(34,211,238,0.45)';
  bctx.lineWidth = 3;
  bctx.stroke();

  bctx.fillStyle = '#22D3EE';
  bctx.font = '700 22px ui-monospace, monospace';
  bctx.fillText('DISPATCH STUDIO · PROVENANCE SPEC', 78, 116);

  bctx.fillStyle = '#F8FAFC';
  bctx.font = '700 36px Georgia, serif';
  const backTitle = wrapCanvasLines(bctx, title, 740, 3);
  backTitle.forEach((l, i) => bctx.fillText(l, 78, 184 + i * 46));

  const specRows = isBriefing
    ? input.briefing.segments.slice(0, 5).map(
        (s, idx) =>
          `CH ${String(idx + 1).padStart(2, '0')} · ${s.title.slice(0, 38)}`
      )
    : [
        `SOURCE · ${input.article.source}`,
        `CATEGORY · ${input.article.category}`,
        `PASSAGES · ${input.article.passages?.length || 1} indexed blocks`,
        `READ TIME · ${input.article.estimatedReadMinutes} min`,
      ];

  specRows.forEach((row, idx) => {
    const ry = 390 + idx * 108;
    drawRoundedRect(bctx, 78, ry, 744, 84, 12);
    bctx.fillStyle = '#111826';
    bctx.fill();
    bctx.strokeStyle = 'rgba(255,255,255,0.1)';
    bctx.lineWidth = 1.5;
    bctx.stroke();

    bctx.fillStyle = '#67E8F9';
    bctx.font = '600 21px ui-monospace, monospace';
    bctx.fillText(row.slice(0, 50), 106, ry + 50);
  });

  // 3. Base Title Strip (1024 x 256, 4:1)
  const plaque = document.createElement('canvas');
  plaque.width = 1024;
  plaque.height = 256;
  const pctx = plaque.getContext('2d')!;
  pctx.fillStyle = '#090D14';
  pctx.fillRect(0, 0, 1024, 256);
  pctx.strokeStyle = '#22D3EE';
  pctx.lineWidth = 4;
  pctx.strokeRect(12, 12, 1000, 232);
  pctx.fillStyle = '#F59E0B';
  pctx.font = '700 18px ui-monospace, monospace';
  pctx.fillText(kicker.slice(0, 56), 48, 78);
  pctx.fillStyle = '#F8FAFC';
  pctx.font = '700 38px Georgia, serif';
  pctx.fillText(title.slice(0, 38), 48, 144);
  pctx.fillStyle = '#94A3B8';
  pctx.font = '500 20px ui-monospace, monospace';
  pctx.fillText(footerMeta.slice(0, 58), 48, 198);

  return {
    frontDataUrl: front.toDataURL('image/png'),
    backDataUrl: back.toDataURL('image/png'),
    plaqueDataUrl: plaque.toDataURL('image/png'),
    label: title.slice(0, 48),
  };
}
