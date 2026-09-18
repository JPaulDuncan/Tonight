/**
 * Blueprint schema.
 *
 * A Blueprint is a piece of game content authored as **data**, not code. In the
 * Unity version these were ScriptableObject assets; here they are plain JSON in
 * `web/data/`, which is strictly better for the contract:
 *
 * - diffable in review, with no binary or YAML-with-GUIDs layer
 * - no `.meta` files and no identity that breaks on rename
 * - loadable by the headless server and the browser client from one source
 *
 * The contract itself is unchanged and is the project's central rule:
 * **adding content to a finished system must require zero code changes.**
 * See docs/blueprints/README.md.
 */

import type { IntRange } from "@/core/rng";

/** Every Blueprint carries these. */
export interface BlueprintBase {
  /** Stable identity. Referenced by id everywhere; never derived from a filename. */
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly tags?: readonly string[];
}

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

export type WeaponClass = "assaultRifle" | "shotgun" | "smg" | "sniper" | "pistol" | "melee";
export type FireMode = "auto" | "semi" | "burst" | "boltAction";
export type AmmoType = "none" | "light" | "medium" | "heavy" | "shell";

export interface DamageProfileBlueprint extends BlueprintBase {
  /** Damage per bullet OR per pellet, before any multiplier. */
  readonly baseDamage: number;
  readonly headshotMultiplier: number;
  /**
   * Applied to build pieces. This is what lets an SMG shred builds without
   * shredding players (GDD 5.5).
   */
  readonly structureMultiplier: number;
  readonly falloffStartMetres: number;
  readonly falloffEndMetres: number;
  readonly falloffEndDamageScale: number;
  /** 0 = shield absorbs first (normal). 1 = damage bypasses shield entirely. */
  readonly shieldPenetration: number;
}

export interface RecoilProfileBlueprint extends BlueprintBase {
  readonly verticalKickDegrees: number;
  readonly horizontalKickDegrees: number;
  /** Fixed pattern as [horizontal, vertical] per shot; when non-empty it replaces random kick. */
  readonly pattern: readonly (readonly [number, number])[];
  readonly recoveryPerSecond: number;
  readonly recoveryDelaySeconds: number;
}

export interface RarityBlueprint extends BlueprintBase {
  /** 0 = Common ... 4 = Legendary. Unique across all rarity blueprints. */
  readonly tier: number;
  /** Hex colour for UI tint and world-drop glow. */
  readonly colour: string;
  /** Rarity multiplies damage ONLY, so a Common AR stays viable. */
  readonly damageMultiplier: number;
  readonly lootWeight: number;
}

export interface ItemBlueprintBase extends BlueprintBase {
  readonly icon?: string;
  /** 1 means the item occupies a slot on its own. */
  readonly maxStack: number;
}

export interface WeaponBlueprint extends ItemBlueprintBase {
  readonly kind: "weapon";
  readonly weaponClass: WeaponClass;
  readonly damageProfileId: string;
  readonly recoilProfileId?: string;
  readonly fireMode: FireMode;
  readonly burstCount: number;
  readonly fireRateRpm: number;
  readonly magazineSize: number;
  readonly reloadSeconds: number;
  readonly equipSeconds: number;
  /** Above 1 makes this a shotgun. There is no shotgun code path. */
  readonly pelletCount: number;
  readonly spreadDegrees: number;
  readonly bloomPerShot: number;
  readonly bloomMaxDegrees: number;
  readonly bloomRecoveryPerSecond: number;
  readonly firstShotAccurate: boolean;
  readonly isProjectile: boolean;
  readonly projectileSpeed: number;
  readonly projectileGravityScale: number;
  readonly ammoType: AmmoType;
  readonly adsFovMultiplier: number;
  readonly adsTimeSeconds: number;
  /** Character socket this weapon is held at, e.g. `GripRight`. */
  readonly attachSocket?: string;
  /** Upper-body clip while simply holding it. */
  readonly carryPoseId?: string;
  /** Upper-body clip played when it is used. */
  readonly usePoseId?: string;
  /** Texture asset name per part role, e.g. `{ Barrel: "T_Weapon_Metal" }`. */
  readonly partTextures?: Readonly<Record<string, string>>;
}

export interface ConsumableBlueprint extends ItemBlueprintBase {
  readonly kind: "consumable";
  readonly healthRestored: number;
  readonly shieldRestored: number;
  /** Bandages cap below max; that cap is what makes it a decision, not a duration. */
  readonly healthCap: number;
  readonly useSeconds: number;
  readonly consumedOnUse: boolean;
  readonly cancelOnDamage: boolean;
}

export type ItemBlueprint = WeaponBlueprint | ConsumableBlueprint;

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

export type BuildMaterialKind = "wood" | "stone" | "metal";
export type BuildPlacementKind = "wall" | "floor" | "ramp" | "cone";
export type SlotOccupancy = "face" | "interior";

export interface BuildMaterialBlueprint extends BlueprintBase {
  readonly materialKind: BuildMaterialKind;
  /** HP at the instant of placement. */
  readonly buildHealth: number;
  /** HP once the ramp completes. */
  readonly fullHealth: number;
  readonly buildTimeSeconds: number;
  readonly costPerPiece: number;
  readonly maxCarried: number;
  readonly colour: string;
  /** Texture asset name, e.g. `T_Build_Wood`. Tints by `colour`. */
  readonly texture?: string;
}

/**
 * A variant produced by editing a placed piece.
 *
 * The 3x3 mask is why new edit shapes are data, not code. A doorway is
 * [1,1,1, 1,0,1, 1,0,1]; a window is [1,1,1, 1,0,1, 1,1,1]. Index 0 is the
 * TOP-left, matching how a designer reads the grid.
 */
export interface EditVariant {
  readonly variantName: string;
  /** Nine entries, row-major, top-left first. false = that sub-cell is cut away. */
  readonly gridMask: readonly boolean[];
  /** Variants with holes may be weaker than the solid piece. */
  readonly healthScale: number;
}

export interface BuildPieceBlueprint extends BlueprintBase {
  readonly placement: BuildPlacementKind;
  readonly occupancy: SlotOccupancy;
  /** -1 uses the material's costPerPiece. */
  readonly costOverride: number;
  readonly editVariants: readonly EditVariant[];
}

// ---------------------------------------------------------------------------
// Loot
// ---------------------------------------------------------------------------

export type LootEntryKind = "item" | "table" | "nothing";

export interface LootEntry {
  readonly kind: LootEntryKind;
  readonly itemId?: string;
  readonly tableId?: string;
  readonly weight: number;
  readonly countRange: IntRange;
  /** Forces a rarity tier. Supply drops use this. */
  readonly rarityOverrideId?: string;
}

export interface LootTableBlueprint extends BlueprintBase {
  readonly entries: readonly LootEntry[];
  readonly rollCount: IntRange;
  readonly allowDuplicates: boolean;
  /** Shifts every rolled rarity up by this many tiers. Chests use 1. */
  readonly rarityBias: number;
}

// ---------------------------------------------------------------------------
// Character
// ---------------------------------------------------------------------------

export interface MovementBlueprint extends BlueprintBase {
  readonly walkSpeed: number;
  readonly sprintSpeed: number;
  readonly crouchSpeed: number;
  readonly acceleration: number;
  readonly deceleration: number;
  readonly airControl: number;
  /** Apex height in metres. */
  readonly jumpHeight: number;
  /** Negative. Exaggerated past -9.81 because airborne time is time not building. */
  readonly gravity: number;
  readonly terminalVelocity: number;
  readonly fallDamageThreshold: number;
  readonly fallDamagePerMetre: number;
  /** Far below the 4 m cell size, so build pieces can never be mantled. */
  readonly mantleMaxHeight: number;
  readonly mantleSeconds: number;
  readonly standHeight: number;
  readonly crouchHeight: number;
}

export interface HitboxDefinition {
  readonly name: string;
  readonly isHead: boolean;
  readonly damageScale: number;
}

/** Which local axis a part rotates about. */
export type PoseAxis = "x" | "y" | "z";

/** One part's contribution to the looping walk cycle. */
export interface CycleTrack {
  /** The part role the generator emits, e.g. `LegLeft`. */
  readonly part: string;
  readonly axis: PoseAxis;
  readonly amplitudeDegrees: number;
  /** Where in the cycle this part peaks, 0..1. Legs sit half a cycle apart. */
  readonly phase: number;
}

/** A fixed rotation applied while a state holds. */
export interface PoseTrack {
  readonly part: string;
  readonly axis: PoseAxis;
  readonly degrees: number;
}

/**
 * A walk cycle, authored as data.
 *
 * Hardcoding a sine wave per limb in TypeScript would be exactly the thing
 * CLAUDE.md's one rule forbids: retiming the walk, or giving a future character
 * a different gait, would be a code change. It is a Blueprint instead.
 */
export interface LocomotionBlueprint extends BlueprintBase {
  /**
   * Metres of travel per full cycle.
   *
   * The phase advances with **distance**, not time, so the feet keep pace with
   * the ground however fast the player is going. Driving it from a clock is
   * what makes a character skate.
   */
  readonly strideMetres: number;
  /** Vertical bob at the peak of each step. */
  readonly bobMetres: number;
  /** Forward lean per m/s of speed, so a sprint reads as effort. */
  readonly leanDegreesPerMetrePerSecond: number;
  readonly maxLeanDegrees: number;
  /** Speed at which the cycle reaches full amplitude, so a creep does not flail. */
  readonly blendInMetresPerSecond: number;
  readonly cycle: readonly CycleTrack[];
  readonly airborne: readonly PoseTrack[];
  readonly crouched: readonly PoseTrack[];
}

/** One moment in an upper-body animation. */
export interface PoseKeyframe {
  /** Normalised time within the clip, 0..1. */
  readonly time: number;
  readonly pose: readonly PoseTrack[];
}

/**
 * An upper-body clip, layered over locomotion.
 *
 * Masked rather than full-body: the legs keep walking while the arms swing a
 * pickaxe, which is what lets one locomotion cycle serve every action instead
 * of needing a walk-and-swing, a run-and-swing and a crouch-and-swing.
 *
 * Timed rather than distance-driven, unlike the walk: a swing takes as long as
 * it takes however fast its owner is moving.
 */
export interface UpperBodyBlueprint extends BlueprintBase {
  /** Parts this clip owns. Everything else stays on the locomotion layer. */
  readonly mask: readonly string[];
  /** Seconds for one play. Zero means a static pose that never advances. */
  readonly durationSeconds: number;
  readonly loop: boolean;
  readonly keyframes: readonly PoseKeyframe[];
}

export interface CharacterBlueprint extends BlueprintBase {
  readonly movementId: string;
  readonly maxHealth: number;
  readonly maxShield: number;
  readonly cameraHeight: number;
  readonly hitboxes: readonly HitboxDefinition[];
  readonly locomotionId: string;
  /** Texture asset name per part role, keyed as the generator names them. */
  readonly partTextures?: Readonly<Record<string, string>>;
}

/**
 * A stand-in opponent.
 *
 * Until netcode lands there is nobody to fight, which leaves health, shields
 * and elimination untestable in play: the storm and a fall both bypass shield
 * by design, so without something shooting back a shield potion is decoration.
 * A bot is the smallest thing that makes those systems real, and every number
 * it fights by is here rather than in code -- a harder opponent is an edited
 * Blueprint, not an edited class.
 */
export interface BotBlueprint extends BlueprintBase {
  /** The character it wears: health, hitboxes and mesh all come from there. */
  readonly characterId: string;
  readonly weaponId: string;
  /** Shield it spawns with. Its health comes from the character. */
  readonly startingShield: number;
  /** It opens fire on a player this close with a clear line. 0 never does. */
  readonly engageRangeMetres: number;
  /** Delay between seeing a target and firing. Zero is a machine, not a player. */
  readonly reactionSeconds: number;
  /**
   * Trigger discipline, in seconds between pulls.
   *
   * Separate from the weapon's fire rate: a bot holding the trigger of a 600
   * rpm rifle is not a difficulty setting, it is a wood chipper.
   */
  readonly secondsBetweenShots: number;
  /** Cone half-angle its aim wanders inside. Its only source of inaccuracy. */
  readonly aimErrorDegrees: number;
  /** Seconds from elimination to standing back up. */
  readonly respawnSeconds: number;
  /** Shoots back at whoever hit it, whatever the engage range says. */
  readonly retaliates: boolean;
}

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------

export interface StormPhaseBlueprint extends BlueprintBase {
  readonly phaseIndex: number;
  readonly waitSeconds: number;
  readonly closeSeconds: number;
  readonly startRadius: number;
  readonly endRadius: number;
  /** Applied every second outside the boundary. Ignores shield: the storm is a clock. */
  readonly damagePerSecond: number;
  /** 0 = purely random inside the previous circle, 1 = the survivors' centroid. */
  readonly centreBiasToPlayers: number;
  /** -1 auto-computes from sprint speed * closeSeconds * 1.1. */
  readonly maxRotationDistance: number;
}

export interface LightingKeyframe {
  readonly phaseIndex: number;
  readonly sunColour: string;
  readonly sunIntensity: number;
  readonly fogColour: string;
  readonly fogDensity: number;
  /** Sun elevation in degrees. Negative is below the horizon. */
  readonly sunElevationDegrees: number;
}

export interface MatchLightingBlueprint extends BlueprintBase {
  readonly keyframesByPhase: readonly LightingKeyframe[];
  /**
   * Floor under character rim lighting. A zero here is what would turn deep
   * night into an accidental stealth mechanic, which the GDD forbids.
   */
  readonly minPlayerRimIntensity: number;
}

export interface MatchRulesBlueprint extends BlueprintBase {
  readonly squadSize: number;
  readonly maxPlayers: number;
  readonly allowDbno: boolean;
  readonly dbnoHealth: number;
  readonly dbnoBleedPerSecond: number;
  readonly reviveSeconds: number;
  readonly stormPhaseIds: readonly string[];
  readonly lightingId: string;
  readonly busSeconds: number;
  readonly gliderDeployAltitude: number;
  readonly startingLoadoutIds: readonly string[];
  readonly friendlyFire: boolean;
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

export interface HarvestableBlueprint extends BlueprintBase {
  readonly materialId: string;
  readonly totalHealth: number;
  readonly yieldPerHit: number;
  readonly bonusYieldOnWeakPoint: number;
  readonly yieldOnDestroy: number;
  /** -1 = never respawns, the match-long default. */
  readonly respawnSeconds: number;
  /** Texture asset name per part role, e.g. `{ Trunk: "T_Harvest_Bark" }`. */
  readonly partTextures?: Readonly<Record<string, string>>;
}

export type PoiTier = "major" | "minor" | "landmark";

export interface PoiBlueprint extends BlueprintBase {
  readonly tier: PoiTier;
  readonly chestSpawnPoints: number;
  readonly chestSpawnChance: number;
  readonly floorLootCount: IntRange;
  readonly chestTableId: string;
  readonly floorTableId: string;
}

export interface MapBlueprint extends BlueprintBase {
  readonly poiIds: readonly string[];
  readonly sizeMetres: number;
  readonly maxPoiSeparation: number;
  readonly maxBuildableSlope: number;
  readonly minOpenTerrainFraction: number;
  readonly busPathSeed: number;
}

// ---------------------------------------------------------------------------
// The whole content set
// ---------------------------------------------------------------------------

export interface BlueprintLibrary {
  readonly damageProfiles: readonly DamageProfileBlueprint[];
  readonly recoilProfiles: readonly RecoilProfileBlueprint[];
  readonly rarities: readonly RarityBlueprint[];
  readonly weapons: readonly WeaponBlueprint[];
  readonly consumables: readonly ConsumableBlueprint[];
  readonly buildMaterials: readonly BuildMaterialBlueprint[];
  readonly buildPieces: readonly BuildPieceBlueprint[];
  readonly lootTables: readonly LootTableBlueprint[];
  readonly movement: readonly MovementBlueprint[];
  readonly characters: readonly CharacterBlueprint[];
  readonly bots: readonly BotBlueprint[];
  readonly locomotion: readonly LocomotionBlueprint[];
  readonly upperBody: readonly UpperBodyBlueprint[];
  readonly stormPhases: readonly StormPhaseBlueprint[];
  readonly lighting: readonly MatchLightingBlueprint[];
  readonly matchRules: readonly MatchRulesBlueprint[];
  readonly harvestables: readonly HarvestableBlueprint[];
  readonly pois: readonly PoiBlueprint[];
  readonly maps: readonly MapBlueprint[];
}
