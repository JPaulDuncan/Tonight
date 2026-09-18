/**
 * A character in the scene: the rig, the pose, and the hitboxes.
 *
 * Extracted from the sandbox the moment there was a second character to build.
 * The player and every bot are the same thing wearing the same
 * `CharacterBlueprint`, and the first version of this that special-cased the
 * player would have grown two poses, two rigs and two hitbox layouts.
 *
 * The hitboxes are the parts. The generator names each primitive after the
 * hitbox it belongs to (`Head`, `Chest`, `LegLeft`), the Blueprint lists those
 * names with their damage scales, and a shot resolves against the boxes the
 * meshes actually occupy this frame. Nothing here decides what a headshot is
 * worth -- that is `damageProfile.headshotMultiplier`, applied by the one
 * damage formula.
 */

import * as THREE from "three";

import type { CharacterBlueprint, HitboxDefinition, WeaponBlueprint } from "@/blueprints/types";
import type { Pose } from "./pose";
import { ArtLibrary, weaponAssetKey } from "./assets";

export interface HitboxHit {
  /** The part struck, e.g. `Head`. */
  readonly part: string;
  readonly hitbox: HitboxDefinition | undefined;
  readonly distance: number;
  readonly point: { x: number; y: number; z: number };
}

/** Colour per part, for a character with no texture bound to that slot. */
const PART_COLOURS: Readonly<Record<string, number>> = {
  Head: 0xe8c39a,
  Chest: 0x4a6ea8,
  Pelvis: 0x36507a,
  ArmLeft: 0xe8c39a,
  ArmRight: 0xe8c39a,
  LegLeft: 0x2f3f5c,
  LegRight: 0x2f3f5c,
};

export class Avatar {
  readonly root = new THREE.Group();
  readonly joints = new Map<string, THREE.Group>();
  /** Every mesh of a part, so a hit test can ask where the part is now. */
  private readonly partMeshes = new Map<string, THREE.Object3D[]>();
  private readonly hitboxes = new Map<string, HitboxDefinition>();
  private held: THREE.Group | undefined;
  private heldWeaponId = "";
  private castShadow = true;

  // Scratch, reused every trace: a hit test runs per pellet per target and
  // allocating a Box3 per part per pellet is the shotgun's ten-times mistake.
  private readonly box = new THREE.Box3();
  private readonly ray = new THREE.Ray();
  private readonly point = new THREE.Vector3();

  constructor(
    private readonly art: ArtLibrary,
    readonly character: CharacterBlueprint,
    /** Overrides the character's own part colours, so bots read as not-you. */
    private readonly tint?: number,
    /**
     * Whether the figure casts a shadow.
     *
     * The player's does. A field of bots casting theirs cost half the frame
     * rate on software WebGL for a shadow nobody looks at, and frame rate is
     * what the hit feedback's timings are measured against.
     */
    castShadow = true,
  ) {
    const name = art.nameForKey("default");
    if (!name) throw new Error("No character mesh was loaded. Re-run: npm run art");

    for (const hitbox of character.hitboxes) this.hitboxes.set(hitbox.name, hitbox);

    const partTextures = character.partTextures ?? {};
    for (const part of art.partsOf(name)) {
      const material = new THREE.MeshLambertMaterial({
        color: tint ?? PART_COLOURS[part.group] ?? 0x8899aa,
        map: art.texture(partTextures[part.group]) ?? null,
      });
      const mesh = new THREE.Mesh(part.geometry, material);
      mesh.castShadow = castShadow;
      this.castShadow = castShadow;

      const meshes = this.partMeshes.get(part.group) ?? [];
      meshes.push(mesh);
      this.partMeshes.set(part.group, meshes);

      // A limb has to turn about its joint, not about the character's feet.
      // The generator emits the joint (it knows where a hip is); this puts a
      // node there and hangs the geometry off it, offset back by the same
      // amount so the part does not move until it is rotated.
      const pivot = part.pivot;
      if (!pivot) {
        this.root.add(mesh);
        continue;
      }

      let joint = this.joints.get(part.group);
      if (!joint) {
        joint = new THREE.Group();
        joint.position.set(pivot[0], pivot[1], pivot[2]);
        this.joints.set(part.group, joint);
        this.root.add(joint);
      }
      mesh.position.set(-pivot[0], -pivot[1], -pivot[2]);
      joint.add(mesh);
    }
  }

  get visible(): boolean {
    return this.root.visible;
  }

  set visible(value: boolean) {
    this.root.visible = value;
  }

  get heldParts(): number {
    return this.held?.children.length ?? 0;
  }

  /**
   * Put a weapon in the right hand.
   *
   * Two sockets meet here: the character's `GripRight` and the weapon's own
   * `Grip`. Both come from the generators, so this positions the weapon by
   * subtracting one from the other and never needs to know what a pickaxe looks
   * like or which way round it is.
   *
   * The hand node is a child of the arm's joint, so the weapon inherits the
   * arm's rotation for free -- a swing moves the pickaxe because the pickaxe is
   * parented to the thing that swings.
   */
  equip(
    weapon: WeaponBlueprint,
    materialFor: (weaponId: string, partRole: string) => THREE.Material,
  ): void {
    if (this.held) {
      this.held.removeFromParent();
      this.held = undefined;
    }
    this.heldWeaponId = weapon.id;

    const characterName = this.art.nameForKey("default");
    const weaponName = this.art.nameForKey(weaponAssetKey(weapon.id));
    if (!characterName || !weaponName) {
      throw new Error(`No mesh for held weapon '${weapon.id}'. Re-run: npm run art`);
    }

    const socketName = weapon.attachSocket ?? "GripRight";
    const hand = this.art.socket(characterName, socketName);
    const grip = this.art.socket(weaponName, "Grip");
    if (!hand || !grip) {
      throw new Error(
        `Missing socket: character '${socketName}' or weapon 'Grip'. Re-run: npm run art`,
      );
    }

    const armPart = socketName.endsWith("Left") ? "ArmLeft" : "ArmRight";
    const joint = this.joints.get(armPart);

    const group = new THREE.Group();
    // Positioned in the joint's local space: the hand relative to the shoulder.
    const pivot = joint ? joint.position : new THREE.Vector3();
    group.position.set(hand[0] - pivot.x, hand[1] - pivot.y, hand[2] - pivot.z);

    for (const part of this.art.partsOf(weaponName)) {
      const mesh = new THREE.Mesh(part.geometry, materialFor(weapon.id, part.group));
      // Offset so the weapon's grip lands on the hand rather than its origin.
      mesh.position.set(-grip[0], -grip[1], -grip[2]);
      mesh.castShadow = this.castShadow;
      group.add(mesh);
    }

    (joint ?? this.root).add(group);
    this.held = group;
  }

  /** Where the held weapon is in the world, for the smoke test's swing check. */
  heldPosition(): [number, number, number] {
    if (!this.held) return [0, 0, 0];
    const at = this.held.getWorldPosition(this.point);
    return [Number(at.x.toFixed(3)), Number(at.y.toFixed(3)), Number(at.z.toFixed(3))];
  }

  get equipped(): string {
    return this.heldWeaponId;
  }

  /**
   * Place and pose the figure.
   *
   * The mesh is authored based at Z=0 facing +Z, so the position and yaw drive
   * it directly with no offset to get wrong.
   */
  apply(
    pose: Pose,
    position: { x: number; y: number; z: number },
    yawDegrees: number,
    squash = 1,
  ): void {
    for (const [part, joint] of this.joints) {
      const rotation = pose.rotations[part];
      joint.rotation.set(rotation?.x ?? 0, rotation?.y ?? 0, rotation?.z ?? 0);
    }
    this.root.position.set(position.x, position.y + pose.bob, position.z);
    this.root.rotation.set(pose.lean, (yawDegrees * Math.PI) / 180, 0, "YXZ");
    this.root.scale.set(1, squash, 1);
  }

  /** Where the eye sits, for a bot aiming from roughly where a player would. */
  eyePosition(): { x: number; y: number; z: number } {
    return {
      x: this.root.position.x,
      y: this.root.position.y + this.character.cameraHeight,
      z: this.root.position.z,
    };
  }

  /**
   * The nearest part a ray strikes, or undefined.
   *
   * World-axis-aligned boxes around the part meshes: a loose fit on a rotated
   * limb, and exactly right on a torso. That looseness is the honest trade for
   * a proxy character -- the alternative is per-triangle picking on every
   * pellet, which costs far more than the accuracy is worth at this fidelity.
   */
  trace(
    origin: { x: number; y: number; z: number },
    direction: { x: number; y: number; z: number },
    maxDistance: number,
  ): HitboxHit | undefined {
    if (!this.root.visible) return undefined;

    // The trace runs inside the simulation tick, which is before the frame's
    // render refreshes the scene graph. Without this the boxes describe where
    // the figure was last frame, which at low frame rates is a limb's width out.
    this.root.updateMatrixWorld(true);

    this.ray.origin.set(origin.x, origin.y, origin.z);
    this.ray.direction.set(direction.x, direction.y, direction.z).normalize();

    let best: HitboxHit | undefined;
    for (const [part, meshes] of this.partMeshes) {
      for (const mesh of meshes) {
        this.box.setFromObject(mesh);
        if (this.box.isEmpty()) continue;
        if (!this.ray.intersectBox(this.box, this.point)) continue;

        const distance = this.ray.origin.distanceTo(this.point);
        if (distance > maxDistance) continue;
        if (best && distance >= best.distance) continue;

        best = {
          part,
          hitbox: this.hitboxes.get(part),
          distance,
          point: { x: this.point.x, y: this.point.y, z: this.point.z },
        };
      }
    }
    return best;
  }

  /** The whole figure's bounds, for a cheap "is it even near this ray" test. */
  boundsCentre(): { x: number; y: number; z: number } {
    this.root.updateMatrixWorld(true);
    this.box.setFromObject(this.root);
    const centre = this.box.getCenter(this.point);
    return { x: centre.x, y: centre.y, z: centre.z };
  }
}
