import * as THREE from 'three';
import { emit } from '../core/event-bus.js';
import { RuntimeEvents } from '../contracts/runtime-events.js';

export class RvmSelectionAdapter {
    constructor(viewer) {
        this.viewer = viewer;
        this.selectedCanonicalId = null;
        this.selectedMeshes = [];
        this.selectedOriginalEmissives = new Map(); // mesh -> color

        this.isActive = true;

        this._raycaster = new THREE.Raycaster();
        this._pointer = new THREE.Vector2();

        this._bindInteractions();
    }

    setActive(active) {
        this.isActive = active;
    }

    _bindInteractions() {
        this._onPointerDown = (event) => {
            if (!this.isActive || !this.viewer.camera || !this.viewer.renderer || !this.viewer._componentGroup) return;

            const rect = this.viewer.renderer.domElement.getBoundingClientRect();
            if (!rect.width || !rect.height) return;

            this._pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            this._pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

            this._raycaster.setFromCamera(this._pointer, this.viewer.camera);
            const hits = this._raycaster.intersectObject(this.viewer._componentGroup, true);

            let pickedRenderId = null;
            for (const entry of hits) {
                let obj = entry.object || null;
                if (obj.isMesh && obj.userData && obj.userData.renderObjectId) {
                    pickedRenderId = obj.userData.renderObjectId;
                    break;
                }
            }

            if (!pickedRenderId) {
                this.clearSelection();
                return;
            }

            const canonicalId = this.viewer._identityMap ? this.viewer._identityMap.canonicalFromRender(pickedRenderId) : null;
            if (canonicalId) {
                this.selectByCanonicalId(canonicalId);
            } else {
                 this.clearSelection();
            }
        };

        if (this.viewer.renderer && this.viewer.renderer.domElement) {
            this.viewer.renderer.domElement.addEventListener('pointerdown', this._onPointerDown);
        }
    }

    selectByCanonicalId(canonicalId) {
        if (!canonicalId || this.selectedCanonicalId === canonicalId) return;

        this.clearSelection();
        this.selectedCanonicalId = canonicalId;

        const renderIds = this.viewer._identityMap ? this.viewer._identityMap.renderIdsFromCanonical(canonicalId) : [];
        if (!renderIds || renderIds.length === 0) return;

        const renderIdSet = new Set(renderIds);

        this.viewer._componentGroup.traverse((obj) => {
            if (obj.isMesh && obj.userData && obj.userData.renderObjectId && renderIdSet.has(obj.userData.renderObjectId)) {
                this.selectedMeshes.push(obj);

                if (obj.material && obj.material.emissive) {
                    this.selectedOriginalEmissives.set(obj, obj.material.emissive.getHex());
                    obj.material.emissive.setHex(0x2244cc);
                }
            }
        });

        emit(RuntimeEvents.RVM_NODE_SELECTED, { canonicalObjectId: canonicalId });
    }

    clearSelection() {
        if (this.selectedMeshes.length > 0) {
            for (const mesh of this.selectedMeshes) {
                if (mesh.material && mesh.material.emissive && this.selectedOriginalEmissives.has(mesh)) {
                    mesh.material.emissive.setHex(this.selectedOriginalEmissives.get(mesh));
                }
            }
        }
        this.selectedMeshes = [];
        this.selectedOriginalEmissives.clear();
        this.selectedCanonicalId = null;
    }

    getSelectedCanonicalId() {
        return this.selectedCanonicalId;
    }

    getSelectedCanonicalIds() {
        return this.selectedCanonicalId ? [this.selectedCanonicalId] : [];
    }

    getSelectedMeshes() {
        return this.selectedMeshes;
    }

    getSelection() {
        return {
             canonicalObjectId: this.selectedCanonicalId,
             renderObjectIds: this.selectedMeshes.map(m => m.userData.renderObjectId).filter(Boolean)
        };
    }

    dispose() {
        if (this.viewer.renderer && this.viewer.renderer.domElement && this._onPointerDown) {
             this.viewer.renderer.domElement.removeEventListener('pointerdown', this._onPointerDown);
        }
        this.clearSelection();
    }
}
