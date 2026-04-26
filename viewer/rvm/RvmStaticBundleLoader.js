import { parseBundleManifest } from './RvmBundleManifest.js';
import { RvmIdentityMap } from './RvmIdentityMap.js';
import { rvmDiagnostics } from './RvmDiagnostics.js';
import { emit } from '../core/event-bus.js';
import { RuntimeEvents } from '../contracts/runtime-events.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export class RvmStaticBundleLoader {

  /**
   * Loads a bundle into memory.
   * @param {Object} input - Should have { kind: 'bundle', manifestText: string, fetchAsset: async function(filename) }
   * @param {Object} ctx - Environment context
   * @param {Function} onProgress - Callback for phase and progress reporting (phase, percentage)
   * @param {Function} isStale - Callback returning boolean if load is cancelled/stale
   */
  async load(input, ctx, onProgress = () => {}, isStale = () => false) {
    if (isStale()) return null;

    let manifest;
    onProgress('manifest', 0);
    try {
      manifest = parseBundleManifest(input.manifestText);
    } catch (e) {
      rvmDiagnostics.error('Manifest Parse Error', e.message);
      throw new Error(`Manifest parse error: ${e.message}`);
    }

    if (!manifest.artifacts.glb) {
      rvmDiagnostics.error('Missing GLB', 'The manifest artifacts.glb field is required but missing.');
      throw new Error('Manifest missing artifacts.glb');
    }

    // GLB Load
    if (isStale()) return null;
    onProgress('glb', 10);
    let glbData;
    try {
      glbData = await input.fetchAsset(manifest.artifacts.glb);
    } catch (e) {
      rvmDiagnostics.error('GLB Load Failed', `Failed to load ${manifest.artifacts.glb}`);
      throw e;
    }

    // Three.js parse GLB
    if (isStale()) return null;
    onProgress('glb', 50);

    // Note: To properly load from ArrayBuffer in GLTFLoader, we use parseAsync
    const loader = new GLTFLoader();
    let gltf;
    try {
      gltf = await loader.parseAsync(glbData, '');
    } catch(e) {
       rvmDiagnostics.error('GLB Parse Failed', e.message);
       throw e;
    }

    // Index Load
    if (isStale()) return null;
    onProgress('index', 70);
    let indexData = null;
    if (manifest.artifacts.index) {
      try {
        const indexBuf = await input.fetchAsset(manifest.artifacts.index);
        const text = new TextDecoder().decode(indexBuf);
        indexData = JSON.parse(text);
        if (indexData.bundleId && indexData.bundleId !== manifest.bundleId) {
          rvmDiagnostics.warn('Bundle ID Mismatch', `Manifest bundleId (${manifest.bundleId}) does not match index.json bundleId (${indexData.bundleId}).`);
        }
      } catch (e) {
        rvmDiagnostics.warn('Index Load Failed', `Failed to load or parse index: ${manifest.artifacts.index}`);
      }
    }

    // Identity Map
    let identityMap = new RvmIdentityMap();
    if (indexData && indexData.nodes) {
       identityMap = RvmIdentityMap.fromNodes(indexData.nodes);
    }

    // Optional Tags Load
    if (isStale()) return null;
    onProgress('tags', 80);
    let tagsXml = null;
    if (manifest.artifacts.tags) {
       try {
         const tagsBuf = await input.fetchAsset(manifest.artifacts.tags);
         tagsXml = new TextDecoder().decode(tagsBuf);
       } catch(e) {
          rvmDiagnostics.info('Tags Load Skipped', `Optional tags not loaded: ${e.message}`);
       }
    }

    if (isStale()) return null;
    onProgress('done', 100);

    const result = {
       manifest,
       gltf,
       index: indexData,
       identityMap,
       tagsXml
    };

    // Broadcast loaded event
    emit(RuntimeEvents.RVM_MODEL_LOADED, result);

    return result;
  }
}
