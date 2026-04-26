import { notify } from '../diagnostics/notification-center.js';
import { emit } from '../core/event-bus.js';
import { RuntimeEvents } from '../contracts/runtime-events.js';

export class RvmDiagnostics {
  constructor() {
    this.entries = [];
  }

  add(level, title, message, details = null) {
    const entry = { level, title, message, details, ts: Date.now() };
    this.entries.push(entry);

    // Call existing notification center
    notify({ level, title, message, details });

    // Emit event for diagnostics panel update
    emit(RuntimeEvents.RVM_CONFIG_CHANGED, { source: 'rvm-diagnostics', diagnostics: this.entries });

    return entry;
  }

  info(title, message, details) {
    return this.add('info', title, message, details);
  }

  warn(title, message, details) {
    return this.add('warning', title, message, details);
  }

  error(title, message, details) {
    return this.add('error', title, message, details);
  }

  clear() {
    this.entries = [];
    emit(RuntimeEvents.RVM_CONFIG_CHANGED, { source: 'rvm-diagnostics', diagnostics: this.entries });
  }

  getEntries() {
    return [...this.entries];
  }
}

// Global instance for convenience, or you can instantiate it per session.
export const rvmDiagnostics = new RvmDiagnostics();
