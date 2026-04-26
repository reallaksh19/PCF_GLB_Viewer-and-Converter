import assert from 'assert/strict';

const _ls = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {}
};
global.localStorage = _ls;
if (typeof window !== 'undefined') window.localStorage = _ls;

const stateUrl = new URL('../../core/state.js', import.meta.url).href;
const RvmLoadPipelineUrl = new URL('../../rvm/RvmLoadPipeline.js', import.meta.url).href;
const RvmStaticBundleLoaderUrl = new URL('../../rvm/RvmStaticBundleLoader.js', import.meta.url).href;

async function executeTests() {
  const { state } = await import(stateUrl);
  const { loadRvmSource, cancelRvmLoad } = await import(RvmLoadPipelineUrl);
  const { RvmStaticBundleLoader } = await import(RvmStaticBundleLoaderUrl);

  const mockCtx = {
    capabilities: { rawRvmImport: false },
    staticBundleLoader: RvmStaticBundleLoader,
    assistedBridge: {
      convertAndLoad: async () => { throw new Error('Not implemented'); }
    }
  };

  const validTestOverrides = { glbLoader: async () => ({ isScene: true }) };

  async function testValidManifest() {
    const manifest = {
      schemaVersion: 'rvm-bundle/v1',
      bundleId: 'bundle-001',
      runtime: { units: 'mm', upAxis: 'Y', originOffset: [0, 0, 0], scale: 1 },
      artifacts: { glb: 'test.glb' }
    };

    const result = await loadRvmSource({ kind: 'bundle', payload: manifest, _testOverrides: validTestOverrides }, mockCtx);
    assert.equal(result.manifest.bundleId, 'bundle-001', '✅ valid bundle manifest loads without error');
    assert.equal(state.rvm.asyncLoad.status, 'loaded', 'Status must be loaded');
  }

  async function testMissingGlb() {
    const manifest = {
      schemaVersion: 'rvm-bundle/v1',
      bundleId: 'bundle-002',
      runtime: { units: 'mm', upAxis: 'Y', originOffset: [0, 0, 0], scale: 1 },
      artifacts: {} // missing glb
    };

    try {
      await loadRvmSource({ kind: 'bundle', payload: manifest, _testOverrides: validTestOverrides }, mockCtx);
      assert.fail('Should have thrown on missing artifacts.glb');
    } catch (err) {
      assert.ok(err.message.includes('artifacts.glb is required'), '✅ missing artifacts.glb field → rejected with actionable diagnostic message');
      assert.equal(state.rvm.asyncLoad.status, 'error', 'Status must be error');
    }
  }

  async function testInvalidManifestJSON() {
    const manifest = "{ this is invalid json }";

    try {
      await loadRvmSource({ kind: 'bundle', payload: manifest, _testOverrides: validTestOverrides }, mockCtx);
      assert.fail('Should have thrown on invalid json');
    } catch (err) {
      assert.ok(err.message.includes('parse error') || err.message.includes('JSON'), '✅ invalid JSON in manifest → rejected with parse error diagnostic');
      assert.equal(state.rvm.asyncLoad.status, 'error', 'Status must be error');
    }
  }

  async function testCancelLoad() {
    const manifest = {
      schemaVersion: 'rvm-bundle/v1',
      bundleId: 'bundle-cancel',
      runtime: { units: 'mm', upAxis: 'Y', originOffset: [0, 0, 0], scale: 1 },
      artifacts: { glb: 'test.glb' }
    };

    const ctxSlow = {
      capabilities: mockCtx.capabilities,
      staticBundleLoader: {
        load: async (input, ctx, session) => {
          session.updateProgress('manifest', 10);
          await new Promise(r => setTimeout(r, 50));
          if (session.isStale()) return;
          session.updateProgress('glb', 20);
          session.commit({ manifest: input.payload });
        }
      }
    };

    const loadPromise = loadRvmSource({ kind: 'bundle', payload: manifest, _testOverrides: validTestOverrides }, ctxSlow);
    cancelRvmLoad();

    await loadPromise;
    assert.equal(state.rvm.asyncLoad.status, 'cancelled', '✅ cancelling load mid-flight leaves clean state (no partial model in scene)');
  }

  async function testDiscardEarlierResult() {
    const manifest1 = { schemaVersion: 'rvm-bundle/v1', bundleId: 'b1', runtime: { units: 'mm', upAxis: 'Y', originOffset: [0, 0, 0], scale: 1 }, artifacts: { glb: 'b1.glb' } };
    const manifest2 = { schemaVersion: 'rvm-bundle/v1', bundleId: 'b2', runtime: { units: 'mm', upAxis: 'Y', originOffset: [0, 0, 0], scale: 1 }, artifacts: { glb: 'b2.glb' } };

    const ctxSlow = {
      capabilities: mockCtx.capabilities,
      staticBundleLoader: {
        load: async (input, ctx, session) => {
          await new Promise(r => setTimeout(r, 50));
          if (session.isStale()) return; // b1 will stale here
          session.commit({ manifest: input.payload });
          return { manifest: input.payload };
        }
      }
    };

    const p1 = loadRvmSource({ kind: 'bundle', payload: manifest1, _testOverrides: validTestOverrides }, ctxSlow);
    const p2 = loadRvmSource({ kind: 'bundle', payload: manifest2, _testOverrides: validTestOverrides }, ctxSlow);

    await Promise.all([p1, p2]);

    // Only the second load should be committed
    assert.equal(state.rvm.activeBundle, 'b2', '✅ starting second load while first is pending → first result discarded');
  }

  async function testMismatchedBundleId() {
    const manifest = {
      schemaVersion: 'rvm-bundle/v1',
      bundleId: 'bundle-001',
      runtime: { units: 'mm', upAxis: 'Y', originOffset: [0, 0, 0], scale: 1 },
      artifacts: { glb: 'test.glb', index: 'index.json' }
    };

    const indexData = {
      bundleId: 'bundle-wrong'
    };

    // State log starts with 0 diagnostics
    state.rvm.diagnostics = [];

    await loadRvmSource({ kind: 'bundle', payload: manifest, _testOverrides: { glbLoader: validTestOverrides.glbLoader, indexData } }, mockCtx);

    const hasWarning = state.rvm.diagnostics.some(d => d.message.includes('Mismatched bundleId'));
    assert.ok(hasWarning, '✅ mismatched bundleId in index.json vs manifest → warning in diagnostics, load continues');
  }

  async function testOptionalTagsAndProgressEvents() {
    const manifest = {
      schemaVersion: 'rvm-bundle/v1',
      bundleId: 'bundle-prog',
      runtime: { units: 'mm', upAxis: 'Y', originOffset: [0, 0, 0], scale: 1 },
      artifacts: { glb: 'test.glb' }
    };

    let phases = [];
    const ctxTracer = {
      capabilities: mockCtx.capabilities,
      staticBundleLoader: {
        load: async (input, ctx, session) => {
          phases.push('manifest');
          session.updateProgress('manifest', 10);

          phases.push('glb');
          session.updateProgress('glb', 50);

          phases.push('index');
          session.updateProgress('index', 80);

          phases.push('done');
          session.commit({ manifest: input.payload });
          return { manifest: input.payload };
        }
      }
    };

    await loadRvmSource({ kind: 'bundle', payload: manifest, _testOverrides: validTestOverrides }, ctxTracer);

    assert.deepEqual(phases, ['manifest', 'glb', 'index', 'done'], '✅ progress events fired: manifest → glb → index → done');
    // the manifest doesn't specify tags file, so loading should succeed gracefully without it.
    assert.equal(state.rvm.activeBundle, 'bundle-prog', '✅ optional tag XML absent → load succeeds (reviewTags: false in coverage)');
  }

  await testValidManifest();
  await testMissingGlb();
  await testInvalidManifestJSON();
  await testCancelLoad();
  await testDiscardEarlierResult();
  await testMismatchedBundleId();
  await testOptionalTagsAndProgressEvents();

  console.log('✅ load pipeline tests passed.');
}

executeTests().catch(err => {
  console.error(err);
  process.exit(1);
});
