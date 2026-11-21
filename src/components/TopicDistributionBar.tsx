import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import type { AudioBriefing, NewsArticle } from '../types';
import { formatClock } from '../utils/wavUtils';

interface TopicDistributionBarProps {
  briefing: AudioBriefing;
  sources?: NewsArticle[];
  activeSegmentIndex: number;
  currentTime: number;
  isPlaying: boolean;
  onSelectSegment: (segmentIndex: number, segmentId: string, hasAudio: boolean) => void;
}

interface TimelineDatum {
  index: number;
  id: string;
  title: string;
  topic: string;
  tags: string[];
  durationSec: number;
  startSec: number;
  endSec: number;
  sharePct: number;
  hasAudio: boolean;
  audioStale: boolean;
  color: string;
}

interface TopicSummary {
  topic: string;
  color: string;
  durationSec: number;
  sharePct: number;
  chapterCount: number;
}

// Restrained editorial dark-studio palette anchored in Dispatch's signature cyan
const TOPIC_PALETTE = [
  '#22D3EE', // Cyan
  '#38BDF8', // Sky
  '#34D399', // Emerald
  '#A78BFA', // Indigo
  '#FBBF24', // Amber
  '#FB7185', // Rose
  '#2DD4BF', // Teal
  '#60A5FA', // Cobalt
];

function resolveSegmentTags(
  sourceTitles: string[],
  sources?: NewsArticle[]
): string[] {
  if (!sources || sources.length === 0 || sourceTitles.length === 0) return [];
  const tagSet = new Set<string>();
  for (const st of sourceTitles) {
    const norm = st.trim().toLowerCase();
    if (!norm) continue;
    const match = sources.find((src) => {
      const srcTitle = src.title.trim().toLowerCase();
      return (
        srcTitle === norm ||
        srcTitle.includes(norm.slice(0, 24)) ||
        norm.includes(srcTitle.slice(0, 24))
      );
    });
    if (match?.tags) {
      for (const t of match.tags) {
        tagSet.add(t);
      }
    }
  }
  return Array.from(tagSet).slice(0, 3);
}

export function TopicDistributionBar({
  briefing,
  sources,
  activeSegmentIndex,
  currentTime,
  isPlaying,
  onSelectSegment,
}: TopicDistributionBarProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [hoveredSegmentIndex, setHoveredSegmentIndex] = useState<number | null>(null);
  const [hoveredTopic, setHoveredTopic] = useState<string | null>(null);
  const [lockedTopic, setLockedTopic] = useState<string | null>(null);

  const focusedTopic = lockedTopic ?? hoveredTopic;

  // Reset locked topic when switching briefings
  useEffect(() => {
    setLockedTopic(null);
    setHoveredTopic(null);
    setHoveredSegmentIndex(null);
  }, [briefing.id]);

  // Measure container width responsively
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const update = () => {
      const next = Math.floor(el.getBoundingClientRect().width);
      if (next > 0) setContainerWidth(next);
    };
    update();

    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Build cumulative timeline & aggregated topic shares using D3 ordinal color scale
  const { items, topicSummaries, totalSeconds, elapsedTotalSeconds } = useMemo(() => {
    const rawDurations = briefing.segments.map((seg) =>
      Math.max(10, seg.audioDurationSeconds || seg.estimatedSeconds || 60)
    );
    const total = rawDurations.reduce((sum, d) => sum + d, 0);

    const uniqueTopics: string[] = [];
    for (const seg of briefing.segments) {
      const topic = (seg.category || 'General').trim() || 'General';
      if (!uniqueTopics.includes(topic)) {
        uniqueTopics.push(topic);
      }
    }

    const colorScale = d3
      .scaleOrdinal<string, string>()
      .domain(uniqueTopics)
      .range(TOPIC_PALETTE);

    let cursor = 0;
    const timeline: TimelineDatum[] = briefing.segments.map((seg, index) => {
      const durationSec = rawDurations[index];
      const topic = (seg.category || 'General').trim() || 'General';
      const startSec = cursor;
      const endSec = cursor + durationSec;
      cursor = endSec;
      const sharePct = total > 0 ? Math.round((durationSec / total) * 100) : 0;

      return {
        index,
        id: seg.id,
        title: seg.title,
        topic,
        tags: resolveSegmentTags(seg.sourceTitles, sources),
        durationSec,
        startSec,
        endSec,
        sharePct,
        hasAudio: Boolean(seg.audioBase64),
        audioStale: Boolean(seg.audioStale),
        color: colorScale(topic),
      };
    });

    const summaryMap = new Map<string, TopicSummary>();
    for (const item of timeline) {
      const existing = summaryMap.get(item.topic);
      if (existing) {
        existing.durationSec += item.durationSec;
        existing.chapterCount += 1;
      } else {
        summaryMap.set(item.topic, {
          topic: item.topic,
          color: item.color,
          durationSec: item.durationSec,
          sharePct: 0,
          chapterCount: 1,
        });
      }
    }

    const summaries = Array.from(summaryMap.values())
      .map((s) => ({
        ...s,
        sharePct: total > 0 ? Math.round((s.durationSec / total) * 100) : 0,
      }))
      .sort((a, b) => b.durationSec - a.durationSec);

    // Compute live elapsed playback position across the whole briefing
    let elapsed = 0;
    const safeIdx = Math.max(0, Math.min(activeSegmentIndex, timeline.length - 1));
    if (timeline.length > 0) {
      for (let i = 0; i < safeIdx; i++) {
        elapsed += timeline[i].durationSec;
      }
      const activeItem = timeline[safeIdx];
      if (activeItem) {
        elapsed += Math.max(0, Math.min(currentTime, activeItem.durationSec));
      }
    }

    return {
      items: timeline,
      topicSummaries: summaries,
      totalSeconds: total,
      elapsedTotalSeconds: Math.min(elapsed, total),
    };
  }, [briefing.segments, sources, activeSegmentIndex, currentTime]);

  // Render D3 SVG progress bar, topic segments, live playhead, and time axis
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || containerWidth <= 0 || items.length === 0 || totalSeconds <= 0) {
      return;
    }

    const barTop = 10;
    const barHeight = 20;
    const axisY = barTop + barHeight + 16;
    const svgHeight = axisY + 8;
    const segmentGap = items.length > 1 ? 2.5 : 0;

    const svg = d3
      .select(svgEl)
      .attr('width', containerWidth)
      .attr('height', svgHeight)
      .attr('viewBox', `0 0 ${containerWidth} ${svgHeight}`);

    svg.selectAll('*').remove();

    const xScale = d3
      .scaleLinear()
      .domain([0, totalSeconds])
      .range([0, containerWidth]);

    // Track base container
    const defs = svg.append('defs');
    defs
      .append('clipPath')
      .attr('id', `topic-bar-clip-${briefing.id}`)
      .append('rect')
      .attr('x', 0)
      .attr('y', barTop)
      .attr('width', containerWidth)
      .attr('height', barHeight)
      .attr('rx', 4)
      .attr('ry', 4);

    svg
      .append('rect')
      .attr('x', 0)
      .attr('y', barTop)
      .attr('width', containerWidth)
      .attr('height', barHeight)
      .attr('rx', 4)
      .attr('ry', 4)
      .attr('fill', '#0E1116')
      .attr('stroke', '#222833')
      .attr('stroke-width', 1);

    const trackGroup = svg
      .append('g')
      .attr('clip-path', `url(#topic-bar-clip-${briefing.id})`);

    const hasLiveProgress =
      isPlaying || activeSegmentIndex > 0 || currentTime >= 1;

    // Render each chapter segment proportionally across the briefing duration
    const segGroups = trackGroup
      .selectAll<SVGGElement, TimelineDatum>('g.topic-segment')
      .data(items, (d) => d.id)
      .join('g')
      .attr('class', 'topic-segment')
      .style('cursor', 'pointer')
      .on('mouseenter', (_event, d) => {
        setHoveredSegmentIndex(d.index);
      })
      .on('mouseleave', () => {
        setHoveredSegmentIndex(null);
      })
      .on('click', (_event, d) => {
        onSelectSegment(d.index, d.id, d.hasAudio);
      });

    segGroups.each(function (d) {
      const g = d3.select(this);
      const rawX = xScale(d.startSec);
      const rawEnd = xScale(d.endSec);
      const x = d.index === 0 ? rawX : rawX + segmentGap / 2;
      const right = d.index === items.length - 1 ? rawEnd : rawEnd - segmentGap / 2;
      const w = Math.max(4, right - x);

      const isHovered = hoveredSegmentIndex === d.index;
      const isActiveChapter = d.index === activeSegmentIndex && hasLiveProgress;
      const isTopicDimmed = Boolean(focusedTopic && d.topic !== focusedTopic);
      const isTopicFocused = Boolean(focusedTopic && d.topic === focusedTopic);

      // Base fill opacity: muted matte for upcoming, solid for elapsed/active/focused
      let baseOpacity = 0.56;
      if (isTopicDimmed) {
        baseOpacity = 0.16;
      } else if (isHovered || isTopicFocused) {
        baseOpacity = 0.92;
      } else if (hasLiveProgress && d.endSec <= elapsedTotalSeconds) {
        baseOpacity = 0.82;
      } else if (isActiveChapter) {
        baseOpacity = 0.34;
      }

      g.append('rect')
        .attr('x', x)
        .attr('y', barTop)
        .attr('width', w)
        .attr('height', barHeight)
        .attr('fill', d.color)
        .attr('fill-opacity', baseOpacity);

      // Elapsed progress fill inside the active chapter
      if (isActiveChapter && !isTopicDimmed) {
        const clamped = Math.max(0, Math.min(currentTime, d.durationSec));
        const progressRatio = d.durationSec > 0 ? clamped / d.durationSec : 0;
        const fillW = Math.max(0, w * progressRatio);
        if (fillW > 0.5) {
          g.append('rect')
            .attr('x', x)
            .attr('y', barTop)
            .attr('width', fillW)
            .attr('height', barHeight)
            .attr('fill', d.color)
            .attr('fill-opacity', 0.95);
        }
      }

      // Crisp hairline top accent rim on active or hovered segment
      if ((isHovered || isActiveChapter || isTopicFocused) && !isTopicDimmed) {
        g.append('rect')
          .attr('x', x)
          .attr('y', barTop)
          .attr('width', w)
          .attr('height', 2)
          .attr('fill', isHovered ? '#F5F7FA' : '#67E8F9')
          .attr('fill-opacity', isHovered ? 0.95 : 0.85);
      }

      // Subtle segment divider tick on the bar seam
      if (d.index > 0) {
        g.append('line')
          .attr('x1', rawX)
          .attr('x2', rawX)
          .attr('y1', barTop)
          .attr('y2', barTop + barHeight)
          .attr('stroke', '#0B0D10')
          .attr('stroke-width', segmentGap);
      }
    });

    // Live playhead indicator needle
    if (hasLiveProgress && elapsedTotalSeconds > 0) {
      const px = Math.max(1, Math.min(containerWidth - 1, xScale(elapsedTotalSeconds)));
      const playhead = svg.append('g').attr('pointer-events', 'none');

      playhead
        .append('line')
        .attr('x1', px)
        .attr('x2', px)
        .attr('y1', barTop - 4)
        .attr('y2', barTop + barHeight + 3)
        .attr('stroke', '#F5F7FA')
        .attr('stroke-width', 1.75);

      playhead
        .append('polygon')
        .attr('points', `${px - 4},${barTop - 6} ${px + 4},${barTop - 6} ${px},${barTop - 1}`)
        .attr('fill', '#22D3EE');
    }

    // D3 time axis ticks along the bottom
    const approxTickCount = Math.max(2, Math.min(6, Math.floor(containerWidth / 130)));
    const rawTicks = xScale.ticks(approxTickCount);
    const tickValues: number[] = [0];
    for (const t of rawTicks) {
      if (t > totalSeconds * 0.08 && t < totalSeconds * 0.9) {
        tickValues.push(t);
      }
    }
    tickValues.push(totalSeconds);

    const axisGroup = svg.append('g').attr('pointer-events', 'none');

    for (let i = 0; i < tickValues.length; i++) {
      const val = tickValues[i];
      const tx = xScale(val);
      const isStart = i === 0;
      const isEnd = i === tickValues.length - 1;

      axisGroup
        .append('line')
        .attr('x1', tx)
        .attr('x2', tx)
        .attr('y1', barTop + barHeight + 2)
        .attr('y2', barTop + barHeight + 6)
        .attr('stroke', '#334055')
        .attr('stroke-width', 1);

      axisGroup
        .append('text')
        .attr('x', tx)
        .attr('y', axisY + 3)
        .attr('text-anchor', isStart ? 'start' : isEnd ? 'end' : 'middle')
        .attr('fill', isEnd ? '#8C96A8' : '#6E788A')
        .style('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
        .style('font-size', '10px')
        .style('font-variant-numeric', 'tabular-nums')
        .text(formatClock(val));
    }
  }, [
    briefing.id,
    containerWidth,
    items,
    totalSeconds,
    elapsedTotalSeconds,
    activeSegmentIndex,
    currentTime,
    isPlaying,
    hoveredSegmentIndex,
    focusedTopic,
    onSelectSegment,
  ]);

  if (items.length === 0) return null;

  const hoveredItem =
    hoveredSegmentIndex !== null ? items[hoveredSegmentIndex] ?? null : null;

  // Compute clamped horizontal tooltip position as a percentage of bar width
  const tooltipLeftPct =
    hoveredItem && totalSeconds > 0
      ? Math.max(
          14,
          Math.min(
            86,
            (((hoveredItem.startSec + hoveredItem.endSec) / 2) / totalSeconds) * 100
          )
        )
      : 50;

  const progressPct =
    totalSeconds > 0
      ? Math.min(100, Math.round((elapsedTotalSeconds / totalSeconds) * 100))
      : 0;

  return (
    <section
      aria-label="Topic distribution across briefing duration"
      className="bg-[#13161C] border border-[#222833] rounded-lg px-5 py-4"
    >
      {/* Header Row */}
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2.5">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-xs font-semibold text-[#F5F7FA]">
            Topic Distribution
          </h2>
          <span aria-hidden="true" className="text-[#4B5568] text-xs">
            ·
          </span>
          <span className="text-xs text-[#8C96A8]">
            {topicSummaries.length}{' '}
            {topicSummaries.length === 1 ? 'topic' : 'topics'} across{' '}
            {items.length} {items.length === 1 ? 'chapter' : 'chapters'}
          </span>
        </div>

        <div className="flex items-center gap-2 font-mono text-xs tabular-nums text-[#8C96A8]">
          {elapsedTotalSeconds > 0 ? (
            <>
              <span className="text-[#67E8F9]">
                {formatClock(elapsedTotalSeconds)}
              </span>
              <span aria-hidden="true">/</span>
              <span>{formatClock(totalSeconds)}</span>
              <span aria-hidden="true">·</span>
              <span>{progressPct}%</span>
            </>
          ) : (
            <span>{formatClock(totalSeconds)} total</span>
          )}
        </div>
      </div>

      {/* D3 Interactive SVG Timeline Container */}
      <div ref={containerRef} className="relative w-full select-none">
        {hoveredItem && (
          <div
            role="tooltip"
            style={{ left: `${tooltipLeftPct}%` }}
            className="pointer-events-none absolute -top-2 -translate-x-1/2 -translate-y-full z-20 w-64 max-w-[90vw] bg-[#0B0D10] border border-[#22D3EE]/55 rounded-md px-3 py-2 shadow-lg"
          >
            <div className="flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums">
              <span className="inline-flex items-center gap-1.5 min-w-0 truncate text-[#F5F7FA]">
                <span
                  className="w-2 h-2 rounded-[2px] shrink-0"
                  style={{ backgroundColor: hoveredItem.color }}
                  aria-hidden="true"
                />
                <span className="truncate">{hoveredItem.topic}</span>
              </span>
              <span className="text-[#67E8F9] shrink-0">
                {formatClock(hoveredItem.durationSec)} ({hoveredItem.sharePct}%)
              </span>
            </div>
            <p className="mt-1 text-xs font-medium text-[#E4E9F1] leading-snug line-clamp-2">
              Ch. {String(hoveredItem.index + 1).padStart(2, '0')} · {hoveredItem.title}
            </p>
            <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-[#8C96A8] font-mono">
              <span className="truncate">
                {hoveredItem.tags.length > 0
                  ? hoveredItem.tags.join(' · ')
                  : `${formatClock(hoveredItem.startSec)} – ${formatClock(hoveredItem.endSec)}`}
              </span>
              <span className="text-[#22D3EE] shrink-0">
                {hoveredItem.hasAudio ? 'Click to play' : 'Jump to chapter'}
              </span>
            </div>
          </div>
        )}

        <svg
          ref={svgRef}
          role="img"
          aria-label={`Briefing duration breakdown across ${topicSummaries
            .map((t) => `${t.topic} ${t.sharePct}%`)
            .join(', ')}`}
          className="block w-full overflow-visible"
        />
      </div>

      {/* Interactive Topic Breakdown Legend */}
      <div className="mt-2.5 pt-2.5 border-t border-[#1F2532] flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {topicSummaries.map((item) => {
          const isSelected = lockedTopic === item.topic;
          const isDimmed = Boolean(focusedTopic && focusedTopic !== item.topic);
          return (
            <button
              key={item.topic}
              type="button"
              aria-pressed={isSelected}
              onMouseEnter={() => setHoveredTopic(item.topic)}
              onMouseLeave={() => setHoveredTopic(null)}
              onClick={() =>
                setLockedTopic((prev) => (prev === item.topic ? null : item.topic))
              }
              className={`h-7 px-2 inline-flex items-center gap-1.5 text-xs rounded border transition-colors whitespace-nowrap cursor-pointer ${
                isSelected
                  ? 'bg-[#18212E] border-[#22D3EE]/60 text-[#F5F7FA]'
                  : 'bg-transparent border-transparent hover:bg-[#0E1116] hover:border-[#2A3342] text-[#D5DCE6]'
              } ${isDimmed ? 'opacity-45' : 'opacity-100'}`}
            >
              <span
                className="w-2.5 h-2.5 rounded-[2px] shrink-0"
                style={{ backgroundColor: item.color }}
                aria-hidden="true"
              />
              <span className="font-medium">{item.topic}</span>
              <span className="font-mono text-[11px] tabular-nums text-[#8C96A8]">
                {item.sharePct}% · {formatClock(item.durationSec)}
              </span>
            </button>
          );
        })}

        {lockedTopic && (
          <button
            type="button"
            onClick={() => setLockedTopic(null)}
            className="ml-auto text-[11px] font-mono text-[#67E8F9] hover:underline whitespace-nowrap cursor-pointer"
          >
            Reset highlight
          </button>
        )}
      </div>
    </section>
  );
}
