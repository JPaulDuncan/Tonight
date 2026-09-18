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
import { assetKey, buildPieceKey, type ArtManifest } from "@/render/assets";

const manifest = JSON.parse(
  readFileSync(new URL("../../blender/exports/manifest.json", import.meta.url), "utf8"),
) as ArtManifest;

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
