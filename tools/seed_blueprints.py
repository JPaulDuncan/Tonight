#!/usr/bin/env python3
"""Generate Unity ``.meta`` files and the seed Blueprint assets.

Two jobs, both reproducible from this file:

1. **Meta files.** Every script, assembly definition and folder under
   ``unity/`` gets a ``.meta`` with a GUID derived from its path. Unity would
   otherwise generate random ones on first open, which means two contributors
   get different GUIDs for the same file and every asset reference breaks
   across the pair.

2. **Seed Blueprints.** The shipped defaults from the GDD, authored as real
   ``.asset`` files. This is the design content -- every number in the GDD's
   tables -- expressed in the form the game actually reads.

Run::

    python3 tools/seed_blueprints.py
    python3 tools/seed_blueprints.py --check    # fail if anything is stale

**Art references are deliberately left unbound.** Prefabs and meshes need
Unity and Blender, neither of which CI has. Opening the project will list every
unbound reference in the Console; that list is the binding checklist, and
working through it is runbook RB-07.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from unity_yaml import (  # noqa: E402
    Colour,
    Curve,
    Enum,
    Gradient,
    LayerMask,
    Nested,
    Ref,
    guid_for,
    render_meta,
    render_scriptable_object,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
UNITY_ROOT = REPO_ROOT / "unity" / "Tonight"
ASSETS_ROOT = UNITY_ROOT / "Assets"
BLUEPRINTS_ROOT = ASSETS_ROOT / "Tonight" / "Blueprints"
SCRIPTS_ROOT = ASSETS_ROOT / "Tonight" / "Scripts"

# --------------------------------------------------------------------------
# Enum values. These mirror the declaration order in the C#; an enum's
# serialised form is its integer value, so reordering a C# enum silently
# remaps every authored asset. Keep these in step with the source.
# --------------------------------------------------------------------------

MATERIAL_WOOD, MATERIAL_STONE, MATERIAL_METAL = 0, 1, 2
PLACE_WALL, PLACE_FLOOR, PLACE_RAMP, PLACE_CONE = 0, 1, 2, 3
OCCUPANCY_FACE, OCCUPANCY_INTERIOR = 0, 1
CLASS_AR, CLASS_SHOTGUN, CLASS_SMG, CLASS_SNIPER, CLASS_PISTOL, CLASS_MELEE = range(6)
FIRE_AUTO, FIRE_SEMI, FIRE_BURST, FIRE_BOLT = range(4)
AMMO_NONE, AMMO_LIGHT, AMMO_MEDIUM, AMMO_HEAVY, AMMO_SHELL = range(5)
LOOT_ITEM, LOOT_TABLE, LOOT_NOTHING = 0, 1, 2
POI_MAJOR, POI_MINOR, POI_LANDMARK = 0, 1, 2


def script_guid(class_name: str) -> str:
    """GUID of the ``.cs`` file declaring ``class_name``."""
    matches = sorted(SCRIPTS_ROOT.rglob(f"{class_name}.cs"))
    if not matches:
        raise FileNotFoundError(
            f"No script named {class_name}.cs under {SCRIPTS_ROOT}. "
            "A Blueprint asset cannot reference a type that does not exist."
        )
    return guid_for(matches[0].relative_to(REPO_ROOT).as_posix())


def asset_path(*parts: str) -> Path:
    return BLUEPRINTS_ROOT.joinpath(*parts)


def asset_guid(path: Path) -> str:
    return guid_for(path.relative_to(REPO_ROOT).as_posix())


def asset_ref(*parts: str) -> Ref:
    """A reference to a seed asset by its path parts."""
    return Ref(asset_guid(asset_path(*parts)))


def base_fields(name: str, display: str, description: str = "", tags=()) -> dict:
    """The fields every Blueprint inherits from TonightBlueprint."""
    return {
        "_blueprintId": guid_for(f"blueprint:{name}"),
        "_displayName": display,
        "_description": description,
        "_tags": list(tags),
    }


# --------------------------------------------------------------------------
# The content
#
# Every number below traces to a table in docs/01-game-design-document.md.
# Where a value is not in the GDD it is a reasonable default that a designer is
# expected to tune -- that is the point of the assets existing.
# --------------------------------------------------------------------------


def rarities() -> list[tuple[Path, str, dict]]:
    """GDD section 5.3. Rarity multiplies damage only."""
    spec = [
        ("Common", 0, Colour(0.62, 0.62, 0.62), 1.00, 50.0),
        ("Uncommon", 1, Colour(0.36, 0.78, 0.31), 1.05, 30.0),
        ("Rare", 2, Colour(0.26, 0.52, 0.96), 1.10, 14.0),
        ("Epic", 3, Colour(0.61, 0.35, 0.91), 1.15, 5.0),
        ("Legendary", 4, Colour(0.95, 0.72, 0.20), 1.21, 1.0),
    ]
    out = []
    for key, tier, colour, multiplier, weight in spec:
        name = f"BP_Rarity_{key}"
        path = asset_path("Combat", "Rarities", f"{name}.asset")
        fields = base_fields(name, key)
        fields.update(
            {
                "_tier": tier,
                "_colour": colour,
                "_damageMultiplier": multiplier,
                "_lootWeight": weight,
            }
        )
        out.append((path, "RarityBlueprint", fields))
    return out


def damage_profiles() -> list[tuple[Path, str, dict]]:
    """GDD 5.2 and 5.5. One profile per weapon class, shared by composition."""
    spec = [
        # key,        dmg,  head, struct, fallStart, fallEnd, endScale
        ("AssaultRifle", 30.0, 2.0, 1.0, 40.0, 80.0, 0.60),
        ("Shotgun", 9.0, 2.0, 0.8, 6.0, 14.0, 0.25),  # per pellet
        ("Smg", 17.0, 2.0, 1.6, 12.0, 28.0, 0.50),
        ("Sniper", 105.0, 2.5, 1.2, 200.0, 250.0, 0.90),
        ("Pistol", 24.0, 2.0, 1.0, 22.0, 45.0, 0.55),
        ("Pickaxe", 20.0, 1.0, 1.0, 3.0, 4.0, 1.0),
    ]
    out = []
    for key, damage, head, structure, start, end, scale in spec:
        name = f"BP_Damage_{key}"
        path = asset_path("Combat", "DamageProfiles", f"{name}.asset")
        fields = base_fields(name, f"{key} damage")
        fields.update(
            {
                "_baseDamage": damage,
                "_headshotMultiplier": head,
                "_structureMultiplier": structure,
                "_falloffStartMetres": start,
                "_falloffEndMetres": end,
                "_falloffEndDamageScale": scale,
                "_shieldPenetration": 0.0,
            }
        )
        out.append((path, "DamageProfileBlueprint", fields))
    return out


def recoil_profiles() -> list[tuple[Path, str, dict]]:
    """Three shared profiles. Several weapons share one, so retuning is one edit."""
    spec = [
        ("Light", 0.35, 0.18, 10.0, 0.10),
        ("Medium", 0.60, 0.22, 8.0, 0.12),
        ("Heavy", 1.40, 0.30, 6.0, 0.18),
    ]
    out = []
    for key, vertical, horizontal, recovery, delay in spec:
        name = f"BP_Recoil_{key}"
        path = asset_path("Combat", "Recoil", f"{name}.asset")
        fields = base_fields(name, f"{key} recoil")
        fields.update(
            {
                "_verticalKickDegrees": vertical,
                "_horizontalKickDegrees": horizontal,
                "_pattern": [],
                "_recoveryPerSecond": recovery,
                "_recoveryDelaySeconds": delay,
            }
        )
        out.append((path, "RecoilProfileBlueprint", fields))
    return out


def weapons() -> list[tuple[Path, str, dict]]:
    """GDD 5.2. Note there is no rarity field and no weapon-specific flag:
    a shotgun is simply a weapon whose pellet count is above one."""
    spec = [
        dict(
            key="AssaultRifle", display="Assault Rifle", cls=CLASS_AR,
            damage="AssaultRifle", recoil="Medium", fire=FIRE_AUTO, rpm=550.0,
            mag=30, reload=2.2, pellets=1, spread=0.0, bloom=0.16, bloom_max=3.0,
            ammo=AMMO_MEDIUM, projectile=False,
        ),
        dict(
            key="Shotgun", display="Pump Shotgun", cls=CLASS_SHOTGUN,
            damage="Shotgun", recoil="Heavy", fire=FIRE_BOLT, rpm=70.0,
            mag=5, reload=3.4, pellets=10, spread=4.2, bloom=0.0, bloom_max=0.0,
            ammo=AMMO_SHELL, projectile=False,
        ),
        dict(
            key="Smg", display="SMG", cls=CLASS_SMG,
            damage="Smg", recoil="Light", fire=FIRE_AUTO, rpm=800.0,
            mag=35, reload=2.0, pellets=1, spread=0.4, bloom=0.22, bloom_max=4.5,
            ammo=AMMO_LIGHT, projectile=False,
        ),
        dict(
            key="Sniper", display="Bolt-Action Sniper", cls=CLASS_SNIPER,
            damage="Sniper", recoil="Heavy", fire=FIRE_BOLT, rpm=40.0,
            mag=1, reload=2.8, pellets=1, spread=0.0, bloom=0.0, bloom_max=0.0,
            ammo=AMMO_HEAVY, projectile=True,
        ),
        dict(
            key="Pistol", display="Pistol", cls=CLASS_PISTOL,
            damage="Pistol", recoil="Light", fire=FIRE_SEMI, rpm=300.0,
            mag=16, reload=1.6, pellets=1, spread=0.2, bloom=0.20, bloom_max=3.5,
            ammo=AMMO_LIGHT, projectile=False,
        ),
    ]
    out = []
    for entry in spec:
        name = f"BP_Weapon_{entry['key']}"
        path = asset_path("Combat", "Weapons", f"{name}.asset")
        fields = base_fields(name, entry["display"], tags=["weapon"])
        fields.update(
            {
                "_icon": Ref(),
                "_pickupPrefab": Ref(),
                "_maxStack": 1,
                "_class": Enum(entry["cls"]),
                "_prefab": Ref(),
                "_damageProfile": asset_ref(
                    "Combat", "DamageProfiles", f"BP_Damage_{entry['damage']}.asset"
                ),
                "_recoil": asset_ref(
                    "Combat", "Recoil", f"BP_Recoil_{entry['recoil']}.asset"
                ),
                "_fireMode": Enum(entry["fire"]),
                "_burstCount": 3,
                "_fireRateRpm": entry["rpm"],
                "_magazineSize": entry["mag"],
                "_reloadSeconds": entry["reload"],
                "_equipSeconds": 0.5,
                "_pelletCount": entry["pellets"],
                "_spreadDegrees": entry["spread"],
                "_bloomPerShot": entry["bloom"],
                "_bloomMaxDegrees": entry["bloom_max"],
                "_bloomRecoveryPerSecond": 4.0,
                "_firstShotAccurate": True,
                "_isProjectile": entry["projectile"],
                "_projectileSpeed": 250.0,
                "_projectileGravityScale": 0.4,
                "_ammoType": Enum(entry["ammo"]),
                "_adsFovMultiplier": 0.55 if entry["key"] == "Sniper" else 0.8,
                "_adsTimeSeconds": 0.35 if entry["key"] == "Sniper" else 0.25,
            }
        )
        out.append((path, "WeaponBlueprint", fields))
    return out


def build_materials() -> list[tuple[Path, str, dict]]:
    """GDD 4.3. The build-HP ramp here is the game's main balance lever."""
    spec = [
        ("Wood", MATERIAL_WOOD, 90.0, 150.0, 3.0, Colour(0.72, 0.51, 0.26)),
        ("Stone", MATERIAL_STONE, 90.0, 300.0, 4.0, Colour(0.58, 0.58, 0.60)),
        ("Metal", MATERIAL_METAL, 90.0, 500.0, 5.0, Colour(0.42, 0.55, 0.64)),
    ]
    out = []
    for key, kind, build_hp, full_hp, ramp, colour in spec:
        name = f"BP_BuildMat_{key}"
        path = asset_path("Building", "Materials", f"{name}.asset")
        fields = base_fields(name, key)
        fields.update(
            {
                "_materialKind": Enum(kind),
                "_buildHealth": build_hp,
                "_fullHealth": full_hp,
                "_buildTimeSeconds": ramp,
                "_costPerPiece": 10,
                "_maxCarried": 500,
                "_surfaceMaterial": Ref(),
                "_uiColour": colour,
                "_harvestSound": Ref(),
                "_buildSound": Ref(),
                "_destroySound": Ref(),
            }
        )
        out.append((path, "BuildMaterialBlueprint", fields))
    return out


def _material_mesh_entries() -> list[Nested]:
    """One (material, mesh) pair per build material, meshes unbound.

    Validation requires an entry per material, so the entries exist with the
    mesh slot empty rather than the list being short -- that way the Editor
    reports "assign this mesh" rather than "this piece is missing a material".
    """
    return [
        Nested({"Material": asset_ref("Building", "Materials", f"BP_BuildMat_{key}.asset"),
                "Mesh": Ref()})
        for key in ("Wood", "Stone", "Metal")
    ]


def build_pieces() -> list[tuple[Path, str, dict]]:
    """GDD 4.2, plus the edit variants from 4.5."""
    doorway = [True, True, True, True, False, True, True, False, True]
    window = [True, True, True, True, False, True, True, True, True]

    def variant(variant_name: str, mask: list[bool], health_scale: float) -> Nested:
        return Nested(
            {
                "_variantName": variant_name,
                "_gridMask": mask,
                "_meshByMaterial": _material_mesh_entries(),
                "_healthScale": health_scale,
            }
        )

    spec = [
        ("Wall", PLACE_WALL, OCCUPANCY_FACE, [variant("Doorway", doorway, 0.85),
                                              variant("Window", window, 0.92)]),
        ("Floor", PLACE_FLOOR, OCCUPANCY_FACE, [variant("Trapdoor", doorway, 0.85)]),
        ("Ramp", PLACE_RAMP, OCCUPANCY_INTERIOR, []),
        ("Cone", PLACE_CONE, OCCUPANCY_INTERIOR, []),
    ]

    out = []
    for key, placement, occupancy, variants in spec:
        name = f"BP_Piece_{key}"
        path = asset_path("Building", "Pieces", f"{name}.asset")
        fields = base_fields(name, key)
        fields.update(
            {
                "_placement": Enum(placement),
                "_occupancy": Enum(occupancy),
                "_meshByMaterial": _material_mesh_entries(),
                "_previewMaterial": Ref(),
                "_costOverride": -1,
                "_editVariants": variants,
                # Layer 8 is reserved for Structure in the project's layer setup.
                "_collisionLayer": LayerMask(1 << 8),
                "_buildSound": Ref(),
            }
        )
        out.append((path, "BuildPieceBlueprint", fields))
    return out


def consumables() -> list[tuple[Path, str, dict]]:
    """The HealthCap below max is what makes bandage-vs-medkit a real choice."""
    spec = [
        ("Bandage", "Bandage", 15.0, 0.0, 75.0, 3.0, 5),
        ("Medkit", "Med Kit", 100.0, 0.0, 100.0, 10.0, 3),
        ("MiniShield", "Small Shield Potion", 0.0, 25.0, 100.0, 2.0, 6),
        ("BigShield", "Shield Potion", 0.0, 50.0, 100.0, 5.0, 2),
    ]
    out = []
    for key, display, health, shield, cap, seconds, stack in spec:
        name = f"BP_Consumable_{key}"
        path = asset_path("Loot", "Consumables", f"{name}.asset")
        fields = base_fields(name, display, tags=["consumable"])
        fields.update(
            {
                "_icon": Ref(),
                "_pickupPrefab": Ref(),
                "_maxStack": stack,
                "_healthRestored": health,
                "_shieldRestored": shield,
                "_healthCap": cap,
                "_useSeconds": seconds,
                "_consumedOnUse": True,
                "_cancelOnDamage": True,
            }
        )
        out.append((path, "ConsumableBlueprint", fields))
    return out


def loot_tables() -> list[tuple[Path, str, dict]]:
    """GDD 6. Nesting is how a Chest table is composed rather than restated."""

    def entry(kind: int, ref: Ref, weight: float, lo: int = 1, hi: int = 1,
              rarity: Ref | None = None) -> Nested:
        return Nested(
            {
                "_kind": Enum(kind),
                "_item": ref if kind == LOOT_ITEM else Ref(),
                "_table": ref if kind == LOOT_TABLE else Ref(),
                "_weight": weight,
                "_countRange": Nested({"_min": lo, "_max": hi}),
                "_rarityOverride": rarity or Ref(),
            }
        )

    def weapon(key: str, weight: float) -> Nested:
        return entry(LOOT_ITEM, asset_ref("Combat", "Weapons", f"BP_Weapon_{key}.asset"), weight)

    def consumable(key: str, weight: float, lo: int, hi: int) -> Nested:
        return entry(
            LOOT_ITEM,
            asset_ref("Loot", "Consumables", f"BP_Consumable_{key}.asset"),
            weight, lo, hi,
        )

    tables = []

    tables.append((
        "BP_Loot_Weapons", "Weapon pool",
        {
            "_entries": [
                weapon("AssaultRifle", 30.0),
                weapon("Shotgun", 24.0),
                weapon("Smg", 22.0),
                weapon("Pistol", 16.0),
                weapon("Sniper", 8.0),
            ],
            "_rollCount": Nested({"_min": 1, "_max": 1}),
            "_allowDuplicates": True,
            "_rarityBias": 0,
        },
    ))

    tables.append((
        "BP_Loot_Consumables", "Consumable pool",
        {
            "_entries": [
                consumable("Bandage", 34.0, 3, 5),
                consumable("MiniShield", 30.0, 2, 3),
                consumable("Medkit", 18.0, 1, 1),
                consumable("BigShield", 18.0, 1, 2),
            ],
            "_rollCount": Nested({"_min": 1, "_max": 1}),
            "_allowDuplicates": True,
            "_rarityBias": 0,
        },
    ))

    tables.append((
        "BP_Loot_Floor", "Floor loot",
        {
            "_entries": [
                entry(LOOT_TABLE, asset_ref("Loot", "Tables", "BP_Loot_Weapons.asset"), 45.0),
                entry(LOOT_TABLE, asset_ref("Loot", "Tables", "BP_Loot_Consumables.asset"), 40.0),
                entry(LOOT_NOTHING, Ref(), 15.0),
            ],
            "_rollCount": Nested({"_min": 1, "_max": 1}),
            "_allowDuplicates": True,
            "_rarityBias": 0,
        },
    ))

    tables.append((
        "BP_Loot_Chest", "Chest",
        {
            "_entries": [
                entry(LOOT_TABLE, asset_ref("Loot", "Tables", "BP_Loot_Weapons.asset"), 55.0),
                entry(LOOT_TABLE, asset_ref("Loot", "Tables", "BP_Loot_Consumables.asset"), 45.0),
            ],
            # Chests shift the rolled rarity up one tier (GDD 6.1).
            "_rollCount": Nested({"_min": 2, "_max": 3}),
            "_allowDuplicates": False,
            "_rarityBias": 1,
        },
    ))

    tables.append((
        "BP_Loot_SupplyDrop", "Supply drop",
        {
            "_entries": [
                entry(
                    LOOT_TABLE,
                    asset_ref("Loot", "Tables", "BP_Loot_Weapons.asset"),
                    60.0,
                    rarity=asset_ref("Combat", "Rarities", "BP_Rarity_Legendary.asset"),
                ),
                entry(LOOT_TABLE, asset_ref("Loot", "Tables", "BP_Loot_Consumables.asset"), 40.0),
            ],
            "_rollCount": Nested({"_min": 3, "_max": 4}),
            "_allowDuplicates": False,
            "_rarityBias": 3,
        },
    ))

    out = []
    for name, display, extra in tables:
        path = asset_path("Loot", "Tables", f"{name}.asset")
        fields = base_fields(name, display)
        fields.update(extra)
        out.append((path, "LootTableBlueprint", fields))
    return out


#: GDD section 7, corrected so the schedule actually totals 16:40.
STORM_SCHEDULE = [
    # index, wait, close, startR, endR, dps, bias
    (0, 165.0, 120.0, 1400.0, 900.0, 1.0, 0.15),
    (1, 90.0, 90.0, 900.0, 600.0, 1.0, 0.20),
    (2, 75.0, 70.0, 600.0, 400.0, 2.0, 0.25),
    (3, 60.0, 55.0, 400.0, 250.0, 5.0, 0.30),
    (4, 45.0, 45.0, 250.0, 150.0, 7.0, 0.35),
    (5, 35.0, 35.0, 150.0, 80.0, 10.0, 0.40),
    (6, 30.0, 30.0, 80.0, 30.0, 10.0, 0.45),
    (7, 20.0, 35.0, 30.0, 0.0, 10.0, 0.50),
]


def storm_phases() -> list[tuple[Path, str, dict]]:
    out = []
    for index, wait, close, start, end, dps, bias in STORM_SCHEDULE:
        name = f"BP_Storm_Phase{index}"
        path = asset_path("Match", "Storm", f"{name}.asset")
        fields = base_fields(name, f"Storm phase {index}")
        fields.update(
            {
                "_phaseIndex": index,
                "_waitSeconds": wait,
                "_closeSeconds": close,
                "_startRadius": start,
                "_endRadius": end,
                "_damagePerSecond": dps,
                "_centreBiasToPlayers": bias,
                # -1 auto-computes the fairness clamp from sprint speed.
                "_maxRotationDistance": -1.0,
            }
        )
        out.append((path, "StormPhaseBlueprint", fields))
    return out


def match_lighting() -> list[tuple[Path, str, dict]]:
    """GDD 1.2: dusk to sunrise, driven by storm phase."""
    keyframes = [
        # phase, sun colour, intensity, fog colour, fog density
        (0, Colour(1.00, 0.76, 0.52), 1.10, Colour(0.55, 0.45, 0.42), 0.006),
        (1, Colour(0.70, 0.66, 0.85), 0.55, Colour(0.32, 0.31, 0.45), 0.010),
        (2, Colour(0.52, 0.55, 0.85), 0.35, Colour(0.22, 0.23, 0.38), 0.013),
        (3, Colour(0.38, 0.44, 0.78), 0.18, Colour(0.12, 0.14, 0.26), 0.017),
        (4, Colour(0.36, 0.42, 0.76), 0.16, Colour(0.10, 0.12, 0.24), 0.018),
        (5, Colour(0.48, 0.48, 0.74), 0.26, Colour(0.16, 0.17, 0.30), 0.015),
        (6, Colour(0.92, 0.66, 0.55), 0.70, Colour(0.44, 0.37, 0.40), 0.009),
        (7, Colour(1.00, 0.86, 0.66), 1.20, Colour(0.62, 0.55, 0.48), 0.005),
    ]

    name = "BP_Lighting_NightfallIsle"
    path = asset_path("Match", "Lighting", f"{name}.asset")
    fields = base_fields(name, "Nightfall Isle lighting")
    fields.update(
        {
            "_keyframesByPhase": [
                Nested(
                    {
                        "_phaseIndex": phase,
                        "_sunColour": sun,
                        "_sunIntensity": intensity,
                        "_fogColour": fog,
                        "_fogDensity": density,
                    }
                )
                for phase, sun, intensity, fog, density in keyframes
            ],
            "_skyGradient": Gradient(
                (
                    (0.00, Colour(0.35, 0.26, 0.38)),   # dusk
                    (0.22, Colour(0.14, 0.15, 0.30)),   # blue hour
                    (0.50, Colour(0.05, 0.06, 0.14)),   # deep night
                    (0.72, Colour(0.12, 0.13, 0.26)),   # false dawn
                    (1.00, Colour(0.52, 0.40, 0.42)),   # sunrise
                )
            ),
            # Dusk +8, deep night -22, sunrise +12 (GDD 1.2).
            "_sunElevationCurve": Curve(
                ((0.0, 8.0), (0.18, -4.0), (0.5, -22.0), (0.72, -10.0),
                 (0.88, 2.0), (1.0, 12.0))
            ),
            # Never zero: this is the floor that stops deep night becoming an
            # accidental stealth mechanic.
            "_minPlayerRimIntensity": 0.4,
        }
    )
    return [(path, "MatchLightingBlueprint", fields)]


def movement_and_character() -> list[tuple[Path, str, dict]]:
    """GDD 3 and 5.1."""
    movement_name = "BP_Movement_Default"
    movement_path = asset_path("Character", f"{movement_name}.asset")
    movement_fields = base_fields(movement_name, "Default movement")
    movement_fields.update(
        {
            "_walkSpeed": 4.6,
            "_sprintSpeed": 7.4,
            "_crouchSpeed": 2.3,
            "_acceleration": 60.0,
            "_deceleration": 45.0,
            "_airControl": 0.35,
            "_jumpHeight": 1.1,
            "_gravity": -22.0,
            "_terminalVelocity": 55.0,
            "_fallDamageThreshold": 3.5,
            "_fallDamagePerMetre": 10.0,
            "_mantleMaxHeight": 1.6,
            "_mantleSeconds": 0.4,
            "_standHeight": 1.8,
            "_crouchHeight": 0.9,
        }
    )

    character_name = "BP_Character_Default"
    character_path = asset_path("Character", f"{character_name}.asset")
    character_fields = base_fields(character_name, "Default character")
    character_fields.update(
        {
            "_movement": Ref(asset_guid(movement_path)),
            "_maxHealth": 100.0,
            "_maxShield": 100.0,
            "_prefab": Ref(),
            "_cosmeticMaterial": Ref(),
            "_cameraHeight": 1.65,
            "_hitboxes": [
                Nested({"_name": "Head", "_isHead": True, "_damageScale": 1.0,
                        "_bonePath": "Root/Spine/Chest/Neck/Head"}),
                Nested({"_name": "Chest", "_isHead": False, "_damageScale": 1.0,
                        "_bonePath": "Root/Spine/Chest"}),
                Nested({"_name": "Pelvis", "_isHead": False, "_damageScale": 1.0,
                        "_bonePath": "Root/Spine"}),
                Nested({"_name": "ArmLeft", "_isHead": False, "_damageScale": 0.85,
                        "_bonePath": "Root/Spine/Chest/ArmLeft"}),
                Nested({"_name": "ArmRight", "_isHead": False, "_damageScale": 0.85,
                        "_bonePath": "Root/Spine/Chest/ArmRight"}),
                Nested({"_name": "LegLeft", "_isHead": False, "_damageScale": 0.85,
                        "_bonePath": "Root/LegLeft"}),
                Nested({"_name": "LegRight", "_isHead": False, "_damageScale": 0.85,
                        "_bonePath": "Root/LegRight"}),
            ],
        }
    )

    return [
        (movement_path, "MovementBlueprint", movement_fields),
        (character_path, "CharacterBlueprint", character_fields),
    ]


def match_rules() -> list[tuple[Path, str, dict]]:
    """GDD 1.3. Solo, Duos and Squads are three assets, not three code paths."""
    phases = [
        Ref(asset_guid(asset_path("Match", "Storm", f"BP_Storm_Phase{i}.asset")))
        for i in range(len(STORM_SCHEDULE))
    ]
    lighting = asset_ref("Match", "Lighting", "BP_Lighting_NightfallIsle.asset")

    spec = [
        ("Solo", "Solo", 1, 100, False),
        ("Duos", "Duos", 2, 100, True),
        ("Squads", "Squads", 4, 100, True),
    ]
    out = []
    for key, display, squad_size, max_players, dbno in spec:
        name = f"BP_Rules_{key}"
        path = asset_path("Match", "Rules", f"{name}.asset")
        fields = base_fields(name, display)
        fields.update(
            {
                "_squadSize": squad_size,
                "_maxPlayers": max_players,
                "_allowDbno": dbno,
                "_dbnoHealth": 100.0,
                "_dbnoBleedPerSecond": 2.0,
                "_reviveSeconds": 8.0,
                "_stormPhases": phases,
                "_lighting": lighting,
                "_busSeconds": 45.0,
                "_gliderDeployAltitude": 35.0,
                "_startingLoadout": [],
                "_friendlyFire": False,
            }
        )
        out.append((path, "MatchRulesBlueprint", fields))
    return out


def harvestables() -> list[tuple[Path, str, dict]]:
    """docs/systems/harvesting.md section 3."""
    spec = [
        ("Tree", "Wood", 300.0, 12, 12, 30),
        ("WoodenProp", "Wood", 150.0, 10, 10, 20),
        ("Rock", "Stone", 400.0, 10, 10, 25),
        ("Masonry", "Stone", 300.0, 10, 10, 20),
        ("Vehicle", "Metal", 500.0, 8, 8, 20),
        ("Machinery", "Metal", 400.0, 8, 8, 15),
    ]
    out = []
    for key, material, health, per_hit, bonus, on_destroy in spec:
        name = f"BP_Harvest_{key}"
        path = asset_path("World", "Harvestables", f"{name}.asset")
        fields = base_fields(name, key)
        fields.update(
            {
                "_material": asset_ref("Building", "Materials", f"BP_BuildMat_{material}.asset"),
                "_totalHealth": health,
                "_yieldPerHit": per_hit,
                "_bonusYieldOnWeakPoint": bonus,
                "_yieldOnDestroy": on_destroy,
                "_prefab": Ref(),
                "_destroyedVfx": Ref(),
                "_respawnSeconds": -1.0,
            }
        )
        out.append((path, "HarvestableBlueprint", fields))
    return out


def world() -> list[tuple[Path, str, dict]]:
    """A practice-range POI and the map that references it.

    The practice range is the M2 deliverable, so its POI exists from the start;
    Nightfall Isle's real POIs arrive at M5.
    """
    poi_name = "BP_Poi_PracticeRange"
    poi_path = asset_path("World", "Map", f"{poi_name}.asset")
    poi_fields = base_fields(poi_name, "Practice Range")
    poi_fields.update(
        {
            "_tier": Enum(POI_MINOR),
            "_chestSpawnPoints": 6,
            "_chestSpawnChance": 1.0,
            "_floorLootCount": Nested({"_min": 6, "_max": 10}),
            "_chestTable": asset_ref("Loot", "Tables", "BP_Loot_Chest.asset"),
            "_floorTable": asset_ref("Loot", "Tables", "BP_Loot_Floor.asset"),
            "_sceneName": "PracticeRange",
        }
    )

    map_name = "BP_Map_NightfallIsle"
    map_path = asset_path("World", "Map", f"{map_name}.asset")
    map_fields = base_fields(map_name, "Nightfall Isle")
    map_fields.update(
        {
            "_pois": [Ref(asset_guid(poi_path))],
            "_sizeMetres": 1400.0,
            "_maxPoiSeparation": 450.0,
            "_maxBuildableSlope": 40.0,
            "_minOpenTerrainFraction": 0.30,
            "_busPathSeed": 0,
        }
    )

    return [
        (poi_path, "PoiBlueprint", poi_fields),
        (map_path, "MapBlueprint", map_fields),
    ]


BUILDERS = (
    rarities,
    damage_profiles,
    recoil_profiles,
    weapons,
    build_materials,
    build_pieces,
    consumables,
    loot_tables,
    storm_phases,
    match_lighting,
    movement_and_character,
    match_rules,
    harvestables,
    world,
)


def collect() -> list[tuple[Path, str, dict]]:
    assets: list[tuple[Path, str, dict]] = []
    for builder in BUILDERS:
        assets.extend(builder())

    seen: dict[Path, str] = {}
    for path, _, _ in assets:
        if path in seen:
            raise RuntimeError(f"Two builders produced {path}")
        seen[path] = ""
    return assets


def write_all(check_only: bool = False) -> tuple[int, list[str]]:
    """Write every meta and asset. Returns (count, stale paths)."""
    stale: list[str] = []
    written = 0

    def emit(path: Path, content: str) -> None:
        nonlocal written
        relative = path.relative_to(REPO_ROOT).as_posix()
        existing = path.read_text(encoding="utf-8") if path.exists() else None
        if existing != content:
            if check_only:
                stale.append(relative)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
        written += 1

    # 1. Meta files for scripts and assembly definitions.
    for path in sorted(ASSETS_ROOT.rglob("*")):
        if path.is_dir():
            continue
        if path.suffix not in (".cs", ".asmdef"):
            continue
        relative = path.relative_to(REPO_ROOT).as_posix()
        emit(path.parent / (path.name + ".meta"), render_meta(relative))

    # 2. Blueprint assets, plus their metas.
    for asset, class_name, fields in collect():
        emit(asset, render_scriptable_object(script_guid(class_name), asset.stem, fields))
        emit(
            asset.parent / (asset.name + ".meta"),
            render_meta(asset.relative_to(REPO_ROOT).as_posix()),
        )

    # 3. Folder metas. Unity needs one per directory under Assets/, and it must
    #    come last so folders created by step 2 are included.
    for folder in sorted(ASSETS_ROOT.rglob("*")):
        if not folder.is_dir():
            continue
        relative = folder.relative_to(REPO_ROOT).as_posix()
        emit(folder.parent / (folder.name + ".meta"), render_meta(relative, is_folder=True))

    return written, stale


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="Do not write; exit non-zero if any generated file is stale.",
    )
    args = parser.parse_args(argv)

    count, stale = write_all(check_only=args.check)

    if args.check:
        if stale:
            print(f"{len(stale)} generated file(s) are stale:", file=sys.stderr)
            for path in stale[:20]:
                print(f"  {path}", file=sys.stderr)
            if len(stale) > 20:
                print(f"  ... and {len(stale) - 20} more", file=sys.stderr)
            print("\nRun: python3 tools/seed_blueprints.py", file=sys.stderr)
            return 1
        print(f"All {count} generated file(s) are up to date.")
        return 0

    print(f"Wrote {count} file(s) under {ASSETS_ROOT.relative_to(REPO_ROOT)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
