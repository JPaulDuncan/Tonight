/**
 * The HUD, as a DOM overlay rather than in-scene geometry.
 *
 * GDD section 10 puts the build palette in the same screen space as the
 * inventory bar so the player's eye never has to move when switching modes;
 * that layout is reproduced here.
 */

import type { BlueprintRegistry } from "@/blueprints/registry";
import type { BuildMaterialBlueprint } from "@/blueprints/types";

export interface HudModel {
  readonly health: number;
  readonly maxHealth: number;
  readonly shield: number;
  readonly maxShield: number;
  readonly materials: Record<string, number>;
  readonly selectedMaterialId: string;
  readonly selectedPieceId: string;
  readonly buildMode: boolean;
  readonly pieceCount: number;
  readonly fps: number;
  readonly lastMessage: string;
}

const PIECE_KEYS: readonly { id: string; key: string; label: string }[] = [
  { id: "piece.wall", key: "1", label: "Wall" },
  { id: "piece.floor", key: "2", label: "Floor" },
  { id: "piece.ramp", key: "3", label: "Ramp" },
  { id: "piece.cone", key: "4", label: "Cone" },
];

const MATERIAL_KEYS: readonly { id: string; key: string }[] = [
  { id: "material.wood", key: "Z" },
  { id: "material.stone", key: "X" },
  { id: "material.metal", key: "C" },
];

export class Hud {
  private readonly root: HTMLDivElement;

  constructor(private readonly registry: BlueprintRegistry, parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "hud";
    this.root.innerHTML = `
      <div class="hud-crosshair"></div>
      <div class="hud-top-right">
        <div class="hud-stat"><span id="hud-fps">--</span> fps</div>
        <div class="hud-stat"><span id="hud-pieces">0</span> pieces</div>
      </div>
      <div class="hud-bottom-left">
        <div class="hud-bar"><div class="hud-bar-fill shield" id="hud-shield"></div></div>
        <div class="hud-bar"><div class="hud-bar-fill health" id="hud-health"></div></div>
      </div>
      <div class="hud-bottom-right">
        <div class="hud-materials" id="hud-materials"></div>
        <div class="hud-palette" id="hud-palette"></div>
      </div>
      <div class="hud-message" id="hud-message"></div>
    `;
    parent.appendChild(this.root);
  }

  update(model: HudModel): void {
    this.setWidth("hud-health", model.health / model.maxHealth);
    this.setWidth("hud-shield", model.shield / Math.max(1, model.maxShield));
    this.setText("hud-fps", String(Math.round(model.fps)));
    this.setText("hud-pieces", String(model.pieceCount));
    this.setText("hud-message", model.lastMessage);

    const materials = this.root.querySelector("#hud-materials");
    if (materials) {
      materials.innerHTML = MATERIAL_KEYS.map(({ id, key }) => {
        const material = this.registry.tryGet<BuildMaterialBlueprint>(id);
        if (!material) return "";
        const count = model.materials[id] ?? 0;
        const selected = id === model.selectedMaterialId ? " selected" : "";
        return `<div class="hud-material${selected}" style="--mat:${material.colour}">
          <span class="hud-key">${key}</span>
          <span class="hud-count">${count}</span>
        </div>`;
      }).join("");
    }

    const palette = this.root.querySelector("#hud-palette");
    if (palette) {
      palette.innerHTML = PIECE_KEYS.map(({ id, key, label }) => {
        const selected = id === model.selectedPieceId ? " selected" : "";
        const dimmed = model.buildMode ? "" : " dimmed";
        return `<div class="hud-piece${selected}${dimmed}">
          <span class="hud-key">${key}</span><span>${label}</span>
        </div>`;
      }).join("");
    }
  }

  private setWidth(id: string, fraction: number): void {
    const element = this.root.querySelector<HTMLElement>(`#${id}`);
    if (element) element.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  }

  private setText(id: string, text: string): void {
    const element = this.root.querySelector<HTMLElement>(`#${id}`);
    if (element) element.textContent = text;
  }
}
