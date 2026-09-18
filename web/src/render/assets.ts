/**
 * Loads the Blender-generated meshes the renderer draws.
 *
 * The art pipeline writes `.glb` files and a manifest into `web/public/art/`
 * (`npm run art`). This module fetches that manifest, loads the meshes it names,
 * and hands out geometry keyed by *what a piece is* rather than by asset name --
 * so adding a build material stays a Blueprint change.
 *
 * **Nothing here fails soft.** An asset that silently does not load leaves an
 * invisible-but-solid wall, which is the worst failure this project has: the
 * collision grid still says the wall is there. A missing or malformed asset
 * rejects the whole load with the name and URL, and the caller shows that rather
 * than booting into a world full of holes.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** One asset, as `tonight.export.ExportRecord` writes it. */
export interface ArtRecord {
  readonly name: string;
  readonly category: string;
  /** Path relative to the art root, e.g. `Build/SM_Build_Wall_Wood.glb`. */
  readonly file: string;
  readonly vertex_count: number;
  readonly triangle_count: number;
  readonly size_metres: readonly [number, number, number];
  readonly content_hash: string;
}

export interface ArtManifest {
  readonly version: number;
  readonly assetCount: number;
  readonly assets: readonly ArtRecord[];
}

/** One primitive of a loaded mesh, carrying the generator's part role. */
export interface ArtPart {
  /** The generator's part name with its instance suffix stripped: `Trunk`. */
  readonly group: string;
  readonly geometry: THREE.BufferGeometry;
}

/**
 * The lookup key for an asset, derived from its name.
 *
 * `SM_Build_Wall_Wood` becomes `wall/wood` and `SM_Harvest_Tree_00` becomes
 * `tree/00`. Deriving the key from the manifest rather than rebuilding the name
 * in TypeScript means a renamed generator output fails loudly at boot instead of
 * quietly missing.
 */
export function assetKey(name: string): string {
  return name.split("_").slice(2).join("/").toLowerCase();
}

export class ArtLibrary {
  private readonly parts = new Map<string, ArtPart[]>();
  private readonly merged = new Map<string, THREE.BufferGeometry>();
  private readonly byKey = new Map<string, string>();

  private constructor(readonly records: readonly ArtRecord[]) {
    for (const record of records) this.byKey.set(assetKey(record.name), record.name);
  }

  /**
   * Fetch the manifest and load every asset `wanted` accepts.
   *
   * @param baseUrl Where the art was published, e.g. `/art/`.
   * @param wanted Which records to load. The sandbox skips terrain, which it
   *   generates itself, and weapons, which nothing renders yet.
   */
  static async load(
    baseUrl: string,
    wanted: (record: ArtRecord) => boolean,
  ): Promise<ArtLibrary> {
    const manifestUrl = new URL("manifest.json", new URL(baseUrl, location.href)).href;

    const response = await fetch(manifestUrl);
    if (!response.ok) {
      throw new Error(
        `Art manifest ${manifestUrl} returned ${response.status}. ` +
          "Run: python3 blender/scripts/build_all.py --out web/public/art",
      );
    }
    const manifest = (await response.json()) as ArtManifest;

    const selected = manifest.assets.filter(wanted);
    const library = new ArtLibrary(selected);
    const loader = new GLTFLoader();

    await Promise.all(
      selected.map(async (record) => {
        const url = new URL(record.file, new URL(baseUrl, location.href)).href;
        let gltf;
        try {
          gltf = await loader.loadAsync(url);
        } catch (cause) {
          throw new Error(`Failed to load ${record.name} from ${url}: ${String(cause)}`);
        }
        library.adopt(record, gltf.scene);
      }),
    );

    return library;
  }

  private adopt(record: ArtRecord, scene: THREE.Object3D): void {
    const parts: ArtPart[] = [];
    scene.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const geometry = node.geometry as THREE.BufferGeometry;
      // The writer records the part role in the primitive's `extras`. GLTFLoader
      // puts *primitive* extras on `geometry.userData` -- node extras go on
      // `mesh.userData`, which is empty here. Falling back to the asset name
      // keeps a single-part mesh working without a special case.
      const group = (geometry.userData?.["group"] as string | undefined) ?? record.name;
      parts.push({ group, geometry });
    });

    if (parts.length === 0) {
      throw new Error(`${record.name} loaded but contained no mesh.`);
    }
    this.parts.set(record.name, parts);
  }

  has(name: string): boolean {
    return this.parts.has(name);
  }

  /** Every primitive of an asset, so a caller can give each part its own material. */
  partsOf(name: string): readonly ArtPart[] {
    const parts = this.parts.get(name);
    if (!parts) throw new Error(`Art asset '${name}' was not loaded.`);
    return parts;
  }

  /**
   * One geometry for the whole asset.
   *
   * Build pieces carry a single material, so merging their primitives turns a
   * wall's slab and its relief panels into one draw call. With thousands of
   * pieces on screen that is the difference the performance budget cares about.
   */
  geometry(name: string): THREE.BufferGeometry {
    const cached = this.merged.get(name);
    if (cached) return cached;

    const parts = this.partsOf(name);
    const first = parts[0]!.geometry;
    const geometry =
      parts.length === 1
        ? first
        : (BufferGeometryUtils.mergeGeometries(
            parts.map((p) => p.geometry),
            false,
          ) ?? first);

    this.merged.set(name, geometry);
    return geometry;
  }

  /** Resolve an asset by its derived key, e.g. `wall/wood`. */
  nameForKey(key: string): string | undefined {
    return this.byKey.get(key);
  }

  /** Every asset name whose key starts with `prefix`, sorted for determinism. */
  keysUnder(prefix: string): string[] {
    return [...this.byKey.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, name]) => name)
      .sort();
  }
}

/**
 * The asset name for a build piece.
 *
 * Built from Blueprint fields -- the piece's `placement` and the material's
 * `materialKind` -- so a new material or a new piece is content, not code. An
 * edit variant appends its name, matching how the generator names variants.
 */
export function buildPieceKey(
  placement: string,
  materialKind: string,
  variantName?: string,
): string {
  const base = `${placement}/${materialKind}`;
  return variantName ? `${base}/${variantName}` : base;
}
