/**
 * Blueprint lookup and cross-asset validation.
 *
 * Two halves, mirroring the Unity version's split between OnValidate and the CI
 * validator, but now in one place that both the browser and the tests run:
 *
 * - **Per-blueprint** checks catch a single bad asset.
 * - **Cross-asset** checks catch problems no single asset can see about itself:
 *   duplicate ids, duplicate rarity tiers, storm phase radius discontinuities,
 *   loot table reference cycles, dangling references.
 *
 * An asset can be individually valid and still wrong in the context of its
 * peers. Those are the failures this exists for.
 */

import type {
  BlueprintBase,
  BlueprintLibrary,
  BotBlueprint,
  BuildMaterialBlueprint,
  BuildPieceBlueprint,
  CharacterBlueprint,
  ConsumableBlueprint,
  DamageProfileBlueprint,
  HarvestableBlueprint,
  CycleTrack,
  ItemBlueprint,
  LocomotionBlueprint,
  LootTableBlueprint,
  MapBlueprint,
  MatchLightingBlueprint,
  MatchRulesBlueprint,
  MovementBlueprint,
  PoiBlueprint,
  RarityBlueprint,
  RecoilProfileBlueprint,
  StormPhaseBlueprint,
  UpperBodyBlueprint,
  WeaponBlueprint,
} from "./types";

export type Severity = "error" | "warning";

export interface Finding {
  readonly severity: Severity;
  readonly message: string;
  readonly subject?: string;
}

export function formatFinding(f: Finding): string {
  return `[${f.severity}] ${f.subject ? `${f.subject}: ` : ""}${f.message}`;
}

/** Indexed, validated access to the content set. */
export class BlueprintRegistry {
  private readonly byId = new Map<string, BlueprintBase>();

  constructor(readonly library: BlueprintLibrary) {
    for (const group of Object.values(library) as readonly BlueprintBase[][]) {
      for (const blueprint of group) {
        // A duplicate id makes every reference to it ambiguous. Validation
        // reports it; at runtime the first wins deterministically rather than
        // depending on load order.
        if (!this.byId.has(blueprint.id)) this.byId.set(blueprint.id, blueprint);
      }
    }
  }

  get<T extends BlueprintBase>(id: string): T {
    const found = this.byId.get(id);
    if (!found) throw new Error(`No blueprint with id '${id}'.`);
    return found as T;
  }

  tryGet<T extends BlueprintBase>(id: string): T | undefined {
    return this.byId.get(id) as T | undefined;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get count(): number {
    return this.byId.size;
  }

  weapon(id: string): WeaponBlueprint { return this.get<WeaponBlueprint>(id); }
  consumable(id: string): ConsumableBlueprint { return this.get<ConsumableBlueprint>(id); }
  damageProfile(id: string): DamageProfileBlueprint { return this.get<DamageProfileBlueprint>(id); }
  recoilProfile(id: string): RecoilProfileBlueprint { return this.get<RecoilProfileBlueprint>(id); }
  rarity(id: string): RarityBlueprint { return this.get<RarityBlueprint>(id); }
  buildMaterial(id: string): BuildMaterialBlueprint { return this.get<BuildMaterialBlueprint>(id); }
  buildPiece(id: string): BuildPieceBlueprint { return this.get<BuildPieceBlueprint>(id); }
  lootTable(id: string): LootTableBlueprint { return this.get<LootTableBlueprint>(id); }
  movement(id: string): MovementBlueprint { return this.get<MovementBlueprint>(id); }
  character(id: string): CharacterBlueprint { return this.get<CharacterBlueprint>(id); }
  bot(id: string): BotBlueprint { return this.get<BotBlueprint>(id); }
  locomotion(id: string): LocomotionBlueprint { return this.get<LocomotionBlueprint>(id); }
  upperBody(id: string): UpperBodyBlueprint { return this.get<UpperBodyBlueprint>(id); }
  stormPhase(id: string): StormPhaseBlueprint { return this.get<StormPhaseBlueprint>(id); }
  lighting(id: string): MatchLightingBlueprint { return this.get<MatchLightingBlueprint>(id); }
  matchRules(id: string): MatchRulesBlueprint { return this.get<MatchRulesBlueprint>(id); }
  harvestable(id: string): HarvestableBlueprint { return this.get<HarvestableBlueprint>(id); }
  poi(id: string): PoiBlueprint { return this.get<PoiBlueprint>(id); }
  map(id: string): MapBlueprint { return this.get<MapBlueprint>(id); }

  /** Rarities ordered by tier, as the loot roller expects. */
  get raritiesByTier(): readonly RarityBlueprint[] {
    return [...this.library.rarities].sort((a, b) => a.tier - b.tier);
  }

  item(id: string): ItemBlueprint {
    return this.get<ItemBlueprint>(id);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateLibrary(library: BlueprintLibrary): Finding[] {
  const findings: Finding[] = [];
  const error = (message: string, subject?: string) =>
    findings.push(subject === undefined ? { severity: "error", message } : { severity: "error", message, subject });
  const warn = (message: string, subject?: string) =>
    findings.push(subject === undefined ? { severity: "warning", message } : { severity: "warning", message, subject });

  const all: BlueprintBase[] = [];
  for (const group of Object.values(library) as readonly BlueprintBase[][]) all.push(...group);

  // --- identity -----------------------------------------------------------
  const seen = new Map<string, number>();
  for (const blueprint of all) {
    if (!blueprint.id || !blueprint.id.trim()) {
      error("Blueprint has an empty id.", blueprint.displayName ?? "<unnamed>");
      continue;
    }
    seen.set(blueprint.id, (seen.get(blueprint.id) ?? 0) + 1);
  }
  for (const [id, count] of seen) {
    if (count > 1) error(`Id '${id}' is claimed by ${count} blueprints. Ids must be unique.`);
  }

  const ids = new Set(all.map((b) => b.id));
  const requireRef = (ref: string | undefined, subject: string, field: string) => {
    if (ref !== undefined && !ids.has(ref)) {
      error(`${field} references '${ref}', which does not exist.`, subject);
    }
  };

  // --- damage profiles ----------------------------------------------------
  for (const p of library.damageProfiles) {
    if (p.baseDamage <= 0) error("baseDamage must be positive.", p.id);
    if (p.headshotMultiplier < 1) {
      error("headshotMultiplier below 1 makes headshots worse than body shots.", p.id);
    }
    if (p.falloffEndMetres < p.falloffStartMetres) {
      error("falloffEndMetres must be at least falloffStartMetres.", p.id);
    }
    if (p.falloffEndDamageScale < 0 || p.falloffEndDamageScale > 1) {
      error("falloffEndDamageScale must be within [0, 1].", p.id);
    }
    if (p.shieldPenetration < 0 || p.shieldPenetration > 1) {
      error("shieldPenetration must be within [0, 1].", p.id);
    }
    if (p.structureMultiplier > 3) warn("structureMultiplier above 3 will trivialise building.", p.id);
  }

  // --- rarities -----------------------------------------------------------
  const tiers = new Map<number, string[]>();
  for (const r of library.rarities) {
    if (r.damageMultiplier <= 0) error("damageMultiplier must be positive.", r.id);
    if (r.lootWeight < 0) error("lootWeight cannot be negative.", r.id);
    tiers.set(r.tier, [...(tiers.get(r.tier) ?? []), r.id]);
  }
  for (const [tier, owners] of tiers) {
    if (owners.length > 1) {
      error(`Rarity tier ${tier} is used by ${owners.length} blueprints: ${owners.join(", ")}.`);
    }
  }
  const sortedTiers = [...tiers.keys()].sort((a, b) => a - b);
  if (sortedTiers.length > 0) {
    const expected = Array.from({ length: sortedTiers.length }, (_, i) => i);
    if (sortedTiers.join() !== expected.join()) {
      warn(
        `Rarity tiers are [${sortedTiers.join(", ")}], not contiguous from 0. ` +
          "A gap makes a loot table's rarityBias skip a tier.",
      );
    }
  }

  // --- weapons ------------------------------------------------------------
  for (const w of library.weapons) {
    if (w.fireRateRpm <= 0) error("fireRateRpm must be positive.", w.id);
    if (w.magazineSize <= 0) error("magazineSize must be positive.", w.id);
    if (w.reloadSeconds <= 0) error("reloadSeconds must be positive.", w.id);
    if (w.pelletCount < 1) error("pelletCount must be at least 1.", w.id);
    if (w.fireMode === "burst" && w.burstCount < 2) {
      error("Burst weapons need a burstCount of at least 2.", w.id);
    }
    if (w.isProjectile && w.projectileSpeed <= 0) {
      error("Projectile weapons need a positive projectileSpeed.", w.id);
    }
    if (w.pelletCount > 1 && w.spreadDegrees <= 0) {
      warn("A multi-pellet weapon with zero spread fires every pellet along one line.", w.id);
    }
    if (w.spreadDegrees > 10) warn("spreadDegrees above 10 is outside the design band.", w.id);

    // Bloom that recovery outpaces is decoration: the fields are authored, the
    // code applies them, and sustained fire is still perfectly accurate. Every
    // bloom weapon shipped this way until the weapons were actually fired,
    // because nothing compared the two rates against each other.
    if (w.bloomMaxDegrees > 0) {
      const shotsPerSecond = w.fireRateRpm / 60;
      const gainedPerSecond = w.bloomPerShot * shotsPerSecond;
      if (gainedPerSecond <= w.bloomRecoveryPerSecond) {
        error(
          `Bloom can never accumulate: firing adds ${gainedPerSecond.toFixed(2)} deg/s and ` +
            `recovery removes ${w.bloomRecoveryPerSecond}. Raise bloomPerShot or lower ` +
            "bloomRecoveryPerSecond, or set bloomMaxDegrees to 0 to say it is deliberate.",
          w.id,
        );
      } else if (w.bloomPerShot <= 0) {
        error("bloomMaxDegrees is set but bloomPerShot is zero.", w.id);
      }
    }
    requireRef(w.damageProfileId, w.id, "damageProfileId");
    requireRef(w.recoilProfileId, w.id, "recoilProfileId");
  }

  // --- build materials ----------------------------------------------------
  const materialKinds = new Map<string, string[]>();
  for (const m of library.buildMaterials) {
    if (m.fullHealth < m.buildHealth) {
      error("fullHealth must be at least buildHealth, or the piece weakens as it matures.", m.id);
    }
    if (m.buildTimeSeconds <= 0) error("buildTimeSeconds must be positive.", m.id);
    if (m.costPerPiece <= 0) error("costPerPiece must be positive.", m.id);
    if (m.maxCarried < m.costPerPiece) {
      error("maxCarried below costPerPiece makes the material unusable.", m.id);
    }
    materialKinds.set(m.materialKind, [...(materialKinds.get(m.materialKind) ?? []), m.id]);
  }
  for (const [kind, owners] of materialKinds) {
    if (owners.length > 1) error(`Material kind '${kind}' is used by ${owners.join(", ")}.`);
  }

  // --- build pieces -------------------------------------------------------
  for (const p of library.buildPieces) {
    const needsInterior = p.placement === "ramp" || p.placement === "cone";
    if (needsInterior && p.occupancy !== "interior") {
      error("Ramps and cones must use interior occupancy.", p.id);
    }
    if (!needsInterior && p.occupancy !== "face") {
      error("Walls and floors must use face occupancy.", p.id);
    }

    const masks = new Set<number>();
    for (const variant of p.editVariants) {
      if (variant.gridMask.length !== 9) {
        error(`Edit variant '${variant.variantName}' needs a 9-entry grid mask.`, p.id);
        continue;
      }
      const key = packMask(variant.gridMask);
      if (masks.has(key)) {
        error(
          `Edit variant '${variant.variantName}' duplicates another variant's mask; ` +
            "only the first would ever be reachable.",
          p.id,
        );
      }
      masks.add(key);
      if (variant.healthScale <= 0) {
        error(`Edit variant '${variant.variantName}' needs a positive healthScale.`, p.id);
      }
    }
  }

  // --- loot tables --------------------------------------------------------
  const tablesById = new Map(library.lootTables.map((t) => [t.id, t]));
  for (const t of library.lootTables) {
    if (t.entries.length === 0) error("Loot table has no entries.", t.id);
    const total = t.entries.reduce((sum, e) => sum + Math.max(0, e.weight), 0);
    if (total <= 0) error("Loot table weights sum to zero; it can never produce anything.", t.id);
    if (t.rollCount.max < t.rollCount.min) error("rollCount max must be at least min.", t.id);

    for (const [index, entry] of t.entries.entries()) {
      if (entry.countRange.max < entry.countRange.min) {
        error(`Entry ${index} has an inverted count range.`, t.id);
      }
      if (entry.kind === "item") {
        if (!entry.itemId) error(`Entry ${index} is kind 'item' but has no itemId.`, t.id);
        else requireRef(entry.itemId, t.id, `entries[${index}].itemId`);
      }
      if (entry.kind === "table") {
        if (!entry.tableId) error(`Entry ${index} is kind 'table' but has no tableId.`, t.id);
        else if (entry.tableId === t.id) error(`Entry ${index} references its own table.`, t.id);
        else requireRef(entry.tableId, t.id, `entries[${index}].tableId`);
      }
      requireRef(entry.rarityOverrideId, t.id, `entries[${index}].rarityOverrideId`);
    }
  }
  findings.push(...findLootCycles(tablesById));

  // --- movement -----------------------------------------------------------
  for (const m of library.movement) {
    if (m.sprintSpeed < m.walkSpeed) error("sprintSpeed must be at least walkSpeed.", m.id);
    if (m.walkSpeed < m.crouchSpeed) error("walkSpeed must be at least crouchSpeed.", m.id);
    if (m.gravity >= 0) error("gravity must be negative.", m.id);
    if (m.jumpHeight <= 0) error("jumpHeight must be positive.", m.id);
    if (m.crouchHeight >= m.standHeight) error("crouchHeight must be below standHeight.", m.id);
    if (m.terminalVelocity <= 0) error("terminalVelocity must be positive.", m.id);
    if (m.mantleMaxHeight >= 4) {
      warn("mantleMaxHeight at or above the 4 m cell size would let players climb walls.", m.id);
    }
  }

  // --- characters ---------------------------------------------------------
  for (const c of library.characters) {
    if (c.maxHealth <= 0) error("maxHealth must be positive.", c.id);
    const heads = c.hitboxes.filter((h) => h.isHead).length;
    if (heads !== 1) error(`Character must have exactly one head hitbox; found ${heads}.`, c.id);
    requireRef(c.movementId, c.id, "movementId");
    requireRef(c.locomotionId, c.id, "locomotionId");

    // Every animated part must be a real hitbox: the generator names its parts
    // after them, so a typo here animates nothing and says nothing.
    const parts = new Set(c.hitboxes.map((h) => h.name));
    const locomotion = library.locomotion.find((l) => l.id === c.locomotionId);
    if (locomotion) {
      const tracks = [...locomotion.cycle, ...locomotion.airborne, ...locomotion.crouched];
      for (const track of tracks) {
        if (!parts.has(track.part)) {
          error(
            `Locomotion drives '${track.part}', which is not one of this character's parts.`,
            c.id,
          );
        }
      }
    }
    for (const part of Object.keys(c.partTextures ?? {})) {
      if (!parts.has(part)) {
        error(`partTextures names '${part}', which is not one of this character's parts.`, c.id);
      }
    }
    const movement = library.movement.find((m) => m.id === c.movementId);
    if (movement && c.cameraHeight >= movement.standHeight) {
      error("cameraHeight must be below the standing capsule height.", c.id);
    }
  }

  // --- bots ---------------------------------------------------------------
  //
  // A bot is difficulty expressed as data, so these checks are about it being a
  // fight rather than a formality. A bot that never fires is not an error: that
  // is what a target dummy is, and it is expressed as engageRangeMetres 0 with
  // retaliates false rather than as a second class.
  for (const b of library.bots) {
    requireRef(b.characterId, b.id, "characterId");
    requireRef(b.weaponId, b.id, "weaponId");
    if (b.startingShield < 0) error("startingShield cannot be negative.", b.id);
    if (b.engageRangeMetres < 0) error("engageRangeMetres cannot be negative.", b.id);
    if (b.reactionSeconds < 0) error("reactionSeconds cannot be negative.", b.id);
    if (b.aimErrorDegrees < 0) error("aimErrorDegrees cannot be negative.", b.id);
    if (b.respawnSeconds <= 0) {
      error("respawnSeconds must be positive, or an eliminated bot never returns.", b.id);
    }

    const character = library.characters.find((c) => c.id === b.characterId);
    if (character && b.startingShield > character.maxShield) {
      error(
        `startingShield ${b.startingShield} exceeds the character's maxShield ` +
          `${character.maxShield}, so the bot would spawn with a shield it cannot hold.`,
        b.id,
      );
    }

    const weapon = library.weapons.find((w) => w.id === b.weaponId);
    if (weapon && weapon.weaponClass === "melee") {
      // Nothing here moves a bot, so a melee bot is a scarecrow that thinks it
      // is fighting.
      error("A bot with a melee weapon can never reach anything: it does not move.", b.id);
    }
    if (weapon && b.secondsBetweenShots < 60 / weapon.fireRateRpm) {
      // Trigger discipline slower than the weapon is the point; faster than it
      // is a number that does nothing, because tryFire still owns the cooldown.
      warn(
        `secondsBetweenShots ${b.secondsBetweenShots} is shorter than the weapon's own ` +
          "fire interval, so the weapon's rate decides and this field is inert.",
        b.id,
      );
    }
  }

  // --- locomotion ---------------------------------------------------------
  //
  // A walk cycle is content, so a broken one has to fail here rather than as a
  // character standing rigid or spinning a limb through its own torso.
  for (const l of library.locomotion) {
    if (l.strideMetres <= 0) {
      error("strideMetres must be positive; the phase is driven by distance.", l.id);
    }
    if (l.blendInMetresPerSecond <= 0) {
      error("blendInMetresPerSecond must be positive, or the cycle never blends in.", l.id);
    }
    if (l.cycle.length === 0) error("A locomotion blueprint with no cycle animates nothing.", l.id);

    const seenTracks = new Set<string>();
    for (const track of l.cycle) {
      const key = `${track.part}:${track.axis}`;
      if (seenTracks.has(key)) {
        error(`Two cycle tracks drive ${key}; only the last would be visible.`, l.id);
      }
      seenTracks.add(key);
      if (track.phase < 0 || track.phase >= 1) {
        error(`Track ${key} has phase ${track.phase}; phases are within [0, 1).`, l.id);
      }
      if (Math.abs(track.amplitudeDegrees) > 90) {
        warn(`Track ${key} swings ${track.amplitudeDegrees} degrees, past a limb's range.`, l.id);
      }
    }

    // Legs that swing together is a hop, not a walk. Catching it here beats
    // catching it by watching the character.
    const legs = l.cycle.filter((t) => t.part.startsWith("Leg"));
    if (legs.length === 2) {
      const [a, b] = legs as [CycleTrack, CycleTrack];
      const separation = Math.abs(a.phase - b.phase);
      if (Math.min(separation, 1 - separation) < 0.2) {
        warn("The two legs are nearly in phase, which reads as a hop.", l.id);
      }
    }
  }

  // --- upper body ---------------------------------------------------------
  for (const u of library.upperBody) {
    if (u.mask.length === 0) {
      error("An upper-body clip with an empty mask animates nothing.", u.id);
    }
    if (u.keyframes.length === 0) error("An upper-body clip needs keyframes.", u.id);
    if (u.durationSeconds < 0) error("durationSeconds cannot be negative.", u.id);
    if (u.durationSeconds > 0 && u.keyframes.length < 2) {
      warn("A timed clip with one keyframe is a static pose; set durationSeconds to 0.", u.id);
    }

    let previous = -Infinity;
    for (const frame of u.keyframes) {
      if (frame.time < 0 || frame.time > 1) {
        error(`Keyframe time ${frame.time} is outside [0, 1].`, u.id);
      }
      if (frame.time <= previous) {
        error(`Keyframes must be ordered by time; ${frame.time} follows ${previous}.`, u.id);
      }
      previous = frame.time;

      for (const track of frame.pose) {
        if (!u.mask.includes(track.part)) {
          // A track outside the mask is silently ignored at runtime, which is
          // the worst kind of broken: the data says one thing and nothing
          // happens.
          error(`Keyframe drives '${track.part}', which is not in this clip's mask.`, u.id);
        }
      }
    }

    // A looping clip whose ends disagree snaps on the wrap.
    if (u.loop && u.keyframes.length > 1) {
      const first = u.keyframes[0]!;
      const last = u.keyframes[u.keyframes.length - 1]!;
      if (first.time === 0 && last.time === 1) {
        const key = (f: typeof first) =>
          f.pose.map((t) => `${t.part}:${t.axis}:${t.degrees}`).sort().join("|");
        if (key(first) !== key(last)) {
          warn("A looping clip's first and last keyframes differ; it will snap.", u.id);
        }
      }
    }
  }

  // --- weapons hold and use an upper-body clip ----------------------------
  for (const w of library.weapons) {
    requireRef(w.carryPoseId, w.id, "carryPoseId");
    requireRef(w.usePoseId, w.id, "usePoseId");

    // The socket has to be one the character actually offers, or the weapon
    // ends up parented to nothing and floats at the character's feet.
    const sockets = new Set(["GripRight", "GripLeft"]);
    if (w.attachSocket && !sockets.has(w.attachSocket)) {
      error(`attachSocket '${w.attachSocket}' is not a socket the character has.`, w.id);
    }
  }

  // --- storm phases -------------------------------------------------------
  //
  // Per phase only. Continuity and index uniqueness are properties of a *phase
  // list*, not of the library: storm.md section 5 promises that a faster mode
  // and a slower one are two assets, and checking those two rules across every
  // phase in the library made that impossible -- a second set restarting at
  // phaseIndex 0 read as a duplicate, and its first radius as a teleport.
  for (const p of library.stormPhases) {
    if (p.endRadius > p.startRadius) error("endRadius must not exceed startRadius.", p.id);
    if (p.startRadius <= 0) error("startRadius must be positive.", p.id);
    if (p.closeSeconds <= 0) error("closeSeconds must be positive.", p.id);
  }

  // --- lighting -----------------------------------------------------------
  for (const l of library.lighting) {
    if (l.keyframesByPhase.length === 0) error("Match lighting has no keyframes.", l.id);
    if (l.minPlayerRimIntensity <= 0) {
      error(
        "minPlayerRimIntensity must be above zero, or players become invisible in " +
          "deep night and the storm phases become a stealth mechanic.",
        l.id,
      );
    }
  }

  // --- match rules --------------------------------------------------------
  for (const r of library.matchRules) {
    if (r.squadSize < 1) error("squadSize must be at least 1.", r.id);
    if (r.maxPlayers < r.squadSize) error("maxPlayers must be at least squadSize.", r.id);
    if (r.maxPlayers % r.squadSize !== 0) {
      error("maxPlayers must divide evenly by squadSize, or the last squad is short.", r.id);
    }
    if (r.stormPhaseIds.length === 0) error("Match rules need at least one storm phase.", r.id);

    // This mode's own phases, in the order it runs them.
    const ordered = r.stormPhaseIds
      .map((id) => library.stormPhases.find((p) => p.id === id))
      .filter((p): p is StormPhaseBlueprint => p !== undefined);

    const seenPhaseIndex = new Map<number, string>();
    for (const phase of ordered) {
      const claimed = seenPhaseIndex.get(phase.phaseIndex);
      if (claimed) {
        error(
          `Phases '${claimed}' and '${phase.id}' both claim phaseIndex ${phase.phaseIndex} ` +
            "in this mode, so the lighting keyframe for it is ambiguous.",
          r.id,
        );
      }
      seenPhaseIndex.set(phase.phaseIndex, phase.id);
    }

    for (let i = 1; i < ordered.length; i++) {
      const previous = ordered[i - 1]!;
      const current = ordered[i]!;
      if (Math.abs(previous.endRadius - current.startRadius) > 0.01) {
        error(
          `Phase '${current.id}' starts at radius ${current.startRadius} m but '${previous.id}' ` +
            `ended at ${previous.endRadius} m. The circle would teleport.`,
          r.id,
        );
      }
    }
    if (r.allowDbno && r.squadSize === 1) {
      warn("DBNO is enabled on a solo mode. Legal, but nobody can revive anyone.", r.id);
    }
    requireRef(r.lightingId, r.id, "lightingId");
    for (const id of r.stormPhaseIds) requireRef(id, r.id, "stormPhaseIds");
    for (const id of r.startingLoadoutIds) requireRef(id, r.id, "startingLoadoutIds");

    const totalSeconds = ordered.reduce((sum, p) => sum + p.waitSeconds + p.closeSeconds, 0);
    const minutes = totalSeconds / 60;
    if (minutes < 6 || minutes > 22) {
      warn(
        `Storm phases total ${minutes.toFixed(1)} minutes, outside the 6-22 minute band.`,
        r.id,
      );
    }

    // Lighting must cover every phase, or the night clock stalls partway.
    const lighting = library.lighting.find((l) => l.id === r.lightingId);
    if (lighting) {
      for (const phase of ordered) {
        if (!lighting.keyframesByPhase.some((k) => k.phaseIndex === phase.phaseIndex)) {
          error(`No lighting keyframe for storm phase ${phase.phaseIndex}.`, r.lightingId);
        }
      }
    }
  }

  // --- world --------------------------------------------------------------
  for (const h of library.harvestables) {
    if (h.totalHealth <= 0) error("totalHealth must be positive.", h.id);
    if (h.yieldPerHit <= 0 && h.yieldOnDestroy <= 0) {
      error("A harvestable that yields nothing is just scenery.", h.id);
    }
    requireRef(h.materialId, h.id, "materialId");
  }

  for (const p of library.pois) {
    if (p.floorLootCount.max < p.floorLootCount.min) {
      error("floorLootCount max must be at least min.", p.id);
    }
    if (p.chestSpawnChance < 0 || p.chestSpawnChance > 1) {
      error("chestSpawnChance must be within [0, 1].", p.id);
    }
    requireRef(p.chestTableId, p.id, "chestTableId");
    requireRef(p.floorTableId, p.id, "floorTableId");
  }

  for (const m of library.maps) {
    if (m.poiIds.length === 0) error("Map has no POIs.", m.id);
    if (m.sizeMetres <= 0) error("sizeMetres must be positive.", m.id);
    for (const id of m.poiIds) requireRef(id, m.id, "poiIds");

    const majors = m.poiIds
      .map((id) => library.pois.find((p) => p.id === id))
      .filter((p) => p?.tier === "major").length;
    if (majors < 3) warn("Fewer than three major POIs gives the bus too few interesting drops.", m.id);
  }

  return findings;
}

/** Depth-first cycle detection over nested loot tables. */
function findLootCycles(tables: Map<string, LootTableBlueprint>): Finding[] {
  const findings: Finding[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const walk = (id: string, trail: readonly string[]): void => {
    if (visiting.has(id)) {
      findings.push({
        severity: "error",
        message: `Loot table reference cycle: ${[...trail, id].join(" -> ")}.`,
      });
      return;
    }
    if (visited.has(id)) return;

    visiting.add(id);
    const table = tables.get(id);
    for (const entry of table?.entries ?? []) {
      if (entry.kind === "table" && entry.tableId && tables.has(entry.tableId)) {
        walk(entry.tableId, [...trail, id]);
      }
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of [...tables.keys()].sort()) walk(id, []);
  return findings;
}

/** Pack a 3x3 mask into the low 9 bits, matching the generator's packing. */
export function packMask(mask: readonly boolean[]): number {
  let key = 0;
  for (let i = 0; i < Math.min(9, mask.length); i++) {
    if (mask[i]) key |= 1 << i;
  }
  return key;
}

export const SOLID_MASK = 0b111_111_111;
