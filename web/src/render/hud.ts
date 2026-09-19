/**
 * The HUD, as a DOM overlay rather than in-scene geometry.
 *
 * GDD section 10 puts the build palette in the same screen space as the
 * inventory bar so the player's eye never has to move when switching modes;
 * that layout is reproduced here.
 */

import type { BlueprintRegistry } from "@/blueprints/registry";
import type { BuildMaterialBlueprint } from "@/blueprints/types";

/** One line of the kill feed. Shaped by `EliminationFeed`, read only here. */
export interface HudFeedEntry {
  readonly attackerName: string;
  readonly victimName: string;
  readonly weaponName: string;
  readonly headshot: boolean;
}

export interface HudConsumable {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly count: number;
}

/** What the storm panel shows. */
export interface HudStorm {
  readonly phase: number;
  /** `waiting`, `closing`, or `paused`. */
  readonly state: string;
  readonly secondsRemaining: number;
  readonly outside: boolean;
  /**
   * Where safety is, in degrees clockwise from straight ahead.
   *
   * Relative to the player's facing rather than to north, because the question
   * it answers is "which way do I run", and a compass rose would make that a
   * second calculation to do while on fire.
   */
  readonly bearingDegrees: number;
}

export interface HudModel {
  readonly health: number;
  readonly maxHealth: number;
  readonly shield: number;
  readonly maxShield: number;
  readonly alive: boolean;
  /** Seconds until the player stands back up. Zero while alive. */
  readonly respawnSeconds: number;
  readonly eliminations: number;
  /** A hit landed recently: flash the edges. */
  readonly hurt: boolean;
  readonly feed: readonly HudFeedEntry[];
  /** The consumable being used, or empty. */
  readonly channelLabel: string;
  readonly channelFraction: number;
  readonly consumables: readonly HudConsumable[];
  readonly storm: HudStorm;
  readonly materials: Record<string, number>;
  readonly selectedMaterialId: string;
  readonly selectedPieceId: string;
  readonly buildMode: boolean;
  readonly pieceCount: number;
  readonly fps: number;
  readonly lastMessage: string;
  readonly weaponName: string;
  /** Rounds in the magazine, or -1 for a weapon that does not use ammo. */
  readonly ammoInMagazine: number;
  readonly magazineSize: number;
  readonly reloading: boolean;
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
        <div class="hud-stat"><span id="hud-elims">0</span> elims</div>
      </div>
      <div class="hud-weapon" id="hud-weapon">
        <span id="hud-weapon-name">--</span>
        <span class="hud-ammo" id="hud-ammo"></span>
      </div>
      <div class="hud-bottom-left">
        <div class="hud-bar">
          <div class="hud-bar-fill shield" id="hud-shield"></div>
          <span class="hud-bar-text" id="hud-shield-text"></span>
        </div>
        <div class="hud-bar">
          <div class="hud-bar-fill health" id="hud-health"></div>
          <span class="hud-bar-text" id="hud-health-text"></span>
        </div>
        <div class="hud-consumables" id="hud-consumables"></div>
        <div class="hud-channel" id="hud-channel">
          <div class="hud-channel-fill" id="hud-channel-fill"></div>
          <span class="hud-channel-label" id="hud-channel-label"></span>
        </div>
      </div>
      <div class="hud-storm-panel" id="hud-storm">
        <div class="hud-storm-line">
          <span class="hud-storm-state" id="hud-storm-state">WAITING</span>
          <span id="hud-storm-clock">0:00</span>
        </div>
        <div class="hud-storm-warning" id="hud-storm-warning">
          <span class="hud-storm-arrow" id="hud-storm-arrow">&#10148;</span> IN THE STORM
        </div>
      </div>
      <div class="hud-storm-vignette" id="hud-storm-vignette"></div>
      <div class="hud-feed" id="hud-feed"></div>
      <div class="hud-eliminated" id="hud-eliminated">
        <div class="hud-eliminated-title">ELIMINATED</div>
        <div id="hud-respawn"></div>
      </div>
      <div class="hud-hurt" id="hud-hurt"></div>
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
    // Numbers as well as bars: "how much shield do I have" is a decision about
    // whether to pop another potion, and a bar answers it only roughly.
    this.setText("hud-health-text", String(Math.ceil(model.health)));
    this.setText("hud-shield-text", String(Math.ceil(model.shield)));
    this.setDisplay("hud-eliminated", model.alive ? "none" : "block");
    this.setText("hud-respawn", `respawning in ${Math.ceil(model.respawnSeconds)}`);
    this.setOpacity("hud-hurt", model.hurt ? 1 : 0);

    this.setDisplay("hud-channel", model.channelLabel ? "block" : "none");
    if (model.channelLabel) {
      this.setWidth("hud-channel-fill", model.channelFraction);
      this.setText("hud-channel-label", model.channelLabel);
    }

    const clock = Math.max(0, Math.ceil(model.storm.secondsRemaining));
    this.setText("hud-storm-state", `PHASE ${model.storm.phase + 1} · ${model.storm.state.toUpperCase()}`);
    this.setText(
      "hud-storm-clock",
      `${Math.floor(clock / 60)}:${String(clock % 60).padStart(2, "0")}`,
    );
    this.setDisplay("hud-storm-warning", model.storm.outside ? "flex" : "none");
    this.setOpacity("hud-storm-vignette", model.storm.outside ? 1 : 0);
    const arrow = this.root.querySelector<HTMLElement>("#hud-storm-arrow");
    // The glyph points right at rest, so due-ahead is a quarter turn back.
    if (arrow) arrow.style.transform = `rotate(${model.storm.bearingDegrees - 90}deg)`;

    const feed = this.root.querySelector("#hud-feed");
    if (feed) {
      feed.innerHTML = model.feed
        .map((entry) => `<div class="hud-feed-line">
          <span class="hud-feed-name">${escapeHtml(entry.attackerName)}</span>
          <span class="hud-feed-weapon${entry.headshot ? " headshot" : ""}">${
            escapeHtml(entry.weaponName)
          }</span>
          <span class="hud-feed-name">${escapeHtml(entry.victimName)}</span>
        </div>`)
        .join("");
    }

    const consumables = this.root.querySelector("#hud-consumables");
    if (consumables) {
      consumables.innerHTML = model.consumables
        .map((item) => `<div class="hud-consumable${item.count > 0 ? "" : " empty"}"
          title="${escapeHtml(item.name)}">
          <span class="hud-key">${escapeHtml(item.key)}</span>
          <span class="hud-count">${item.count}</span>
        </div>`)
        .join("");
    }
    this.setText("hud-fps", String(Math.round(model.fps)));
    this.setText("hud-pieces", String(model.pieceCount));
    this.setText("hud-elims", String(model.eliminations));
    this.setText("hud-message", model.lastMessage);
    this.setText("hud-weapon-name", model.weaponName);
    // A melee weapon shows no counter at all rather than a zero, which would
    // read as an empty gun.
    this.setText(
      "hud-ammo",
      model.ammoInMagazine < 0
        ? ""
        : model.reloading
          ? "reloading"
          : `${model.ammoInMagazine} / ${model.magazineSize}`,
    );

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

  private setDisplay(id: string, display: string): void {
    const element = this.root.querySelector<HTMLElement>(`#${id}`);
    if (element) element.style.display = display;
  }

  private setOpacity(id: string, opacity: number): void {
    const element = this.root.querySelector<HTMLElement>(`#${id}`);
    if (element) element.style.opacity = String(opacity);
  }
}

/**
 * Names reach the feed from Blueprints rather than from players, so nothing
 * here is hostile yet -- but a kill feed is the first place a name the client
 * did not author will be rendered, and building the escape in now is cheaper
 * than remembering to add it the day names come over the wire.
 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c
  ));
}
