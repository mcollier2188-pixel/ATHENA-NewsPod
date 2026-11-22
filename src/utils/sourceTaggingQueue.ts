export interface TaggingQueueSourceItem {
  id: string;
  title: string;
  summary?: string;
  content?: string;
  category?: string;
}

export interface TaggingQueueSnapshot {
  isProcessing: boolean;
  queuedCount: number;
  inFlightCount: number;
  activeBatches: number;
  completedInRun: number;
  totalInRun: number;
  queuedIds: ReadonlySet<string>;
  inFlightIds: ReadonlySet<string>;
}

export interface SourceTaggingQueueOptions {
  batchSize?: number;
  maxConcurrency?: number;
  coalesceDelayMs?: number;
  maxRetries?: number;
  processor: (
    batch: TaggingQueueSourceItem[]
  ) => Promise<Record<string, string[]>>;
  onBatchResolved?: (
    tagsById: Record<string, string[]>,
    processedIds: string[]
  ) => void;
  onStateChange?: (snapshot: TaggingQueueSnapshot) => void;
}

interface Waiter {
  targetIds: Set<string>;
  collected: Record<string, string[]>;
  resolve: (result: Record<string, string[]>) => void;
}

export const EMPTY_TAGGING_QUEUE_SNAPSHOT: TaggingQueueSnapshot = {
  isProcessing: false,
  queuedCount: 0,
  inFlightCount: 0,
  activeBatches: 0,
  completedInRun: 0,
  totalInRun: 0,
  queuedIds: new Set<string>(),
  inFlightIds: new Set<string>(),
};

/**
 * Concurrent, coalescing batch processing queue for automatic source tagging.
 * Buffers rapidly imported documents into optimal multi-source batches and
 * dispatches multiple batches simultaneously without canceling in-flight workers.
 */
export class SourceTaggingQueue {
  private readonly batchSize: number;
  private readonly maxConcurrency: number;
  private readonly coalesceDelayMs: number;
  private readonly maxRetries: number;
  private readonly processor: (
    batch: TaggingQueueSourceItem[]
  ) => Promise<Record<string, string[]>>;
  private readonly onBatchResolved?: (
    tagsById: Record<string, string[]>,
    processedIds: string[]
  ) => void;
  private readonly onStateChange?: (snapshot: TaggingQueueSnapshot) => void;

  private queuedOrder: string[] = [];
  private queuedItems = new Map<string, TaggingQueueSourceItem>();
  private inFlightIds = new Set<string>();
  private activeBatches = 0;
  private completedInRun = 0;
  private totalInRun = 0;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private waiters: Waiter[] = [];

  constructor(options: SourceTaggingQueueOptions) {
    this.batchSize = Math.max(1, options.batchSize ?? 8);
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 3);
    this.coalesceDelayMs = Math.max(0, options.coalesceDelayMs ?? 120);
    this.maxRetries = Math.max(0, options.maxRetries ?? 1);
    this.processor = options.processor;
    this.onBatchResolved = options.onBatchResolved;
    this.onStateChange = options.onStateChange;
  }

  public getSnapshot(): TaggingQueueSnapshot {
    const isProcessing =
      this.queuedItems.size > 0 ||
      this.inFlightIds.size > 0 ||
      this.activeBatches > 0;
    return {
      isProcessing,
      queuedCount: this.queuedItems.size,
      inFlightCount: this.inFlightIds.size,
      activeBatches: this.activeBatches,
      completedInRun: this.completedInRun,
      totalInRun: this.totalInRun,
      queuedIds: new Set(this.queuedItems.keys()),
      inFlightIds: new Set(this.inFlightIds),
    };
  }

  public enqueue(
    sources: TaggingQueueSourceItem[],
    options?: { force?: boolean }
  ): Promise<Record<string, string[]>> {
    if (this.disposed || sources.length === 0) {
      return Promise.resolve({});
    }

    const force = Boolean(options?.force);
    const wasIdle =
      this.queuedItems.size === 0 &&
      this.inFlightIds.size === 0 &&
      this.activeBatches === 0;

    if (wasIdle) {
      this.completedInRun = 0;
      this.totalInRun = 0;
    }

    const trackedIds = new Set<string>();

    for (const item of sources) {
      if (!item?.id) continue;

      const alreadyQueued = this.queuedItems.has(item.id);
      const alreadyInFlight = this.inFlightIds.has(item.id);

      if (alreadyQueued) {
        this.queuedItems.set(item.id, item);
        trackedIds.add(item.id);
        continue;
      }

      if (alreadyInFlight && !force) {
        trackedIds.add(item.id);
        continue;
      }

      this.queuedItems.set(item.id, item);
      this.queuedOrder.push(item.id);
      this.totalInRun += 1;
      trackedIds.add(item.id);
    }

    if (trackedIds.size === 0) {
      return Promise.resolve({});
    }

    const promise = new Promise<Record<string, string[]>>((resolve) => {
      this.waiters.push({
        targetIds: trackedIds,
        collected: {},
        resolve,
      });
    });

    this.emitState();
    this.schedulePump();

    return promise;
  }

  public remove(sourceId: string): void {
    if (this.queuedItems.delete(sourceId)) {
      this.queuedOrder = this.queuedOrder.filter((id) => id !== sourceId);
      this.totalInRun = Math.max(this.completedInRun, this.totalInRun - 1);
      this.settleItemForWaiters(sourceId, undefined);
      this.emitState();
    }
  }

  public dispose(): void {
    this.disposed = true;
    if (this.coalesceTimer !== null) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    this.queuedOrder = [];
    this.queuedItems.clear();
    this.inFlightIds.clear();
    for (const waiter of this.waiters) {
      waiter.resolve(waiter.collected);
    }
    this.waiters = [];
  }

  private emitState(): void {
    if (this.disposed) return;
    this.onStateChange?.(this.getSnapshot());
  }

  private schedulePump(): void {
    if (this.disposed) return;

    // Immediately dispatch full batches whenever worker slots are open
    while (
      this.activeBatches < this.maxConcurrency &&
      this.queuedItems.size >= this.batchSize
    ) {
      if (this.coalesceTimer !== null) {
        clearTimeout(this.coalesceTimer);
        this.coalesceTimer = null;
      }
      void this.launchNextBatch();
    }

    // Coalesce partial tail batches briefly so multi-file imports group together
    if (
      this.queuedItems.size > 0 &&
      this.activeBatches < this.maxConcurrency &&
      this.coalesceTimer === null
    ) {
      this.coalesceTimer = setTimeout(() => {
        this.coalesceTimer = null;
        this.drainAvailableSlots();
      }, this.coalesceDelayMs);
    }
  }

  private drainAvailableSlots(): void {
    if (this.disposed) return;
    while (
      this.activeBatches < this.maxConcurrency &&
      this.queuedItems.size > 0
    ) {
      void this.launchNextBatch();
    }
  }

  private takeNextBatch(): TaggingQueueSourceItem[] {
    const batch: TaggingQueueSourceItem[] = [];
    while (batch.length < this.batchSize && this.queuedOrder.length > 0) {
      const nextId = this.queuedOrder.shift()!;
      const item = this.queuedItems.get(nextId);
      if (!item) continue;
      this.queuedItems.delete(nextId);
      this.inFlightIds.add(nextId);
      batch.push(item);
    }
    return batch;
  }

  private async launchNextBatch(): Promise<void> {
    if (this.disposed || this.activeBatches >= this.maxConcurrency) return;
    const batch = this.takeNextBatch();
    if (batch.length === 0) return;

    this.activeBatches += 1;
    this.emitState();

    const batchIds = batch.map((b) => b.id);
    let resolvedTags: Record<string, string[]> = {};

    try {
      resolvedTags = await this.executeWithRetry(batch);
    } catch {
      resolvedTags = {};
    } finally {
      for (const id of batchIds) {
        // Only clear inFlight if not re-queued again
        this.inFlightIds.delete(id);
      }
      this.activeBatches = Math.max(0, this.activeBatches - 1);
      this.completedInRun = Math.min(
        this.totalInRun,
        this.completedInRun + batchIds.length
      );

      if (!this.disposed) {
        if (Object.keys(resolvedTags).length > 0) {
          this.onBatchResolved?.(resolvedTags, batchIds);
        }
        for (const id of batchIds) {
          if (!this.queuedItems.has(id)) {
            this.settleItemForWaiters(id, resolvedTags[id]);
          }
        }
      }

      const nowIdle =
        this.queuedItems.size === 0 &&
        this.inFlightIds.size === 0 &&
        this.activeBatches === 0;

      if (nowIdle && this.coalesceTimer !== null) {
        clearTimeout(this.coalesceTimer);
        this.coalesceTimer = null;
      }

      this.emitState();
      if (!nowIdle) {
        this.drainAvailableSlots();
      }
    }
  }

  private async executeWithRetry(
    batch: TaggingQueueSourceItem[]
  ): Promise<Record<string, string[]>> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (this.disposed) return {};
      try {
        return await this.processor(batch);
      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetries) {
          const jitterMs = 250 * Math.pow(2, attempt) + Math.floor(Math.random() * 120);
          await new Promise((r) => setTimeout(r, jitterMs));
        }
      }
    }
    throw lastError;
  }

  private settleItemForWaiters(id: string, tags: string[] | undefined): void {
    if (this.waiters.length === 0) return;
    const remaining: Waiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.targetIds.has(id)) {
        if (tags && tags.length > 0) {
          waiter.collected[id] = tags;
        }
        waiter.targetIds.delete(id);
      }
      if (waiter.targetIds.size === 0) {
        waiter.resolve(waiter.collected);
      } else {
        remaining.push(waiter);
      }
    }
    this.waiters = remaining;
  }
}

/**
 * Executes an async mapper across an input array with bounded concurrency,
 * preserving deterministic result ordering.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const total = items.length;
  if (total === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, total));
  const results = new Array<R>(total);
  let cursor = 0;

  const runners = Array.from({ length: limit }, async () => {
    while (cursor < total) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  });

  await Promise.all(runners);
  return results;
}
