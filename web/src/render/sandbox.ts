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
import type {
  BotBlueprint, BuildMaterialBlueprint, CharacterBlueprint, ConsumableBlueprint,
} from "@/blueprints/types";
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
import {
  FireRejection, applyHit, beginEquip, computeDamage, effectiveSpread, freshWeaponState,
  pelletDirection, tickWeapon, tryBeginReload, tryFire,
  type WeaponState,
} from "@/gameplay/combat";
import {
  EliminationFeed, damageCombatant, damageHealthDirectly, makeCombatant, readyToRespawn,
  respawnCombatant, type Combatant,
} from "@/gameplay/combatant";
import {
  beginUse, cancelUse, channelFraction, completeUse, freshChannel, interruptOnDamage,
  type ChannelState,
} from "@/gameplay/consumable";
import { decideBot, freshBotState, provoke, resetBotState, type BotState } from "@/gameplay/bot";
import { harvestHit, harvestStateFor, weakPointFor, type HarvestState } from "@/gameplay/harvest";
import {
  TICK_DELTA, TICK_RATE, motorAtRest, stepMotor, yawRotate, type MotorState,
} from "@/gameplay/motor";
import { WorldCollision } from "./collision";
import { Hud } from "./hud";
import { ArtLibrary, buildPieceKey, weaponAssetKey, type ArtRecord } from "./assets";
import {
  FeedbackLayer, ShotAccumulator, type HitKind,
} from "./feedback";
import { Avatar, type HitboxHit } from "./avatar";
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
  // Terrain is generated in the browser from the heightfield collision reads,
  // so loading the Blender island would put two surfaces in one scene.
  return record.category !== "terrain";
}

/** Part colours for a held weapon, keyed by the generator's part roles. */
const WEAPON_PART_COLOURS: Readonly<Record<string, number>> = {
  Haft: 0x6b4a2f,
  Head: 0x8b9099,
  Spike: 0x8b9099,
  Barrel: 0x4a4f57,
  Receiver: 0x3f444b,
  Grip: 0x2e3238,
  Stock: 0x5a4433,
  Magazine: 0x33373d,
  Scope: 0x2a2d33,
  FrontSight: 0x4a4f57,
};

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

const PLAYER_ID = 1;
const PICKAXE_DAMAGE = 20;
const PICKAXE_INTERVAL_TICKS = Math.ceil((60 / 84) * TICK_RATE);
const INTERACT_RANGE = 4.5;

/**
 * What the sandbox hands you.
 *
 * Everything at once, because this is a range for testing weapon feel rather
 * than a match: the loot system decides what a player actually carries, and it
 * is tested separately.
 */
const SANDBOX_LOADOUT = [
  "weapon.pickaxe", "weapon.assaultRifle", "weapon.shotgun",
  "weapon.smg", "weapon.sniper", "weapon.pistol",
] as const;

/** How far a hitscan shot reaches before it stops caring. */
const SHOT_RANGE = 220;

/**
 * The consumables the sandbox hands you, and the keys that use them.
 *
 * A full stack of each, for the same reason the wallet starts at 500 wood:
 * this is a range for testing how a shield potion feels mid-fight, not the
 * economy. Which items exist is Blueprint data; only the key bindings are here.
 */
const SANDBOX_CONSUMABLES = [
  { key: "KeyF", label: "F", itemId: "consumable.miniShield" },
  { key: "KeyH", label: "H", itemId: "consumable.bigShield" },
  { key: "KeyJ", label: "J", itemId: "consumable.bandage" },
  { key: "KeyK", label: "K", itemId: "consumable.medkit" },
] as const;

/** Which bot stands where, in metres from the spawn point. */
const BOT_SPAWNS = [
  // Targets ahead, inside the range but outside nobody's patience. The
  // skirmishers sit beyond their own 22 m engage range, so the spawn point is
  // safe and walking toward one is a decision rather than an ambush.
  { botId: "bot.target", x: -8, z: 17 },
  { botId: "bot.target", x: 9, z: 18 },
  { botId: "bot.skirmisher", x: 30, z: 8 },
  { botId: "bot.skirmisher", x: -28, z: -12 },
  { botId: "bot.skirmisher", x: 5, z: -32 },
] as const;

/** Bots read as not-you at a glance. Nothing gameplay hangs off the colour. */
const BOT_TINT = 0xb2564f;

/** Seconds the player spends eliminated before standing back up. */
const PLAYER_RESPAWN_SECONDS = 4;

/** How long an entry stays in the kill feed. */
const FEED_SECONDS = 8;

/** How long the screen flashes after taking a hit. */
const DAMAGE_FLASH_SECONDS = 0.35;

/** Reserve ammo. Unlimited in the sandbox; the real number comes from inventory. */
const SANDBOX_RESERVE_AMMO = 999;

/**
 * How long a tracer stays on screen.
 *
 * Long enough to read, short enough not to smear -- and, more importantly, long
 * enough to survive a frame. At 0.05 s a tracer could be created and expired
 * between two frames of a slow renderer, so a shot would land with nothing
 * drawn at all.
 */
const TRACER_SECONDS = 0.09;

/** Tracers alive at once. A spray at 800 rpm would otherwise pile them up. */
const MAX_TRACERS = 24;

/**
 * One bot in the world.
 *
 * The Blueprint is its difficulty, the combatant is its life, the state is what
 * it has noticed, and the weapon state is a real magazine -- a bot reloads
 * through `tryBeginReload` like anybody else, because a second firing state
 * machine would drift from the first within a week.
 */
interface BotInstance {
  readonly blueprint: BotBlueprint;
  readonly combatant: Combatant;
  readonly brain: BotState;
  readonly avatar: Avatar;
  readonly spawn: Vec3;
  readonly weapon: WeaponState;
  yaw: number;
  shotsFired: number;
  /** Whether it could see the player on the last tick, for the smoke test. */
  sawTarget: boolean;
}

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
  private avatar!: Avatar;
  private heldWeaponId = "weapon.pickaxe";
  /**
   * Per-weapon state, kept across swaps.
   *
   * Swapping away and back must not refill a magazine -- that would make
   * swapping a free reload, which is the one thing beginEquip's comment warns
   * about.
   */
  private readonly weaponStates = new Map<string, WeaponState>();
  private readonly tracers: { line: THREE.Line; until: number }[] = [];
  private feedback!: FeedbackLayer;
  /** Reused every shot, so aggregating pellets allocates nothing. */
  private readonly shotHits = new ShotAccumulator();
  /** Reused by `project`, which runs once per live number per frame. */
  private readonly projectScratch = new THREE.Vector3();
  /** Cumulative, for the smoke test: a live tracer count races its own expiry. */
  private shotsFired = 0;
  private pelletsFired = 0;
  private structureHits = 0;
  private propHits = 0;
  private botHits = 0;
  private upperBodyId = "upper.carry";
  private upperBodyStartedMs = 0;
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
  /** The player, as the same kind of thing every bot is. */
  private player!: Combatant;
  private readonly bots: BotInstance[] = [];
  private readonly feed = new EliminationFeed();
  private readonly channel: ChannelState = freshChannel();
  private readonly stock = new Map<string, number>();
  private spawnPoint = vec3();
  private damageFlashUntilMs = 0;
  /** Cumulative, for the smoke test. */
  private damageTaken = 0;
  private shieldAbsorbed = 0;
  private botShotsFired = 0;
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

    this.player = makeCombatant(PLAYER_ID, "You", character);
    this.spawnPoint = vec3(0, this.field.sample(0, 0) + 1, 0);
    this.motor = motorAtRest(this.spawnPoint);

    // A full stack of each consumable, so shields can be tested without first
    // testing the loot roller.
    for (const { itemId } of SANDBOX_CONSUMABLES) {
      this.stock.set(itemId, registry.get<ConsumableBlueprint>(itemId).maxStack);
    }

    this.buildScene();
    this.hud = new Hud(registry, container);
    this.feedback = new FeedbackLayer(container);

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
        position: [this.motor.position.x, this.motor.position.y, this.motor.position.z]
          .map((v: number) => Number(v.toFixed(3))),
        yaw: Number(this.motor.yaw.toFixed(2)),
        pitch: Number(this.motor.pitch.toFixed(2)),
        joints: Object.fromEntries(
          [...this.avatar.joints].map(([part, joint]) => [
            part,
            [joint.rotation.x, joint.rotation.y, joint.rotation.z].map(
              (v: number) => Number(v.toFixed(4)),
            ),
          ]),
        ),
        bobY: Number((this.avatar.root.position.y - this.motor.position.y).toFixed(4)),
        upperBody: this.upperBodyId,
        weapon: this.avatar.heldParts > 0
          ? { parts: this.avatar.heldParts, world: this.avatar.heldPosition() }
          : null,
        leanX: Number(this.avatar.root.rotation.x.toFixed(4)),
        speed: Number(this.lastAvatarSpeed.toFixed(3)),
      }),
      describeWeapon: () => {
        const weapon = blueprints().weapon(this.heldWeaponId);
        const state = this.weaponState();
        return {
          id: this.heldWeaponId,
          name: weapon.displayName,
          fireMode: weapon.fireMode,
          pelletCount: weapon.pelletCount,
          ammo: state.ammoInMagazine,
          magazine: weapon.magazineSize,
          reloading: state.isReloading,
          bloom: Number(state.bloomDegrees.toFixed(3)),
          tracers: this.tracers.length,
          shotsFired: this.shotsFired,
          pelletsFired: this.pelletsFired,
          structureHits: this.structureHits,
          propHits: this.propHits,
          heldParts: this.avatar.heldParts,
        };
      },
      describeFeedback: () => this.feedback.describe(),
      describeSurvival: () => ({
        player: {
          health: Number(this.player.pool.health.toFixed(2)),
          shield: Number(this.player.pool.shield.toFixed(2)),
          alive: this.player.alive,
          eliminations: this.player.eliminations,
          damageTaken: Number(this.damageTaken.toFixed(2)),
          shieldAbsorbed: Number(this.shieldAbsorbed.toFixed(2)),
        },
        channel: {
          active: this.channel.active,
          itemId: this.channel.itemId,
          fraction: Number(channelFraction(this.channel, this.tick).toFixed(3)),
        },
        stock: Object.fromEntries(this.stock),
        botShotsFired: this.botShotsFired,
        botHits: this.botHits,
        bots: this.bots.map((bot) => ({
          id: bot.blueprint.id,
          health: Number(bot.combatant.pool.health.toFixed(2)),
          shield: Number(bot.combatant.pool.shield.toFixed(2)),
          alive: bot.combatant.alive,
          provoked: bot.brain.provoked,
          sees: bot.sawTarget,
          shotsFired: bot.shotsFired,
          respawnIn: bot.combatant.alive
            ? 0
            : Number(((bot.combatant.respawnAtTick - this.tick) / TICK_RATE).toFixed(2)),
          position: [bot.spawn.x, bot.spawn.y, bot.spawn.z].map((v) => Number(v.toFixed(2))),
          distance: Number(Math.hypot(
            bot.spawn.x - this.motor.position.x, bot.spawn.z - this.motor.position.z,
          ).toFixed(2)),
        })),
        feed: [...this.feed.visible(this.tick, FEED_SECONDS * TICK_RATE)].map((entry) => ({
          attacker: entry.attackerName,
          victim: entry.victimName,
          weapon: entry.weaponName,
          headshot: entry.headshot,
        })),
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
    this.spawnBots();
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
    this.avatar = new Avatar(this.art, blueprints().character("character.default"));
    this.avatar.equip(
      blueprints().weapon(this.heldWeaponId),
      (weaponId, part) => this.weaponMaterial(weaponId, part),
    );
    this.scene.add(this.avatar.root);
  }

  /**
   * Put the bots in the world.
   *
   * Placed relative to the spawn rather than scattered: the point of a range is
   * knowing where the targets are. The two furthest out are skirmishers, so
   * walking in any direction eventually finds a fight, and the pair in front
   * are pure targets that never shoot back -- which is a Blueprint field, not a
   * second kind of bot.
   */
  private spawnBots(): void {
    const registry = blueprints();
    for (const [index, placement] of BOT_SPAWNS.entries()) {
      const blueprint = registry.bot(placement.botId);
      const character = registry.character(blueprint.characterId);
      const weapon = registry.weapon(blueprint.weaponId);

      const x = this.spawnPoint.x + placement.x;
      const z = this.spawnPoint.z + placement.z;
      const spawn = vec3(x, this.field.sample(x, z), z);

      const avatar = new Avatar(this.art, character, BOT_TINT, false);
      avatar.equip(weapon, (weaponId, part) => this.weaponMaterial(weaponId, part));
      this.scene.add(avatar.root);

      this.bots.push({
        blueprint,
        combatant: makeCombatant(
          100 + index, blueprint.displayName, character, blueprint.startingShield,
        ),
        brain: freshBotState(),
        avatar,
        spawn,
        weapon: freshWeaponState(weapon),
        // Facing the spawn point, so they are looking at the player rather than
        // away from one another.
        yaw: (Math.atan2(this.spawnPoint.x - x, this.spawnPoint.z - z) * 180) / Math.PI,
        shotsFired: 0,
        sawTarget: false,
      });
    }
  }

  /** The live state of whatever is in hand. */
  private weaponState(): WeaponState {
    let state = this.weaponStates.get(this.heldWeaponId);
    if (!state) {
      state = freshWeaponState(blueprints().weapon(this.heldWeaponId));
      this.weaponStates.set(this.heldWeaponId, state);
    }
    return state;
  }

  /**
   * Swap to another weapon.
   *
   * The equip timer is the reason this is not just a mesh change: a weapon is
   * not usable the instant it appears, and that delay is what makes swapping a
   * decision rather than a free action.
   */
  private equipWeapon(weaponId: string): void {
    if (weaponId === this.heldWeaponId) return;
    const weapon = blueprints().weapon(weaponId);

    this.heldWeaponId = weaponId;
    beginEquip(this.weaponState(), weapon, this.tick, TICK_RATE);

    this.avatar.equip(weapon, (id, part) => this.weaponMaterial(id, part));
    this.playUpperBody(weapon.carryPoseId);
    this.say(weapon.displayName.toLowerCase());
  }

  private weaponMaterial(weaponId: string, partRole: string): THREE.MeshLambertMaterial {
    const key = `weapon:${weaponId}:${partRole}`;
    let material = this.materials.get(key);
    if (!material) {
      const textures = blueprints().weapon(weaponId).partTextures ?? {};
      material = new THREE.MeshLambertMaterial({
        color: WEAPON_PART_COLOURS[partRole] ?? 0x555a61,
        map: this.art.texture(textures[partRole]) ?? null,
      });
      this.materials.set(key, material);
    }
    return material;
  }

  /**
   * Start an upper-body clip.
   *
   * Restarting one that is already playing is deliberate: swinging twice in
   * quick succession should replay the swing, not continue a stale one.
   */
  private playUpperBody(id: string | undefined): void {
    if (!id) return;
    this.upperBodyId = id;
    this.upperBodyStartedMs = performance.now();
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

    const clip = registry.upperBody(this.upperBodyId);
    const elapsed = (performance.now() - this.upperBodyStartedMs) / 1000;

    // A one-shot that has run its course hands the body back to the carry pose,
    // so the character settles into holding its tool rather than freezing on
    // the last frame of a swing.
    if (!clip.loop && clip.durationSeconds > 0 && elapsed > clip.durationSeconds) {
      const carry = registry.weapon(this.heldWeaponId).carryPoseId;
      if (carry && carry !== this.upperBodyId) this.playUpperBody(carry);
    }

    const pose = poseFor(
      registry.locomotion("locomotion.default"),
      {
        distanceTravelled: this.distanceTravelled,
        speed,
        airborne: !this.motor.grounded,
        crouched: this.motor.crouched,
      },
      { blueprint: registry.upperBody(this.upperBodyId), elapsed },
    );

    // Crouching squashes rather than swapping mesh: the capsule shrinks by the
    // same ratio, so the proxy stays inside the thing collision actually uses.
    const squash = this.motor.crouched ? movement.crouchHeight / movement.standHeight : 1;
    this.avatar.apply(pose, this.motor.position, this.motor.yaw, squash);

    // Eliminated: the figure lies where it fell rather than vanishing, because
    // a body that disappears makes a kill read as a miss.
    if (!this.player.alive) this.avatar.root.rotation.x = Math.PI / 2.2;

    this.updateBotAvatars();
  }

  /**
   * Pose every bot.
   *
   * They do not move, so the locomotion cycle is standing still and the whole
   * pose is the carry clip -- but it is the same `poseFor` the player uses,
   * because two pose paths is two sets of bugs.
   */
  private updateBotAvatars(): void {
    const registry = blueprints();
    const locomotion = registry.locomotion("locomotion.default");
    const carry = registry.upperBody("upper.carry");

    for (const bot of this.bots) {
      const pose = poseFor(
        locomotion,
        { distanceTravelled: 0, speed: 0, airborne: false, crouched: false },
        { blueprint: carry, elapsed: 0 },
      );
      bot.avatar.apply(pose, bot.spawn, bot.yaw);
      // Face down when eliminated, for the same reason the player's body does.
      if (!bot.combatant.alive) bot.avatar.root.rotation.x = Math.PI / 2.2;
    }
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

      // The number row means pieces while building and weapons otherwise: the
      // same keys, read against what the player is currently doing.
      if (!this.buildMode) {
        const slot = Number(event.code.replace("Digit", ""));
        const weaponId = SANDBOX_LOADOUT[slot - 1];
        if (event.code.startsWith("Digit") && weaponId) {
          this.equipWeapon(weaponId);
          return;
        }
      }

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

      // Consumables are on their own row: the number keys already mean two
      // things depending on build mode, and a third meaning would be one too
      // many for a key you reach for while being shot at.
      const consumable = SANDBOX_CONSUMABLES.find((c) => c.key === event.code);
      if (consumable && !event.repeat) {
        this.tryUseConsumable(consumable.itemId);
        return;
      }

      if (event.code === "KeyQ") this.buildMode = !this.buildMode;
      // R reloads, as it does in every shooter. Resetting the world is a
      // sandbox convenience and gives up the letter.
      if (event.code === "KeyR") {
        const weapon = blueprints().weapon(this.heldWeaponId);
        if (tryBeginReload(
          this.weaponState(), weapon, this.tick, TICK_RATE, SANDBOX_RESERVE_AMMO,
        )) {
          this.say("reloading");
        }
      }
      if (event.code === "Backspace") this.reset();
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
    // Through the respawn path, so a reset pressed while eliminated puts the
    // body back on its feet rather than leaving it face down at the spawn.
    this.respawnPlayer();
    this.player.eliminations = 0;
    cancelUse(this.channel);
    for (const { itemId } of SANDBOX_CONSUMABLES) {
      this.stock.set(itemId, blueprints().get<ConsumableBlueprint>(itemId).maxStack);
    }
    for (const bot of this.bots) this.reviveBot(bot);
    this.feed.clear();
    this.damageTaken = 0;
    this.shieldAbsorbed = 0;
    this.botShotsFired = 0;
    this.botHits = 0;

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

    this.expireTracers();
    this.feedback.update(this, performance.now());
    this.updateAvatar(delta);
    this.updateCamera();
    this.paintEdit();
    this.updateEditOverlay();
    this.updateGhost();
    this.renderer.render(this.scene, this.camera);

    this.hud.update({
      health: this.player.pool.health,
      maxHealth: this.player.pool.maxHealth,
      shield: this.player.pool.shield,
      maxShield: this.player.pool.maxShield,
      alive: this.player.alive,
      respawnSeconds: this.player.alive
        ? 0
        : Math.max(0, (this.player.respawnAtTick - this.tick) / TICK_RATE),
      eliminations: this.player.eliminations,
      hurt: now < this.damageFlashUntilMs,
      feed: [...this.feed.visible(this.tick, FEED_SECONDS * TICK_RATE)],
      channelLabel: this.channel.active
        ? blueprints().get<ConsumableBlueprint>(this.channel.itemId).displayName
        : "",
      channelFraction: channelFraction(this.channel, this.tick),
      consumables: SANDBOX_CONSUMABLES.map(({ itemId, label }) => ({
        id: itemId,
        key: label,
        name: blueprints().get<ConsumableBlueprint>(itemId).displayName,
        count: this.stock.get(itemId) ?? 0,
      })),
      materials: this.world.wallet(PLAYER_ID).snapshot(),
      selectedMaterialId: this.selectedMaterialId,
      selectedPieceId: this.selectedPieceId,
      buildMode: this.buildMode,
      pieceCount: this.world.structure.count,
      fps: this.fps,
      lastMessage: this.tick < this.messageUntil ? this.message : "",
      ...this.weaponHud(),
    });
  }

  private simulate(): void {
    this.tickRespawns();

    // Eliminated players do not act. Gravity still applies, so a body dropped
    // in mid-air lands rather than hanging there.
    const dead = !this.player.alive;

    let flags: number = MoveFlags.None;
    if (!dead) {
      if (this.jumpQueued) flags |= MoveFlags.Jump;
      if (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")) flags |= MoveFlags.Sprint;
      if (this.keys.has("ControlLeft") || this.keys.has("KeyV")) flags |= MoveFlags.Crouch;
    }

    const forward = dead ? 0 : (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
    const strafe = dead ? 0 : (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);

    const command = moveCommand(
      this.tick, vec2(strafe, forward), this.lookDelta, flags, TICK_DELTA,
    );
    this.lookDelta = vec2();
    this.jumpQueued = false;

    const stepped = stepMotor(this.motor, command, blueprints().movement("movement.default"), this.collision);
    this.motor = stepped.state;

    if (stepped.result.fallDamage > 0) {
      // Through the pool rather than straight at the health field: a fall that
      // takes the last of it is an elimination like any other, and the only
      // difference from a bullet is that it ignores shield (movement.md 5).
      const outcome = damageHealthDirectly(
        this.player, stepped.result.fallDamage, this.tick,
        PLAYER_RESPAWN_SECONDS * TICK_RATE,
      );
      this.onPlayerDamaged(outcome.toHealth);
      this.say(`fall damage ${Math.round(stepped.result.fallDamage)}`);
      if (outcome.eliminated) this.eliminatePlayer("the fall", "");
    }

    // The eye, not the feet: build range is measured from where the player
    // is looking from, which is what the placement resolver uses too.
    this.world.setPlayerPosition(PLAYER_ID, this.eyePosition());
    this.world.tick(this.tick);

    // Timers advance whether or not the trigger is down: a reload finishes
    // while you run, and bloom recovers while you hold fire.
    const held = blueprints().weapon(this.heldWeaponId);
    tickWeapon(this.weaponState(), held, this.tick, TICK_DELTA);

    this.tickChannel();
    this.tickBots();

    if (dead) {
      // Still release the trigger, or the weapon believes it is held down
      // through the respawn and refuses the first shot of the next life.
      tryFire(this.weaponState(), held, this.tick, TICK_RATE, false);
      this.primaryPressed = false;
      this.tick++;
      return;
    }

    if (this.buildMode) {
      if (this.primaryPressed) this.tryPlace();
      // Releasing the trigger has to reach the weapon even in build mode, or a
      // semi-auto stays "still held" and refuses the next shot after a build.
      if (!this.primaryDown) {
        tryFire(this.weaponState(), held, this.tick, TICK_RATE, false);
      }
    } else if (held.weaponClass === "melee") {
      if (this.primaryDown || this.primaryPressed) this.trySwing();
    } else {
      // Called every tick rather than only on a press: automatic weapons keep
      // firing while the trigger is down, and tryFire owns that decision.
      this.tryShoot();
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

    if (rejection !== PlacementRejection.None) {
      this.say(rejection);
      return;
    }
    // Only on a placement that actually happened: an animation that plays on a
    // rejected input tells the player they built something when they did not.
    this.playUpperBody("upper.build");
  }

  /**
   * Fire, if the weapon will let us.
   *
   * All the decisions -- cooldown, fire mode, magazine, reload and equip
   * timers -- live in `tryFire`, which is tested headlessly and is the same
   * function a server would run. This function's whole job is to ask, and then
   * to draw the consequences.
   */
  private tryShoot(): void {
    const registry = blueprints();
    const weapon = registry.weapon(this.heldWeaponId);
    const state = this.weaponState();

    const rejection = tryFire(state, weapon, this.tick, TICK_RATE, this.primaryDown);
    if (rejection !== FireRejection.None) {
      // An empty magazine is the one rejection worth a word: the others are
      // timers the player can feel.
      if (rejection === FireRejection.MagazineEmpty) this.say("reload");
      return;
    }

    this.playUpperBody(weapon.usePoseId);
    this.shotsFired++;

    const eye = this.eyePosition();
    const aim = this.aimDirection();
    const spread = effectiveSpread(state, weapon);
    // Seeded from the tick so a predicted shot and an authoritative one agree
    // without replicating per-pellet data.
    const shotSeed = this.tick * 2654435761;

    this.shotHits.clear();
    for (let pellet = 0; pellet < Math.max(1, weapon.pelletCount); pellet++) {
      this.pelletsFired++;
      this.fireOnePellet(weapon, pelletDirection(aim, spread, shotSeed, pellet), eye);
    }
    this.flushShotFeedback();
  }

  /**
   * Turn a shot's accumulated hits into numbers and one marker.
   *
   * One marker per shot rather than per pellet: the marker confirms that the
   * shot connected, and flashing it ten times for one shell says nothing extra.
   */
  private flushShotFeedback(): void {
    if (!this.shotHits.anyHits) return;

    const now = performance.now();
    let markerKind: HitKind = "structure";
    let destroyed = false;

    for (const hit of this.shotHits.entries()) {
      this.feedback.showNumber(
        hit.amount, { x: hit.x, y: hit.y, z: hit.z }, hit.kind, hit.headshot, now,
      );
      markerKind = hit.kind;
      if (hit.destroyed) destroyed = true;
    }

    this.feedback.showMarker(markerKind, destroyed, now);
  }

  private fireOnePellet(
    weapon: { damageProfileId: string }, direction: Vec3, eye: Vec3,
  ): void {
    const registry = blueprints();
    const profile = registry.damageProfile(weapon.damageProfileId);

    // Props first: they sit in the scatter list rather than the collision
    // world, so the trace does not know about them.
    const prop = this.propAlongRay(eye, direction, SHOT_RANGE);
    const trace = this.collision.trace(eye, direction, SHOT_RANGE);
    const onBot = this.botAlongRay(eye, direction, SHOT_RANGE);

    // A bot first, when it is the nearest of the three. Structures shield the
    // thing behind them, which is the whole reason to build.
    if (
      onBot
      && onBot.hit.distance <= trace.distance
      && (!prop || onBot.hit.distance <= prop.distance)
    ) {
      this.shootBot(onBot.bot, onBot.hit, weapon);
      this.spawnTracer(eye, onBot.hit.point);
      return;
    }

    if (prop && prop.distance < trace.distance) {
      const damage = computeDamage({
        profile, targetKind: "harvestable", distanceMetres: prop.distance,
      });
      this.propHits++;
      this.damageProp(prop.prop, damage, false);
      // Recorded rather than shown: a shotgun's ten pellets are one number.
      this.shotHits.add(
        `prop:${prop.prop.point.objectId}`, "harvestable", damage, prop.point,
      );
      this.spawnTracer(eye, prop.point);
      return;
    }

    if (trace.kind === "structure" && trace.cell && trace.slot !== undefined) {
      const damage = computeDamage({
        profile, targetKind: "structure", distanceMetres: trace.distance,
      });
      this.structureHits++;
      // applyDamage says whether this hit finished the piece off. Asking the
      // structure afterwards is not the same question: by then a later pellet
      // of the same shot may have removed it, or nothing may have yet.
      const destroyed = this.world.applyDamage(trace.cell, trace.slot, damage, this.tick);
      this.shotHits.add(
        pieceKey(trace.cell, trace.slot), "structure", damage, trace.point, false, destroyed,
      );
    }
    this.spawnTracer(eye, trace.point);
  }

  /** Nearest harvestable the ray passes close enough to count as a hit. */
  // -----------------------------------------------------------------------
  // Staying alive
  // -----------------------------------------------------------------------

  /** Stand back up anything whose respawn tick has come round. */
  private tickRespawns(): void {
    if (!this.player.alive && this.tick >= this.player.respawnAtTick) this.respawnPlayer();
    for (const bot of this.bots) {
      if (readyToRespawn(bot.combatant, this.tick)) this.reviveBot(bot);
    }
  }

  private respawnPlayer(): void {
    respawnCombatant(this.player);
    this.motor = motorAtRest(this.spawnPoint);
    this.avatar.root.rotation.x = 0;
    this.say("respawned");
  }

  private reviveBot(bot: BotInstance): void {
    respawnCombatant(bot.combatant);
    resetBotState(bot.brain);
    // A fresh magazine too: a bot that came back mid-reload would stand there
    // holding an empty gun for the rest of the session.
    Object.assign(bot.weapon, freshWeaponState(blueprints().weapon(bot.blueprint.weaponId)));
    bot.avatar.root.rotation.x = 0;
    bot.shotsFired = 0;
  }

  /** Bookkeeping for a hit the player took, whatever dealt it. */
  private onPlayerDamaged(toHealth: number, toShield = 0): void {
    if (toHealth <= 0 && toShield <= 0) return;
    this.damageTaken += toHealth + toShield;
    this.shieldAbsorbed += toShield;
    this.damageFlashUntilMs = performance.now() + DAMAGE_FLASH_SECONDS * 1000;

    // Taking a hit interrupts a heal, and the item is not spent: it is
    // consumed on completion, so an interrupted heal costs time only.
    if (this.channel.active) {
      const item = blueprints().get<ConsumableBlueprint>(this.channel.itemId);
      if (interruptOnDamage(this.channel, item)) {
        this.say(`${item.displayName.toLowerCase()} interrupted`);
      }
    }
  }

  private eliminatePlayer(attackerName: string, weaponName: string): void {
    cancelUse(this.channel);
    this.feed.record(attackerName, this.player.displayName, weaponName, false, this.tick);
    this.say(`eliminated by ${attackerName}`);
  }

  /** Finish a consumable whose channel has run its course. */
  private tickChannel(): void {
    if (!this.channel.active) return;
    const item = blueprints().get<ConsumableBlueprint>(this.channel.itemId);
    const done = completeUse(this.channel, item, this.player.pool, this.tick);
    if (!done) return;

    if (done.consumed) {
      this.stock.set(item.id, Math.max(0, (this.stock.get(item.id) ?? 0) - 1));
    }
    this.say(
      done.shielded > 0
        ? `+${Math.round(done.shielded)} shield`
        : `+${Math.round(done.healed)} health`,
    );
  }

  private tryUseConsumable(itemId: string): void {
    if (!this.player.alive) return;
    const item = blueprints().get<ConsumableBlueprint>(itemId);
    const have = this.stock.get(itemId) ?? 0;

    if (beginUse(this.channel, item, this.player.pool, have, this.tick, TICK_RATE)) {
      this.say(`using ${item.displayName.toLowerCase()}`);
      return;
    }
    if (this.channel.active) return;                     // already using something
    this.say(have <= 0 ? `no ${item.displayName.toLowerCase()} left` : "nothing to restore");
  }

  // -----------------------------------------------------------------------
  // Bots
  // -----------------------------------------------------------------------

  /** Where a bot aims: the chest, not the feet and not the eyes. */
  private playerAimPoint(): Vec3 {
    const character = blueprints().character("character.default");
    return vec3(
      this.motor.position.x,
      this.motor.position.y + character.cameraHeight * 0.75,
      this.motor.position.z,
    );
  }

  private tickBots(): void {
    const registry = blueprints();
    const aimPoint = this.playerAimPoint();

    for (const bot of this.bots) {
      const weapon = registry.weapon(bot.blueprint.weaponId);
      tickWeapon(bot.weapon, weapon, this.tick, TICK_DELTA);

      // Cleared every tick, because the sight check below only runs when the
      // bot would otherwise fire: a stale true on a bot that stopped looking
      // would be a lie in the debug window and in the smoke test.
      bot.sawTarget = false;

      if (!bot.combatant.alive) {
        tryFire(bot.weapon, weapon, this.tick, TICK_RATE, false);
        continue;
      }

      const eye = bot.avatar.eyePosition();
      const dx = aimPoint.x - eye.x;
      const dy = aimPoint.y - eye.y;
      const dz = aimPoint.z - eye.z;
      const distance = Math.hypot(dx, dy, dz);
      const direction = vec3(dx / distance, dy / distance, dz / distance);

      const action = decideBot(
        bot.brain,
        bot.blueprint,
        {
          targetAlive: this.player.alive,
          distanceMetres: distance,
          // Anything solid in the way -- a wall you built, a tree you ran
          // behind. This is what makes building worth doing against them, and
          // it is a function so that a bot with nobody in range never pays for
          // the ray march.
          hasLineOfSight: () => {
            bot.sawTarget = this.clearLineTo(eye, direction, distance);
            return bot.sawTarget;
          },
        },
        this.tick,
        TICK_RATE,
      );

      // Turn to face what it is shooting at, so a bot in a fight is not firing
      // out of the side of its head.
      if (action !== "idle") bot.yaw = (Math.atan2(dx, dz) * 180) / Math.PI;

      if (action !== "fire") {
        // Releasing matters for the same reason it does for the player: a
        // semi-auto that believes the trigger is still down never fires again.
        tryFire(bot.weapon, weapon, this.tick, TICK_RATE, false);
        if (bot.weapon.ammoInMagazine <= 0) {
          tryBeginReload(bot.weapon, weapon, this.tick, TICK_RATE, SANDBOX_RESERVE_AMMO);
        }
        continue;
      }

      const rejection = tryFire(bot.weapon, weapon, this.tick, TICK_RATE, true);
      if (rejection === FireRejection.MagazineEmpty) {
        tryBeginReload(bot.weapon, weapon, this.tick, TICK_RATE, SANDBOX_RESERVE_AMMO);
        continue;
      }
      if (rejection !== FireRejection.None) continue;

      this.botShoot(bot, weapon.id, eye, direction);
    }
  }

  /** Nothing solid between two points. Terrain, structures and props all count. */
  private clearLineTo(eye: Vec3, direction: Vec3, distance: number): boolean {
    // A coarser step than a bullet uses: this asks whether a wall is in the
    // way, not exactly where, and 0.4 m cannot miss a 4 m piece.
    const trace = this.collision.trace(eye, direction, distance, 0.4);
    if (trace.kind !== "none" && trace.distance < distance) return false;
    const prop = this.propAlongRay(eye, direction, distance);
    return !prop || prop.distance >= distance;
  }

  /**
   * One bot's shot.
   *
   * It goes through the same pellet cone, the same damage formula and the same
   * structure damage the player's shots do. The only thing that makes it a bot
   * shot is where the cone's width comes from: its Blueprint's aim error on top
   * of the weapon's own spread.
   */
  private botShoot(bot: BotInstance, weaponId: string, eye: Vec3, aim: Vec3): void {
    const registry = blueprints();
    const weapon = registry.weapon(weaponId);
    const profile = registry.damageProfile(weapon.damageProfileId);
    const spread = weapon.spreadDegrees + bot.blueprint.aimErrorDegrees;
    const seed = (bot.combatant.id * 2654435761) ^ this.tick;

    bot.shotsFired++;
    this.botShotsFired++;

    for (let pellet = 0; pellet < Math.max(1, weapon.pelletCount); pellet++) {
      const direction = pelletDirection(aim, spread, seed, pellet);
      const trace = this.collision.trace(eye, direction, SHOT_RANGE);
      const onPlayer = this.avatar.trace(eye, direction, SHOT_RANGE);

      if (onPlayer && this.player.alive && onPlayer.distance <= trace.distance) {
        const split = applyHit(
          {
            profile,
            targetKind: "player",
            hitbox: onPlayer.hitbox,
            distanceMetres: onPlayer.distance,
          },
          this.player.pool.shield,
          this.player.pool.health,
        );
        const outcome = damageCombatant(
          this.player, split, bot.combatant.id, this.tick,
          PLAYER_RESPAWN_SECONDS * TICK_RATE,
        );
        this.onPlayerDamaged(outcome.toHealth, outcome.toShield);
        if (outcome.eliminated) {
          bot.combatant.eliminations++;
          this.eliminatePlayer(bot.combatant.displayName, weapon.displayName);
        }
        this.spawnTracer(eye, onPlayer.point);
        continue;
      }

      // It missed the player and met the world. A bot shooting your wall down
      // is the point: cover has to be spendable or it is just a wall.
      if (trace.kind === "structure" && trace.cell && trace.slot !== undefined) {
        const damage = computeDamage({
          profile, targetKind: "structure", distanceMetres: trace.distance,
        });
        this.world.applyDamage(trace.cell, trace.slot, damage, this.tick);
      }
      this.spawnTracer(eye, trace.point);
    }
  }

  /** The nearest live bot a ray strikes. */
  private botAlongRay(
    eye: Vec3, direction: Vec3, maxDistance: number,
  ): { bot: BotInstance; hit: HitboxHit } | undefined {
    let best: { bot: BotInstance; hit: HitboxHit } | undefined;
    for (const bot of this.bots) {
      if (!bot.combatant.alive) continue;
      const hit = bot.avatar.trace(eye, direction, maxDistance);
      if (!hit) continue;
      if (best && hit.distance >= best.hit.distance) continue;
      best = { bot, hit };
    }
    return best;
  }

  /**
   * Land one of the player's pellets on a bot.
   *
   * The hitbox comes from the part the ray actually met, so a headshot is a
   * shot that hit the head rather than a shot that was aimed high. What that is
   * worth is `damageProfile.headshotMultiplier` -- this makes no such decision.
   */
  private shootBot(bot: BotInstance, hit: HitboxHit, weapon: { damageProfileId: string }): void {
    const registry = blueprints();
    const profile = registry.damageProfile(weapon.damageProfileId);

    const split = applyHit(
      { profile, targetKind: "player", hitbox: hit.hitbox, distanceMetres: hit.distance },
      bot.combatant.pool.shield,
      bot.combatant.pool.health,
    );
    const outcome = damageCombatant(
      bot.combatant, split, PLAYER_ID, this.tick,
      bot.blueprint.respawnSeconds * TICK_RATE,
    );
    if (outcome.toShield <= 0 && outcome.toHealth <= 0) return;

    this.botHits++;
    // Being shot is what turns a bot that ignores you into one that does not,
    // however far away you were when you did it.
    provoke(bot.brain);

    const headshot = hit.hitbox?.isHead ?? false;
    this.shotHits.add(
      `bot:${bot.combatant.id}`, "player", outcome.toShield + outcome.toHealth,
      hit.point, headshot, outcome.eliminated,
    );

    if (outcome.eliminated) {
      this.player.eliminations++;
      const weaponName = registry.weapon(this.heldWeaponId).displayName;
      this.feed.record(
        this.player.displayName, bot.combatant.displayName, weaponName, headshot, this.tick,
      );
      this.say(`eliminated ${bot.combatant.displayName.toLowerCase()}`);
    }
  }

  private propAlongRay(
    eye: Vec3, direction: Vec3, maxDistance: number,
  ): { prop: PropInstance; distance: number; point: Vec3 } | undefined {
    const PROP_RADIUS = 0.9;
    let best: { prop: PropInstance; distance: number; point: Vec3 } | undefined;

    for (const prop of this.props) {
      if (prop.state.destroyed) continue;
      // Centre of mass rather than the base, or every shot would have to be
      // aimed at a tree's roots.
      const cx = prop.point.x - eye.x;
      const cy = prop.point.y + 1.4 - eye.y;
      const cz = prop.point.z - eye.z;

      const along = cx * direction.x + cy * direction.y + cz * direction.z;
      if (along <= 0 || along > maxDistance) continue;
      if (best && along >= best.distance) continue;

      const px = eye.x + direction.x * along;
      const py = eye.y + direction.y * along;
      const pz = eye.z + direction.z * along;
      const miss = Math.hypot(prop.point.x - px, prop.point.y + 1.4 - py, prop.point.z - pz);
      if (miss > PROP_RADIUS) continue;

      best = { prop, distance: along, point: { x: px, y: py, z: pz } };
    }
    return best;
  }

  /**
   * A short-lived line from the muzzle to whatever the shot met.
   *
   * Without it a hitscan weapon has no visible output at all: the damage
   * happens, the target does not obviously react, and the gun reads as broken.
   */
  private spawnTracer(from: Vec3, to: Vec3): void {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(from.x, from.y - 0.12, from.z),
      new THREE.Vector3(to.x, to.y, to.z),
    ]);
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.85 }),
    );
    this.scene.add(line);
    this.tracers.push({ line, until: performance.now() + TRACER_SECONDS * 1000 });
    while (this.tracers.length > MAX_TRACERS) this.retireTracer();
  }

  private expireTracers(): void {
    const now = performance.now();
    while (this.tracers.length > 0 && this.tracers[0]!.until <= now) this.retireTracer();
  }

  private retireTracer(): void {
    const spent = this.tracers.shift();
    if (!spent) return;
    this.scene.remove(spent.line);
    // These geometries and materials are per-shot, not shared from the art
    // library, so they are ours to dispose -- and must be, or a magazine's
    // worth of them leaks per reload.
    spent.line.geometry.dispose();
    (spent.line.material as THREE.Material).dispose();
  }

  private trySwing(): void {
    if (this.tick - this.lastPickaxeTick < PICKAXE_INTERVAL_TICKS) return;
    this.lastPickaxeTick = this.tick;

    // The swing plays whether or not it connects: a miss is still a swing, and
    // withholding the animation until a hit lands would make the pickaxe feel
    // like it fires late.
    this.playUpperBody(blueprints().weapon(this.heldWeaponId).usePoseId);

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

    this.shotHits.clear();

    if (best) {
      this.swingAtProp(best);
      this.shotHits.add(
        `prop:${best.point.objectId}`, "harvestable", PICKAXE_DAMAGE,
        { x: best.point.x, y: best.point.y + 1.4, z: best.point.z },
      );
      this.flushShotFeedback();
      return;
    }

    // Nothing to harvest: try the structure the player is looking at.
    const target = this.currentTarget();
    if (target.found && this.world.structure.isOccupied(target.cell, target.slot)) {
      // The pickaxe ignores the build ramp and always does full damage, so a
      // player can reliably remove a fresh build (building.md section 4).
      const damage = PICKAXE_DAMAGE * 5;
      const destroyed = this.world.applyDamage(target.cell, target.slot, damage, this.tick);
      this.shotHits.add(
        pieceKey(target.cell, target.slot), "structure", damage,
        slotAnchor(target.cell, target.slot), false, destroyed,
      );
      this.flushShotFeedback();
    }
  }

  private swingAtProp(prop: PropInstance): void {
    // Aim the swing at the marker: with no aiming UI in the sandbox, always
    // hitting it keeps the harvest rates matching the design targets.
    this.damageProp(prop, PICKAXE_DAMAGE, true);
  }

  /**
   * Damage a harvestable and bank what it yields.
   *
   * Shared by the pickaxe and by bullets. A shot does not get the weak-point
   * bonus: hitting the marker is a pickaxe skill, and handing it to anyone who
   * sprays a tree with an SMG would make the tool pointless.
   */
  private damageProp(prop: PropInstance, damage: number, weakPoint: boolean): void {
    const registry = blueprints();
    const blueprint = registry.harvestable(prop.blueprintId);

    const marker = weakPointFor(prop.state.objectId, prop.state.hitCount);
    const aimedAt = weakPoint ? marker : { x: marker.x + 1, y: marker.y + 1 };
    const result = harvestHit(prop.state, blueprint, damage, aimedAt);

    const material = registry.buildMaterial(blueprint.materialId);
    const gained = this.world.wallet(PLAYER_ID).add(material, result.yield);
    if (gained > 0) this.say(`+${gained} ${material.displayName.toLowerCase()}`);

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

  /**
   * World point to viewport pixels.
   *
   * Implements ScreenProjector so the feedback layer needs no three.js of its
   * own. `project` gives normalised device coordinates; anything with w behind
   * the camera comes back with z above 1, which is the reliable behind-test.
   */
  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    const point = this.projectScratch.set(x, y, z).project(this.camera);
    const width = this.renderer.domElement.clientWidth || 1;
    const height = this.renderer.domElement.clientHeight || 1;
    return {
      x: (point.x * 0.5 + 0.5) * width,
      y: (-point.y * 0.5 + 0.5) * height,
      visible: point.z < 1,
    };
  }

  /** What the HUD shows about the weapon in hand. */
  private weaponHud() {
    const weapon = blueprints().weapon(this.heldWeaponId);
    const state = this.weaponState();
    const usesAmmo = weapon.ammoType !== "none";
    return {
      weaponName: weapon.displayName,
      ammoInMagazine: usesAmmo ? state.ammoInMagazine : -1,
      magazineSize: weapon.magazineSize,
      reloading: state.isReloading,
    };
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
