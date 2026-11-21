import type { MockupSectionKey, SiteMockupProject } from '../types';
import { normalizeSectionOrder } from '../data/defaultMockup';
import { resolvePaletteTextColors } from './colorContrast';
import {
  buildGoogleFontsStylesheetHref,
  buildMockupFontCssVars,
  resolveActiveFontPairing,
} from './googleFonts';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildStandaloneMockupHtml(project: SiteMockupProject): string {
  const { brand, hero, services, projects, about, quoteForm, sectionVisibility } = project;
  const isDark = brand.palette.canvasMode === 'dark';
  const resolvedColors = resolvePaletteTextColors(brand.palette);
  const primary = resolvedColors.primary;
  const accent = resolvedColors.accent;
  const onPrimary = resolvedColors.onPrimary;
  const onAccent = resolvedColors.onAccent;
  const heroKickerText = resolvedColors.heroKickerText;
  const accentText = resolvedColors.accentText;

  const bg = isDark ? '#0E1218' : '#F8FAFC';
  const surface = isDark ? '#151B24' : '#FFFFFF';
  const surfaceMuted = isDark ? '#1B2330' : '#F1F5F9';
  const ink = isDark ? '#F8FAFC' : '#0F172A';
  const inkMuted = isDark ? '#94A3B8' : '#475569';
  const border = isDark ? 'rgba(148, 163, 184, 0.18)' : 'rgba(15, 23, 42, 0.1)';

  const activeFontPairing = resolveActiveFontPairing(brand.fontMood, brand.fontPairing);
  const { headingStack, bodyStack, monoStack } = buildMockupFontCssVars(activeFontPairing);
  const googleFontsHref =
    buildGoogleFontsStylesheetHref([
      activeFontPairing.headingFont,
      activeFontPairing.bodyFont,
      activeFontPairing.monoFont || 'IBM Plex Mono',
    ]) || 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap';

  const orderedVisibleSections = normalizeSectionOrder(project.sectionOrder).filter(
    (key) => sectionVisibility[key]
  );

  const navLabels: Record<MockupSectionKey, { href: string; label: string }> = {
    services: { href: '#services', label: 'Services' },
    projects: { href: '#projects', label: 'Projects' },
    about: { href: '#about', label: 'About' },
    quote: { href: '#quote', label: 'Contact' },
  };

  const navLinksHtml = orderedVisibleSections
    .map((key) => `<a href="${navLabels[key].href}">${navLabels[key].label}</a>`)
    .join('\n        ');

  function renderSectionHtml(key: MockupSectionKey, isAlt: boolean): string {
    const cls = isAlt ? 'section alt' : 'section';
    if (key === 'services') {
      return `<section id="services" class="${cls}">
        <div class="container">
          <p class="eyebrow">Core Capabilities</p>
          <h2 class="section-title">What we deliver</h2>
          <div class="services-grid">
            ${services
              .map(
                (srv, idx) => `
              <article class="card">
                <p class="num">${String(idx + 1).padStart(2, '0')}.</p>
                <h3>${escapeHtml(srv.title)}</h3>
                <p class="muted">${escapeHtml(srv.description)}</p>
                ${
                  srv.deliverable
                    ? `<p class="deliverable">${escapeHtml(srv.deliverable)}</p>`
                    : ''
                }
              </article>`
              )
              .join('')}
          </div>
        </div>
      </section>`;
    }

    if (key === 'projects') {
      return `<section id="projects" class="${cls}">
        <div class="container">
          <p class="eyebrow">Recent Work</p>
          <h2 class="section-title">Completed projects</h2>
          <div class="projects-grid">
            ${projects
              .map(
                (prj) => `
              <article class="card project-card">
                ${
                  prj.photoDataUrl
                    ? `<img class="project-photo" src="${prj.photoDataUrl}" alt="${escapeHtml(prj.title)}" />`
                    : ''
                }
                <div class="project-body">
                  <p class="meta">${escapeHtml(prj.location)}${prj.metric ? ` &middot; <strong>${escapeHtml(prj.metric)}</strong>` : ''}</p>
                  <h3>${escapeHtml(prj.title)}</h3>
                  <p class="muted">${escapeHtml(prj.summary)}</p>
                </div>
              </article>`
              )
              .join('')}
          </div>
        </div>
      </section>`;
    }

    if (key === 'about') {
      return `<section id="about" class="${cls}">
        <div class="container about-grid">
          <div>
            <p class="eyebrow">About ${escapeHtml(brand.name)}</p>
            <h2 class="section-title">${escapeHtml(about.heading)}</h2>
            <p class="body-lg muted">${escapeHtml(about.story)}</p>
          </div>
          <ul class="creds">
            ${about.credentials
              .filter(Boolean)
              .map(
                (c, i) =>
                  `<li><span class="num-inline">${String(i + 1).padStart(2, '0')}.</span><span>${escapeHtml(c)}</span></li>`
              )
              .join('')}
          </ul>
        </div>
      </section>`;
    }

    return `<section id="quote" class="${cls}">
        <div class="container quote-grid">
          <div>
            <p class="eyebrow">Get in Touch</p>
            <h2 class="section-title">${escapeHtml(quoteForm.heading)}</h2>
            <p class="muted">${escapeHtml(quoteForm.subtext)}</p>
            <div class="contact-details">
              ${brand.phone ? `<p><strong>Phone:</strong> ${escapeHtml(brand.phone)}</p>` : ''}
              ${brand.email ? `<p><strong>Email:</strong> ${escapeHtml(brand.email)}</p>` : ''}
              ${brand.serviceArea ? `<p><strong>Coverage:</strong> ${escapeHtml(brand.serviceArea)}</p>` : ''}
              ${brand.hours ? `<p><strong>Hours:</strong> ${escapeHtml(brand.hours)}</p>` : ''}
            </div>
          </div>
          <form id="quote-form" class="card form" novalidate>
            <label>Your Name<input name="name" required placeholder="Full name" /></label>
            <label>Phone or Email<input name="contact" required placeholder="07... or you@example.com" /></label>
            <label>Project Details<textarea name="details" rows="4" required placeholder="Postcode, job type, and rough timeframe"></textarea></label>
            <button type="submit" class="btn-accent">${escapeHtml(quoteForm.submitLabel)}</button>
            <p id="form-status" class="form-status" aria-live="polite"></p>
          </form>
        </div>
      </section>`;
  }

  const orderedSectionsHtml = orderedVisibleSections
    .map((key, idx) => renderSectionHtml(key, idx % 2 === 1))
    .join('\n\n    ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(brand.name)} — ${escapeHtml(brand.industry)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="${googleFontsHref}" rel="stylesheet" />
  <style>
    :root {
      --brand-primary: ${primary};
      --brand-accent: ${accent};
      --brand-accent-text: ${accentText};
      --hero-kicker-text: ${heroKickerText};
      --on-primary: ${onPrimary};
      --on-accent: ${onAccent};
      --bg: ${bg};
      --surface: ${surface};
      --surface-muted: ${surfaceMuted};
      --ink: ${ink};
      --ink-muted: ${inkMuted};
      --border: ${border};
      --mockup-font-heading: ${headingStack};
      --mockup-font-body: ${bodyStack};
      --mockup-font-mono: ${monoStack};
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; font-family: var(--mockup-font-body); background: var(--bg); color: var(--ink); line-height: 1.6; }
    .container { max-width: 1120px; margin: 0 auto; padding: 0 24px; }
    header { position: sticky; top: 0; z-index: 20; background: var(--surface); border-bottom: 1px solid var(--border); }
    .nav { height: 68px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
    .brand { display: inline-flex; align-items: center; gap: 10px; font-family: var(--mockup-font-heading); font-weight: 700; font-size: 1.15rem; color: var(--ink); text-decoration: none; white-space: nowrap; }
    .brand-logo { height: 32px; width: auto; max-width: 130px; object-fit: contain; }
    .nav-links { display: flex; gap: 24px; align-items: center; }
    .nav-links a { color: var(--ink-muted); text-decoration: none; font-size: 0.9rem; font-weight: 500; white-space: nowrap; }
    .nav-links a:hover { color: var(--ink); }
    .btn-accent { display: inline-flex; align-items: center; justify-content: center; padding: 11px 20px; border-radius: 6px; border: none; background: var(--brand-accent); color: var(--on-accent); font-family: var(--mockup-font-body); font-weight: 600; font-size: 0.9rem; text-decoration: none; cursor: pointer; white-space: nowrap; }
    .btn-outline { display: inline-flex; align-items: center; justify-content: center; padding: 11px 20px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.35); color: var(--on-primary); font-family: var(--mockup-font-body); font-weight: 600; font-size: 0.9rem; text-decoration: none; white-space: nowrap; }
    .hero { background: var(--brand-primary); color: var(--on-primary); padding: 72px 0 64px; }
    .hero-split { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 0.9fr); gap: 36px; align-items: stretch; }
    .hero-photo-wrap { position: relative; border-radius: 10px; overflow: hidden; border: 1px solid rgba(255,255,255,0.2); min-height: 260px; }
    .hero-photo { width: 100%; height: 100%; object-fit: cover; display: block; }
    .eyebrow { font-size: 0.8rem; font-weight: 600; letter-spacing: 0.04em; color: var(--brand-accent-text); margin: 0 0 10px; }
    .hero .eyebrow { color: var(--hero-kicker-text); }
    .hero h1 { font-family: var(--mockup-font-heading); font-size: clamp(2rem, 4.2vw, 3.35rem); line-height: 1.12; margin: 0; max-width: 18ch; text-wrap: balance; }
    .hero-sub { margin: 18px 0 0; max-width: 60ch; opacity: 0.88; font-size: 1.05rem; }
    .hero-actions { margin-top: 28px; display: flex; flex-wrap: wrap; gap: 12px; }
    .trust { margin-top: 36px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.18); display: flex; flex-wrap: wrap; gap: 12px 24px; font-size: 0.85rem; opacity: 0.9; }
    .section { padding: 68px 0; }
    .section.alt { background: var(--surface-muted); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
    .section-title { font-family: var(--mockup-font-heading); font-size: clamp(1.5rem, 2.6vw, 2.15rem); margin: 0 0 28px; line-height: 1.2; }
    .services-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; }
    .projects-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 20px; }
    .about-grid, .quote-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 36px; align-items: start; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 24px; }
    .project-card { padding: 0; overflow: hidden; }
    .project-photo { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; display: block; }
    .project-body { padding: 24px; }
    .card h3 { font-family: var(--mockup-font-heading); margin: 6px 0 10px; font-size: 1.1rem; line-height: 1.3; }
    .num { font-family: var(--mockup-font-mono); font-size: 0.82rem; font-weight: 600; color: var(--brand-accent-text); margin: 0; }
    .muted { color: var(--ink-muted); margin: 0; font-size: 0.94rem; }
    .deliverable { margin: 14px 0 0; padding-top: 12px; border-top: 1px solid var(--border); font-size: 0.82rem; font-weight: 500; color: var(--ink); }
    .meta { font-size: 0.8rem; color: var(--ink-muted); margin: 0; }
    .creds { list-style: none; padding: 0; margin: 0; display: grid; gap: 14px; }
    .creds li { display: flex; gap: 12px; padding: 14px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; font-size: 0.94rem; }
    .num-inline { font-family: var(--mockup-font-mono); font-weight: 600; color: var(--brand-accent-text); }
    .contact-details { margin-top: 20px; display: grid; gap: 8px; font-size: 0.92rem; }
    .contact-details p { margin: 0; }
    .form { display: grid; gap: 14px; }
    .form label { display: grid; gap: 6px; font-size: 0.84rem; font-weight: 600; }
    .form input, .form textarea { width: 100%; padding: 10px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--ink); font: inherit; }
    .form-status { margin: 0; font-size: 0.85rem; color: var(--brand-accent-text); font-weight: 600; }
    footer { padding: 32px 0; border-top: 1px solid var(--border); font-size: 0.84rem; color: var(--ink-muted); }
    .footer-inner { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; }
    @media (max-width: 820px) { .hero-split { grid-template-columns: 1fr; } }
    @media (max-width: 720px) { .nav-links { display: none; } }
  </style>
</head>
<body>
  <header>
    <div class="container nav">
      <a class="brand" href="#top">${brand.logoDataUrl ? `<img class="brand-logo" src="${brand.logoDataUrl}" alt="${escapeHtml(brand.name)} logo" />` : ''}<span>${escapeHtml(brand.name)}</span></a>
      <nav class="nav-links" aria-label="Primary">
        ${navLinksHtml}
      </nav>
      <a class="btn-accent" href="#quote">${escapeHtml(hero.primaryCta)}</a>
    </div>
  </header>

  <main id="top">
    <section class="hero">
      <div class="container">
        <div class="${hero.photoDataUrl ? 'hero-split' : ''}">
          <div>
            <p class="eyebrow">${escapeHtml(hero.kicker)}${brand.serviceArea ? ` &middot; ${escapeHtml(brand.serviceArea)}` : ''}</p>
            <h1>${escapeHtml(hero.headline)}</h1>
            <p class="hero-sub">${escapeHtml(hero.subheadline)}</p>
            <div class="hero-actions">
              <a class="btn-accent" href="#quote">${escapeHtml(hero.primaryCta)}</a>
              ${hero.secondaryCta ? `<a class="btn-outline" href="#services">${escapeHtml(hero.secondaryCta)}</a>` : ''}
            </div>
          </div>
          ${
            hero.photoDataUrl
              ? `<div class="hero-photo-wrap"><img class="hero-photo" src="${hero.photoDataUrl}" alt="${escapeHtml(brand.name)} featured work" /></div>`
              : ''
          }
        </div>
        ${
          hero.trustHighlights.length > 0
            ? `<div class="trust">${hero.trustHighlights
                .filter(Boolean)
                .map((h) => `<span>${escapeHtml(h)}</span>`)
                .join('<span aria-hidden="true">&middot;</span>')}</div>`
            : ''
        }
      </div>
    </section>

    ${orderedSectionsHtml}
  </main>

  <footer>
    <div class="container footer-inner">
      <span>&copy; ${new Date().getFullYear()} ${escapeHtml(brand.name)}</span>
      <span>${escapeHtml([brand.serviceArea, brand.address].filter(Boolean).join(' · '))}</span>
    </div>
  </footer>

  <script>
    const form = document.getElementById('quote-form');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        const status = document.getElementById('form-status');
        const name = form.elements.name.value.trim();
        const contact = form.elements.contact.value.trim();
        const details = form.elements.details.value.trim();
        if (!name || !contact || !details) {
          status.textContent = 'Please complete your name, contact info, and project details.';
          return;
        }
        status.textContent = 'Thanks ' + name + ' — your enquiry is ready. Connect this form to your email or backend when going live.';
        form.reset();
      });
    }
  </script>
</body>
</html>`;
}
