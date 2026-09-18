/**
 * Loot rolling and spawning.
 *
 * All rolls happen server-side, once, at spawn time. A client never rolls
 * anything that matters and nothing is re-rolled -- opening a chest is a reveal
 * of contents that already exist, not a request for new ones.
 *
 * Every draw is seeded from the match seed, so a whole match's loot is
 * reproducible from that seed. Worth more than it sounds when chasing a report
 * about one specific match.
 */

import type { BlueprintRegistry } from "@/blueprints/registry";
import type {
  ItemBlueprint,
  LootTableBlueprint,
  PoiBlueprint,
  RarityBlueprint,
  WeaponBlueprint,
} from "@/blueprints/types";
import { Rng } from "@/core/rng";

export interface RolledItem {
  readonly item: ItemBlueprint;
  readonly rarity: RarityBlueprint | undefined;
  readonly count: number;
}

/**
 * Guards against a table graph that cycles despite validation. Depth rather
 * than a visited set, because a table legitimately appearing twice in one roll
 * is fine; unbounded recursion is not.
 */
const MAX_NESTING_DEPTH = 8;

/**
 * Roll a rarity tier, shifted up by `bias` tiers. Chests use a bias of 1.
 *
 * The bias shifts the rolled TIER and then finds the rarity with that tier, so
 * the shift is meaningful regardless of list ordering, and clamps at the top.
 */
export function rollRarity(
  rarities: readonly RarityBlueprint[], bias: number, rng: Rng,
): RarityBlueprint | undefined {
  if (rarities.length === 0) return undefined;

  const index = rng.weightedPick(rarities.map((r) => r.lootWeight));
  if (index < 0) return undefined;

  const rolled = rarities[index]!;
  if (bias === 0) return rolled;

  const target = rolled.tier + bias;
  let best = rolled;
  let bestDistance = Number.MAX_SAFE_INTEGER;
  for (const candidate of rarities) {
    const distance = Math.abs(candidate.tier - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

export function rollTable(
  table: LootTableBlueprint | undefined,
  registry: BlueprintRegistry,
  rng: Rng,
  results: RolledItem[] = [],
  depth = 0,
): RolledItem[] {
  if (!table || depth >= MAX_NESTING_DEPTH || table.entries.length === 0) return results;

  const weights = table.entries.map((e) => e.weight);
  const rarities = registry.raritiesByTier;
  const rolls = rng.rangeInclusive(table.rollCount.min, table.rollCount.max);

  for (let r = 0; r < rolls; r++) {
    const index = rng.weightedPick(weights);
    // Weights sum to zero. Validation should have caught it; producing nothing
    // is the safe runtime behaviour.
    if (index < 0) return results;

    const entry = table.entries[index]!;
    if (entry.kind === "nothing") continue;

    if (entry.kind === "table") {
      rollTable(registry.tryGet<LootTableBlueprint>(entry.tableId ?? ""), registry, rng, results, depth + 1);
      continue;
    }

    const item = registry.tryGet<ItemBlueprint>(entry.itemId ?? "");
    if (!item) continue;

    const rarity = entry.rarityOverrideId
      ? registry.tryGet<RarityBlueprint>(entry.rarityOverrideId)
      : rollRarity(rarities, table.rarityBias, rng);

    // Re-roll once rather than looping: a table whose entries are nearly
    // exhausted would otherwise spin.
    if (!table.allowDuplicates && results.some((r2) => r2.item.id === item.id)) continue;

    results.push({
      item,
      rarity,
      count: rng.rangeInclusive(entry.countRange.min, entry.countRange.max),
    });
  }

  return results;
}

export type LootPlacementKind = "chest" | "floor" | "supplyDrop";

export interface LootPlacement {
  readonly kind: LootPlacementKind;
  readonly index: number;
  readonly contents: readonly RolledItem[];
}

/** Populate a POI at match start. */
export function spawnPoi(
  poi: PoiBlueprint | undefined,
  registry: BlueprintRegistry,
  matchSeed: number,
  poiIndex: number,
): LootPlacement[] {
  if (!poi) return [];

  const rng = Rng.forStream(matchSeed, poiIndex);
  const placements: LootPlacement[] = [];

  for (let point = 0; point < poi.chestSpawnPoints; point++) {
    if (rng.nextFloat() > poi.chestSpawnChance) continue;
    placements.push({
      kind: "chest",
      index: point,
      contents: rollTable(registry.tryGet<LootTableBlueprint>(poi.chestTableId), registry, rng),
    });
  }

  const floorCount = rng.rangeInclusive(poi.floorLootCount.min, poi.floorLootCount.max);
  for (let i = 0; i < floorCount; i++) {
    const contents = rollTable(registry.tryGet<LootTableBlueprint>(poi.floorTableId), registry, rng);
    if (contents.length > 0) placements.push({ kind: "floor", index: i, contents });
  }

  return placements;
}

export function countItems(placements: readonly LootPlacement[]): number {
  return placements.reduce((sum, p) => sum + p.contents.length, 0);
}

/**
 * Ammo granted alongside a rolled weapon.
 *
 * A weapon with no ammo is a disappointment rather than a decision, so picking
 * one up always comes with enough to use it.
 */
export function startingAmmoFor(weapon: WeaponBlueprint): number {
  switch (weapon.ammoType) {
    case "shell":
      return Math.max(8, weapon.magazineSize * 2);
    case "heavy":
      return Math.max(6, weapon.magazineSize * 4);
    case "none":
      return 0;
    default:
      return Math.max(30, weapon.magazineSize * 2);
  }
}
