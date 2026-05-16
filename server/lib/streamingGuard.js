'use strict';

/**
 * CPU-based streaming state machine.
 *
 * Tracks whether the server is under enough CPU load to warrant pausing or
 * killing terminal output streams. Transitions: ok → warn → critical → ok.
 *
 * Usage:
 *   const guard = createStreamingGuard({ getThresholds, onCpuReading })
 *   guard.updateState(cpu, stats)   // called by resource-governor after each poll
 *   guard.onStreamStateChange(cb)   // subscribe (pty.js uses this)
 *   guard.stop()                    // on server shutdown
 *
 * @param {object} opts
 * @param {() => { warn: number, critical: number }} opts.getThresholds
 * @param {(cpu: number) => void} [opts.onCpuReading]  called on each recovery poll cpu reading
 */

const { getCpuUsage } = require('./procReader');

const STREAM_RECOVERY_POLL_MS = 5_000;

function createStreamingGuard({ getThresholds, onCpuReading }) {
  let _state           = 'ok';
  let _callbacks       = [];
  let _okDebounceTimer = null;
  let _recoveryTimer   = null;

  function _emit(state, stats) {
    if (state !== 'ok') _startRecovery();
    else               _stopRecovery();
    for (const cb of _callbacks) {
      try { cb(state, stats); } catch (e) {
        console.error('[streamingGuard] callback error:', e.message);
      }
    }
  }

  function updateState(cpu, stats) {
    const th = getThresholds();
    let newState;
    if (cpu >= th.critical)  newState = 'critical';
    else if (cpu >= th.warn) newState = 'warn';
    else                     newState = 'ok';

    if (newState !== _state) {
      if (newState === 'ok') {
        // Debounce ok transition — 3s hold-off avoids thrashing at boundary
        if (!_okDebounceTimer) {
          _okDebounceTimer = setTimeout(() => {
            _okDebounceTimer = null;
            _state = 'ok';
            _emit('ok', stats);
          }, 3000);
          _okDebounceTimer.unref?.();
        }
      } else {
        if (_okDebounceTimer) { clearTimeout(_okDebounceTimer); _okDebounceTimer = null; }
        _state = newState;
        _emit(newState, stats);
      }
    } else if (newState !== 'ok' && _okDebounceTimer) {
      // Still degraded — cancel the debounce timer
      clearTimeout(_okDebounceTimer);
      _okDebounceTimer = null;
    }
  }

  function _startRecovery() {
    if (_recoveryTimer) return;
    // Poll CPU every 5s while degraded (faster than normal 15-60s pressure poll)
    _recoveryTimer = setInterval(async () => {
      try {
        const cpu = await getCpuUsage();
        if (cpu === null) return;
        if (onCpuReading) onCpuReading(cpu);
        updateState(cpu, null);
      } catch (e) {
        console.error('[streamingGuard] recovery poll error:', e.message);
      }
    }, STREAM_RECOVERY_POLL_MS);
    _recoveryTimer.unref?.();
  }

  function _stopRecovery() {
    if (_recoveryTimer) { clearInterval(_recoveryTimer); _recoveryTimer = null; }
  }

  function onStreamStateChange(cb)  { _callbacks.push(cb); }
  function offStreamStateChange(cb) { _callbacks = _callbacks.filter(x => x !== cb); }
  function streamState()            { return _state; }

  function stop() {
    if (_okDebounceTimer) { clearTimeout(_okDebounceTimer); _okDebounceTimer = null; }
    _stopRecovery();
  }

  return { updateState, onStreamStateChange, offStreamStateChange, streamState, stop };
}

module.exports = { createStreamingGuard };
