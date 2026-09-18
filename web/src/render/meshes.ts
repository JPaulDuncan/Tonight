/**
 * Procedural three.js geometry for build pieces and props.
 *
 * Mirrors the shapes the Blender generators produce, so the sandbox looks like
 * the game will. When the glTF pipeline lands these become the fallback for a
 * missing asset rather than the primary source.
 */

import * as THREE from "three";
import { CELL_SIZE } from "@/core/grid";

const SLAB_THICKNESS = 0.24;

export function wallGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(CELL_SIZE, CELL_SIZE, SLAB_THICKNESS);
}

export function floorGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(CELL_SIZE, SLAB_THICKNESS, CELL_SIZE);
}

/** A right-triangular prism rising one cell over one cell: exactly 45 degrees. */
export function rampGeometry(): THREE.BufferGeometry {
  const half = CELL_SIZE / 2;
  const geometry = new THREE.BufferGeometry();

  const v = [
    [-half, -half, -half], [half, -half, -half], [half, -half, half], [-half, -half, half],
    [-half, half, half], [half, half, half],
  ] as const;

  const faces: readonly (readonly number[])[] = [
    [0, 3, 2], [0, 2, 1],        // bottom
    [0, 1, 5], [0, 5, 4],        // the slope
    [3, 4, 5], [3, 5, 2],        // back
    [0, 4, 3], [1, 2, 5],        // side triangles
  ];

  const positions: number[] = [];
  for (const face of faces) {
    for (const index of face) {
      const vertex = v[index]!;
      positions.push(vertex[0], vertex[1], vertex[2]);
    }
  }

  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export function coneGeometry(): THREE.BufferGeometry {
  // Four-sided so it reads as the pyramid the Blender generator makes.
  const geometry = new THREE.ConeGeometry(CELL_SIZE * 0.707, CELL_SIZE, 4);
  geometry.rotateY(Math.PI / 4);
  return geometry;
}

export function treeMesh(material: THREE.Material, foliage: THREE.Material): THREE.Group {
  const group = new THREE.Group();

  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 2.6, 6), material);
  trunk.position.y = 1.3;
  trunk.castShadow = true;
  group.add(trunk);

  // Stacked tiers, as the generator builds them.
  for (let tier = 0; tier < 3; tier++) {
    const radius = 1.5 * (1 - tier * 0.25);
    const canopy = new THREE.Mesh(new THREE.ConeGeometry(radius, 2.2, 6), foliage);
    canopy.position.y = 2.4 + tier * 1.3;
    canopy.rotation.y = tier * 0.7;
    canopy.castShadow = true;
    group.add(canopy);
  }

  return group;
}

export function rockMesh(material: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const chunks: readonly (readonly [number, number, number, number, number, number])[] = [
    [1.4, 1.0, 1.3, 0, 0.5, 0],
    [0.9, 0.7, 1.0, 0.7, 0.35, 0.4],
    [1.0, 0.6, 0.8, -0.6, 0.3, -0.3],
  ];
  for (const [w, h, d, x, y, z] of chunks) {
    const chunk = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    chunk.position.set(x, y, z);
    chunk.rotation.y = x + z;
    chunk.castShadow = true;
    group.add(chunk);
  }
  return group;
}
