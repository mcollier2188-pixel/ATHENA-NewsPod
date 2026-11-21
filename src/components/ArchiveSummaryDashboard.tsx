import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import type { AudioBriefing } from '../types';

interface ArchiveSummaryDashboardProps {
  archive: AudioBriefing[];
}

type SeriesFilter = 'both' | 'listening' | 'articles';

interface DayBucket {
  dateKey: string;
  shortDay: string;
  fullDate: string;
  listeningSeconds: number;
  listeningMinutes: number;
  articlesProcessed: number;
  editionsCount: number;
}

function toLocalDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDurationCompact(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  if (safe === 0) return '0m';
  const hours = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  if (mins > 0) {
    return secs >= 10 ? `${mins}m ${secs}s` : `${mins}m`;
  }
  return `${secs}s`;
}

function getBriefingDurationSeconds(briefing: AudioBriefing): number {
  return briefing.segments.reduce(
    (sum, seg) => sum + (seg.audioDurationSeconds || seg.estimatedSeconds || 60),
    0
  );
}

export function ArchiveSummaryDashboard({ archive }: ArchiveSummaryDashboardProps) {
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [chartWidth, setChartWidth] = useState(0);
  const [seriesFilter, setSeriesFilter] = useState<SeriesFilter>('both');
  const [hoveredDayIndex, setHoveredDayIndex] = useState<number | null>(null);

  // Measure chart container responsively
  useEffect(() => {
    const el = chartContainerRef.current;
    if (!el) return;

    const update = () => {
      const w = Math.floor(el.getBoundingClientRect().width);
      if (w > 0) setChartWidth(w);
    };
    update();

    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Build 7-day rolling window ending today & aggregate archive metrics
  const {
    days,
    weekListeningSeconds,
    weekArticlesCount,
    weekEditionsCount,
    allTimeListeningSeconds,
    allTimeArticlesCount,
  } = useMemo(() => {
    const now = new Date();
    const shortFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
    const fullFmt = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });

    const buckets: DayBucket[] = [];
    const bucketByKey = new Map<string, DayBucket>();

    for (let offset = 6; offset >= 0; offset--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
      const dateKey = toLocalDateKey(d);
      const bucket: DayBucket = {
        dateKey,
        shortDay: offset === 0 ? 'Today' : shortFmt.format(d),
        fullDate: fullFmt.format(d),
        listeningSeconds: 0,
        listeningMinutes: 0,
        articlesProcessed: 0,
        editionsCount: 0,
      };
      buckets.push(bucket);
      bucketByKey.set(dateKey, bucket);
    }

    let totalAllSec = 0;
    let totalAllArticles = 0;

    for (const item of archive) {
      const durSec = getBriefingDurationSeconds(item);
      const articleCount =
        item.articleTitles.length > 0 ? item.articleTitles.length : item.segments.length;

      totalAllSec += durSec;
      totalAllArticles += articleCount;

      const createdDate = new Date(item.createdAt);
      if (Number.isNaN(createdDate.getTime())) continue;
      const key = toLocalDateKey(createdDate);
      const bucket = bucketByKey.get(key);
      if (bucket) {
        bucket.listeningSeconds += durSec;
        bucket.articlesProcessed += articleCount;
        bucket.editionsCount += 1;
      }
    }

    let weekSec = 0;
    let weekArt = 0;
    let weekEd = 0;
    for (const b of buckets) {
      b.listeningMinutes = Number((b.listeningSeconds / 60).toFixed(2));
      weekSec += b.listeningSeconds;
      weekArt += b.articlesProcessed;
      weekEd += b.editionsCount;
    }

    return {
      days: buckets,
      weekListeningSeconds: weekSec,
      weekArticlesCount: weekArt,
      weekEditionsCount: weekEd,
      allTimeListeningSeconds: totalAllSec,
      allTimeArticlesCount: totalAllArticles,
    };
  }, [archive]);

  // Render D3 line chart
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || chartWidth <= 0 || days.length === 0) return;

    const svgHeight = 152;
    const showListening = seriesFilter === 'both' || seriesFilter === 'listening';
    const showArticles = seriesFilter === 'both' || seriesFilter === 'articles';

    const margin = {
      top: 14,
      right: showArticles ? 34 : 14,
      bottom: 24,
      left: showListening ? 36 : 32,
    };
    const innerWidth = Math.max(40, chartWidth - margin.left - margin.right);
    const innerHeight = Math.max(40, svgHeight - margin.top - margin.bottom);

    const svg = d3
      .select(svgEl)
      .attr('width', chartWidth)
      .attr('height', svgHeight)
      .attr('viewBox', `0 0 ${chartWidth} ${svgHeight}`);

    svg.selectAll('*').remove();

    const defs = svg.append('defs');

    // Subtle cyan area gradient for listening time
    const cyanGrad = defs
      .append('linearGradient')
      .attr('id', 'archive-listening-area-grad')
      .attr('x1', '0%')
      .attr('y1', '0%')
      .attr('x2', '0%')
      .attr('y2', '100%');
    cyanGrad.append('stop').attr('offset', '0%').attr('stop-color', '#22D3EE').attr('stop-opacity', 0.16);
    cyanGrad.append('stop').attr('offset', '100%').attr('stop-color', '#22D3EE').attr('stop-opacity', 0.0);

    // Subtle emerald area gradient when viewing articles alone
    const emeraldGrad = defs
      .append('linearGradient')
      .attr('id', 'archive-articles-area-grad')
      .attr('x1', '0%')
      .attr('y1', '0%')
      .attr('x2', '0%')
      .attr('y2', '100%');
    emeraldGrad.append('stop').attr('offset', '0%').attr('stop-color', '#34D399').attr('stop-opacity', 0.14);
    emeraldGrad.append('stop').attr('offset', '100%').attr('stop-color', '#34D399').attr('stop-opacity', 0.0);

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const xScale = d3
      .scalePoint<string>()
      .domain(days.map((d) => d.dateKey))
      .range([0, innerWidth])
      .padding(0.2);

    const maxMinutesRaw = d3.max(days, (d) => d.listeningMinutes) ?? 0;
    const maxArticlesRaw = d3.max(days, (d) => d.articlesProcessed) ?? 0;

    const yListeningMax = Math.max(5, Math.ceil(maxMinutesRaw * 1.25));
    const yArticlesMax = Math.max(4, Math.ceil(maxArticlesRaw * 1.25));

    const yListening = d3
      .scaleLinear()
      .domain([0, yListeningMax])
      .nice(3)
      .range([innerHeight, 0]);

    const yArticles = d3
      .scaleLinear()
      .domain([0, yArticlesMax])
      .nice(3)
      .range([innerHeight, 0]);

    // Horizontal gridlines driven by primary active scale
    const gridScale = showListening ? yListening : yArticles;
    const gridTicks = gridScale.ticks(3);

    g.append('g')
      .attr('class', 'grid-lines')
      .selectAll('line')
      .data(gridTicks)
      .join('line')
      .attr('x1', 0)
      .attr('x2', innerWidth)
      .attr('y1', (d) => gridScale(d))
      .attr('y2', (d) => gridScale(d))
      .attr('stroke', '#1F2532')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', (d) => (d === 0 ? 'none' : '2,3'));

    // Left Y-axis (Listening minutes when shown, or Articles when filtered to articles only)
    const leftTicks = gridScale.ticks(3);
    g.append('g')
      .selectAll('text')
      .data(leftTicks)
      .join('text')
      .attr('x', -8)
      .attr('y', (d) => gridScale(d))
      .attr('dy', '0.32em')
      .attr('text-anchor', 'end')
      .attr('fill', showListening ? '#6E788A' : '#34D399')
      .style('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
      .style('font-size', '10px')
      .style('font-variant-numeric', 'tabular-nums')
      .text((d) => (showListening ? `${d}m` : `${d}`));

    // Right Y-axis (Articles count when both series are active)
    if (showListening && showArticles) {
      const rightTicks = yArticles.ticks(3).filter((t) => Number.isInteger(t));
      g.append('g')
        .selectAll('text')
        .data(rightTicks)
        .join('text')
        .attr('x', innerWidth + 8)
        .attr('y', (d) => yArticles(d))
        .attr('dy', '0.32em')
        .attr('text-anchor', 'start')
        .attr('fill', '#5B8F7B')
        .style('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
        .style('font-size', '10px')
        .style('font-variant-numeric', 'tabular-nums')
        .text((d) => `${d}`);
    }

    // X-axis day labels
    g.append('g')
      .selectAll('text')
      .data(days)
      .join('text')
      .attr('x', (d) => xScale(d.dateKey) ?? 0)
      .attr('y', innerHeight + 17)
      .attr('text-anchor', 'middle')
      .attr('fill', (_d, idx) =>
        hoveredDayIndex === idx
          ? '#67E8F9'
          : idx === days.length - 1
            ? '#A0AABB'
            : '#6E788A'
      )
      .style('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
      .style('font-size', '10px')
      .text((d) => d.shortDay);

    // Listening Time area + line
    if (showListening) {
      const areaGen = d3
        .area<DayBucket>()
        .x((d) => xScale(d.dateKey) ?? 0)
        .y0(innerHeight)
        .y1((d) => yListening(d.listeningMinutes))
        .curve(d3.curveMonotoneX);

      const lineGen = d3
        .line<DayBucket>()
        .x((d) => xScale(d.dateKey) ?? 0)
        .y((d) => yListening(d.listeningMinutes))
        .curve(d3.curveMonotoneX);

      g.append('path')
        .datum(days)
        .attr('fill', 'url(#archive-listening-area-grad)')
        .attr('d', areaGen);

      g.append('path')
        .datum(days)
        .attr('fill', 'none')
        .attr('stroke', '#22D3EE')
        .attr('stroke-width', 2)
        .attr('stroke-linecap', 'round')
        .attr('d', lineGen);
    }

    // Articles Processed area (if solo) + line
    if (showArticles) {
      if (!showListening) {
        const artArea = d3
          .area<DayBucket>()
          .x((d) => xScale(d.dateKey) ?? 0)
          .y0(innerHeight)
          .y1((d) => yArticles(d.articlesProcessed))
          .curve(d3.curveMonotoneX);

        g.append('path')
          .datum(days)
          .attr('fill', 'url(#archive-articles-area-grad)')
          .attr('d', artArea);
      }

      const artLine = d3
        .line<DayBucket>()
        .x((d) => xScale(d.dateKey) ?? 0)
        .y((d) => yArticles(d.articlesProcessed))
        .curve(d3.curveMonotoneX);

      g.append('path')
        .datum(days)
        .attr('fill', 'none')
        .attr('stroke', '#34D399')
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', showListening ? '4,3' : 'none')
        .attr('stroke-linecap', 'round')
        .attr('d', artLine);
    }

    // Active hover vertical guide hairline
    if (hoveredDayIndex !== null && days[hoveredDayIndex]) {
      const hx = xScale(days[hoveredDayIndex].dateKey) ?? 0;
      g.append('line')
        .attr('x1', hx)
        .attr('x2', hx)
        .attr('y1', 0)
        .attr('y2', innerHeight)
        .attr('stroke', '#22D3EE')
        .attr('stroke-opacity', 0.35)
        .attr('stroke-width', 1)
        .attr('pointer-events', 'none');
    }

    // Data point dots for Listening Time
    if (showListening) {
      g.selectAll('circle.pt-listening')
        .data(days)
        .join('circle')
        .attr('class', 'pt-listening')
        .attr('cx', (d) => xScale(d.dateKey) ?? 0)
        .attr('cy', (d) => yListening(d.listeningMinutes))
        .attr('r', (_d, idx) => (hoveredDayIndex === idx ? 4.5 : 3))
        .attr('fill', '#22D3EE')
        .attr('stroke', '#0B0D10')
        .attr('stroke-width', 1.5)
        .attr('pointer-events', 'none');
    }

    // Data point dots for Articles Processed
    if (showArticles) {
      g.selectAll('circle.pt-articles')
        .data(days)
        .join('circle')
        .attr('class', 'pt-articles')
        .attr('cx', (d) => xScale(d.dateKey) ?? 0)
        .attr('cy', (d) => yArticles(d.articlesProcessed))
        .attr('r', (_d, idx) => (hoveredDayIndex === idx ? 4.5 : 3))
        .attr('fill', '#34D399')
        .attr('stroke', '#0B0D10')
        .attr('stroke-width', 1.5)
        .attr('pointer-events', 'none');
    }

    // Invisible hover hit columns for crisp day-by-day scrubbing
    const step = days.length > 1 ? innerWidth / days.length : innerWidth;
    g.selectAll<SVGRectElement, DayBucket>('rect.day-hit')
      .data(days)
      .join('rect')
      .attr('class', 'day-hit')
      .attr('x', (d) => Math.max(0, (xScale(d.dateKey) ?? 0) - step / 2))
      .attr('y', 0)
      .attr('width', step)
      .attr('height', innerHeight + margin.bottom)
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair')
      .on('mouseenter', (_event, d) => {
        const idx = days.findIndex((item) => item.dateKey === d.dateKey);
        setHoveredDayIndex(idx >= 0 ? idx : null);
      })
      .on('mouseleave', () => {
        setHoveredDayIndex(null);
      });
  }, [chartWidth, days, seriesFilter, hoveredDayIndex]);

  const hoveredDay = hoveredDayIndex !== null ? days[hoveredDayIndex] ?? null : null;
  const tooltipLeftPct =
    hoveredDayIndex !== null && days.length > 1
      ? Math.max(14, Math.min(86, (hoveredDayIndex / (days.length - 1)) * 100))
      : 50;

  return (
    <section
      aria-label="Weekly listening and articles summary"
      className="mt-6 bg-[#13161C] border border-[#222833] rounded-lg p-5"
    >
      {/* Top KPI Strip + Series Switcher */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-4 border-b border-[#1F2532]">
        <div className="grid grid-cols-2 gap-6 sm:gap-10">
          <div>
            <p className="text-xs text-[#8C96A8]">Listening Time (7d)</p>
            <p className="mt-1 font-mono text-2xl font-medium text-[#F5F7FA] tabular-nums leading-none">
              {formatDurationCompact(weekListeningSeconds)}
            </p>
            <p className="mt-1.5 text-[11px] font-mono text-[#6E788A] tabular-nums">
              {weekEditionsCount} {weekEditionsCount === 1 ? 'edition' : 'editions'} this week
              {allTimeListeningSeconds > weekListeningSeconds && (
                <> · {formatDurationCompact(allTimeListeningSeconds)} total</>
              )}
            </p>
          </div>

          <div className="pl-6 sm:pl-10 border-l border-[#1F2532]">
            <p className="text-xs text-[#8C96A8]">Articles Processed (7d)</p>
            <p className="mt-1 font-mono text-2xl font-medium text-[#F5F7FA] tabular-nums leading-none">
              {weekArticlesCount}
            </p>
            <p className="mt-1.5 text-[11px] font-mono text-[#6E788A] tabular-nums">
              {weekEditionsCount > 0
                ? `avg ${(weekArticlesCount / weekEditionsCount).toFixed(1)} per briefing`
                : '0 briefings logged'}
              {allTimeArticlesCount > weekArticlesCount && (
                <> · {allTimeArticlesCount} total</>
              )}
            </p>
          </div>
        </div>

        {/* Interactive Series Selector */}
        <div
          role="group"
          aria-label="Chart series display"
          className="inline-flex items-center gap-1 p-1 bg-[#0E1116] border border-[#222833] rounded-md self-start shrink-0"
        >
          {(
            [
              { id: 'both', label: 'Both' },
              { id: 'listening', label: 'Listening' },
              { id: 'articles', label: 'Articles' },
            ] as Array<{ id: SeriesFilter; label: string }>
          ).map((opt) => {
            const active = seriesFilter === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                aria-pressed={active}
                onClick={() => setSeriesFilter(opt.id)}
                className={`h-7 px-2.5 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? 'bg-[#18212E] text-[#67E8F9] border border-[#22D3EE]/50'
                    : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* D3 7-Day Line Chart */}
      <div className="pt-4">
        <div ref={chartContainerRef} className="relative w-full select-none">
          {hoveredDay && (
            <div
              role="tooltip"
              style={{ left: `${tooltipLeftPct}%` }}
              className="pointer-events-none absolute -top-1 -translate-x-1/2 -translate-y-full z-20 w-48 bg-[#0B0D10] border border-[#22D3EE]/55 rounded-md px-3 py-2 shadow-lg"
            >
              <p className="font-mono text-[11px] font-medium text-[#F5F7FA]">
                {hoveredDay.fullDate}
              </p>
              <div className="mt-1 space-y-0.5 font-mono text-[11px] tabular-nums">
                <div className="flex items-center justify-between gap-2 text-[#67E8F9]">
                  <span>Listening</span>
                  <span>{formatDurationCompact(hoveredDay.listeningSeconds)}</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[#34D399]">
                  <span>Articles</span>
                  <span>{hoveredDay.articlesProcessed}</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[#8C96A8]">
                  <span>Briefings</span>
                  <span>{hoveredDay.editionsCount}</span>
                </div>
              </div>
            </div>
          )}

          <svg
            ref={svgRef}
            role="img"
            aria-label={`7-day trend chart showing ${formatDurationCompact(weekListeningSeconds)} total listening time and ${weekArticlesCount} articles processed this week`}
            className="block w-full overflow-visible"
          />
        </div>

        {/* Clean Unboxed Legend & Window Note */}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#8C96A8]">
          <div className="flex flex-wrap items-center gap-4">
            {(seriesFilter === 'both' || seriesFilter === 'listening') && (
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="w-3 h-0.5 bg-[#22D3EE] inline-block"
                  aria-hidden="true"
                />
                <span>Listening time (min)</span>
              </span>
            )}
            {(seriesFilter === 'both' || seriesFilter === 'articles') && (
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="w-3 h-0.5 border-t-2 border-dashed border-[#34D399] inline-block"
                  aria-hidden="true"
                />
                <span>Articles processed</span>
              </span>
            )}
          </div>
          <span className="font-mono text-[#6E788A]">
            {weekEditionsCount === 0
              ? 'Generate a briefing to plot 7-day activity'
              : 'Rolling 7-day window'}
          </span>
        </div>
      </div>
    </section>
  );
}
