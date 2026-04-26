/**
 * RvmDiagnostics — Aggregator for load errors, unresolved tags, mismatched IDs.
 */
import { emit } from '../core/event-bus.js';
import { RuntimeEvents } from '../contracts/runtime-events.js';
import { notify } from '../diagnostics/notification-center.js';
import { state } from '../core/state.js';

export function notifyRvmDiagnostic(level, message, details = null) {
  state.rvm.diagnostics.push({ level, message, details, ts: Date.now() });

  notify({
    level,
    title: level === 'error' ? 'RVM Error' : 'RVM Warning',
    message,
    details
  });

  emit(RuntimeEvents.RVM_CONFIG_CHANGED, { reason: 'diagnostic-added' });
}

export function clearRvmDiagnostics() {
  state.rvm.diagnostics = [];
  emit(RuntimeEvents.RVM_CONFIG_CHANGED, { reason: 'diagnostics-cleared' });
}
