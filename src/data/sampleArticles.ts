import type { NewsArticle } from '../types';

export const EDITION_COVER_IMAGE =
  '/src/assets/images/edition_cover_morning_1795050894143.jpg';

export const SAMPLE_ARTICLES: NewsArticle[] = [
  {
    id: 'sample-semiconductors-2026',
    title: 'Advanced Chip Packaging Emerges as the Real Bottleneck Behind Next-Gen AI Supply',
    source: 'Global Markets Desk',
    category: 'Technology',
    tags: ['Tech', 'AI', 'Supply Chain'],
    summary:
      'While lithography plants capture headlines, foundry executives say high-bandwidth memory stacking and glass-substrate packaging now dictate delivery timelines for enterprise accelerators through 2027.',
    keyFacts: [
      'Packaging capacity utilization at leading Asian and European assembly hubs crossed 94% in Q3 2026.',
      'Panel-level glass substrates cut interposer warpage by roughly 40% for multi-die server modules.',
      'Cloud operators have pre-booked specialized assembly lines 14 months ahead of silicon tape-outs.',
    ],
    content: `For nearly a decade, semiconductor supply debates revolved around extreme ultraviolet lithography machines and nanometer transistor shrinks. Today, the sharpest constraint sits one step further down the production floor: advanced packaging.

Industry supply-chain filings released this week show that utilization across Chip-on-Wafer-on-Substrate and hybrid bonding assembly lines climbed above 94 percent in the third quarter. Even when logic dies leave fabrication plants on schedule, finished server modules wait weeks for high-bandwidth memory stacks and precision interposers.

Foundry leaders in Taiwan, South Korea, and Germany are accelerating investments in rectangular panel-level packaging and glass core substrates. Compared with traditional organic substrates, glass cores maintain dimensional stability across larger multi-chip layouts, reducing thermal warpage by roughly 40 percent and allowing denser vertical power delivery.

For enterprise buyers and cloud infrastructure planners, the shift changes capital strategy. Hyperscalers are now signing direct capacity-reservation contracts with outsourced assembly and test partners up to 14 months in advance—an arrangement that used to apply almost exclusively to leading-edge wafer fabs. Analysts expect packaging capital expenditures to grow nearly twice as fast as front-end wafer spending over the next 24 months, creating new regional hubs in Malaysia, Poland, and Arizona.`,
    estimatedReadMinutes: 4,
    selected: true,
    addedAt: '2026-11-18T07:15:00Z',
    imageUrl: '/src/assets/images/editorial_chips_foundry_1795050895552.jpg',
  },
  {
    id: 'sample-north-sea-grid-2026',
    title: 'North Sea Wind Operators Pair Offshore Arrays With 100-Hour Iron-Air Storage to Steady Winter Grids',
    source: 'Energy & Infrastructure Weekly',
    category: 'Climate',
    tags: ['Energy', 'Climate', 'Europe'],
    summary:
      'A consortium of Northern European utilities is commissioning multi-day iron-air battery substations alongside offshore interconnectors to curb curtailment during high-wind nights and calm winter cold snaps.',
    keyFacts: [
      'Grid curtailment wasted an estimated 6.8 terawatt-hours of North Sea wind power over the past 12 months.',
      'New iron-air storage installations deliver up to 100 hours of discharge at roughly one-fifth the capital cost of lithium-ion packs.',
      'Wholesale winter price swings in connected markets are projected to narrow by 18% to 25% once phase one comes online.',
    ],
    content: `Across the North Sea, offshore wind turbines have become extraordinarily cheap to run—yet grid operators still routinely pay wind farms to shut down during blustery overnight hours when transmission cables saturate. Over the last twelve months alone, curtailment across UK, Dutch, and Danish offshore zones exceeded 6.8 terawatt-hours, enough electricity to power nearly two million homes for a year.

Now a utility consortium is rolling out a different answer alongside high-voltage subsea cables: multi-day iron-air storage parks built right at coastal landing substations. Unlike four-hour lithium-ion batteries built for rapid frequency balancing, iron-air systems rely on reversible rusting of abundant iron pellets to store and release electricity continuously for up to 100 hours.

While their round-trip efficiency sits lower than lithium cells, project engineers note that the capital cost per kilowatt-hour of stored energy is roughly one-fifth as high. That economics shift targets Europe's toughest renewable challenge—the week-long winter "Dunkelflaute" periods when wind drops and solar output fades simultaneously. Energy economists modeling the phase-one substations estimate wholesale winter price volatility in connected bidding zones could narrow by 18 to 25 percent, easing pressure on industrial manufacturers and household utility bills alike.`,
    estimatedReadMinutes: 4,
    selected: true,
    addedAt: '2026-11-18T07:20:00Z',
    imageUrl: '/src/assets/images/editorial_grid_energy_1795050893538.jpg',
  },
  {
    id: 'sample-commuter-rail-signaling-2026',
    title: 'Digital Signaling Upgrades Add 22% More Peak-Hour Trains Without Laying a Single Mile of New Track',
    source: 'Civic Transit Review',
    category: 'Urban Economy',
    tags: ['Economy', 'Transit', 'Cities'],
    summary:
      'Metropolitan rail networks replacing fixed-block trackside signals with moving-block digital dispatch are cutting peak-hour delays by a third and reclaiming billions in commuter productivity.',
    keyFacts: [
      'Moving-block signaling safely compresses train headways from 180 seconds down to 110 seconds on legacy tunnels.',
      'Upgrading software and onboard transponders costs roughly 12% of boring parallel relief tunnels.',
      'Ridership on upgraded commuter corridors rebounded 14% faster than neighboring bus and highway routes.',
    ],
    content: `Major cities trying to move more commuters during morning and evening peaks have historically faced an unforgiving choice: spend tens of billions tunneling beneath dense downtowns, or accept chronic overcrowding. A wave of digital rail re-signaling projects across London, Milan, Toronto, and Osaka is proving a far cheaper third route.

Traditional fixed-block signaling divides track into rigid multi-kilometer zones, allowing only one train per zone regardless of braking performance. Modern communications-based moving-block systems continuously transmit each train's exact position and speed to central dispatch computers, creating a dynamic safety envelope that moves with the locomotive.

On corridors converted over the past eighteen months, transit agencies have added up to 22 percent more trains per hour during peak windows while trimming knock-on delay cascades by more than a third. Because the upgrade replaces trackside relays and cab electronics rather than excavating earth, total project costs average just 12 percent of new tunnel construction. City economists report an immediate dividend: hybrid workers facing predictable 90-second platform waits are returning to midweek office commutes in greater numbers, lifting downtown retail and hospitality spending along modernized lines.`,
    estimatedReadMinutes: 3,
    selected: true,
    addedAt: '2026-11-18T07:25:00Z',
    imageUrl: '/src/assets/images/edition_cover_morning_1795050894143.jpg',
  },
];
