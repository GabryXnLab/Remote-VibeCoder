'use strict';

const { execFile } = require('child_process');

let _cachedGpu     = null;
let _lastSampleMs  = 0;
const GPU_SAMPLE_INTERVAL = 10_000; // every 10s

/**
 * Returns GPU utilisation as 0.0-1.0, or null if nvidia-smi is unavailable.
 * Result is cached for 10 seconds to avoid frequent child process spawns.
 */
function getGpuUsage() {
  const now = Date.now();
  if (now - _lastSampleMs < GPU_SAMPLE_INTERVAL) return Promise.resolve(_cachedGpu);

  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 2000 },
      (err, stdout) => {
        if (err) {
          _cachedGpu    = null;
          _lastSampleMs = now;
          return resolve(null);
        }
        const val = parseInt(stdout.trim(), 10);
        _cachedGpu    = isNaN(val) ? null : val / 100;
        _lastSampleMs = now;
        resolve(_cachedGpu);
      }
    );
  });
}

module.exports = { getGpuUsage };
