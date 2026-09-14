/**
 * progress.ts
 *
 * A single-line progress bar for long downloads.
 *
 * Installing a registry agent can mean pulling tens of megabytes before
 * anything else happens, and until now that looked like a hung terminal. This
 * draws what has arrived so far, redrawing one line in place rather than
 * scrolling a wall of output.
 *
 * It stays deliberately small and dependency-free: the gateway ships two
 * protocol SDKs and nothing else, and a progress bar is not worth a third.
 */

/** The slice of a writable stream a bar needs; `process.stderr` satisfies it. */
export interface ProgressStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Widths the bar itself is allowed to take, before the surrounding text. */
const MIN_BAR = 8;
const MAX_BAR = 32;

/** Assumed terminal width when the stream does not report one. */
const FALLBACK_COLUMNS = 80;

/** Shortest gap between redraws, so a fast download cannot flood the terminal. */
const DEFAULT_INTERVAL_MS = 100;

/**
 * Renders a byte count the way a human reads one.
 *
 * Uses the binary units a download tool conventionally reports, and keeps one
 * decimal above bytes so the number visibly moves on a slow connection.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

/**
 * Renders throughput, or nothing at all.
 *
 * A rate computed over no measurable time is noise — the first chunk usually
 * arrives in the same millisecond the clock started — so it is left out until
 * there is something real to divide by.
 */
export function formatRate(bytes: number, elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || bytes <= 0) return "";
  return `${formatBytes((bytes * 1000) / elapsedMs)}/s`;
}

/** Draws the bar itself: `fraction` filled, the rest hollow. */
export function renderBar(fraction: number, width: number): string {
  const span = Math.max(1, Math.floor(width));
  const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const filled = Math.round(clamped * span);
  return "█".repeat(filled) + "░".repeat(span - filled);
}

/**
 * Composes the whole line, fitted to the terminal's width.
 *
 * The numbers matter more than the bar, so a narrow terminal loses the bar and
 * keeps the counts rather than wrapping — a wrapped line cannot be redrawn in
 * place, and would leave a trail of half-finished bars behind.
 */
export function progressLine(
  label: string,
  received: number,
  total: number | undefined,
  elapsedMs: number,
  columns: number,
): string {
  const width = Math.max(1, Math.floor(columns) || FALLBACK_COLUMNS);
  const rate = formatRate(received, elapsedMs);

  // Without a Content-Length there is no fraction to draw, so report the
  // bytes themselves: it still shows the download is alive and moving.
  if (!total) return fit(join([label, formatBytes(received), rate]), width);

  const percent = `${Math.floor(Math.min(1, received / total) * 100)}%`;
  const counts = `${formatBytes(received)}/${formatBytes(total)}`;
  const stats = join([percent, counts, rate]);

  // What is left for the bar once the text and its brackets have their room.
  const room = width - label.length - stats.length - 4;
  if (room >= MIN_BAR) {
    return join([label, `[${renderBar(received / total, Math.min(MAX_BAR, room))}]`, stats]);
  }

  // Too narrow for a bar. Shed the rate before the line wraps, since how far
  // along the download is matters more than how fast it is going.
  const withRate = join([label, stats]);
  return fit(withRate.length <= width ? withRate : join([label, percent, counts]), width);
}

function join(parts: string[]): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Clips a line to the terminal's width.
 *
 * A line that wraps cannot be redrawn in place — the carriage return only
 * returns to the start of the last row — so it would leave every earlier row
 * behind as litter. Losing the tail of one line is the cheaper failure.
 */
function fit(line: string, width: number): string {
  return line.length > width ? line.slice(0, width) : line;
}

/** A live download bar. Every method is safe to call on a bar that draws nothing. */
export interface DownloadProgress {
  /** Reports the running byte count, and the total once the response reveals it. */
  update(received: number, total?: number): void;
  /** Completes the bar and leaves the finished line on screen. */
  finish(): void;
  /** Erases the bar, for a download that failed and should not look done. */
  abort(): void;
}

export interface DownloadProgressOptions {
  /** Names what is being downloaded, at the head of the line. */
  label: string;
  stream?: ProgressStream;
  now?: () => number;
  intervalMs?: number;
}

/**
 * Starts a progress bar, or a bar that does nothing.
 *
 * Redrawing in place only means anything on a terminal: piped into a log or a
 * supervisor, the carriage returns would just run every update together, so
 * there the bar silently stands down and the surrounding log lines say all
 * there is to say.
 */
export function createDownloadProgress({
  label,
  stream = process.stderr,
  now = Date.now,
  intervalMs = DEFAULT_INTERVAL_MS,
}: DownloadProgressOptions): DownloadProgress {
  if (!stream.isTTY) return { update: () => {}, finish: () => {}, abort: () => {} };

  const startedAt = now();
  let total: number | undefined;
  let received = 0;
  let lastDrawAt = 0;
  let lastWidth = 0;
  let drawn = false;

  const draw = (): void => {
    const columns = stream.columns || FALLBACK_COLUMNS;
    const line = progressLine(label, received, total, now() - startedAt, columns);
    // Pad to the previous line's width so a line that shrank does not leave
    // the tail of the longer one it replaced on screen.
    stream.write(`\r${line.padEnd(lastWidth, " ")}`);
    lastWidth = line.length;
    lastDrawAt = now();
    drawn = true;
  };

  return {
    update(nextReceived: number, nextTotal?: number): void {
      received = nextReceived;
      if (nextTotal !== undefined) total = nextTotal;
      // The first update draws immediately, so the bar appears at once; the
      // rest wait their turn.
      if (drawn && now() - lastDrawAt < intervalMs) return;
      draw();
    },
    finish(): void {
      draw();
      stream.write("\n");
    },
    abort(): void {
      if (!drawn) return;
      // Wipe the line so the error that follows is not read as the bar's own.
      stream.write(`\r${" ".repeat(lastWidth)}\r`);
      drawn = false;
    },
  };
}
