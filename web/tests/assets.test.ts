/**
 * Tests for the art manifest contract.
 *
 * These run in Node with no WebGL, so they cover the part that can be wrong
 * without a browser: whether the key every piece looks up actually exists in
 * what the generators produced. That is the coupling most likely to rot -- a
 * renamed generator output, or a Blueprint material added without a mesh --
 * and a browser test would catch it far later and far more expensively.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { blueprints, library } from "@/blueprints/library";
import { assetKey, buildPieceKey, type ArtManifest, type TextureRecord } from "@/render/assets";

const manifest = JSON.parse(
  readFileSync(new URL("../../blender/exports/manifest.json", import.meta.url), "utf8"),
) as ArtManifest & { textureCount?: number };

const keys = new Set(manifest.assets.map((a) => assetKey(a.name)));

describe("art manifest", () => {
  it("names a file for every asset", () => {
    for (const asset of manifest.assets) {
      expect(asset.file, asset.name).toMatch(/^[A-Za-z]+\/[A-Za-z0-9_]+\.glb$/);
    }
  });

  it("agrees with its own asset count", () => {
    expect(manifest.assets).toHaveLength(manifest.assetCount);
  });

  it("derives a unique key per asset", () => {
    expect(keys.size).toBe(manifest.assets.length);
  });
});

describe("asset keys", () => {
  it("drops the prefix and category", () => {
    expect(assetKey("SM_Build_Wall_Wood")).toBe("wall/wood");
    expect(assetKey("SM_Harvest_Tree_00")).toBe("tree/00");
    expect(assetKey("SM_Build_Wall_Wood_Doorway")).toBe("wall/wood/doorway");
  });

  it("matches what buildPieceKey asks for", () => {
    expect(buildPieceKey("wall", "wood")).toBe(assetKey("SM_Build_Wall_Wood"));
    expect(buildPieceKey("cone", "metal")).toBe(assetKey("SM_Build_Cone_Metal"));
  });
});

describe("every Blueprint combination has a mesh", () => {
  // The check that makes the contract real: adding a build material to
  // building.json without a generator would ship a piece that throws at
  // placement time, in a browser, on someone else's machine.
  it("covers every piece x material pair", () => {
    const missing: string[] = [];
    for (const piece of library.buildPieces) {
      for (const material of library.buildMaterials) {
        const key = buildPieceKey(piece.placement, material.materialKind);
        if (!keys.has(key)) missing.push(`${piece.id} + ${material.id} -> ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("covers every harvestable the sandbox scatters", () => {
    // scatterProps emits these two kinds; each needs at least one variant.
    for (const kind of ["tree", "rock"]) {
      const variants = [...keys].filter((k) => k.startsWith(`${kind}/`));
      expect(variants.length, `no ${kind} meshes`).toBeGreaterThan(0);
    }
  });

  it("resolves the placement of every piece through the registry", () => {
    const registry = blueprints();
    for (const piece of library.buildPieces) {
      // geometryFor reads exactly these two fields; if either stops resolving,
      // the renderer throws rather than drawing the wrong thing.
      expect(registry.buildPiece(piece.id).placement).toBe(piece.placement);
    }
    for (const material of library.buildMaterials) {
      expect(registry.buildMaterial(material.id).materialKind).toBe(material.materialKind);
    }
  });
});

describe("the manifest describes meshes the client can use", () => {
  it("reports a positive triangle count for every asset", () => {
    for (const asset of manifest.assets) {
      expect(asset.triangle_count, asset.name).toBeGreaterThan(0);
    }
  });

  it("sizes every build piece to the 4 m cell", () => {
    // A piece that does not span the cell would leave a visible seam between
    // two players' walls, which ADR-0006's shared-face rule exists to prevent.
    //
    // size_metres is in Blender axes, so [0] is width and [2] is height. Height
    // may exceed the cell by the skirt: pieces hang slightly below their cell so
    // they meet sloped terrain without a gap (units.SKIRT_DEPTH).
    const SKIRT_DEPTH = 0.35;
    for (const asset of manifest.assets.filter((a) => a.category === "build")) {
      const [width, , height] = asset.size_metres;
      expect(width, `${asset.name} width`).toBeCloseTo(4, 5);
      expect(height, `${asset.name} height`).toBeLessThanOrEqual(4 + SKIRT_DEPTH + 1e-6);
    }
  });
});

// ---------------------------------------------------------------------------
// Orientation, checked against the generated file rather than the manifest.
//
// The manifest records size, not direction, so this reads the .glb. It needs
// `npm run art` to have run; CI always does, and a local run without it skips
// with a message rather than failing for the wrong reason.
// ---------------------------------------------------------------------------

const artRoot = new URL("../public/art/", import.meta.url);

function readGlb(file: string): { json: any; bin: Buffer<ArrayBufferLike> } | undefined {
  let raw: Buffer<ArrayBufferLike>;
  try {
    raw = readFileSync(new URL(file, artRoot));
  } catch {
    return undefined;
  }
  let offset = 12;
  let json: any;
  let bin: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (offset < raw.length) {
    const length = raw.readUInt32LE(offset);
    const kind = raw.readUInt32LE(offset + 4);
    const body = raw.subarray(offset + 8, offset + 8 + length);
    if (kind === 0x4e4f534a) json = JSON.parse(body.toString("utf8"));
    else bin = body;
    offset += 8 + length;
  }
  return { json, bin };
}

/** Every POSITION in a glb, as [x, y, z] triples in glTF axes. */
function positionsOf(glb: { json: any; bin: Buffer<ArrayBufferLike> }): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const primitive of glb.json.meshes[0].primitives) {
    const accessor = glb.json.accessors[primitive.attributes.POSITION];
    const view = glb.json.bufferViews[accessor.bufferView];
    for (let i = 0; i < accessor.count; i++) {
      const at = view.byteOffset + i * 12;
      out.push([glb.bin.readFloatLE(at), glb.bin.readFloatLE(at + 4), glb.bin.readFloatLE(at + 8)]);
    }
  }
  return out;
}

const artGenerated = readGlb("Build/SM_Build_Ramp_Wood.glb") !== undefined;

describe.skipIf(!artGenerated)("generated meshes agree with the collision model", () => {
  it("has a ramp that rises the way surfaceHeight walks", () => {
    const glb = readGlb("Build/SM_Build_Ramp_Wood.glb")!;

    // collision.ts: surfaceHeight returns base.y + localZ / CELL_SIZE * CELL_SIZE
    // for a ramp, so the walkable surface is highest at the +Z edge of the cell.
    // A mesh whose high edge is at -Z is walkable from the end it descends to.
    const positions = positionsOf(glb);
    const peak = Math.max(...positions.map((p) => p[1]));
    const topEdgeZ = new Set(
      positions.filter((p) => p[1] > peak - 0.01).map((p) => Number(p[2].toFixed(3))),
    );
    expect([...topEdgeZ]).toEqual([2]);
  });

  it("authors build pieces with their base at the cell floor", () => {
    // sandbox.meshOrigin places pieces against the cell floor, not the slot
    // anchor's mid-height. A mesh centred on its own origin would float 2 m.
    const glb = readGlb("Build/SM_Build_Wall_Wood.glb")!;

    const ys = positionsOf(glb).map((p) => p[1]);
    expect(Math.max(...ys)).toBeCloseTo(4, 3);
    expect(Math.min(...ys)).toBeLessThanOrEqual(0);
    expect(Math.min(...ys)).toBeGreaterThan(-0.5); // the skirt, and no more
  });
});

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

const textureNames = new Set((manifest.textures ?? []).map((t) => t.name));

describe("textures", () => {
  it("ships some", () => {
    expect(textureNames.size).toBeGreaterThan(0);
    expect(manifest.textures).toHaveLength(manifest.textureCount ?? -1);
  });

  it("names a file for every texture", () => {
    for (const texture of manifest.textures ?? []) {
      expect(texture.file, texture.name).toMatch(/^Textures\/T_[A-Za-z0-9_]+\.png$/);
    }
  });

  it("gives every build material a texture that exists", () => {
    // The Blueprint names the texture, so a typo here is a wall that silently
    // renders as flat colour. Cheap to catch, invisible otherwise.
    const missing: string[] = [];
    for (const material of library.buildMaterials) {
      if (!material.texture) missing.push(`${material.id} names no texture`);
      else if (!textureNames.has(material.texture)) {
        missing.push(`${material.id} -> ${material.texture}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("gives every character part a texture that exists", () => {
    const missing: string[] = [];
    for (const character of library.characters) {
      for (const [part, texture] of Object.entries(character.partTextures ?? {})) {
        if (!textureNames.has(texture)) missing.push(`${character.id}.${part} -> ${texture}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("gives every harvestable part texture a texture that exists", () => {
    const missing: string[] = [];
    for (const harvestable of library.harvestables) {
      for (const [part, texture] of Object.entries(harvestable.partTextures ?? {})) {
        if (!textureNames.has(texture)) missing.push(`${harvestable.id}.${part} -> ${texture}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("uses a power-of-two size, so the GPU can mipmap it", () => {
    // A non-power-of-two texture with RepeatWrapping is a WebGL error, not a
    // blurry texture: it renders black.
    for (const texture of manifest.textures ?? []) {
      const size = texture.size_pixels;
      expect(size & (size - 1), `${texture.name} is ${size}px`).toBe(0);
    }
  });
});

describe("character articulation", () => {
  it("exports a pivot for every part the locomotion drives", () => {
    // Without a pivot a limb rotates about the character's feet, which looks
    // like the leg detaching and swinging from the floor. The check has to be
    // here because the pivot is in the .glb, not in the manifest.
    const glb = readGlb("Characters/SM_Character_Default.glb");
    if (!glb) return;

    const pivots = new Map<string, number[]>();
    for (const primitive of glb.json.meshes[0].primitives) {
      const extras = primitive.extras ?? {};
      if (extras.pivot) pivots.set(extras.group, extras.pivot);
    }

    const locomotion = blueprints().locomotion("locomotion.default");
    for (const track of [...locomotion.cycle, ...locomotion.airborne, ...locomotion.crouched]) {
      expect(pivots.has(track.part), `no pivot for ${track.part}`).toBe(true);
    }
  });

  it("puts the hips below the shoulders", () => {
    // A cheap sanity check on the joint positions: if these were swapped the
    // arms would swing from the hips and the legs from the chest.
    const glb = readGlb("Characters/SM_Character_Default.glb");
    if (!glb) return;

    const pivot = (group: string) =>
      glb.json.meshes[0].primitives.find((p: any) => p.extras?.group === group)?.extras.pivot;

    expect(pivot("LegLeft")[1]).toBeLessThan(pivot("ArmLeft")[1]);
    expect(pivot("Head")[1]).toBeGreaterThan(pivot("ArmLeft")[1]);
  });

  it("mirrors the left and right joints", () => {
    const glb = readGlb("Characters/SM_Character_Default.glb");
    if (!glb) return;
    const pivot = (group: string) =>
      glb.json.meshes[0].primitives.find((p: any) => p.extras?.group === group)?.extras.pivot;

    expect(pivot("LegLeft")[0]).toBeCloseTo(-pivot("LegRight")[0], 6);
    expect(pivot("ArmLeft")[0]).toBeCloseTo(-pivot("ArmRight")[0], 6);
  });
});
