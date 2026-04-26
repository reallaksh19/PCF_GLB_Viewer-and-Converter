/**
 * RvmStaticBundleLoader — GLB + JSON + XML loading logic.
 */
import { notifyRvmDiagnostic } from './RvmDiagnostics.js';
import { RvmIdentityMap } from './RvmIdentityMap.js';
import { parseBundleManifest } from './RvmBundleManifest.js';

export const RvmStaticBundleLoader = {
  /**
   * Load the resources requested in a bundle manifest.
   * @param {object} input { kind: 'bundle', payload: manifest, basePath?: string }
   * @param {object} ctx Context for loaders.
   * @param {object} session Async session.
   */
  async load(input, ctx, session) {
    if (session.isStale()) return;

    let manifest;
    try {
      manifest = parseBundleManifest(input.payload);
    } catch (err) {
      throw new Error(`Invalid bundle manifest: ${err.message}`);
    }

    const basePath = input.basePath || '';
    const glbUrl = basePath + manifest.artifacts.glb;
    const indexUrl = manifest.artifacts.index ? basePath + manifest.artifacts.index : null;
    const tagsUrl = manifest.artifacts.tags ? basePath + manifest.artifacts.tags : null;

    let glbScene = null;
    session.updateProgress('glb', 20);

    if (input._testOverrides && input._testOverrides.glbLoader) {
      glbScene = await input._testOverrides.glbLoader(glbUrl);
    } else {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(glbUrl);
      glbScene = gltf.scene;
    }

    if (session.isStale()) return;

    session.updateProgress('index', 50);

    let indexData = null;
    if (input._testOverrides && input._testOverrides.indexData) {
      indexData = input._testOverrides.indexData;
    } else if (indexUrl) {
      try {
        const res = await fetch(indexUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        indexData = await res.json();
      } catch (err) {
        notifyRvmDiagnostic('error', `Failed to load index JSON: ${err.message}`);
      }
    }

    if (indexData && indexData.bundleId && indexData.bundleId !== manifest.bundleId) {
      notifyRvmDiagnostic('warning', `Mismatched bundleId in index.json (${indexData.bundleId}) vs manifest (${manifest.bundleId})`);
    }

    if (session.isStale()) return;

    session.updateProgress('tags', 70);
    let tags = [];
    if (input._testOverrides && input._testOverrides.tagsData) {
      tags = input._testOverrides.tagsData;
    } else if (tagsUrl) {
      try {
        const res = await fetch(tagsUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const xmlText = await res.text();

        // Basic parsing or leave it raw for TagXmlStore to handle later
        // In this implementation, TagStore handles XML text parsing,
        // so we can pass xmlText as an object. But let's keep it simple for now
        // As per spec we'll just pass the text forward or parse it if tag store is not doing it.
        // Actually the specs say `TagXmlStore.js` will parse XML. We just return the loaded text or simple objects.
        tags = [{ rawXml: xmlText }];
      } catch (err) {
        notifyRvmDiagnostic('error', `Failed to load review tags XML: ${err.message}`);
      }
    }

    if (session.isStale()) return;

    session.updateProgress('build-tree', 80);
    let identityMap = null;
    if (indexData && indexData.nodes) {
        identityMap = RvmIdentityMap.fromNodes(indexData.nodes);
    }

    if (session.isStale()) return;

    const result = {
      manifest,
      index: indexData,
      identityMap,
      tags,
      glb: glbScene
    };

    session.commit(result);
    return result;
  },

  /**
   * Deterministic matching for raw RVM sidecars.
   * - Prefers .att over .txt.
   * - Rejects .rev (it is derived output, not source).
   */
  matchSidecars(baseFilename, availableFiles) {
    const base = baseFilename.replace(/\.rvm$/i, '');
    let att = null;
    let txt = null;

    for (const file of availableFiles) {
      const lower = file.toLowerCase();
      if (lower === `${base.toLowerCase()}.att`) att = file;
      if (lower === `${base.toLowerCase()}.txt`) txt = file;
      if (lower === `${base.toLowerCase()}.rev`) {
        notifyRvmDiagnostic('warning', `.rev files are derived output and cannot be used as source tags. Ignoring ${file}.`);
      }
    }

    if (att && txt) {
      notifyRvmDiagnostic('warning', `Both .att and .txt found for ${base}. Preferring .att.`);
    }

    return { attributes: att || txt || null };
  }
};
