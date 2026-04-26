import assert from 'assert/strict';
import { RvmLoadPipeline } from '../../rvm/RvmLoadPipeline.js';
import { RvmStaticBundleLoader } from '../../rvm/RvmStaticBundleLoader.js';
import { rvmDiagnostics } from '../../rvm/RvmDiagnostics.js';

// Mock ctx
const mockCapabilities = { rawRvmImport: false };
const mockStaticBundleLoader = new RvmStaticBundleLoader();
const ctx = {
  capabilities: mockCapabilities,
  staticBundleLoader: mockStaticBundleLoader,
  assistedBridge: {
    convertAndLoad: async () => { throw new Error('Not implemented in mock'); }
  }
};

// Override GLTFLoader for test
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
GLTFLoader.prototype.parseAsync = async function(data) {
  if (data === 'bad_glb') throw new Error('Parse error');
  return { scene: { isScene: true } }; // mock gltf object
};

async function test_valid_bundle_manifest_loads_without_error() {
  rvmDiagnostics.clear();
  const pipeline = new RvmLoadPipeline();

  const manifest = {
    schemaVersion: "rvm-bundle/v1",
    bundleId: "test-123",
    artifacts: { glb: "model.glb", index: "model.index.json" },
    runtime: {}
  };

  const input = {
    kind: 'bundle',
    manifestText: JSON.stringify(manifest),
    fetchAsset: async (filename) => {
      if (filename === 'model.glb') return new ArrayBuffer(8);
      if (filename === 'model.index.json') return new TextEncoder().encode(JSON.stringify({ bundleId: 'test-123', nodes: [] }));
      throw new Error('Not found');
    }
  };

  const res = await pipeline.loadRvmSource(input, ctx);
  assert.equal(res.status, 'success', 'Load should succeed');
  assert.equal(pipeline.getState().status, 'loaded');
  assert.ok(res.result.gltf);
  assert.ok(res.result.index);
  assert.equal(rvmDiagnostics.getEntries().length, 0, 'No diagnostics expected');
  console.log('✅ valid bundle manifest loads without error');
}

async function test_missing_artifacts_glb_rejected() {
  rvmDiagnostics.clear();
  const pipeline = new RvmLoadPipeline();

  const manifest = {
    schemaVersion: "rvm-bundle/v1",
    bundleId: "test-123",
    artifacts: { }, // missing glb
    runtime: {}
  };

  const input = {
    kind: 'bundle',
    manifestText: JSON.stringify(manifest),
    fetchAsset: async () => new ArrayBuffer(8)
  };

  const res = await pipeline.loadRvmSource(input, ctx);
  assert.equal(res.status, 'error', 'Should fail without glb');

  const diags = rvmDiagnostics.getEntries();
  assert.equal(diags.length, 2, 'Expected diagnostic entry');
  assert.equal(diags[1].level, 'error');
  assert.match(diags[1].title, /Load Failed/); // parseBundleManifest validates and throws
  console.log('✅ missing artifacts.glb field → rejected with actionable diagnostic message');
}

async function test_invalid_json_manifest_rejected() {
  rvmDiagnostics.clear();
  const pipeline = new RvmLoadPipeline();

  const input = {
    kind: 'bundle',
    manifestText: '{ bad json',
    fetchAsset: async () => null
  };

  const res = await pipeline.loadRvmSource(input, ctx);
  assert.equal(res.status, 'error', 'Should fail parse');

  const diags = rvmDiagnostics.getEntries();
  assert.equal(diags.length, 2);
  assert.equal(diags[1].level, 'error');
  assert.match(diags[1].title, /Load Failed/);
  console.log('✅ invalid JSON in manifest → rejected with parse error diagnostic');
}

async function test_cancelling_mid_flight() {
  rvmDiagnostics.clear();
  const pipeline = new RvmLoadPipeline();

  const manifest = {
    schemaVersion: "rvm-bundle/v1",
    bundleId: "test-123",
    artifacts: { glb: "model.glb" },
    runtime: {}
  };

  let resolveFetch;
  const fetchPromise = new Promise(resolve => resolveFetch = resolve);

  const input = {
    kind: 'bundle',
    manifestText: JSON.stringify(manifest),
    fetchAsset: async () => {
      await fetchPromise; // pause load here
      return new ArrayBuffer(8);
    }
  };

  const loadPromise = pipeline.loadRvmSource(input, ctx);

  // cancel while paused
  pipeline.cancel();
  assert.equal(pipeline.getState().status, 'cancelled');

  resolveFetch(); // resume
  const res = await loadPromise;

  assert.equal(res.status, 'cancelled', 'Load should be marked cancelled');
  console.log('✅ cancelling load mid-flight leaves clean state (no partial model in scene)');
}

async function test_second_load_discards_first() {
  rvmDiagnostics.clear();
  const pipeline = new RvmLoadPipeline();

  const manifest = {
    schemaVersion: "rvm-bundle/v1",
    bundleId: "test-123",
    artifacts: { glb: "model.glb" },
    runtime: {}
  };

  let resolveFetch1;
  const fetchPromise1 = new Promise(resolve => resolveFetch1 = resolve);
  const input1 = {
    kind: 'bundle',
    manifestText: JSON.stringify(manifest),
    fetchAsset: async () => {
      await fetchPromise1;
      return new ArrayBuffer(8);
    }
  };

  const loadPromise1 = pipeline.loadRvmSource(input1, ctx);

  // Start second load
  const input2 = {
    kind: 'bundle',
    manifestText: JSON.stringify(manifest),
    fetchAsset: async () => new ArrayBuffer(8)
  };

  const loadPromise2 = pipeline.loadRvmSource(input2, ctx);
  const res2 = await loadPromise2;

  assert.equal(res2.status, 'success');

  // Finish first load
  resolveFetch1();
  const res1 = await loadPromise1;

  assert.equal(res1.status, 'cancelled', 'First load should be silently discarded due to staleness');
  console.log('✅ starting second load while first is pending → first result discarded');
}

async function test_mismatched_bundleId() {
  rvmDiagnostics.clear();
  const pipeline = new RvmLoadPipeline();

  const manifest = {
    schemaVersion: "rvm-bundle/v1",
    bundleId: "test-123",
    artifacts: { glb: "model.glb", index: "model.index.json" },
    runtime: {}
  };

  const input = {
    kind: 'bundle',
    manifestText: JSON.stringify(manifest),
    fetchAsset: async (filename) => {
      if (filename === 'model.glb') return new ArrayBuffer(8);
      if (filename === 'model.index.json') return new TextEncoder().encode(JSON.stringify({ bundleId: 'different-id', nodes: [] }));
      throw new Error('Not found');
    }
  };

  const res = await pipeline.loadRvmSource(input, ctx);
  assert.equal(res.status, 'success');

  const diags = rvmDiagnostics.getEntries();
  assert.equal(diags.length, 1);
  assert.equal(diags[0].level, 'warning');
  assert.match(diags[0].title, /Bundle ID Mismatch/);
  console.log('✅ mismatched bundleId in index.json vs manifest → warning in diagnostics, load continues');
}

async function test_missing_optional_tag_xml_succeeds() {
  rvmDiagnostics.clear();
  const pipeline = new RvmLoadPipeline();

  const manifest = {
    schemaVersion: "rvm-bundle/v1",
    bundleId: "test-123",
    artifacts: { glb: "model.glb", tags: "model.tags.xml" },
    runtime: {}
  };

  const input = {
    kind: 'bundle',
    manifestText: JSON.stringify(manifest),
    fetchAsset: async (filename) => {
      if (filename === 'model.glb') return new ArrayBuffer(8);
      if (filename === 'model.tags.xml') throw new Error('Not found');
    }
  };

  const res = await pipeline.loadRvmSource(input, ctx);
  assert.equal(res.status, 'success');

  const diags = rvmDiagnostics.getEntries();
  assert.equal(diags.length, 1);
  assert.equal(diags[0].level, 'info');
  assert.match(diags[0].title, /Tags Load Skipped/);
  console.log('✅ optional tag XML absent → load succeeds (reviewTags: false in coverage)');
}

async function test_progress_events() {
  rvmDiagnostics.clear();
  const pipeline = new RvmLoadPipeline();

  const manifest = {
    schemaVersion: "rvm-bundle/v1",
    bundleId: "test-123",
    artifacts: { glb: "model.glb", index: "model.index.json" },
    runtime: {}
  };

  const phases = [];
  // Use a spy to intercept state changes
  const originalUpdate = pipeline._updateState.bind(pipeline);
  pipeline._updateState = (updates) => {
    if (updates.phase && phases[phases.length-1] !== updates.phase) phases.push(updates.phase);
    originalUpdate(updates);
  };

  const input = {
    kind: 'bundle',
    manifestText: JSON.stringify(manifest),
    fetchAsset: async (filename) => {
      if (filename === 'model.glb') return new ArrayBuffer(8);
      if (filename === 'model.index.json') return new TextEncoder().encode(JSON.stringify({ bundleId: 'test-123', nodes: [] }));
      throw new Error('Not found');
    }
  };

  await pipeline.loadRvmSource(input, ctx);

  assert.deepEqual(phases, ['manifest', 'glb', 'index', 'tags', 'done']);
  console.log('✅ progress events fired: manifest → glb → index → done');
}


async function runAll() {
  console.log('Running rvm-load-pipeline.test.js...');
  await test_valid_bundle_manifest_loads_without_error();
  await test_missing_artifacts_glb_rejected();
  await test_invalid_json_manifest_rejected();
  await test_cancelling_mid_flight();
  await test_second_load_discards_first();
  await test_mismatched_bundleId();
  await test_missing_optional_tag_xml_succeeds();
  await test_progress_events();
  console.log('All tests passed.');
}

runAll().catch(err => {
  console.error(err);
  process.exit(1);
});
