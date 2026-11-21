import * as THREE from 'three';

export type CorridorPhysicsMode = 'smoothOrbit' | 'gravityExploration';

export interface PhysicsCheckpointDescriptor {
  index: number;
  id: string;
  waypointId?: string;
  role: 'origin' | 'stop' | 'via' | 'destination' | 'chapter';
  roleLabel: string;
  title: string;
  category: string;
  distanceMeters: number;
}

export interface FloorImpactEvent {
  position: THREE.Vector3;
  impactSpeed: number;
  checkpoint: PhysicsCheckpointDescriptor;
}

export interface CourierWaypointCollisionEvent {
  position: THREE.Vector3;
  impactSpeed: number;
  checkpoint: PhysicsCheckpointDescriptor;
}

interface WaypointNodeSlot {
  slotIndex: number;
  boundCheckpointId: string;
  boundTextureKey: string;
  checkpointIndex: number;
  active: boolean;
  rootGroup: THREE.Group;
  tumbleGroup: THREE.Group;
  billboardGroup: THREE.Group;
  coreMat: THREE.MeshPhysicalMaterial;
  ringMesh: THREE.Mesh;
  badgeMat: THREE.MeshBasicMaterial;
  hitProxyMesh: THREE.Mesh;
  shadowMesh: THREE.Mesh;
  shadowMat: THREE.MeshBasicMaterial;
  rippleMesh: THREE.Mesh;
  rippleMat: THREE.MeshBasicMaterial;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  angVel: THREE.Vector3;
  anchorZ: number;
  rippleLife: number;
  collideCooldown: number;
}

const MAX_PHYSICS_WAYPOINTS = 8;
const WAYPOINT_RADIUS = 0.72;
const GRAVITY_ACCEL = -19.4;
const FLOOR_RESTITUTION = 0.72;
const WALL_RESTITUTION = 0.78;
const STAGE_HALF_WIDTH = 4.95;

// Pre-allocated zero-GC scratch vectors
const _diff = new THREE.Vector3();
const _impactWorld = new THREE.Vector3();
const _courierDelta = new THREE.Vector3();

function waypointAccentHex(
  role: PhysicsCheckpointDescriptor['role'],
  cleared: boolean
): string {
  if (cleared) return '#34D399';
  if (role === 'origin') return '#34D399';
  if (role === 'destination') return '#F59E0B';
  return '#22D3EE';
}

function truncateBadgeLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 4 && ctx.measureText(`${out}...`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

function createWaypointBadgeTexture(
  cp: PhysicsCheckpointDescriptor,
  cleared: boolean,
  maxAnisotropy: number
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    const accent = waypointAccentHex(cp.role, cleared);
    ctx.fillStyle = '#0A101B';
    ctx.fillRect(0, 0, 512, 128);

    ctx.strokeStyle = accent;
    ctx.lineWidth = 5;
    ctx.strokeRect(4, 4, 504, 120);

    ctx.fillStyle = accent;
    ctx.fillRect(16, 18, 86, 92);

    ctx.fillStyle = '#071018';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 44px ui-monospace, SFMono-Regular, monospace';
    ctx.fillText(String(cp.index + 1).padStart(2, '0'), 59, 66);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = accent;
    ctx.font = '600 20px ui-monospace, SFMono-Regular, monospace';
    ctx.fillText(
      truncateBadgeLabel(
        ctx,
        `${cp.roleLabel.toUpperCase()} · ${cleared ? 'SYNCED' : cp.category.toUpperCase()}`,
        372
      ),
      120,
      48
    );

    ctx.fillStyle = '#F8FAFC';
    ctx.font = '700 32px system-ui, -apple-system, sans-serif';
    ctx.fillText(truncateBadgeLabel(ctx, cp.title, 372), 120, 94);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return tex;
}

export class CorridorWaypointPhysicsWorld {
  private readonly parentGroup = new THREE.Group();
  private readonly slots: WaypointNodeSlot[] = [];
  private readonly clickTargets: THREE.Object3D[] = [];
  private readonly badgeCache = new Map<string, THREE.CanvasTexture>();
  private readonly maxAnisotropy: number;
  private mode: CorridorPhysicsMode = 'smoothOrbit';

  // Shared geometries & base materials for draw-call efficiency and clean disposal
  private readonly coreGeo = new THREE.OctahedronGeometry(0.58, 0);
  private readonly ringGeo = new THREE.TorusGeometry(0.76, 0.055, 10, 28);
  private readonly collarGeo = new THREE.CylinderGeometry(0.48, 0.58, 0.2, 16);
  private readonly spireGeo = new THREE.ConeGeometry(0.16, 0.32, 8);
  private readonly badgeGeo = new THREE.PlaneGeometry(2.15, 0.54);
  private readonly hitProxyGeo = new THREE.SphereGeometry(1.08, 12, 10);
  private readonly shadowGeo = new THREE.PlaneGeometry(2.25, 2.25);
  private readonly rippleGeo = new THREE.RingGeometry(0.38, 0.92, 28);

  private readonly ringMat = new THREE.MeshStandardMaterial({
    color: 0x263244,
    roughness: 0.42,
    metalness: 0.88,
  });
  private readonly collarMat = new THREE.MeshStandardMaterial({
    color: 0x121824,
    roughness: 0.78,
    metalness: 0.24,
  });
  private readonly hitProxyMat = new THREE.MeshBasicMaterial({
    visible: false,
  });

  public constructor(
    scene: THREE.Scene,
    contactShadowTex: THREE.Texture,
    maxAnisotropy: number
  ) {
    this.maxAnisotropy = maxAnisotropy;
    scene.add(this.parentGroup);

    for (let i = 0; i < MAX_PHYSICS_WAYPOINTS; i++) {
      const rootGroup = new THREE.Group();
      rootGroup.visible = false;

      const tumbleGroup = new THREE.Group();
      rootGroup.add(tumbleGroup);

      // 1. Primary Silhouette: Clearcoat faceted waypoint core
      const coreMat = new THREE.MeshPhysicalMaterial({
        color: 0x22d3ee,
        emissive: 0x22d3ee,
        emissiveIntensity: 0.55,
        roughness: 0.15,
        metalness: 0.32,
        clearcoat: 0.9,
        clearcoatRoughness: 0.12,
      });
      const coreMesh = new THREE.Mesh(this.coreGeo, coreMat);
      coreMesh.castShadow = true;
      tumbleGroup.add(coreMesh);

      // 2. Secondary Read: Brushed titanium gyroscopic gimbal ring
      const ringMesh = new THREE.Mesh(this.ringGeo, this.ringMat);
      ringMesh.rotation.x = Math.PI * 0.32;
      ringMesh.castShadow = true;
      tumbleGroup.add(ringMesh);

      // 3. Secondary Read: Matte vulcanized lower shock collar
      const collarMesh = new THREE.Mesh(this.collarGeo, this.collarMat);
      collarMesh.position.y = -0.34;
      collarMesh.castShadow = true;
      tumbleGroup.add(collarMesh);

      // 4. Accent Detail: Upper crown beacon spire
      const spireMesh = new THREE.Mesh(this.spireGeo, this.ringMat);
      spireMesh.position.y = 0.68;
      tumbleGroup.add(spireMesh);

      // 5. Upright Waypoint Title Crest (stays readable while core tumbles)
      const billboardGroup = new THREE.Group();
      billboardGroup.position.set(0, 1.12, 0);
      const badgeMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
      });
      const badgeMesh = new THREE.Mesh(this.badgeGeo, badgeMat);
      billboardGroup.add(badgeMesh);
      rootGroup.add(billboardGroup);

      // Layer-1 Raycast Collider Proxy
      const hitProxyMesh = new THREE.Mesh(this.hitProxyGeo, this.hitProxyMat);
      hitProxyMesh.layers.set(1);
      hitProxyMesh.userData.waypointSlotIndex = i;
      rootGroup.add(hitProxyMesh);
      this.clickTargets.push(hitProxyMesh);

      this.parentGroup.add(rootGroup);

      // Grounded Stage-Floor Contact Shadow (y = 0.032, coplanar safe)
      const shadowMat = new THREE.MeshBasicMaterial({
        map: contactShadowTex,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      const shadowMesh = new THREE.Mesh(this.shadowGeo, shadowMat);
      shadowMesh.rotation.x = -Math.PI / 2;
      shadowMesh.position.set(0, 0.032, 0);
      shadowMesh.visible = false;
      this.parentGroup.add(shadowMesh);

      // Stage-Floor Collision Shockwave Ring (flashes on floor bounce)
      const rippleMat = new THREE.MeshBasicMaterial({
        color: 0x22d3ee,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const rippleMesh = new THREE.Mesh(this.rippleGeo, rippleMat);
      rippleMesh.rotation.x = -Math.PI / 2;
      rippleMesh.position.set(0, 0.038, 0);
      rippleMesh.visible = false;
      this.parentGroup.add(rippleMesh);

      this.slots.push({
        slotIndex: i,
        boundCheckpointId: '',
        boundTextureKey: '',
        checkpointIndex: -1,
        active: false,
        rootGroup,
        tumbleGroup,
        billboardGroup,
        coreMat,
        ringMesh,
        badgeMat,
        hitProxyMesh,
        shadowMesh,
        shadowMat,
        rippleMesh,
        rippleMat,
        pos: new THREE.Vector3(0, 2.4, -18),
        vel: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
        anchorZ: -18,
        rippleLife: 0,
        collideCooldown: 0,
      });
    }
  }

  public getMode(): CorridorPhysicsMode {
    return this.mode;
  }

  public setMode(nextMode: CorridorPhysicsMode): void {
    if (this.mode === nextMode) return;
    this.mode = nextMode;

    if (nextMode === 'gravityExploration') {
      // Release all active orbital waypoints into free-fall with staggered heights & spin
      for (let i = 0; i < this.slots.length; i++) {
        const slot = this.slots[i];
        if (!slot.active) continue;
        slot.pos.y = Math.max(slot.pos.y, 2.8 + (i % 3) * 0.85);
        slot.vel.set(
          ((i % 2 === 0 ? 1 : -1) * (1.8 + (i % 3) * 0.65)),
          2.2 + (i % 4) * 0.75,
          (Math.random() - 0.5) * 2.4
        );
        slot.angVel.set(
          (Math.random() - 0.5) * 4.5,
          (i % 2 === 0 ? 1 : -1) * 3.6,
          (Math.random() - 0.5) * 4.2
        );
      }
    } else {
      // Smoothly damp velocities so nodes glide back onto orbital tracks without snapping
      for (const slot of this.slots) {
        slot.vel.multiplyScalar(0.25);
        slot.angVel.multiplyScalar(0.2);
      }
    }
  }

  /** Launches all visible waypoints upward so users can re-test floor & inter-waypoint collisions anytime */
  public triggerGravityDropWave(): void {
    if (this.mode !== 'gravityExploration') {
      this.setMode('gravityExploration');
      return;
    }
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot.active) continue;
      slot.vel.y = 7.8 + (i % 3) * 1.65;
      slot.vel.x += (i % 2 === 0 ? 1 : -1) * 2.6;
      slot.angVel.set(
        (Math.random() - 0.5) * 6.5,
        (Math.random() - 0.5) * 6.5,
        (Math.random() - 0.5) * 6.5
      );
    }
  }

  /** Raycasts Layer-1 waypoint colliders; on hit, imparts upward/lateral bounce impulse */
  public raycastImpulse(
    raycaster: THREE.Raycaster
  ): { checkpointIndex: number; worldPoint: THREE.Vector3 } | null {
    const prevMask = raycaster.layers.mask;
    raycaster.layers.set(1);
    const hits = raycaster.intersectObjects(this.clickTargets, false);
    raycaster.layers.mask = prevMask;

    for (const hit of hits) {
      const idx = hit.object.userData.waypointSlotIndex;
      if (typeof idx !== 'number') continue;
      const slot = this.slots[idx];
      if (!slot || !slot.active || slot.checkpointIndex < 0) continue;

      if (this.mode === 'gravityExploration') {
        slot.vel.y = Math.max(slot.vel.y + 8.6, 8.6);
        slot.vel.x += (Math.random() - 0.5) * 5.2;
        slot.vel.z -= 4.2;
        slot.angVel.set(
          (Math.random() - 0.5) * 8,
          (Math.random() - 0.5) * 8,
          (Math.random() - 0.5) * 8
        );
      } else {
        // Gentle harmonic spin pulse in Smooth Orbit mode
        slot.angVel.y += 5.5;
      }

      _impactWorld.copy(slot.pos);
      return {
        checkpointIndex: slot.checkpointIndex,
        worldPoint: _impactWorld,
      };
    }
    return null;
  }

  private getBadgeTexture(
    cp: PhysicsCheckpointDescriptor,
    cleared: boolean
  ): THREE.CanvasTexture {
    const key = `${cp.id}|${cleared ? '1' : '0'}|${cp.title}|${cp.roleLabel}`;
    const existing = this.badgeCache.get(key);
    if (existing) return existing;
    if (this.badgeCache.size > 40) {
      this.badgeCache.forEach((t) => t.dispose());
      this.badgeCache.clear();
    }
    const created = createWaypointBadgeTexture(cp, cleared, this.maxAnisotropy);
    this.badgeCache.set(key, created);
    return created;
  }

  public step(params: {
    dt: number;
    elapsed: number;
    currentMeters: number;
    zPerMeter: number;
    corridorSpeed: number;
    courierPos: THREE.Vector3;
    courierVisible: boolean;
    checkpoints: PhysicsCheckpointDescriptor[];
    clearedIds: Set<string>;
    onFloorImpact?: (ev: FloorImpactEvent) => void;
    onCourierCollide?: (ev: CourierWaypointCollisionEvent) => void;
  }): void {
    const {
      dt,
      elapsed,
      currentMeters,
      zPerMeter,
      corridorSpeed,
      courierPos,
      courierVisible,
      checkpoints,
      clearedIds,
      onFloorImpact,
      onCourierCollide,
    } = params;

    // 1. Select up to MAX_PHYSICS_WAYPOINTS visible checkpoints in the corridor window
    let usedSlots = 0;
    for (
      let i = 0;
      i < checkpoints.length && usedSlots < MAX_PHYSICS_WAYPOINTS;
      i++
    ) {
      const cp = checkpoints[i];
      const relMeters = cp.distanceMeters - currentMeters;
      const gateZ = -relMeters * zPerMeter;
      if (gateZ > 16 || gateZ < -168) continue;

      const slot = this.slots[usedSlots++];
      const wasSameCheckpoint = slot.boundCheckpointId === cp.id && slot.active;
      const prevAnchorZ = slot.anchorZ;
      // Position the waypoint beacon slightly ahead of the checkpoint portal threshold
      const nextAnchorZ = gateZ + 3.2;
      slot.anchorZ = nextAnchorZ;
      slot.checkpointIndex = i;
      slot.active = true;
      slot.rootGroup.visible = true;
      slot.shadowMesh.visible = true;

      const isCleared = clearedIds.has(cp.id);
      const accentHex = waypointAccentHex(cp.role, isCleared);
      const texKey = `${cp.id}|${isCleared ? '1' : '0'}|${cp.title}`;
      if (slot.boundTextureKey !== texKey) {
        slot.boundTextureKey = texKey;
        slot.badgeMat.map = this.getBadgeTexture(cp, isCleared);
        slot.badgeMat.needsUpdate = true;
        slot.coreMat.color.set(accentHex);
        slot.coreMat.emissive.set(accentHex);
        slot.rippleMat.color.set(accentHex);
      }

      const orbitPhase = elapsed * 1.18 + i * 1.45;
      const orbitX = Math.sin(orbitPhase) * 3.15;
      const orbitY = 2.05 + Math.cos(orbitPhase * 1.55) * 0.44;
      const orbitZ = nextAnchorZ + Math.cos(orbitPhase) * 1.35;

      if (!wasSameCheckpoint) {
        slot.boundCheckpointId = cp.id;
        slot.collideCooldown = 0;
        slot.rippleLife = 0;
        if (this.mode === 'gravityExploration') {
          slot.pos.set(
            ((i % 3) - 1) * 2.8,
            3.1 + (i % 3) * 0.9,
            nextAnchorZ
          );
          slot.vel.set(
            (i % 2 === 0 ? 1 : -1) * 1.6,
            1.4,
            0
          );
          slot.angVel.set(1.8, 2.6, -1.4);
        } else {
          slot.pos.set(orbitX, orbitY, orbitZ);
          slot.vel.set(0, 0, 0);
          slot.angVel.set(0, 1.6, 0);
        }
      } else if (this.mode === 'gravityExploration') {
        // Scroll waypoint Z cleanly with the advancing expressway stage while preserving local bounce Z offset
        const deltaStageZ = nextAnchorZ - prevAnchorZ;
        slot.pos.z += deltaStageZ;
      }

      if (slot.collideCooldown > 0) {
        slot.collideCooldown = Math.max(0, slot.collideCooldown - dt);
      }

      if (this.mode === 'smoothOrbit') {
        // Buoyant zero-impact harmonic orbit above the stage floor
        slot.pos.x = THREE.MathUtils.damp(slot.pos.x, orbitX, 6.4, dt);
        slot.pos.y = THREE.MathUtils.damp(slot.pos.y, orbitY, 6.4, dt);
        slot.pos.z = THREE.MathUtils.damp(slot.pos.z, orbitZ, 7.2, dt);

        slot.angVel.x = THREE.MathUtils.damp(slot.angVel.x, 0, 5, dt);
        slot.angVel.y = THREE.MathUtils.damp(slot.angVel.y, 1.75, 4, dt);
        slot.angVel.z = THREE.MathUtils.damp(slot.angVel.z, 0, 5, dt);

        slot.tumbleGroup.rotation.x = THREE.MathUtils.damp(
          slot.tumbleGroup.rotation.x,
          Math.sin(orbitPhase) * 0.14,
          5,
          dt
        );
        slot.tumbleGroup.rotation.y += slot.angVel.y * dt;
        slot.tumbleGroup.rotation.z = THREE.MathUtils.damp(
          slot.tumbleGroup.rotation.z,
          Math.cos(orbitPhase) * 0.14,
          5,
          dt
        );
        slot.ringMesh.rotation.z = elapsed * 2.1 + i;
      } else {
        // Gravity Exploration: Newtonian downward acceleration + Stage Floor & Rail collisions
        slot.vel.y += GRAVITY_ACCEL * dt;
        // Soft Z tether spring keeps waypoint associated with its sector gate while letting impacts knock it forward/back
        const zOffset = slot.pos.z - nextAnchorZ;
        slot.vel.z += (-3.4 * zOffset - 1.6 * slot.vel.z) * dt;
        // Subtle air drag
        slot.vel.x *= Math.max(0, 1 - 0.38 * dt);

        slot.pos.addScaledVector(slot.vel, dt);

        // Stage Floor Collision (y = 0 asphalt deck)
        if (slot.pos.y <= WAYPOINT_RADIUS) {
          const impactSpeed = -slot.vel.y;
          slot.pos.y = WAYPOINT_RADIUS;

          if (impactSpeed > 1.45) {
            slot.vel.y = impactSpeed * FLOOR_RESTITUTION;
            // Road scroll imparts subtle kinetic hop & tumble spin on floor contact
            slot.angVel.x += (corridorSpeed * 0.09 + (Math.random() - 0.5) * 2.2);
            slot.angVel.z -= slot.vel.x * 0.45;
            slot.rippleLife = 1.0;
            slot.rippleMesh.position.set(slot.pos.x, 0.038, slot.pos.z);
            slot.rippleMesh.visible = true;

            if (onFloorImpact && impactSpeed > 2.3) {
              _impactWorld.set(slot.pos.x, 0.08, slot.pos.z);
              onFloorImpact({
                position: _impactWorld,
                impactSpeed,
                checkpoint: cp,
              });
            }
          } else {
            // Micro-rumble bounce when rolling along a moving stage floor, or rest cleanly when stationary
            if (corridorSpeed > 8) {
              slot.vel.y = 2.65 + (i % 3) * 0.45;
              slot.angVel.x = corridorSpeed * 0.12;
            } else {
              slot.vel.y = 0;
              slot.vel.x *= Math.max(0, 1 - 4.5 * dt);
              slot.angVel.multiplyScalar(Math.max(0, 1 - 3.5 * dt));
            }
          }
        }

        // Corridor Side-Barrier Elastic Collisions
        if (slot.pos.x > STAGE_HALF_WIDTH) {
          slot.pos.x = STAGE_HALF_WIDTH;
          slot.vel.x = -Math.abs(slot.vel.x) * WALL_RESTITUTION;
          slot.angVel.z += 3.2;
        } else if (slot.pos.x < -STAGE_HALF_WIDTH) {
          slot.pos.x = -STAGE_HALF_WIDTH;
          slot.vel.x = Math.abs(slot.vel.x) * WALL_RESTITUTION;
          slot.angVel.z -= 3.2;
        }

        // Interactive Courier-to-Waypoint 3D Collision
        if (courierVisible && slot.collideCooldown <= 0) {
          _courierDelta.subVectors(slot.pos, courierPos);
          // Account for courier hull length along Z and width along X
          const hitDistSq =
            _courierDelta.x * _courierDelta.x +
            _courierDelta.y * _courierDelta.y * 0.85 +
            _courierDelta.z * _courierDelta.z * 0.55;
          if (hitDistSq < 2.25) {
            slot.collideCooldown = 0.48;
            const horizLen = Math.hypot(_courierDelta.x, _courierDelta.z) || 1;
            const nx = _courierDelta.x / horizLen;
            slot.vel.x = nx * 6.4 + (Math.random() - 0.5) * 2.0;
            slot.vel.y = 7.8 + Math.min(4.2, corridorSpeed * 0.08);
            slot.vel.z = -(8.5 + corridorSpeed * 0.18);
            slot.angVel.set(
              -9.5,
              nx * 7.5,
              -nx * 6.2
            );
            if (onCourierCollide) {
              _impactWorld.copy(slot.pos);
              onCourierCollide({
                position: _impactWorld,
                impactSpeed: Math.max(6, corridorSpeed * 0.25),
                checkpoint: cp,
              });
            }
          }
        }

        slot.tumbleGroup.rotation.x += slot.angVel.x * dt;
        slot.tumbleGroup.rotation.y += slot.angVel.y * dt;
        slot.tumbleGroup.rotation.z += slot.angVel.z * dt;
        slot.ringMesh.rotation.z += dt * 3.1;
      }

      // Update floor impact shockwave ring animation
      if (slot.rippleLife > 0) {
        slot.rippleLife = Math.max(0, slot.rippleLife - dt * 2.6);
        const progress = 1 - slot.rippleLife;
        const rippleScale = 0.75 + progress * 2.15;
        slot.rippleMesh.scale.set(rippleScale, rippleScale, 1);
        slot.rippleMat.opacity = slot.rippleLife * 0.68;
        if (slot.rippleLife <= 0.01) {
          slot.rippleMesh.visible = false;
        }
      } else {
        slot.rippleMesh.visible = false;
      }
    }

    // Hide unused pool slots
    for (let j = usedSlots; j < MAX_PHYSICS_WAYPOINTS; j++) {
      const slot = this.slots[j];
      slot.active = false;
      slot.rootGroup.visible = false;
      slot.shadowMesh.visible = false;
      slot.rippleMesh.visible = false;
    }

    // 2. Pairwise Waypoint-to-Waypoint Elastic Collisions in Gravity Exploration Mode
    if (this.mode === 'gravityExploration' && usedSlots > 1) {
      const minSep = WAYPOINT_RADIUS * 2.05;
      const minSepSq = minSep * minSep;
      for (let a = 0; a < usedSlots; a++) {
        const sa = this.slots[a];
        for (let b = a + 1; b < usedSlots; b++) {
          const sb = this.slots[b];
          _diff.subVectors(sb.pos, sa.pos);
          const distSq = _diff.lengthSq();
          if (distSq > 0.0001 && distSq < minSepSq) {
            const dist = Math.sqrt(distSq);
            _diff.divideScalar(dist);
            const overlap = (minSep - dist) * 0.5;
            sa.pos.addScaledVector(_diff, -overlap);
            sb.pos.addScaledVector(_diff, overlap);

            const relVx = sb.vel.x - sa.vel.x;
            const relVy = sb.vel.y - sa.vel.y;
            const relVz = sb.vel.z - sa.vel.z;
            const velAlongNormal =
              relVx * _diff.x + relVy * _diff.y + relVz * _diff.z;
            if (velAlongNormal < 0) {
              const impulse = -(1 + 0.82) * velAlongNormal * 0.5;
              sa.vel.addScaledVector(_diff, -impulse);
              sb.vel.addScaledVector(_diff, impulse);
              sa.angVel.y -= impulse * 0.8;
              sb.angVel.y += impulse * 0.8;
            }
          }
        }
      }
    }

    // 3. Commit world transforms & height-responsive floor contact shadows
    for (let i = 0; i < usedSlots; i++) {
      const slot = this.slots[i];
      slot.rootGroup.position.copy(slot.pos);
      const heightAboveFloor = Math.max(0, slot.pos.y - WAYPOINT_RADIUS);
      const shadowScale = THREE.MathUtils.clamp(
        1.08 - heightAboveFloor * 0.14,
        0.42,
        1.15
      );
      slot.shadowMesh.position.set(slot.pos.x, 0.032, slot.pos.z);
      slot.shadowMesh.scale.set(shadowScale, shadowScale, 1);
      slot.shadowMat.opacity = THREE.MathUtils.clamp(
        0.66 - heightAboveFloor * 0.13,
        0.14,
        0.66
      );
    }
  }

  public dispose(): void {
    this.badgeCache.forEach((tex) => tex.dispose());
    this.badgeCache.clear();
    this.coreGeo.dispose();
    this.ringGeo.dispose();
    this.collarGeo.dispose();
    this.spireGeo.dispose();
    this.badgeGeo.dispose();
    this.hitProxyGeo.dispose();
    this.shadowGeo.dispose();
    this.rippleGeo.dispose();
    this.ringMat.dispose();
    this.collarMat.dispose();
    this.hitProxyMat.dispose();
    for (const slot of this.slots) {
      slot.coreMat.dispose();
      slot.badgeMat.dispose();
      slot.shadowMat.dispose();
      slot.rippleMat.dispose();
    }
  }
}
