export interface TurntableRecordResult {
  blobUrl: string;
  filename: string;
  sizeKb: number;
}

function pickSupportedWebmMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const mime of candidates) {
    if (
      typeof MediaRecorder.isTypeSupported === 'function' &&
      MediaRecorder.isTypeSupported(mime)
    ) {
      return mime;
    }
  }
  return '';
}

/**
 * Records a clean 60 FPS `.webm` turntable video directly from the WebGL `<canvas>`
 * via `canvas.captureStream(60)` and `MediaRecorder` with zero server roundtrips.
 */
export function recordCanvasTurntableWebM(
  canvas: HTMLCanvasElement,
  durationMs = 6000,
  onProgress?: (pct: number) => void
): {
  stopEarly: () => void;
  promise: Promise<TurntableRecordResult>;
} {
  if (
    typeof MediaRecorder === 'undefined' ||
    typeof canvas.captureStream !== 'function'
  ) {
    return {
      stopEarly: () => {},
      promise: Promise.reject(
        new Error('WebM canvas recording is not supported in this browser.')
      ),
    };
  }

  const stream = canvas.captureStream(60);
  const mimeType = pickSupportedWebmMime();
  const chunks: BlobPart[] = [];

  const recorder = mimeType
    ? new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 12_000_000,
      })
    : new MediaRecorder(stream, {
        videoBitsPerSecond: 12_000_000,
      });

  let progressTimer = 0;
  let stopTimer = 0;
  const startedAt = performance.now();

  const cleanupTimersAndTracks = () => {
    if (progressTimer) window.clearInterval(progressTimer);
    if (stopTimer) window.clearTimeout(stopTimer);
    stream.getTracks().forEach((t) => t.stop());
  };

  const promise = new Promise<TurntableRecordResult>((resolve, reject) => {
    recorder.ondataavailable = (evt) => {
      if (evt.data && evt.data.size > 0) {
        chunks.push(evt.data);
      }
    };

    recorder.onerror = () => {
      cleanupTimersAndTracks();
      reject(new Error('MediaRecorder encountered an encoding error.'));
    };

    recorder.onstop = () => {
      cleanupTimersAndTracks();
      onProgress?.(100);
      const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
      const blobUrl = URL.createObjectURL(blob);
      resolve({
        blobUrl,
        filename: `dispatch-3d-turntable-${Date.now()}.webm`,
        sizeKb: Math.max(1, Math.round(blob.size / 1024)),
      });
    };

    recorder.start(120);

    progressTimer = window.setInterval(() => {
      const elapsed = performance.now() - startedAt;
      const pct = Math.min(99, Math.round((elapsed / durationMs) * 100));
      onProgress?.(pct);
    }, 120);

    stopTimer = window.setTimeout(() => {
      if (recorder.state !== 'inactive') {
        recorder.stop();
      }
    }, durationMs);
  });

  return {
    stopEarly: () => {
      if (recorder.state !== 'inactive') {
        recorder.stop();
      }
    },
    promise,
  };
}
