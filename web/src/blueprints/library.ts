/**
 * Loads the content set from `web/data/*.json`.
 *
 * The JSON is the source of truth. Unlike the Unity version there is no
 * generator step and no `.meta` sidecar: a designer edits the JSON, the
 * validator checks it, and it is in the game.
 *
 * Vite inlines these imports at build time, so the browser makes no extra
 * requests and the tests read them synchronously.
 */

import buildingData from "../../data/building.json";
import characterData from "../../data/character.json";
import combatData from "../../data/combat.json";
import lootData from "../../data/loot.json";
import matchData from "../../data/match.json";
import worldData from "../../data/world.json";

import { BlueprintRegistry, validateLibrary, type Finding } from "./registry";
import type { BlueprintLibrary } from "./types";

/**
 * The content set.
 *
 * The casts are the one place raw JSON becomes typed. They are safe because
 * {@link validateLibrary} runs over the result in a test that fails the build
 * on any mismatch -- narrowing 71 blueprints by hand would be noise without
 * adding a check the validator does not already make.
 */
export const library: BlueprintLibrary = {
  damageProfiles: combatData.damageProfiles,
  recoilProfiles: combatData.recoilProfiles,
  rarities: combatData.rarities,
  weapons: combatData.weapons,
  consumables: lootData.consumables,
  buildMaterials: buildingData.buildMaterials,
  buildPieces: buildingData.buildPieces,
  lootTables: lootData.lootTables,
  movement: characterData.movement,
  characters: characterData.characters,
  stormPhases: matchData.stormPhases,
  lighting: matchData.lighting,
  matchRules: matchData.matchRules,
  harvestables: worldData.harvestables,
  pois: worldData.pois,
  maps: worldData.maps,
} as unknown as BlueprintLibrary;

let cached: BlueprintRegistry | undefined;

/** The shared registry. Built once; Blueprints are read-only at runtime. */
export function blueprints(): BlueprintRegistry {
  cached ??= new BlueprintRegistry(library);
  return cached;
}

/** Run every validation check over the shipped content. */
export function validateShippedContent(): Finding[] {
  return validateLibrary(library);
}

/** Convenient ids for the systems that need a default. */
export const DEFAULT_IDS = {
  character: "character.default",
  movement: "movement.default",
  soloRules: "rules.solo",
  trioRules: "rules.trios",
  map: "map.nightfallIsle",
  practiceRange: "poi.practiceRange",
  wall: "piece.wall",
  floor: "piece.floor",
  ramp: "piece.ramp",
  cone: "piece.cone",
  wood: "material.wood",
  stone: "material.stone",
  metal: "material.metal",
  pickaxe: "weapon.pickaxe",
} as const;
