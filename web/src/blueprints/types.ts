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

export interface CharacterBlueprint extends BlueprintBase {
  readonly movementId: string;
  readonly maxHealth: number;
  readonly maxShield: number;
  readonly cameraHeight: number;
  readonly hitboxes: readonly HitboxDefinition[];
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
  readonly stormPhases: readonly StormPhaseBlueprint[];
  readonly lighting: readonly MatchLightingBlueprint[];
  readonly matchRules: readonly MatchRulesBlueprint[];
  readonly harvestables: readonly HarvestableBlueprint[];
  readonly pois: readonly PoiBlueprint[];
  readonly maps: readonly MapBlueprint[];
}
