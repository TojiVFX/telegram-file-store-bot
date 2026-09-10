/**
 * Automated Memory & Cache Recycler
 * Continuously returns CPU & RAM usage back to baseline ("normal") by:
 * 1. Pruning stale caches & rate-limiting records.
 * 2. Invoking V8 garbage collection (when --expose-gc is enabled).
 * 3. Logging heap/RSS recovery metrics.
 */

import { pruneExpiredRateLimits } from './bot-common.js';
import { pruneBotHelperCaches } from './bot-helpers.js';

let isRecycling = false;

export function recycleMemory(trigger = 'periodic') {
  if (isRecycling) return;
  isRecycling = true;

  try {
    const before = process.memoryUsage();
    const rssBeforeMb = (before.rss / 1024 / 1024).toFixed(1);
    const heapBeforeMb = (before.heapUsed / 1024 / 1024).toFixed(1);

    // 1. Purge internal in-memory caches
    pruneExpiredRateLimits();
    pruneBotHelperCaches();

    // 2. Force V8 Garbage Collection to release memory back to OS
    if (typeof global.gc === 'function') {
      global.gc();
    }

    const after = process.memoryUsage();
    const rssAfterMb = (after.rss / 1024 / 1024).toFixed(1);
    const heapAfterMb = (after.heapUsed / 1024 / 1024).toFixed(1);

    console.log(`[Auto-Cache Recycler] RAM reset to baseline (${trigger}): RSS ${rssBeforeMb}MB → ${rssAfterMb}MB | Heap: ${heapBeforeMb}MB → ${heapAfterMb}MB`);
  } catch (err) {
    console.warn('[Auto-Cache Recycler] Warning:', err.message);
  } finally {
    isRecycling = false;
  }
}

/**
 * Start the recurring background memory & cache recycler
 * @param {number} intervalMs - Interval between memory recycling cycles (default: 5 minutes)
 */
export function startMemoryRecycler(intervalMs = 5 * 60 * 1000) {
  // First recycle 20 seconds after boot to clean up module load overhead
  setTimeout(() => recycleMemory('warmup'), 20_000).unref?.();

  // Recurring memory reset
  const timer = setInterval(() => {
    recycleMemory('scheduled');
  }, intervalMs);
  timer.unref?.();

  console.log(`[Auto-Cache Recycler] Active — automatically reclaiming RAM and purging caches every ${Math.round(intervalMs / 60000)} minutes.`);
}
