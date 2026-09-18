using Tonight.Blueprints.Building;
using UnityEngine;

namespace Tonight.Gameplay.Inventory
{
    /// <summary>
    /// A player's wood/stone/metal counts.
    /// </summary>
    /// <remarks>
    /// Materials are three counters rather than inventory slots (see
    /// docs/systems/inventory.md). A struct so it snapshots and rolls back with
    /// the rest of the predicted state.
    /// </remarks>
    public struct MaterialWallet
    {
        private int _wood;
        private int _stone;
        private int _metal;

        public int Wood => _wood;

        public int Stone => _stone;

        public int Metal => _metal;

        public int Get(BuildMaterialKind kind) => kind switch
        {
            BuildMaterialKind.Wood => _wood,
            BuildMaterialKind.Stone => _stone,
            BuildMaterialKind.Metal => _metal,
            _ => 0,
        };

        public int Get(BuildMaterialBlueprint material) =>
            material == null ? 0 : Get(material.MaterialKind);

        private void Set(BuildMaterialKind kind, int value)
        {
            switch (kind)
            {
                case BuildMaterialKind.Wood: _wood = value; break;
                case BuildMaterialKind.Stone: _stone = value; break;
                case BuildMaterialKind.Metal: _metal = value; break;
            }
        }

        /// <summary>
        /// Add materials, clamped to the material's carry cap.
        /// </summary>
        /// <returns>
        /// How much was actually added. The caller uses this to drive the HUD's
        /// "at cap" flash -- harvesting at cap still damages the object (a
        /// player clearing a tree for sightlines is doing something
        /// intentional), so the yield and the gain are genuinely different
        /// numbers.
        /// </returns>
        public int Add(BuildMaterialBlueprint material, int amount)
        {
            if (material == null || amount <= 0)
            {
                return 0;
            }

            int current = Get(material.MaterialKind);
            int added = Mathf.Min(amount, Mathf.Max(0, material.MaxCarried - current));
            Set(material.MaterialKind, current + added);
            return added;
        }

        public bool CanAfford(BuildMaterialBlueprint material, int cost) =>
            material != null && Get(material.MaterialKind) >= cost;

        /// <summary>Spend materials. Returns false and changes nothing if unaffordable.</summary>
        public bool TrySpend(BuildMaterialBlueprint material, int cost)
        {
            if (cost <= 0)
            {
                return true;
            }

            if (!CanAfford(material, cost))
            {
                return false;
            }

            Set(material.MaterialKind, Get(material.MaterialKind) - cost);
            return true;
        }

        /// <summary>Return materials after a rejected placement. Refunds are never capped away.</summary>
        public void Refund(BuildMaterialBlueprint material, int amount)
        {
            if (material == null || amount <= 0)
            {
                return;
            }

            // Deliberately not clamped to MaxCarried: a refund restores exactly
            // what was deducted, or a player at cap would lose materials by
            // having a placement rejected.
            Set(material.MaterialKind, Get(material.MaterialKind) + amount);
        }

        public bool IsAtCap(BuildMaterialBlueprint material) =>
            material != null && Get(material.MaterialKind) >= material.MaxCarried;

        public void Clear()
        {
            _wood = 0;
            _stone = 0;
            _metal = 0;
        }
    }
}
