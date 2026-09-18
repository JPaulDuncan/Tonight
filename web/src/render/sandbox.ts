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
import type { BuildMaterialBlueprint, CharacterBlueprint } from "@/blueprints/types";
import {
  BuildSlot, CELL_SIZE, cellCentre, parsePieceKey, slotAnchor, slotRotationY, type GridCell,
} from "@/core/grid";
import { vec2, vec3 } from "@/core/math";
import { MoveFlags, PlacementRejection, moveCommand } from "@/gameplay/commands";
import { BuildWorld, resolvePlacement, placementTransform } from "@/gameplay/build";
import { fullHealth, type HealthPool } from "@/gameplay/combat";
import { harvestHit, harvestStateFor, weakPointFor, type HarvestState } from "@/gameplay/harvest";
import {
  TICK_DELTA, TICK_RATE, motorAtRest, stepMotor, yawRotate, type MotorState,
} from "@/gameplay/motor";
import { WorldCollision } from "./collision";
import { Hud } from "./hud";
import { coneGeometry, floorGeometry, rampGeometry, rockMesh, treeMesh, wallGeometry } from "./meshes";
import { Heightfield, SANDBOX_TERRAIN, scatterProps, type ScatterPoint } from "./terrain";

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
  private selectedMaterialId = "material.wood";

  constructor(private readonly container: HTMLElement) {
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
    const bark = new THREE.MeshLambertMaterial({ color: 0x6b4a2f });
    const foliage = new THREE.MeshLambertMaterial({ color: 0x2f4a33 });
    const stone = new THREE.MeshLambertMaterial({ color: 0x7a7a80 });
    const registry = blueprints();

    for (const point of scatterProps(this.field, { tree: 70, rock: 35 })) {
      const object = point.kind === "tree" ? treeMesh(bark, foliage) : rockMesh(stone);
      object.position.set(point.x, point.y, point.z);
      object.rotation.y = point.yaw;
      object.scale.setScalar(point.scale);
      this.scene.add(object);

      const blueprintId = point.kind === "tree" ? "harvest.tree" : "harvest.rock";
      this.props.push({
        point, object, blueprintId,
        state: harvestStateFor(point.objectId, registry.harvestable(blueprintId)),
      });
    }
  }

  private makeGhost(): void {
    this.ghost = new THREE.Mesh(
      wallGeometry(),
      new THREE.MeshBasicMaterial({ color: 0x66ddff, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.ghost.visible = false;
    this.scene.add(this.ghost);
  }

  private pieceMaterial(materialId: string): THREE.MeshLambertMaterial {
    let material = this.materials.get(materialId);
    if (!material) {
      const blueprint = blueprints().buildMaterial(materialId);
      material = new THREE.MeshLambertMaterial({ color: new THREE.Color(blueprint.colour) });
      this.materials.set(materialId, material);
    }
    return material;
  }

  private geometryFor(pieceId: string): THREE.BufferGeometry {
    switch (pieceId) {
      case "piece.floor": return floorGeometry();
      case "piece.ramp": return rampGeometry();
      case "piece.cone": return coneGeometry();
      default: return wallGeometry();
    }
  }

  private syncPiece(key: string): void {
    const { cell, slot } = parsePieceKey(key);
    const piece = this.world.structure.get(cell, slot);
    if (!piece) return;

    this.removePieceMesh(key);
    const mesh = new THREE.Mesh(
      this.geometryFor(piece.pieceId), this.pieceMaterial(piece.materialId),
    );

    const anchor = piece.slot === BuildSlot.Interior ? cellCentre(piece.cell) : slotAnchor(piece.cell, piece.slot);
    mesh.position.set(anchor.x, anchor.y, anchor.z);
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
    existing.geometry.dispose();
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
    });

    document.addEventListener("keyup", (event) => this.keys.delete(event.code));
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

    this.updateCamera();
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
    this.camera.position.set(eye.x, eye.y, eye.z);
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = (this.motor.yaw * Math.PI) / 180 + Math.PI;
    this.camera.rotation.x = (this.motor.pitch * Math.PI) / 180;
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

    // The ghost must use the same transform function as the placed piece, or it
    // would disagree with where the piece lands -- the failure pillar 1 forbids.
    const { position, rotationY } = placementTransform(target);
    const centre = target.slot === BuildSlot.Interior ? cellCentre(target.cell) : position;

    this.ghost.geometry.dispose();
    this.ghost.geometry = this.geometryFor(this.selectedPieceId);
    this.ghost.position.set(centre.x, centre.y, centre.z);
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
