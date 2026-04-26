import { emit } from '../core/event-bus.js';
import { RuntimeEvents } from '../contracts/runtime-events.js';
import { rvmDiagnostics } from './RvmDiagnostics.js';

function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

export class RvmLoadPipeline {
  constructor() {
    this.currentLoadId = null;
    this.status = 'idle';
    this.phase = null;
    this.progress = 0;
    this.error = null;
    this.startedAt = null;
    this.cancelledAt = null;
  }

  _updateState(updates) {
    Object.assign(this, updates);
    // Optional: emit state change for UI
    emit(RuntimeEvents.RVM_CONFIG_CHANGED, { source: 'rvm-load-pipeline', state: this.getState() });
  }

  getState() {
    return {
      loadId: this.currentLoadId,
      status: this.status,
      phase: this.phase,
      progress: this.progress,
      error: this.error,
      startedAt: this.startedAt,
      cancelledAt: this.cancelledAt
    };
  }

  async loadRvmSource(input, ctx) {
    const loadId = generateUUID();
    this.currentLoadId = loadId;
    this._updateState({
      status: 'loading',
      phase: 'manifest',
      progress: 0,
      error: null,
      startedAt: Date.now(),
      cancelledAt: null
    });

    const isStale = () => this.currentLoadId !== loadId || this.status === 'cancelled';

    try {
      const { capabilities, staticBundleLoader, assistedBridge } = ctx;

      let result;
      if (input.kind === 'bundle') {
        result = await staticBundleLoader.load(input, ctx, (phase, progress) => {
          if (!isStale()) this._updateState({ phase, progress });
        }, isStale);
      } else if (input.kind === 'raw-rvm') {
        if (!capabilities?.rawRvmImport) {
          throw new Error('Raw RVM import unavailable in static mode. Load a converted bundle instead.');
        }
        result = await assistedBridge.convertAndLoad(input, ctx, (phase, progress) => {
           if (!isStale()) this._updateState({ phase, progress });
        }, isStale);
      } else {
        throw new Error('Unsupported RVM source.');
      }

      if (isStale()) {
        return { status: 'cancelled' }; // Silently discard
      }

      this._updateState({ status: 'loaded', phase: 'done', progress: 100 });
      return { status: 'success', result };

    } catch (err) {
      if (isStale()) {
         return { status: 'cancelled' };
      }
      this._updateState({ status: 'error', error: err.message });
      rvmDiagnostics.error('Load Failed', err.message, err.stack);
      return { status: 'error', error: err };
    }
  }

  cancel() {
    if (this.status === 'loading') {
      this._updateState({
        status: 'cancelled',
        cancelledAt: Date.now()
      });
    }
  }
}
