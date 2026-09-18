/**
 * The playable build-fight sandbox.
 *
 * Wires the headless simulation to a three.js scene and pointer-lock input.
 * Everything gameplay-relevant lives in `src/gameplay`; this module only reads
 * that state and draws it, plus turns raw input into commands at the edge
 * (ADR-0003 rule 2).
 */

import * as THREE from "three";

import { blueprints } from "@/blueprints/library";
import { SOLID_MASK } from "@/blueprints/registry";
import type { BuildMaterialBlueprint, CharacterBlueprint } from "@/blueprints/types";
import {
  BuildSlot, CELL_SIZE, cellCentre, cellToWorld, parsePieceKey, pieceKey, slotAnchor,
  slotRotationY,
  type GridCell,
} from "@/core/grid";
import { vec2, vec3, type Vec3 } from "@/core/math";
import { MoveFlags, PlacementRejection, moveCommand } from "@/gameplay/commands";
import {
  BuildWorld, resolveEditTarget, resolvePlacement, placementTransform, variantForMask,
} from "@/gameplay/build";
import { fullHealth, type HealthPool } from "@/gameplay/combat";
import { harvestHit, harvestStateFor, weakPointFor, type HarvestState } from "@/gameplay/harvest";
import {
  TICK_DELTA, TICK_RATE, motorAtRest, stepMotor, yawRotate, type MotorState,
} from "@/gameplay/motor";
import { WorldCollision } from "./collision";
import { Hud } from "./hud";
import { ArtLibrary, buildPieceKey, type ArtRecord } from "./assets";
import { poseFor } from "./pose";
import { Heightfield, SANDBOX_TERRAIN, scatterProps, type ScatterPoint } from "./terrain";

/** Where `npm run art` publishes the generated meshes. */
const ART_BASE_URL = "art/";

/**
 * What the sandbox loads.
 *
 * Terrain is generated in the browser from the same heightfield collision reads,
 * so loading the Blender island would put two different surfaces in one scene.
 * Weapons are skipped because nothing renders a held weapon yet -- when that
 * lands, this predicate is the one place that changes.
 */
function wantedInSandbox(record: ArtRecord): boolean {
  return ["build", "harvest", "character"].includes(record.category);
}

/**
 * Third-person camera rig.
 *
 * Fortnite's camera is over-the-shoulder, and so is this one. The boom sits
 * behind the player along the aim direction, offset to the right and slightly
 * up.
 */
const CAMERA_BOOM = 3.4;
const CAMERA_SHOULDER = 0.75;
const CAMERA_RISE = 0.35;

/**
 * How far along the aim ray the camera converges.
 *
 * An offset camera and a centre-screen crosshair disagree unless the camera
 * *looks at* a point on the player's aim ray rather than simply pointing the
 * same way. Converging removes the parallax at this distance and leaves a
 * little at others, so it is set to build range: the crosshair has to be
 * truthful where building happens, because building is the pillar.
 */
const CAMERA_CONVERGE = 10;

/** Keeps the boom from burying the camera in a wall the player just built. */
const CAMERA_MIN_BOOM = 0.6;

/** Size of a loaded texture, for the debug hook. */
function describeImage(texture: THREE.Texture | null): string | null {
  const image = texture?.image as { width?: number; height?: number } | undefined;
  return image?.width ? `${image.width}x${image.height}` : null;
}

/** Part roles the harvestable generators emit, mapped to their colours. */
const PROP_PART_COLOURS: Readonly<Record<string, number>> = {
  Trunk: 0x6b4a2f,
  Canopy: 0x2f4a33,
};

/**
 * Character part colours, keyed by the hitbox each part stands for.
 *
 * The generator names its parts after `CharacterBlueprint.hitboxes`, so these
 * line up without a second list of what a limb is.
 */
const CHARACTER_PART_COLOURS: Readonly<Record<string, number>> = {
  Head: 0xd8b28a,
  Chest: 0x4a6fa5,
  Pelvis: 0x3b5580,
  ArmLeft: 0xd8b28a,
  ArmRight: 0xd8b28a,
  LegLeft: 0x35507a,
  LegRight: 0x35507a,
};

const PLAYER_ID = 1;
const PICKAXE_DAMAGE = 20;
const PICKAXE_INTERVAL_TICKS = Math.ceil((60 / 84) * TICK_RATE);
const INTERACT_RANGE = 4.5;

interface PropInstance {
  readonly point: ScatterPoint;
  readonly object: THREE.Object3D;
  readonly blueprintId: string;
  state: HarvestState;
}

export class Sandbox {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private avatar!: THREE.Group;
  private avatarJoints = new Map<string, THREE.Group>();
  private distanceTravelled = 0;
  private lastAvatarSpeed = 0;
  private lastAvatarPosition = vec3();
  private editTiles: THREE.Mesh[] = [];
  private lastFrameMs = 0;

  private readonly field: Heightfield;
  private readonly world: BuildWorld;
  private readonly collision: WorldCollision;
  private readonly hud: Hud;

  private readonly pieceMeshes = new Map<string, THREE.Mesh>();
  private readonly props: PropInstance[] = [];
  private readonly materials = new Map<string, THREE.MeshLambertMaterial>();
  private ghost!: THREE.Mesh;

  private motor: MotorState;
  private pool: HealthPool;
  private tick = 0;
  private accumulator = 0;
  private lastPickaxeTick = -999;
  private message = "";
  private messageUntil = 0;
  private fps = 0;

  private readonly keys = new Set<string>();
  private lookDelta = vec2();
  private jumpQueued = false;
  private primaryDown = false;
  private primaryPressed = false;
  private buildMode = false;
  private selectedPieceId = "piece.wall";
  /**
   * Non-null while the edit key is held: the piece, the mask being drawn, and
   * the state the drag is painting.
   */
  private editing: { key: string; mask: number; paintKeeps: boolean } | undefined;
  private selectedMaterialId = "material.wood";

  /**
   * Load the art, then build the sandbox.
   *
   * Loading is the one part of boot that can fail on a fresh checkout, so it
   * happens before anything is on screen and its error reaches the caller
   * intact rather than leaving a half-built world.
   */
  static async create(container: HTMLElement): Promise<Sandbox> {
    const art = await ArtLibrary.load(ART_BASE_URL, wantedInSandbox);
    return new Sandbox(container, art);
  }

  private constructor(
    private readonly container: HTMLElement,
    private readonly art: ArtLibrary,
  ) {
    const registry = blueprints();
    const character = registry.get<CharacterBlueprint>("character.default");

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap was removed in three 0.186.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1200);

    this.field = new Heightfield(SANDBOX_TERRAIN);
    this.world = new BuildWorld(registry, TICK_RATE, (cell) => this.collision.groundTest(cell));
    this.collision = new WorldCollision(this.field, this.world.structure);

    // Generous starting materials: this is a sandbox for testing build feel,
    // not the economy.
    for (const id of ["material.wood", "material.stone", "material.metal"]) {
      this.world.wallet(PLAYER_ID).add(registry.get<BuildMaterialBlueprint>(id), 500);
    }

    this.pool = fullHealth(character.maxHealth, character.maxShield);
    const spawn = vec3(0, this.field.sample(0, 0) + 1, 0);
    this.motor = motorAtRest(spawn);

    this.buildScene();
    this.hud = new Hud(registry, container);

    this.world.onChanged((event) => {
      if (event.kind === "placed" || event.kind === "edited") this.syncPiece(event.key);
      else this.removePieceMesh(event.key);
    });

    this.bindInput();
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  start(): void {
    this.renderer.setAnimationLoop(() => this.frame());
    // A read-only window onto what is actually in the scene. The smoke test
    // uses it to assert that a placed wall is the *loaded* mesh sitting on the
    // right cell, which a screenshot cannot distinguish from a procedural box
    // in roughly the right place.
    (window as unknown as { __tonight?: unknown }).__tonight = {
      describePieces: () => this.describePieces(),
      describeMaterials: () =>
        Object.fromEntries(
          [...this.materials].map(([key, material]) => [
            key,
            {
              colour: `#${material.color.getHexString()}`,
              map: describeImage(material.map),
            },
          ]),
        ),
      describeAvatar: () => ({
        distanceTravelled: Number(this.distanceTravelled.toFixed(3)),
        grounded: this.motor.grounded,
        joints: Object.fromEntries(
          [...this.avatarJoints].map(([part, joint]) => [
            part,
            [joint.rotation.x, joint.rotation.y, joint.rotation.z].map(
              (v) => Number(v.toFixed(4)),
            ),
          ]),
        ),
        bobY: Number((this.avatar.position.y - this.motor.position.y).toFixed(4)),
        leanX: Number(this.avatar.rotation.x.toFixed(4)),
        speed: Number(this.lastAvatarSpeed.toFixed(3)),
      }),
      describeEdit: () => ({
        editing: this.editing ? { ...this.editing } : null,
        target: this.editTarget(),
      }),
    };
  }

  /** What each placed piece is and where it ended up, in world metres. */
  private describePieces(): unknown[] {
    return [...this.pieceMeshes.entries()].map(([key, mesh]) => {
      const bounds = new THREE.Box3().setFromObject(mesh);
      const position = mesh.geometry.getAttribute("position");
      return {
        key,
        vertices: position ? position.count : 0,
        min: [bounds.min.x, bounds.min.y, bounds.min.z].map((v) => Number(v.toFixed(3))),
        max: [bounds.max.x, bounds.max.y, bounds.max.z].map((v) => Number(v.toFixed(3))),
      };
    });
  }

  // -----------------------------------------------------------------------
  // Scene
  // -----------------------------------------------------------------------

  private buildScene(): void {
    const registry = blueprints();
    const lighting = registry.lighting("lighting.nightfall");
    const dusk = lighting.keyframesByPhase[0]!;

    this.scene.background = new THREE.Color("#2a2338");
    this.scene.fog = new THREE.FogExp2(new THREE.Color(dusk.fogColour), dusk.fogDensity);

    const sun = new THREE.DirectionalLight(new THREE.Color(dusk.sunColour), dusk.sunIntensity * 1.6);
    const elevation = (dusk.sunElevationDegrees * Math.PI) / 180;
    sun.position.set(Math.cos(elevation) * 120, Math.sin(elevation) * 120 + 40, 60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -90;
    sun.shadow.camera.right = 90;
    sun.shadow.camera.top = 90;
    sun.shadow.camera.bottom = -90;
    sun.shadow.camera.far = 400;
    this.scene.add(sun);

    // The rim floor from MatchLightingBlueprint: ambient never drops far enough
    // to make darkness a stealth mechanic (vision pillar 2). The sandbox scales
    // it up further because reading your own structure matters more here than
    // atmosphere does; a match would use the floor directly.
    const SANDBOX_AMBIENT_BOOST = 4;
    this.scene.add(new THREE.HemisphereLight(
      0x9aa8d8, 0x3a3848, lighting.minPlayerRimIntensity * SANDBOX_AMBIENT_BOOST));

    this.scene.add(this.terrainMesh());
    this.scatter();
    this.makeAvatar();
    this.makeEditOverlay();
    this.makeGhost();
  }

  private terrainMesh(): THREE.Mesh {
    const spec = this.field.spec;
    const segments = spec.resolution - 1;
    const geometry = new THREE.PlaneGeometry(spec.sizeMetres, spec.sizeMetres, segments, segments);
    geometry.rotateX(-Math.PI / 2);

    const position = geometry.attributes["position"] as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      position.setY(i, this.field.sample(position.getX(i), position.getZ(i)));
    }
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({ color: 0x4a5c3f }),
    );
    mesh.receiveShadow = true;
    return mesh;
  }

  private scatter(): void {
    const registry = blueprints();

    for (const point of scatterProps(this.field, { tree: 70, rock: 35 })) {
      const blueprintId = point.kind === "tree" ? "harvest.tree" : "harvest.rock";
      const object = this.propObject(point.kind, point.objectId, blueprintId);
      object.position.set(point.x, point.y, point.z);
      object.rotation.y = point.yaw;
      object.scale.setScalar(point.scale);
      this.scene.add(object);

      this.props.push({
        point, object, blueprintId,
        state: harvestStateFor(point.objectId, registry.harvestable(blueprintId)),
      });
    }
  }

  /**
   * The player's own body.
   *
   * Third person means the player looks at this the entire match, so it is the
   * most-seen mesh in the game and the one whose facing being wrong would be
   * most obvious. It is driven from the motor rather than from the camera: the
   * camera is a view onto the simulation, not the other way round.
   */
  private makeAvatar(): void {
    const name = this.art.nameForKey("default");
    if (!name) throw new Error("No character mesh was loaded. Re-run: npm run art");

    const character = blueprints().character("character.default");
    const partTextures = character.partTextures ?? {};

    this.avatar = new THREE.Group();
    this.avatarJoints = new Map();

    for (const part of this.art.partsOf(name)) {
      const material = new THREE.MeshLambertMaterial({
        color: CHARACTER_PART_COLOURS[part.group] ?? 0x8899aa,
        map: this.art.texture(partTextures[part.group]) ?? null,
      });
      const mesh = new THREE.Mesh(part.geometry, material);
      mesh.castShadow = true;

      // A limb has to turn about its joint, not about the character's feet.
      // The generator emits the joint (it knows where a hip is); the renderer
      // just puts a node there and hangs the geometry off it, offset back by
      // the same amount so the part does not move until it is rotated.
      const pivot = part.pivot;
      if (!pivot) {
        this.avatar.add(mesh);
        continue;
      }

      const joint = this.avatarJoints.get(part.group) ?? new THREE.Group();
      if (!this.avatarJoints.has(part.group)) {
        joint.position.set(pivot[0], pivot[1], pivot[2]);
        this.avatarJoints.set(part.group, joint);
        this.avatar.add(joint);
      }
      mesh.position.set(-pivot[0], -pivot[1], -pivot[2]);
      joint.add(mesh);
    }

    this.scene.add(this.avatar);
  }

  private updateAvatar(deltaSeconds: number): void {
    const registry = blueprints();
    const movement = registry.movement("movement.default");

    // Ground distance, not time: the walk cycle is driven by how far the feet
    // have actually travelled, which is what stops them skating when the speed
    // changes. Vertical motion does not turn the legs over.
    const dx = this.motor.position.x - this.lastAvatarPosition.x;
    const dz = this.motor.position.z - this.lastAvatarPosition.z;
    const stepped = Math.hypot(dx, dz);
    this.distanceTravelled += stepped;
    this.lastAvatarPosition = { ...this.motor.position };

    // Speed comes from the *frame* delta, not the tick rate. This runs once
    // per rendered frame and several simulation ticks may have happened inside
    // it, so dividing by the tick interval overstates speed by the ratio of the
    // two -- which pinned the lean at its cap at any frame rate below 30.
    const speed = deltaSeconds > 1e-6 ? stepped / deltaSeconds : 0;
    this.lastAvatarSpeed = speed;

    const pose = poseFor(registry.locomotion("locomotion.default"), {
      distanceTravelled: this.distanceTravelled,
      speed,
      airborne: !this.motor.grounded,
      crouched: this.motor.crouched,
    });

    for (const [part, joint] of this.avatarJoints) {
      const rotation = pose.rotations[part];
      joint.rotation.set(rotation?.x ?? 0, rotation?.y ?? 0, rotation?.z ?? 0);
    }

    // The mesh is authored based at Z=0 facing +Z, so the motor's position and
    // yaw drive it directly with no offset to get wrong.
    this.avatar.position.set(
      this.motor.position.x, this.motor.position.y + pose.bob, this.motor.position.z,
    );
    this.avatar.rotation.set(pose.lean, (this.motor.yaw * Math.PI) / 180, 0, "YXZ");

    // Crouching squashes rather than swapping mesh: the capsule shrinks by the
    // same ratio, so the proxy stays inside the thing collision actually uses.
    const squash = this.motor.crouched ? movement.crouchHeight / movement.standHeight : 1;
    this.avatar.scale.set(1, squash, 1);
  }

  /**
   * The nine tiles drawn over a face while editing.
   *
   * Built once and repositioned, because an edit happens mid-fight and
   * allocating nine meshes on the frame the key goes down is the wrong time to
   * ask the GC for anything.
   */
  private makeEditOverlay(): void {
    const tile = CELL_SIZE / 3;
    this.editTiles = [];
    for (let index = 0; index < 9; index++) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(tile * 0.88, tile * 0.88),
        new THREE.MeshBasicMaterial({
          transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide,
        }),
      );
      mesh.visible = false;
      this.editTiles.push(mesh);
      this.scene.add(mesh);
    }
  }

  private updateEditOverlay(): void {
    const pending = this.editing;
    if (!pending) {
      for (const tile of this.editTiles) tile.visible = false;
      return;
    }

    const { cell, slot } = parsePieceKey(pending.key);
    const anchor = slotAnchor(cell, slot);
    const base = cellToWorld(cell);
    const rotationY = slotRotationY(slot);
    const step = CELL_SIZE / 3;

    // Nudge off the face so the tiles are not z-fighting the wall they mark.
    const OFF_FACE = 0.16;
    const onNorthSouth = slot === BuildSlot.NorthFace || slot === BuildSlot.SouthFace;
    const towardPlayer = onNorthSouth
      ? Math.sign(this.motor.position.z - anchor.z) || 1
      : Math.sign(this.motor.position.x - anchor.x) || 1;

    for (let index = 0; index < 9; index++) {
      const tile = this.editTiles[index]!;
      const column = index % 3;
      // Index 0 is the TOP-left, matching subCellIndex and how a designer reads
      // the grid, so row 0 is the highest band on the wall.
      const rowFromBottom = 2 - Math.floor(index / 3);

      const along = base.x + step * (column + 0.5);
      const acrossAlong = base.z + step * (column + 0.5);
      const height = base.y + step * (rowFromBottom + 0.5);

      tile.position.set(
        onNorthSouth ? along : anchor.x + OFF_FACE * towardPlayer,
        height,
        onNorthSouth ? anchor.z + OFF_FACE * towardPlayer : acrossAlong,
      );
      tile.rotation.set(0, rotationY, 0);

      // Set bits are the wall that remains; cleared bits are what gets cut out.
      const keeps = (pending.mask & (1 << index)) !== 0;
      (tile.material as THREE.MeshBasicMaterial).color.setHex(keeps ? 0x66ddff : 0xff7755);
      tile.visible = true;
    }
  }

  private makeGhost(): void {
    this.ghost = new THREE.Mesh(
      this.geometryFor(this.selectedPieceId, this.selectedMaterialId),
      new THREE.MeshBasicMaterial({ color: 0x66ddff, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.ghost.visible = false;
    this.scene.add(this.ghost);
  }

  private pieceMaterial(materialId: string): THREE.MeshLambertMaterial {
    let material = this.materials.get(materialId);
    if (!material) {
      const blueprint = blueprints().buildMaterial(materialId);
      // The texture is named by the Blueprint and tinted by its colour, so the
      // two agree by construction: a wood texture under a stone tint would read
      // as neither.
      material = new THREE.MeshLambertMaterial({
        color: new THREE.Color(blueprint.colour),
        map: this.art.texture(blueprint.texture) ?? null,
      });
      this.materials.set(materialId, material);
    }
    return material;
  }

  /**
   * The mesh for a piece, resolved from Blueprint fields.
   *
   * `placement` comes from the BuildPieceBlueprint and `materialKind` from the
   * BuildMaterialBlueprint, so a new piece or a new material is a JSON change
   * plus a generator -- never a branch here. This used to switch on `pieceId`,
   * which is the anti-pattern CLAUDE.md names first.
   */
  private geometryFor(
    pieceId: string, materialId: string, editMask: number = SOLID_MASK,
  ): THREE.BufferGeometry {
    const registry = blueprints();
    const piece = registry.buildPiece(pieceId);
    const materialKind = registry.buildMaterial(materialId).materialKind;

    // An edit resolves through the same blueprint the simulation validated
    // against, so the mesh drawn is the variant that was actually applied. A
    // mask with no authored variant is a solid piece, exactly as tryEdit
    // treats it.
    const variant = variantForMask(piece, editMask);
    const key = buildPieceKey(
      piece.placement, materialKind, variant?.variantName.toLowerCase(),
    );

    const name = this.art.nameForKey(key);
    if (!name) {
      // Loudly, not silently: a missing mesh with live collision is an
      // invisible wall, and the grid would still stop the player.
      throw new Error(`No mesh for build piece '${key}'. Re-run: npm run art`);
    }
    return this.art.geometry(name);
  }

  /**
   * Where a loaded mesh's origin goes.
   *
   * Every build piece is authored centred in x and z with its base on the cell
   * floor (`test_pieces_are_authored_with_their_base_at_the_cell_floor`), so the
   * slot anchor supplies x and z and the cell floor supplies y. Placing one at
   * the raw anchor would float a wall half a cell high.
   */
  private meshOrigin(cell: GridCell, slot: BuildSlot): { x: number; y: number; z: number } {
    const anchor = slotAnchor(cell, slot);
    return { x: anchor.x, y: cellCentre(cell).y - CELL_SIZE / 2, z: anchor.z };
  }

  /**
   * A harvestable prop, assembled from its loaded variants.
   *
   * The generators emit several numbered variants of each prop so a forest is
   * not one tree repeated; picking by `objectId` keeps that choice deterministic,
   * which matters because the same seed has to produce the same world on a
   * server as in a browser.
   *
   * Parts keep their own materials: the tree's trunk and canopy arrive as
   * separate glTF primitives tagged with their role, so the two-tone read
   * survives the move off procedural geometry.
   */
  private propObject(kind: string, objectId: number, blueprintId: string): THREE.Object3D {
    const variants = this.art.keysUnder(`${kind}/`);
    if (variants.length === 0) {
      throw new Error(`No '${kind}' meshes were loaded. Re-run: npm run art`);
    }
    const name = variants[Math.abs(objectId) % variants.length]!;

    const group = new THREE.Group();
    for (const part of this.art.partsOf(name)) {
      const mesh = new THREE.Mesh(part.geometry, this.propMaterial(blueprintId, part.group));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }

  private propMaterial(blueprintId: string, partRole: string): THREE.MeshLambertMaterial {
    const key = `prop:${blueprintId}:${partRole}`;
    let material = this.materials.get(key);
    if (!material) {
      const textures = blueprints().harvestable(blueprintId).partTextures ?? {};
      material = new THREE.MeshLambertMaterial({
        color: PROP_PART_COLOURS[partRole] ?? 0x7a7a80,
        map: this.art.texture(textures[partRole]) ?? null,
      });
      this.materials.set(key, material);
    }
    return material;
  }

  private syncPiece(key: string): void {
    const { cell, slot } = parsePieceKey(key);
    const piece = this.world.structure.get(cell, slot);
    if (!piece) return;

    this.removePieceMesh(key);
    const mesh = new THREE.Mesh(
      this.geometryFor(piece.pieceId, piece.materialId, piece.editMask),
      this.pieceMaterial(piece.materialId),
    );

    const origin = this.meshOrigin(piece.cell, piece.slot);
    mesh.position.set(origin.x, origin.y, origin.z);
    mesh.rotation.y = slotRotationY(piece.slot);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    this.scene.add(mesh);
    this.pieceMeshes.set(key, mesh);
  }

  private removePieceMesh(key: string): void {
    const existing = this.pieceMeshes.get(key);
    if (!existing) return;
    this.scene.remove(existing);
    // The geometry is **not** disposed: it belongs to the ArtLibrary and every
    // other piece of the same kind is drawing it. Disposing here used to be
    // correct, when each piece built its own procedural geometry; with loaded
    // meshes it would free the buffers out from under every wall on the map.
    this.pieceMeshes.delete(key);
  }

  // -----------------------------------------------------------------------
  // Input
  // -----------------------------------------------------------------------

  private bindInput(): void {
    const canvas = this.renderer.domElement;

    canvas.addEventListener("click", () => {
      if (document.pointerLockElement !== canvas) void canvas.requestPointerLock();
    });

    document.addEventListener("mousemove", (event) => {
      if (document.pointerLockElement !== canvas) return;
      // Accumulated, then consumed by the next tick: a look delta is a per-tick
      // increment, not a held state.
      this.lookDelta = vec2(
        this.lookDelta.x + event.movementX * 0.12,
        this.lookDelta.y - event.movementY * 0.12,
      );
    });

    canvas.addEventListener("mousedown", (event) => {
      if (event.button === 0) {
        this.primaryDown = true;
        this.primaryPressed = true;
      }
      if (event.button === 2) this.buildMode = !this.buildMode;
    });
    canvas.addEventListener("mouseup", (event) => {
      if (event.button === 0) this.primaryDown = false;
    });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());

    document.addEventListener("keydown", (event) => {
      this.keys.add(event.code);
      if (event.code === "Space") this.jumpQueued = true;

      const pieces: Record<string, string> = {
        Digit1: "piece.wall", Digit2: "piece.floor", Digit3: "piece.ramp", Digit4: "piece.cone",
      };
      const chosen = pieces[event.code];
      if (chosen) {
        this.selectedPieceId = chosen;
        this.buildMode = true;
      }

      const mats: Record<string, string> = {
        KeyZ: "material.wood", KeyX: "material.stone", KeyC: "material.metal",
      };
      const material = mats[event.code];
      if (material) this.selectedMaterialId = material;

      if (event.code === "KeyQ") this.buildMode = !this.buildMode;
      if (event.code === "KeyR") this.reset();
      if (event.code === "KeyG" && !event.repeat) this.beginEdit();
      // Reset-to-default is one input: fumbling an edit mid-fight and needing to
      // undo it instantly is common (building.md section 5).
      if (event.code === "KeyT") this.resetEdit();
    });

    document.addEventListener("keyup", (event) => {
      this.keys.delete(event.code);
      // Release applies, per the spec: hold, drag across cells, release.
      if (event.code === "KeyG") this.commitEdit();
    });
  }

  private reset(): void {
    for (const key of [...this.pieceMeshes.keys()]) this.removePieceMesh(key);
    this.world.clear();
    for (const id of ["material.wood", "material.stone", "material.metal"]) {
      this.world.wallet(PLAYER_ID).add(blueprints().buildMaterial(id), 500);
    }
    this.motor = motorAtRest(vec3(0, this.field.sample(0, 0) + 1, 0));
    this.say("reset");
  }

  // -----------------------------------------------------------------------
  // Loop
  // -----------------------------------------------------------------------

  private frame(): void {
    // THREE.Clock is deprecated in three 0.186; performance.now() is what it
    // wrapped anyway, and the simulation takes its dt from the command.
    const now = performance.now();
    const delta = this.lastFrameMs === 0 ? 1 / 60 : Math.min((now - this.lastFrameMs) / 1000, 0.25);
    this.lastFrameMs = now;
    this.fps = this.fps * 0.9 + (1 / Math.max(delta, 1e-6)) * 0.1;

    this.accumulator += delta;
    // Bounded so a long hitch does not spiral into hundreds of catch-up ticks.
    let budget = 8;
    while (this.accumulator >= TICK_DELTA && budget-- > 0) {
      this.accumulator -= TICK_DELTA;
      this.simulate();
    }

    this.updateAvatar(delta);
    this.updateCamera();
    this.paintEdit();
    this.updateEditOverlay();
    this.updateGhost();
    this.renderer.render(this.scene, this.camera);

    this.hud.update({
      health: this.pool.health,
      maxHealth: this.pool.maxHealth,
      shield: this.pool.shield,
      maxShield: this.pool.maxShield,
      materials: this.world.wallet(PLAYER_ID).snapshot(),
      selectedMaterialId: this.selectedMaterialId,
      selectedPieceId: this.selectedPieceId,
      buildMode: this.buildMode,
      pieceCount: this.world.structure.count,
      fps: this.fps,
      lastMessage: this.tick < this.messageUntil ? this.message : "",
    });
  }

  private simulate(): void {
    let flags: number = MoveFlags.None;
    if (this.jumpQueued) flags |= MoveFlags.Jump;
    if (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")) flags |= MoveFlags.Sprint;
    if (this.keys.has("ControlLeft") || this.keys.has("KeyV")) flags |= MoveFlags.Crouch;

    const forward = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
    const strafe = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);

    const command = moveCommand(
      this.tick, vec2(strafe, forward), this.lookDelta, flags, TICK_DELTA,
    );
    this.lookDelta = vec2();
    this.jumpQueued = false;

    const stepped = stepMotor(this.motor, command, blueprints().movement("movement.default"), this.collision);
    this.motor = stepped.state;

    if (stepped.result.fallDamage > 0) {
      this.pool.health = Math.max(0, this.pool.health - stepped.result.fallDamage);
      this.say(`fall damage ${Math.round(stepped.result.fallDamage)}`);
    }

    // The eye, not the feet: build range is measured from where the player
    // is looking from, which is what the placement resolver uses too.
    this.world.setPlayerPosition(PLAYER_ID, this.eyePosition());
    this.world.tick(this.tick);

    if (this.primaryDown || this.primaryPressed) {
      if (this.buildMode) {
        if (this.primaryPressed) this.tryPlace();
      } else {
        this.trySwing();
      }
    }
    this.primaryPressed = false;

    this.tick++;
  }

  private aimDirection() {
    const pitch = (this.motor.pitch * Math.PI) / 180;
    const flat = yawRotate(vec3(0, 0, 1), this.motor.yaw);
    return vec3(
      flat.x * Math.cos(pitch), Math.sin(pitch), flat.z * Math.cos(pitch),
    );
  }

  private eyePosition() {
    const character = blueprints().character("character.default");
    const movement = blueprints().movement("movement.default");
    const height = this.motor.crouched
      ? character.cameraHeight * (movement.crouchHeight / movement.standHeight)
      : character.cameraHeight;
    return vec3(this.motor.position.x, this.motor.position.y + height, this.motor.position.z);
  }

  private currentTarget() {
    return resolvePlacement(
      this.eyePosition(), this.aimDirection(), -1,
      blueprints().buildPiece(this.selectedPieceId),
      this.world.structure, this.motor.position.y,
    );
  }

  // -----------------------------------------------------------------------
  // Editing
  // -----------------------------------------------------------------------

  private editTarget() {
    return resolveEditTarget(this.eyePosition(), this.aimDirection(), this.world.structure);
  }

  /** Start drawing a mask on the piece under the crosshair. */
  private beginEdit(): void {
    const target = this.editTarget();
    if (!target.found) {
      this.say("nothing to edit");
      return;
    }

    const piece = this.world.structure.get(target.cell, target.slot);
    if (!piece) return;
    if (piece.ownerId !== PLAYER_ID) {
      // Ownership transfers on nothing: a captured structure must be destroyed,
      // not edited (building.md section 5).
      this.say("not yours to edit");
      return;
    }

    // The first cell decides what the drag paints: press on a solid cell and
    // the drag cuts, press on a hole and it fills back in.
    const wasKept = (piece.editMask & (1 << target.subCell)) !== 0;
    this.editing = {
      key: pieceKey(target.cell, target.slot),
      mask: piece.editMask,
      paintKeeps: !wasKept,
    };
    this.paintEdit();
  }

  /**
   * Paint the sub-cell under the crosshair.
   *
   * Called every frame while the key is held, so sweeping the crosshair across
   * a face drags a selection. It **paints** one state rather than toggling each
   * cell it crosses: crossing a cell twice with a toggle undoes it, so a shaky
   * drag mid-fight silently produces a different shape from the one intended.
   * Painting is idempotent, so only where the crosshair went matters, not how
   * many times it went there.
   */
  private paintEdit(): void {
    const pending = this.editing;
    if (!pending) return;

    const target = this.editTarget();
    if (!target.found || pieceKey(target.cell, target.slot) !== pending.key) return;

    const bit = 1 << target.subCell;
    const mask = pending.paintKeeps ? pending.mask | bit : pending.mask & ~bit;
    if (mask !== pending.mask) this.editing = { ...pending, mask };
  }

  /** Apply the drawn mask, or revert when it matches no authored variant. */
  private commitEdit(): void {
    const pending = this.editing;
    this.editing = undefined;
    if (!pending) return;

    const { cell, slot } = parsePieceKey(pending.key);
    const piece = this.world.structure.get(cell, slot);
    if (!piece) return;

    const blueprint = blueprints().buildPiece(piece.pieceId);
    // No authored variant means revert to solid rather than refusing: the spec
    // makes a nonsense selection a no-op, not a stuck piece.
    const variant = variantForMask(blueprint, pending.mask);
    const mask = variant ? pending.mask : SOLID_MASK;

    if (this.world.tryEdit(cell, slot, mask, PLAYER_ID)) {
      this.say(variant ? variant.variantName.toLowerCase() : "reverted");
    }
  }

  private resetEdit(): void {
    const target = this.editTarget();
    if (!target.found) return;
    if (this.world.tryEdit(target.cell, target.slot, SOLID_MASK, PLAYER_ID)) {
      this.say("reverted");
    }
  }

  private tryPlace(): void {
    const target = this.currentTarget();
    if (!target.found) return;

    const rejection = this.world.tryPlace({
      playerId: PLAYER_ID, tick: this.tick, cell: target.cell, slot: target.slot,
      pieceId: this.selectedPieceId, materialId: this.selectedMaterialId,
    }, this.tick, false);

    if (rejection !== PlacementRejection.None) this.say(rejection);
  }

  private trySwing(): void {
    if (this.tick - this.lastPickaxeTick < PICKAXE_INTERVAL_TICKS) return;
    this.lastPickaxeTick = this.tick;

    const eye = this.eyePosition();
    const aim = this.aimDirection();

    // Nearest prop within range and roughly ahead. A full raycast is overkill
    // for a sandbox and would not change the feel.
    let best: PropInstance | undefined;
    let bestDistance = INTERACT_RANGE;
    for (const prop of this.props) {
      if (prop.state.destroyed) continue;
      const dx = prop.point.x - eye.x;
      const dy = prop.point.y + 1 - eye.y;
      const dz = prop.point.z - eye.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance > bestDistance) continue;
      const dot = (dx * aim.x + dy * aim.y + dz * aim.z) / Math.max(distance, 1e-6);
      if (dot < 0.6) continue;
      best = prop;
      bestDistance = distance;
    }

    if (best) {
      this.swingAtProp(best);
      return;
    }

    // Nothing to harvest: try the structure the player is looking at.
    const target = this.currentTarget();
    if (target.found && this.world.structure.isOccupied(target.cell, target.slot)) {
      this.world.applyDamage(target.cell, target.slot, PICKAXE_DAMAGE * 5, this.tick);
    }
  }

  private swingAtProp(prop: PropInstance): void {
    const registry = blueprints();
    const blueprint = registry.harvestable(prop.blueprintId);

    // Aim the swing at the marker: with no aiming UI in the sandbox, always
    // hitting it keeps the harvest rates matching the design targets.
    const marker = weakPointFor(prop.state.objectId, prop.state.hitCount);
    const result = harvestHit(prop.state, blueprint, PICKAXE_DAMAGE, marker);

    const material = registry.buildMaterial(blueprint.materialId);
    const gained = this.world.wallet(PLAYER_ID).add(material, result.yield);
    this.say(gained > 0 ? `+${gained} ${material.displayName.toLowerCase()}` : "at cap");

    if (result.destroyed) this.scene.remove(prop.object);
  }

  private updateCamera(): void {
    const eye = this.eyePosition();
    const aim = this.aimDirection();

    // Right-hand side of the aim direction, flattened: the shoulder offset must
    // not tilt with pitch or the camera rolls when the player looks up.
    const rightX = -aim.z;
    const rightZ = aim.x;
    const rightLength = Math.hypot(rightX, rightZ) || 1;

    const offsetX = (rightX / rightLength) * CAMERA_SHOULDER;
    const offsetZ = (rightZ / rightLength) * CAMERA_SHOULDER;

    const boom = this.clearBoom(eye, aim, offsetX, offsetZ);

    this.camera.position.set(
      eye.x - aim.x * boom + offsetX,
      eye.y - aim.y * boom + CAMERA_RISE,
      eye.z - aim.z * boom + offsetZ,
    );
    // Look at a point on the *player's* aim ray, not merely along the same
    // direction, so the crosshair and the placement resolver agree.
    this.camera.lookAt(
      eye.x + aim.x * CAMERA_CONVERGE,
      eye.y + aim.y * CAMERA_CONVERGE,
      eye.z + aim.z * CAMERA_CONVERGE,
    );
  }

  /**
   * Shorten the boom until it is not inside something.
   *
   * Without this, backing into a wall puts the camera on the far side of it and
   * the player sees the inside of their own base. Sampled rather than swept:
   * the collision model is a height query and a set of slabs, not a solver, and
   * a handful of samples along a 3.4 m boom is accurate to a few centimetres.
   */
  private clearBoom(eye: Vec3, aim: Vec3, offsetX: number, offsetZ: number): number {
    const STEPS = 8;
    for (let step = STEPS; step > 0; step--) {
      const boom = (CAMERA_BOOM * step) / STEPS;
      const x = eye.x - aim.x * boom + offsetX;
      const y = eye.y - aim.y * boom + CAMERA_RISE;
      const z = eye.z - aim.z * boom + offsetZ;
      if (!this.collision.isInsideSolid(x, y, z)) return boom;
    }
    return CAMERA_MIN_BOOM;
  }

  private updateGhost(): void {
    if (!this.buildMode) {
      this.ghost.visible = false;
      return;
    }

    const target = this.currentTarget();
    if (!target.found) {
      this.ghost.visible = false;
      return;
    }

    // The ghost must use the same geometry and the same transform as the placed
    // piece, or it would disagree with where the piece lands -- the failure
    // pillar 1 forbids. Both now go through geometryFor and meshOrigin.
    const { rotationY } = placementTransform(target);
    const origin = this.meshOrigin(target.cell, target.slot);

    // Not disposed: the geometry is the shared, loaded one, and disposing it
    // here would destroy the mesh every placed piece is drawing.
    this.ghost.geometry = this.geometryFor(this.selectedPieceId, this.selectedMaterialId);
    this.ghost.position.set(origin.x, origin.y, origin.z);
    this.ghost.rotation.y = rotationY;
    this.ghost.visible = true;
  }

  private say(text: string): void {
    this.message = text;
    this.messageUntil = this.tick + TICK_RATE * 2;
  }

  private resize(): void {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}

export { CELL_SIZE };
export type { GridCell };
