/**
 * @devinegearing/cli-progress
 *
 * Animated CLI progress bars with spinners, time-estimated fills,
 * and real-time command output tracking.
 *
 * Usage:
 *   import { createProgress } from '@devinegearing/cli-progress';
 *
 *   const p = createProgress();
 *
 *   // Time-estimated bar (fills based on expected duration)
 *   await p.runEstimated({
 *     label: 'Starting containers',
 *     command: 'docker compose up -d',
 *     estimatedMs: 26_000,
 *   });
 *
 *   // Tracked bar (real % from command output)
 *   await p.runTracked({
 *     label: 'Running migrations',
 *     command: 'npx migrate up',
 *     total: 10,
 *     onOutput(text, bar) {
 *       if (text.includes('Applied')) bar.increment();
 *     },
 *   });
 *
 *   // Manual bar (for sync loops)
 *   const bar = p.start('Querying tables');
 *   for (let i = 0; i < items.length; i++) {
 *     bar.setPct(i / items.length);
 *     await p.yieldLoop();
 *     doWork(items[i]);
 *   }
 *   bar.stop();
 *   p.succeed('Verified all tables');
 */

import { spawn } from "node:child_process";
import chalk from "chalk";

export function createProgress(options = {}) {
  const {
    barWidth = 24,
    indent = 4,
    filledChar = "━",
    emptyChar = "─",
    spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    renderInterval = 80,
    estimateBuffer = 0.15,
  } = options;

  let frameIdx = 0;
  const pad = " ".repeat(indent);

  // ── Rendering ────────────────────────────────────────────────────────────

  function renderBar(pct) {
    const clamped = Math.max(0, Math.min(1, pct));
    const filled = Math.round(barWidth * clamped);
    return (
      chalk.cyan(filledChar.repeat(filled)) +
      chalk.dim(emptyChar.repeat(barWidth - filled))
    );
  }

  function paint(label, pct) {
    const pctStr = `${Math.round(pct * 100)}%`;
    const frame = chalk.cyan(spinnerFrames[frameIdx++ % spinnerFrames.length]);
    process.stdout.write(
      `\r\x1b[2K${pad}${frame} ${label}  ${renderBar(pct)}  ${chalk.dim(pctStr)}`
    );
  }

  // ── Static final states ──────────────────────────────────────────────────

  function succeed(label) {
    process.stdout.write(`\r\x1b[2K${pad}${chalk.green("✓")} ${label}\n`);
  }

  function fail(label) {
    process.stdout.write(`\r\x1b[2K${pad}${chalk.red("✖")} ${label}\n`);
  }

  function info(label) {
    process.stdout.write(`${pad}${chalk.dim("○")} ${label}\n`);
  }

  function warn(label) {
    process.stdout.write(`${pad}${chalk.yellow("⚠")} ${label}\n`);
  }

  // ── Animated bar ─────────────────────────────────────────────────────────

  /**
   * Start a continuously-animated spinner + progress bar.
   * Returns { setPct, getPct, stop }.
   */
  function start(label, initialPct = 0) {
    let pct = initialPct;
    const id = setInterval(() => paint(label, pct), renderInterval);
    paint(label, pct);
    return {
      setPct(v) { pct = v; },
      getPct() { return pct; },
      stop() { clearInterval(id); },
    };
  }

  /**
   * Quickly animate from currentPct to 100%, then print ✓.
   * Returns a promise that resolves when the animation completes.
   */
  function snapTo100(label, currentPct, finalLabel) {
    return new Promise((resolve) => {
      let frame = 0;
      const totalFrames = 8;
      const interval = setInterval(() => {
        frame++;
        paint(label, currentPct + (1 - currentPct) * (frame / totalFrames));
        if (frame >= totalFrames) {
          clearInterval(interval);
          succeed(finalLabel || label);
          resolve();
        }
      }, 30);
    });
  }

  // ── Command runners ──────────────────────────────────────────────────────

  /**
   * Run a shell command with a time-estimated progress bar.
   *
   * The bar fills to ~90% over `estimatedMs` using an ease-out curve,
   * then snaps to 100% when the command finishes.
   *
   * Options:
   *   label          — text shown next to the bar
   *   command        — shell command to run
   *   estimatedMs    — expected duration in ms (buffer is applied automatically)
   *   cwd            — working directory (default: process.cwd())
   *   doneLabel      — label on completion (string or function, default: label)
   *   tolerateFailure — function returning true to treat non-zero exit as OK
   */
  async function runEstimated({
    label,
    command,
    estimatedMs,
    cwd,
    doneLabel,
    tolerateFailure,
  }) {
    const adjustedMs = estimatedMs * (1 + estimateBuffer);
    const startTime = Date.now();
    const render = start(label);

    const pctInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      render.setPct(0.9 * (1 - Math.exp(-2.5 * (elapsed / adjustedMs))));
    }, 200);

    return new Promise((resolve, reject) => {
      let stderr = "";
      const child = spawn(command, {
        cwd: cwd || process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
      });
      child.stdout.on("data", () => {});
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("close", async (code) => {
        clearInterval(pctInterval);
        render.stop();
        const ok =
          code === 0 || (tolerateFailure && tolerateFailure());
        if (ok) {
          const final =
            typeof doneLabel === "function" ? doneLabel() : doneLabel;
          await snapTo100(label, render.getPct(), final);
          resolve();
        } else {
          fail(label);
          if (stderr.trim())
            console.error(chalk.red(`\n${stderr.trim()}\n`));
          reject(new Error(`Command failed with exit code ${code}`));
        }
      });
    });
  }

  /**
   * Run a shell command and track real progress from its output.
   *
   * Progress can be reported two ways (pick one):
   *   1. `onOutput(text, bar)` — called with each stdout/stderr chunk.
   *      Use `bar.increment()` (requires `total`) or `bar.setPct(0-1)`.
   *   2. `parseProgress(text)` — return a 0-1 number or null to skip.
   *
   * Options:
   *   label           — text shown next to the bar
   *   command         — shell command to run
   *   cwd             — working directory
   *   total           — total steps (enables bar.increment())
   *   onOutput        — function(text, bar) for line-by-line processing
   *   parseProgress   — function(text) => number|null for ratio parsing
   *   doneLabel       — label on completion (string or function)
   *   tolerateFailure — function returning true to treat non-zero exit as OK
   */
  async function runTracked({
    label,
    command,
    cwd,
    total,
    onOutput,
    parseProgress,
    doneLabel,
    tolerateFailure,
  }) {
    const render = start(label);
    let completed = 0;

    const bar = {
      setPct(v) { render.setPct(v); },
      getPct() { return render.getPct(); },
      increment() {
        completed++;
        if (total) render.setPct(completed / total);
      },
    };

    return new Promise((resolve, reject) => {
      let allStderr = "";
      const child = spawn(command, {
        cwd: cwd || process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
      });

      function processData(text, isStderr) {
        if (isStderr) allStderr += text;
        if (parseProgress) {
          const pct = parseProgress(text);
          if (pct !== null && pct !== undefined) render.setPct(pct);
        }
        if (onOutput) onOutput(text, bar);
      }

      child.stdout.on("data", (d) => processData(d.toString(), false));
      child.stderr.on("data", (d) => processData(d.toString(), true));

      child.on("close", async (code) => {
        render.stop();
        const ok =
          code === 0 || (tolerateFailure && tolerateFailure());
        if (ok) {
          const final =
            typeof doneLabel === "function" ? doneLabel() : doneLabel;
          await snapTo100(label, render.getPct(), final);
          resolve();
        } else {
          fail(label);
          if (allStderr.trim())
            console.error(chalk.red(`\n${allStderr.trim()}\n`));
          reject(new Error(`Command failed with exit code ${code}`));
        }
      });
    });
  }

  /** Yield the event loop so the spinner can animate between sync operations. */
  function yieldLoop() {
    return new Promise((r) => setTimeout(r, 0));
  }

  return {
    // Rendering
    renderBar,
    paint,
    // Static states
    succeed,
    fail,
    info,
    warn,
    // Animated bar
    start,
    snapTo100,
    // Command runners
    runEstimated,
    runTracked,
    // Helpers
    yieldLoop,
  };
}
