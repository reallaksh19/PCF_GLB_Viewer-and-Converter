/**
 * RvmLoadPipeline — Orchestration + async session (merged RvmAsyncSession).
 */
import { emit } from '../core/event-bus.js';
import { RuntimeEvents } from '../contracts/runtime-events.js';
import { state } from '../core/state.js';
import { notifyRvmDiagnostic } from './RvmDiagnostics.js';

/**
 * Creates a unique identifier for the load session.
 */
function generateLoadId() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

/**
 * Unified load entry
 * @param {object} input { kind: 'bundle', payload: manifest } or { kind: 'raw-rvm', file: File }
 * @param {object} ctx { capabilities, staticBundleLoader, assistedBridge }
 */
export async function loadRvmSource(input, ctx) {
  const { capabilities } = ctx;

  const loadId = generateLoadId();
  state.rvm.asyncLoad = {
    loadId,
    status: 'loading',
    phase: 'manifest',
    progress: 0,
    error: null,
    startedAt: Date.now(),
  };
  emit(RuntimeEvents.RVM_CONFIG_CHANGED, { reason: 'load-start', loadId });

  const session = {
    loadId,
    isStale: () => state.rvm.asyncLoad.loadId !== loadId || state.rvm.asyncLoad.status === 'cancelled',
    updateProgress: (phase, progress) => {
      if (state.rvm.asyncLoad.loadId !== loadId) return;
      state.rvm.asyncLoad.phase = phase;
      state.rvm.asyncLoad.progress = progress;
      emit(RuntimeEvents.RVM_CONFIG_CHANGED, { reason: 'load-progress', loadId, phase, progress });
    },
    commit: (result) => {
      if (state.rvm.asyncLoad.loadId !== loadId) return; // discarded
      state.rvm.asyncLoad.status = 'loaded';
      state.rvm.asyncLoad.phase = 'done';
      state.rvm.asyncLoad.progress = 100;

      // Update state with loaded model data
      state.rvm.manifest = result.manifest;
      state.rvm.activeBundle = result.manifest.bundleId;
      state.rvm.index = result.index || null;
      state.rvm.identityMap = result.identityMap || null;
      state.rvm.tags = result.tags || [];

      emit(RuntimeEvents.RVM_MODEL_LOADED, { loadId, result });
      emit(RuntimeEvents.RVM_CONFIG_CHANGED, { reason: 'load-done', loadId });
    },
    fail: (error) => {
      if (state.rvm.asyncLoad.loadId !== loadId) return;
      state.rvm.asyncLoad.status = 'error';
      state.rvm.asyncLoad.error = error.message;
      notifyRvmDiagnostic('error', `Failed to load: ${error.message}`);
      emit(RuntimeEvents.RVM_CONFIG_CHANGED, { reason: 'load-error', loadId, error: error.message });
    },
    cancel: () => {
      if (state.rvm.asyncLoad.loadId !== loadId) return;
      state.rvm.asyncLoad.status = 'cancelled';
      state.rvm.asyncLoad.phase = null;
      state.rvm.asyncLoad.error = null;
      emit(RuntimeEvents.RVM_CONFIG_CHANGED, { reason: 'load-cancelled', loadId });
    }
  };

  try {
    if (input.kind === 'bundle') {
      return await ctx.staticBundleLoader.load(input, ctx, session);
    }

    if (input.kind === 'raw-rvm') {
      if (!capabilities?.rawRvmImport) {
        throw new Error('Raw RVM import unavailable in static mode. Load a converted bundle instead.');
      }
      return await ctx.assistedBridge.convertAndLoad(input, ctx, session);
    }

    throw new Error('Unsupported RVM source.');
  } catch (err) {
    session.fail(err);
    throw err;
  }
}

/**
 * Cancel the current load operation.
 */
export function cancelRvmLoad() {
  const currentLoadId = state.rvm.asyncLoad.loadId;
  if (!currentLoadId || state.rvm.asyncLoad.status !== 'loading') {
    return; // Nothing to cancel
  }

  state.rvm.asyncLoad.status = 'cancelled';
  state.rvm.asyncLoad.phase = null;
  state.rvm.asyncLoad.error = null;
  emit(RuntimeEvents.RVM_CONFIG_CHANGED, { reason: 'load-cancelled', loadId: currentLoadId });
}
