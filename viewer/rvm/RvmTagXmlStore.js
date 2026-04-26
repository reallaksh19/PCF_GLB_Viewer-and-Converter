import { emit } from '../core/event-bus.js';
import { RuntimeEvents } from '../contracts/runtime-events.js';
import { notify } from '../diagnostics/notification-center.js';
import { state, saveStickyState } from '../core/state.js';

const SCHEMA_VERSION = 'rvm-review-tags/v1';

export class RvmTagXmlStore {
  constructor(identityMap, activeBundleId) {
    this.identityMap = identityMap;
    this.bundleId = activeBundleId;
    this.tags = new Map(); // id -> tag config

    // Load from state if available
    if (state.rvm.tags && Array.isArray(state.rvm.tags)) {
      for (const t of state.rvm.tags) {
        if (t.bundleId === this.bundleId) {
          this.tags.set(t.id, t);
        }
      }
    }
  }

  // Create a new tag programmatically
  createTag(config) {
    // Generate an id if not provided
    const id = config.id || `TAG-${Date.now()}-${Math.floor(Math.random()*1000)}`;
    const tag = {
      id,
      bundleId: this.bundleId,
      canonicalObjectId: config.canonicalObjectId || '',
      sourceObjectId: config.sourceObjectId || '',
      anchorType: config.anchorType || 'object',
      text: config.text || '',
      severity: config.severity || 'info',
      viewStateRef: config.viewStateRef || '',
      status: config.status || 'active', // active, unresolved
      worldPosition: config.worldPosition || null, // Optional position to place the tag in 3D
      cameraState: config.cameraState || null
    };

    if (!tag.sourceObjectId && tag.canonicalObjectId) {
      const entry = this.identityMap?.lookupByCanonical(tag.canonicalObjectId);
      if (entry) {
        tag.sourceObjectId = entry.sourceObjectId;
      }
    }

    this.tags.set(id, tag);
    this._persist();
    emit(RuntimeEvents.RVM_TAG_CREATED, { tag });
    return tag;
  }

  deleteTag(id) {
    if (this.tags.has(id)) {
      const tag = this.tags.get(id);
      this.tags.delete(id);
      this._persist();
      emit(RuntimeEvents.RVM_TAG_DELETED, { id, tag });
      return true;
    }
    return false;
  }

  getTag(id) {
    return this.tags.get(id) || null;
  }

  getAllTags() {
    return Array.from(this.tags.values());
  }

  _persist() {
    state.rvm.tags = this.getAllTags();
    saveStickyState();
  }

  exportToXml() {
    const doc = document.implementation.createDocument(null, 'ReviewTags');
    const root = doc.documentElement;
    root.setAttribute('schemaVersion', SCHEMA_VERSION);
    if (this.bundleId) {
      root.setAttribute('bundleId', this.bundleId);
    }

    for (const tag of this.tags.values()) {
      const tagEl = doc.createElement('Tag');
      tagEl.setAttribute('id', tag.id);

      const canonicalEl = doc.createElement('CanonicalObjectId');
      canonicalEl.textContent = tag.canonicalObjectId || '';
      tagEl.appendChild(canonicalEl);

      if (tag.sourceObjectId) {
        const sourceEl = doc.createElement('SourceObjectId');
        sourceEl.textContent = tag.sourceObjectId;
        tagEl.appendChild(sourceEl);
      }

      const anchorEl = doc.createElement('AnchorType');
      anchorEl.textContent = tag.anchorType || 'object';
      tagEl.appendChild(anchorEl);

      const textEl = doc.createElement('Text');
      textEl.textContent = tag.text || '';
      tagEl.appendChild(textEl);

      const severityEl = doc.createElement('Severity');
      severityEl.textContent = tag.severity || 'info';
      tagEl.appendChild(severityEl);

      if (tag.viewStateRef) {
        const viewRefEl = doc.createElement('ViewStateRef');
        viewRefEl.textContent = tag.viewStateRef;
        tagEl.appendChild(viewRefEl);
      }

      if (tag.worldPosition) {
        const wpEl = doc.createElement('WorldPosition');
        wpEl.setAttribute('x', tag.worldPosition.x);
        wpEl.setAttribute('y', tag.worldPosition.y);
        wpEl.setAttribute('z', tag.worldPosition.z);
        tagEl.appendChild(wpEl);
      }

      if (tag.cameraState) {
        const camEl = doc.createElement('CameraState');
        const posEl = doc.createElement('Position');
        posEl.setAttribute('x', tag.cameraState.position.x);
        posEl.setAttribute('y', tag.cameraState.position.y);
        posEl.setAttribute('z', tag.cameraState.position.z);
        camEl.appendChild(posEl);

        const tgtEl = doc.createElement('Target');
        tgtEl.setAttribute('x', tag.cameraState.target.x);
        tgtEl.setAttribute('y', tag.cameraState.target.y);
        tgtEl.setAttribute('z', tag.cameraState.target.z);
        camEl.appendChild(tgtEl);

        tagEl.appendChild(camEl);
      }

      root.appendChild(tagEl);
    }

    const serializer = new XMLSerializer();
    const xmlString = serializer.serializeToString(doc);
    return `<?xml version="1.0" encoding="UTF-8"?>\n${xmlString}`;
  }

  importFromXml(xmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'application/xml');

    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      throw new Error(`XML Parse Error: ${parseError.textContent}`);
    }

    const root = doc.documentElement;
    if (root.tagName !== 'ReviewTags') {
      throw new Error('Invalid root element. Expected <ReviewTags>.');
    }

    const schemaVersion = root.getAttribute('schemaVersion');
    if (schemaVersion !== SCHEMA_VERSION) {
      notify({ type: 'warning', message: `XML schema version mismatch. Expected ${SCHEMA_VERSION}, got ${schemaVersion}`});
    }

    const xmlBundleId = root.getAttribute('bundleId');
    if (xmlBundleId && this.bundleId && xmlBundleId !== this.bundleId) {
      notify({ type: 'warning', message: `Imported tags bundleId (${xmlBundleId}) does not match current bundle (${this.bundleId}).` });
    }

    const tagElements = root.querySelectorAll('Tag');
    const importedTags = [];

    for (const tagEl of tagElements) {
      const id = tagEl.getAttribute('id');
      const canonicalObjectId = tagEl.querySelector('CanonicalObjectId')?.textContent || '';
      const sourceObjectId = tagEl.querySelector('SourceObjectId')?.textContent || '';
      const anchorType = tagEl.querySelector('AnchorType')?.textContent || 'object';
      const text = tagEl.querySelector('Text')?.textContent || '';
      const severity = tagEl.querySelector('Severity')?.textContent || 'info';
      const viewStateRef = tagEl.querySelector('ViewStateRef')?.textContent || '';

      let worldPosition = null;
      const wpEl = tagEl.querySelector('WorldPosition');
      if (wpEl) {
        worldPosition = {
          x: parseFloat(wpEl.getAttribute('x')),
          y: parseFloat(wpEl.getAttribute('y')),
          z: parseFloat(wpEl.getAttribute('z'))
        };
      }

      let cameraState = null;
      const camEl = tagEl.querySelector('CameraState');
      if (camEl) {
         const posEl = camEl.querySelector('Position');
         const tgtEl = camEl.querySelector('Target');
         if (posEl && tgtEl) {
           cameraState = {
             position: { x: parseFloat(posEl.getAttribute('x')), y: parseFloat(posEl.getAttribute('y')), z: parseFloat(posEl.getAttribute('z')) },
             target: { x: parseFloat(tgtEl.getAttribute('x')), y: parseFloat(tgtEl.getAttribute('y')), z: parseFloat(tgtEl.getAttribute('z')) }
           };
         }
      }

      let status = 'active';
      if (this.identityMap && canonicalObjectId) {
        const entry = this.identityMap.lookupByCanonical(canonicalObjectId);
        if (!entry) {
          status = 'unresolved';
          notify({ type: 'warning', message: `Imported tag ${id} references unresolved canonical ID: ${canonicalObjectId}` });
        }
      } else {
         // If we don't have an identity map initialized (e.g. static tests without full loading)
         // or it's a test case, handle gracefully
      }

      const tag = {
        id,
        bundleId: xmlBundleId || this.bundleId,
        canonicalObjectId,
        sourceObjectId,
        anchorType,
        text,
        severity,
        viewStateRef,
        status,
        worldPosition,
        cameraState
      };

      this.tags.set(id, tag);
      importedTags.push(tag);
      emit(RuntimeEvents.RVM_TAG_CREATED, { tag });
    }

    this._persist();
    return importedTags;
  }
}
