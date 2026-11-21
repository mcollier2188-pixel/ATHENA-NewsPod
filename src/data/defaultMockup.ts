import type {
  MockupCanvasMode,
  MockupSectionKey,
  SiteMockupProject,
} from '../types';

export const DEFAULT_SECTION_ORDER: MockupSectionKey[] = [
  'services',
  'projects',
  'about',
  'quote',
];

export function normalizeSectionOrder(order?: MockupSectionKey[]): MockupSectionKey[] {
  if (!Array.isArray(order) || order.length === 0) {
    return [...DEFAULT_SECTION_ORDER];
  }
  const seen = new Set<MockupSectionKey>();
  const valid: MockupSectionKey[] = [];
  for (const key of order) {
    if (DEFAULT_SECTION_ORDER.includes(key) && !seen.has(key)) {
      seen.add(key);
      valid.push(key);
    }
  }
  for (const fallbackKey of DEFAULT_SECTION_ORDER) {
    if (!seen.has(fallbackKey)) {
      valid.push(fallbackKey);
    }
  }
  return valid;
}

export interface PalettePreset {
  id: string;
  label: string;
  primary: string;
  accent: string;
  canvasMode: MockupCanvasMode;
}

export const PALETTE_PRESETS: PalettePreset[] = [
  {
    id: 'industrial-navy',
    label: 'Industrial Navy & Amber',
    primary: '#1E3A5F',
    accent: '#D97706',
    canvasMode: 'light',
  },
  {
    id: 'concrete-slate',
    label: 'Concrete Slate & Rust',
    primary: '#272E38',
    accent: '#EA580C',
    canvasMode: 'light',
  },
  {
    id: 'heritage-forest',
    label: 'Heritage Forest & Stone',
    primary: '#1B4332',
    accent: '#B45309',
    canvasMode: 'light',
  },
  {
    id: 'midnight-steel',
    label: 'Dark Steel & Gold',
    primary: '#111827',
    accent: '#F59E0B',
    canvasMode: 'dark',
  },
];

/**
 * Returns crisp white or deep slate text for WCAG AA contrast on top of any hex background.
 */
export function getReadableOnColor(hex: string): string {
  const clean = hex.replace('#', '').trim();
  if (clean.length !== 6) return '#FFFFFF';
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  if ([r, g, b].some((n) => Number.isNaN(n))) return '#FFFFFF';

  const toLin = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const lum = 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
  return lum > 0.44 ? '#0F172A' : '#FFFFFF';
}

export function createStarterMockup(): SiteMockupProject {
  const now = new Date().toISOString();
  return {
    id: 'mockup-default',
    sourceUrl: '',
    updatedAt: now,
    brand: {
      name: 'Alder & Sons Groundworks',
      industry: 'Concrete, Groundworks & Civil Contracting',
      serviceArea: 'Midlands & Surrounding Counties',
      phone: '0121 496 0428',
      email: 'quotes@aldergroundworks.co.uk',
      hours: 'Mon–Fri 07:00–17:30 · Sat by arrangement',
      address: 'Unit 4, Millbrook Yard, Industrial Estate',
      palette: {
        primary: '#1E3A5F',
        accent: '#D97706',
        canvasMode: 'light',
      },
      fontMood: 'industrial',
    },
    brandSwatches: [
      {
        hex: '#1E3A5F',
        name: 'Industrial Navy',
        role: 'primary',
        usageNote: 'Header bar, hero accents, and primary trust elements',
      },
      {
        hex: '#D97706',
        name: 'Hi-Vis Amber',
        role: 'accent',
        usageNote: 'Primary quote CTAs and key callout highlights',
      },
      {
        hex: '#272E38',
        name: 'Concrete Slate',
        role: 'neutral',
        usageNote: 'Heavy headings, dark footers, and structural contrast',
      },
      {
        hex: '#EA580C',
        name: 'Site Rust',
        role: 'accent',
        usageNote: 'High-impact alternative action button and badge highlight',
      },
      {
        hex: '#1B4332',
        name: 'Heritage Forest',
        role: 'primary',
        usageNote: 'Alternative rural and civil groundworks primary brand tone',
      },
      {
        hex: '#F59E0B',
        name: 'Plant Gold',
        role: 'accent',
        usageNote: 'High-visibility accent suited for dark canvas sections',
      },
    ],
    hero: {
      kicker: 'Commercial & Domestic Groundworks',
      headline: 'Foundations, slabs, and drainage built to spec—on programme.',
      subheadline:
        'Family-run concrete and civil groundworks crew handling foundations, reinforced slabs, driveways, and site prep with our own plant and experienced operators.',
      primaryCta: 'Request a Site Quote',
      secondaryCta: 'View Core Services',
      trustHighlights: [
        '18+ years on site',
        'CSCS & CPCS accredited crew',
        '£10M public liability cover',
      ],
    },
    services: [
      {
        id: 'srv-1',
        title: 'Foundations & Reinforced Slabs',
        description:
          'Strip footings, trench fill, raft slabs, and power-floated industrial floors poured cleanly to engineer drawings and building control sign-off.',
        deliverable: 'Full setting-out, shuttering, mesh & finish',
      },
      {
        id: 'srv-2',
        title: 'Site Clearance & Bulk Excavation',
        description:
          'Reduced-level digs, muck away, piling mats, and haul roads prepared quickly using our own tracked excavators and dumpers.',
        deliverable: 'Licensed spoil removal & compaction',
      },
      {
        id: 'srv-3',
        title: 'Drainage, Attenuation & Kerbing',
        description:
          'Foul and storm water runs, soakaways, inspection chambers, and commercial concrete kerbing installed to adopted highway standards.',
        deliverable: 'Laser-levelled runs & pressure-tested lines',
      },
      {
        id: 'srv-4',
        title: 'Concrete Yards & Hardstanding',
        description:
          'Heavy-duty brush-finished yards, agricultural aprons, and loading bays engineered to take HGVs and winter freeze-thaw cycles.',
        deliverable: 'C35/C40 air-entrained mixes & saw-cut joints',
      },
    ],
    projects: [
      {
        id: 'prj-1',
        title: 'Commercial Warehouse Apron & Loading Bay',
        location: 'Coventry Industrial Park',
        metric: '1,450 m² · Completed in 9 days',
        summary:
          'Excavated soft sub-base, laid Type 1 MOT compaction layers, and poured 225mm mesh-reinforced brush-finish concrete ahead of winter handover.',
      },
      {
        id: 'prj-2',
        title: 'Six-Plot Residential Foundations & Foul Drainage',
        location: 'Warwickshire',
        metric: '6 plots · Zero snag sign-off',
        summary:
          'Delivered trench-fill footings, beam-and-block prep, and full storm attenuation crates with first-time building control approval.',
      },
      {
        id: 'prj-3',
        title: 'Agricultural Machinery Shed Slab',
        location: 'Stratford District',
        metric: '680 m² · Power-floated finish',
        summary:
          'Laser-screeded internal slab with thickened edge beams, perimeter drainage channels, and expansion joint sealing.',
      },
    ],
    about: {
      heading: 'Straightforward family crew, zero agency layers.',
      story:
        'We built our reputation on turning up when we say we will, keeping sites tidy, and leaving work ready for the next trade without hold-ups. Paste your mate’s real website URL in the bar above to pull in their exact business story, branding, and services automatically.',
      credentials: [
        'In-house excavators, dumpers & laser levels',
        'Direct communication with the foreman on site',
        'Itemised written quotes within 48 hours',
      ],
    },
    quoteForm: {
      heading: 'Need a straightforward price for upcoming works?',
      subtext:
        'Send over your postcode, rough dimensions, or drawings and we will arrange a quick site visit.',
      submitLabel: 'Send Quote Enquiry',
    },
    sectionVisibility: {
      services: true,
      projects: true,
      about: true,
      quote: true,
    },
    sectionOrder: [...DEFAULT_SECTION_ORDER],
    siteNotes:
      'On-site scratchpad:\n- Grab 3-4 clean photos of finished pours/jobs for the Projects section\n- Confirm exact phone number and service radius with him\n- Check if he wants WhatsApp link next to Call button',
  };
}
