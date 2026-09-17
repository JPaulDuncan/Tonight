# Packages

`manifest.json` pins every dependency. Do not add packages through the Package
Manager UI without committing the resulting manifest change — an unpinned
dependency is how two contributors end up on different Netcode versions and
spend a day debugging a "desync" that is actually a version mismatch.

| Package | Why it is here |
| --- | --- |
| `universal` (URP) | Render pipeline. Stylised art needs no HDRP feature; URP hits the 100-player frame budget. |
| `inputsystem` | Action-map abstraction, so a controller port stays possible. |
| `netcode.gameobjects` + `transport` | Server-authoritative replication. See ADR-0002. |
| `addressables` | Blueprint registry loads only what a scene needs. |
| `cinemachine` | Camera rigs, including the ADS and freefall cameras. |
| `visualscripting` | Designer-authored ability graphs **only** — scoped by ADR-0001. |
| `test-framework` + `codecoverage` | EditMode and PlayMode tests. |
| `terrain` / `terrainphysics` | Nightfall Isle terrain. |

`Library/` is gitignored and regenerated on first open. Expect the first import
to take several minutes.
