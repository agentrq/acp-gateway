import { describe, it, expect } from "vitest";
import {
  createDownloadProgress,
  formatBytes,
  formatRate,
  progressLine,
  renderBar,
  type ProgressStream,
} from "../progress.js";

/** A stream that records what a bar drew, standing in for the terminal. */
function fakeStream(options: { isTTY?: boolean; columns?: number } = {}): ProgressStream & {
  written: string[];
  text: string;
} {
  const written: string[] = [];
  return {
    isTTY: options.isTTY ?? true,
    columns: options.columns ?? 80,
    written,
    get text() {
      return written.join("");
    },
    write(chunk: string) {
      written.push(chunk);
      return true;
    },
  };
}

/** A clock the test advances by hand, so rates and throttling are deterministic. */
function fakeClock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe("progress", () => {
  describe("formatBytes", () => {
    it("reports plain bytes without a decimal", () => {
      expect(formatBytes(0)).toBe("0 B");
      expect(formatBytes(512)).toBe("512 B");
      expect(formatBytes(1023)).toBe("1023 B");
    });

    it("steps up through the binary units", () => {
      expect(formatBytes(1024)).toBe("1.0 KB");
      expect(formatBytes(1536)).toBe("1.5 KB");
      expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
      expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
      expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
    });

    it("stops at the largest unit it knows rather than inventing one", () => {
      expect(formatBytes(1024 ** 5)).toBe("1024.0 TB");
    });

    it("treats nonsense as nothing downloaded", () => {
      expect(formatBytes(-1)).toBe("0 B");
      expect(formatBytes(Number.NaN)).toBe("0 B");
      expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
    });
  });

  describe("formatRate", () => {
    it("divides the bytes by the time they took", () => {
      expect(formatRate(1024, 1000)).toBe("1.0 KB/s");
      expect(formatRate(2048, 500)).toBe("4.0 KB/s");
    });

    it("says nothing when there is no measurable time or traffic", () => {
      expect(formatRate(1024, 0)).toBe("");
      expect(formatRate(1024, -5)).toBe("");
      expect(formatRate(0, 1000)).toBe("");
      expect(formatRate(1024, Number.NaN)).toBe("");
    });
  });

  describe("renderBar", () => {
    it("fills in proportion to the fraction", () => {
      expect(renderBar(0, 10)).toBe("░".repeat(10));
      expect(renderBar(0.5, 10)).toBe("█".repeat(5) + "░".repeat(5));
      expect(renderBar(1, 10)).toBe("█".repeat(10));
    });

    it("clamps a fraction that ran past its own total", () => {
      expect(renderBar(1.5, 4)).toBe("████");
      expect(renderBar(-1, 4)).toBe("░░░░");
      expect(renderBar(Number.NaN, 4)).toBe("░░░░");
    });

    it("always draws at least one cell", () => {
      expect(renderBar(1, 0)).toBe("█");
      expect(renderBar(0, -5)).toBe("░");
    });
  });

  describe("progressLine", () => {
    it("shows a bar, percentage, counts and rate when the total is known", () => {
      const line = progressLine("dl", 512 * 1024, 1024 * 1024, 1000, 80);
      expect(line).toContain("50%");
      expect(line).toContain("512.0 KB/1.0 MB");
      expect(line).toContain("512.0 KB/s");
      expect(line).toContain("█");
      expect(line).toContain("░");
    });

    it("rounds the percentage down, so it only says 100% when it is done", () => {
      expect(progressLine("dl", 999, 1000, 0, 80)).toContain("99%");
      expect(progressLine("dl", 1000, 1000, 0, 80)).toContain("100%");
    });

    it("reports raw bytes when the server sent no total", () => {
      const line = progressLine("dl", 2048, undefined, 1000, 80);
      expect(line).toBe("dl 2.0 KB 2.0 KB/s");
      expect(line).not.toContain("[");
    });

    it("treats a zero total as no total at all", () => {
      expect(progressLine("dl", 2048, 0, 0, 80)).toBe("dl 2.0 KB");
    });

    it("drops the bar rather than wrapping a narrow terminal", () => {
      const line = progressLine("downloading something", 512, 1024, 1000, 30);
      expect(line).not.toContain("[");
      expect(line).toContain("50%");
    });

    it("never returns a line wider than the terminal", () => {
      for (const columns of [10, 20, 30, 40, 60, 80]) {
        expect(progressLine("a rather long label indeed", 512, 1024, 1000, columns).length)
          .toBeLessThanOrEqual(columns);
        expect(progressLine("a rather long label indeed", 512, undefined, 1000, columns).length)
          .toBeLessThanOrEqual(columns);
      }
    });

    it("sheds the rate before it sheds the percentage", () => {
      // Room for the counts but not for the rate as well.
      const line = progressLine("dl", 512, 1024, 1000, 24);
      expect(line).toContain("50%");
      expect(line).toContain("512 B/1.0 KB");
      expect(line).not.toContain("/s");
    });

    it("falls back to a sensible width when the terminal reports nonsense", () => {
      expect(progressLine("dl", 512, 1024, 0, 0)).toContain("[");
      expect(progressLine("dl", 512, 1024, 0, Number.NaN)).toContain("[");
    });

    it("caps the bar so a wide terminal does not get an enormous one", () => {
      const line = progressLine("dl", 512, 1024, 0, 400);
      const bar = line.slice(line.indexOf("[") + 1, line.indexOf("]"));
      expect(bar).toHaveLength(32);
    });

    it("leaves the rate out until there is elapsed time to divide by", () => {
      expect(progressLine("dl", 512, 1024, 0, 80)).not.toContain("/s");
    });
  });

  describe("createDownloadProgress", () => {
    it("draws nothing at all when stderr is not a terminal", () => {
      const stream = fakeStream({ isTTY: false });
      const bar = createDownloadProgress({ label: "dl", stream });
      bar.update(10, 100);
      bar.finish();
      bar.abort();
      expect(stream.written).toEqual([]);
    });

    it("treats a stream that does not mention being a terminal as one that is not", () => {
      const stream = fakeStream();
      delete (stream as { isTTY?: boolean }).isTTY;
      const bar = createDownloadProgress({ label: "dl", stream });
      bar.update(10, 100);
      expect(stream.written).toEqual([]);
    });

    it("redraws one line in place instead of scrolling", () => {
      const stream = fakeStream();
      const clock = fakeClock();
      const bar = createDownloadProgress({ label: "dl", stream, now: clock.now, intervalMs: 0 });

      bar.update(0, 1000);
      clock.advance(1000);
      bar.update(500, 1000);

      expect(stream.written).toHaveLength(2);
      expect(stream.written.every((line) => line.startsWith("\r"))).toBe(true);
      expect(stream.text).not.toContain("\n");
      expect(stream.written[1]).toContain("50%");
    });

    it("draws the first update immediately, then throttles the rest", () => {
      const stream = fakeStream();
      const clock = fakeClock();
      const bar = createDownloadProgress({ label: "dl", stream, now: clock.now, intervalMs: 100 });

      bar.update(1, 1000);
      expect(stream.written).toHaveLength(1);

      // Too soon: these are swallowed rather than flooding the terminal.
      clock.advance(10);
      bar.update(2, 1000);
      clock.advance(10);
      bar.update(3, 1000);
      expect(stream.written).toHaveLength(1);

      clock.advance(100);
      bar.update(4, 1000);
      expect(stream.written).toHaveLength(2);
    });

    it("remembers the total once the response reveals it", () => {
      const stream = fakeStream();
      const bar = createDownloadProgress({ label: "dl", stream, intervalMs: 0 });

      bar.update(50, 100);
      bar.update(75);

      expect(stream.written[1]).toContain("75%");
    });

    it("pads over a longer previous line so no tail is left behind", () => {
      const stream = fakeStream();
      const bar = createDownloadProgress({ label: "dl", stream, intervalMs: 0 });

      bar.update(1000, 1000);
      const first = stream.written[0].length;
      bar.update(1, undefined);

      expect(stream.written[1].length).toBe(first);
    });

    it("finishes on the final numbers and ends the line", () => {
      const stream = fakeStream();
      const bar = createDownloadProgress({ label: "dl", stream, intervalMs: 1000 });

      bar.update(1000, 1000);
      bar.finish();

      expect(stream.written.at(-2)).toContain("100%");
      expect(stream.written.at(-1)).toBe("\n");
    });

    it("finishes even when nothing was ever drawn", () => {
      const stream = fakeStream();
      const bar = createDownloadProgress({ label: "dl", stream });

      bar.finish();

      expect(stream.written.at(-1)).toBe("\n");
      expect(stream.written).toHaveLength(2);
    });

    it("erases the line when the download fails", () => {
      const stream = fakeStream();
      const bar = createDownloadProgress({ label: "dl", stream, intervalMs: 0 });

      bar.update(500, 1000);
      const drawn = stream.written[0].length - 1;
      bar.abort();

      expect(stream.written.at(-1)).toBe(`\r${" ".repeat(drawn)}\r`);
    });

    it("has nothing to erase when it never drew", () => {
      const stream = fakeStream();
      const bar = createDownloadProgress({ label: "dl", stream });

      bar.abort();

      expect(stream.written).toEqual([]);
    });

    it("erases only once, so a second abort cannot blank a later line", () => {
      const stream = fakeStream();
      const bar = createDownloadProgress({ label: "dl", stream, intervalMs: 0 });

      bar.update(500, 1000);
      bar.abort();
      bar.abort();

      expect(stream.written).toHaveLength(2);
    });

    it("assumes a sensible width when the terminal does not report one", () => {
      const stream = fakeStream({ columns: 0 });
      const bar = createDownloadProgress({ label: "dl", stream, intervalMs: 0 });

      bar.update(500, 1000);

      expect(stream.written[0]).toContain("[");
      expect(stream.written[0].length).toBeLessThanOrEqual(81);
    });

    it("defaults to drawing on stderr", () => {
      const original = process.stderr.isTTY;
      try {
        process.stderr.isTTY = false;
        const bar = createDownloadProgress({ label: "dl" });
        expect(() => bar.update(1, 2)).not.toThrow();
      } finally {
        process.stderr.isTTY = original;
      }
    });

    it("uses the wall clock by default", () => {
      const stream = fakeStream();
      const bar = createDownloadProgress({ label: "dl", stream, intervalMs: 0 });

      bar.update(1024, 2048);

      expect(stream.written[0]).toContain("50%");
    });
  });
});
