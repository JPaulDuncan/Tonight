import { chromium } from "playwright";

const URL = process.argv[2] ?? "http://localhost:4173/";
// Playwright's own resolution is used when it works; the explicit path is the
// fallback for this container, where the browser lives in a versioned folder.
const explicit = process.env["CHROMIUM_PATH"];
const browser = await chromium.launch({
  ...(explicit ? { executablePath: explicit } : {}),
  // SwiftShader gives software WebGL, so the renderer runs with no GPU.
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
const logs = [];

// Playwright's mouse.move takes absolute page coordinates, but a pointer-locked
// game reads the *delta* between them. Tracking our own cursor is what makes a
// nudge repeatable; moving to the same absolute point twice sends a delta of
// zero and the aim never budges.
let cursorX = 640;
let cursorY = 360;
async function nudge(dx, dy) {
  cursorX += dx;
  cursorY += dy;
  await page.mouse.move(cursorX, cursorY, { steps: 2 });
  await page.waitForTimeout(70);
}

page.on("console", (m) => { logs.push(`${m.type()}: ${m.text()}`); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

// Is a WebGL canvas actually rendering?
const info = await page.evaluate(() => {
  const canvas = document.querySelector("canvas");
  if (!canvas) return { canvas: false };
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  return {
    canvas: true,
    width: canvas.width,
    height: canvas.height,
    gl: Boolean(gl),
    hud: Boolean(document.querySelector(".hud")),
    fps: document.querySelector("#hud-fps")?.textContent ?? null,
    pieces: document.querySelector("#hud-pieces")?.textContent ?? null,
    bootError: Boolean(document.querySelector(".boot-error")),
  };
});

// Drive it: walk, harvest, then build a box by turning between placements.
await page.mouse.move(640, 360);
await page.keyboard.down("KeyW");
await page.waitForTimeout(600);
await page.keyboard.up("KeyW");

// A few pickaxe swings in combat mode.
for (let i = 0; i < 3; i++) {
  await page.mouse.click(640, 360);
  await page.waitForTimeout(250);
}
const afterHarvest = await page.evaluate(() => ({
  wood: document.querySelector(".hud-material.selected .hud-count")?.textContent ?? null,
  message: document.querySelector("#hud-message")?.textContent ?? null,
}));

await page.keyboard.press("KeyQ"); // build mode
await page.waitForTimeout(200);

// Four walls, turning 90 degrees between each: a 1x1 box.
for (let i = 0; i < 4; i++) {
  await page.mouse.click(640, 360);
  await page.waitForTimeout(220);
  await page.mouse.move(640, 360);
  await page.mouse.move(640 + 250, 360, { steps: 5 });
  await page.waitForTimeout(220);
}

// And a ramp.
await page.keyboard.press("Digit3");
await page.waitForTimeout(150);
await page.mouse.click(640, 360);
await page.waitForTimeout(400);

const after = await page.evaluate(() => ({
  pieces: document.querySelector("#hud-pieces")?.textContent ?? null,
  fps: document.querySelector("#hud-fps")?.textContent ?? null,
  wood: document.querySelector(".hud-material.selected .hud-count")?.textContent ?? null,
  message: document.querySelector("#hud-message")?.textContent ?? null,
  buildMode: Boolean(document.querySelector(".hud-piece.selected:not(.dimmed)")),
}));

// Reset and rebuild. Shared loaded geometry means removing a piece must not
// free the buffers every other piece of that kind is drawing, and a place ->
// remove -> place cycle is the cheapest way to catch it.
await page.keyboard.press("Backspace");
await page.waitForTimeout(300);
const afterReset = await page.evaluate(
  () => window.__tonight?.describePieces?.().length ?? -1,
);
if (afterReset !== 0) errors.push(`reset left ${afterReset} pieces`);

await page.mouse.click(640, 360);
await page.waitForTimeout(400);

// The walk cycle actually runs, and the limbs oppose each other.
//
// A static pose and a running cycle look identical in a screenshot, so this
// samples the joints while walking. Legs in phase is a hop; arms in phase with
// their own leg is a shamble. Both are silent failures otherwise.
await page.keyboard.down("KeyW");
// Several samples across the stride, not one. Both legs pass through zero twice
// per cycle, so a single instant can legitimately catch them level and a
// one-shot check fails at random.
const strideSamples = [];
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(110);
  const a = await page.evaluate(() => window.__tonight?.describeAvatar?.());
  if (a) strideSamples.push(a);
}
await page.keyboard.up("KeyW");
await page.waitForTimeout(200);
const still = await page.evaluate(() => window.__tonight?.describeAvatar?.());

const mid = strideSamples[strideSamples.length - 1];
console.log("walking:", JSON.stringify({ speed: mid?.speed, bob: mid?.bobY, joints: mid?.joints }));

if (strideSamples.length === 0 || !mid?.joints.LegLeft) {
  errors.push("no avatar joints - is the character articulated?");
} else {
  const legLefts = strideSamples.map((a) => a.joints.LegLeft[0]);
  const spread = Math.max(...legLefts) - Math.min(...legLefts);
  if (spread < 0.15) {
    errors.push(`the legs barely moved while walking (range ${spread.toFixed(3)} rad)`);
  }

  // Opposition, checked only where the legs are far enough from the crossing
  // for the signs to mean anything.
  const swung = strideSamples.find((a) => Math.abs(a.joints.LegLeft[0]) > 0.1);
  if (!swung) {
    errors.push("never caught the legs away from the crossing point");
  } else if (Math.sign(swung.joints.LegLeft[0]) === Math.sign(swung.joints.LegRight[0])) {
    errors.push("the legs are in phase - that is a hop, not a walk");
  }

  if ((mid.speed ?? 0) < 1) errors.push(`walking speed read as ${mid.speed} m/s`);
  if (still && Math.abs(still.joints.LegLeft[0]) > 0.35) {
    errors.push("the legs did not settle after stopping");
  }
}

// Back to combat mode: in build mode the left button places a piece rather than
// swinging, so the swing clip would never start and the failure would look like
// an animation bug rather than a mode mix-up.
await page.keyboard.press("KeyQ");
await page.waitForTimeout(200);

// The upper body layers over the walk, and the held weapon moves with the arm.
//
// The rendered frame lags a state read by about one frame at this frame rate,
// so this asserts on the state rather than on pixels: a screenshot taken at the
// top of a swing shows the frame before it.
const swingSamples = [];
await page.mouse.down();
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(70);
  const a = await page.evaluate(() => window.__tonight?.describeAvatar?.());
  if (a) swingSamples.push(a);
}
await page.mouse.up();
await page.waitForTimeout(900);
const settled = await page.evaluate(() => window.__tonight?.describeAvatar?.());

const held = settled?.weapon;
console.log("held weapon:", JSON.stringify(held), "resting clip:", settled?.upperBody);
if (!held) {
  errors.push("no weapon is held - did the grip sockets survive the export?");
} else if (held.parts < 2) {
  errors.push(`the held weapon has ${held.parts} parts; a pickaxe has three`);
}

if (!swingSamples.some((a) => a.upperBody === "upper.swing")) {
  errors.push("swinging the pickaxe did not start the swing clip");
}
const arms = swingSamples.map((a) => a.joints.ArmRight[0]);
if (Math.max(...arms) - Math.min(...arms) < 1.0) {
  errors.push(`the arm barely moved through the swing (range ${(Math.max(...arms) - Math.min(...arms)).toFixed(2)} rad)`);
}
// The weapon is parented to the arm, so it has to travel with it.
const heights = swingSamples.map((a) => a.weapon?.world?.[1] ?? 0);
if (Math.max(...heights) - Math.min(...heights) < 0.15) {
  errors.push("the weapon did not move while the arm swung - is it parented to the joint?");
}
// And the body must hand back to the carry pose rather than freezing.
if (settled?.upperBody !== "upper.carry") {
  errors.push(`after swinging the clip stayed on ${settled?.upperBody}`);
}

// Carrying must stop the arms swinging with the walk: the carry clip masks
// them, so an arm that still cycles means the mask is not being applied.
await page.keyboard.down("KeyW");
const walkArms = [];
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(90);
  const a = await page.evaluate(() => window.__tonight?.describeAvatar?.());
  if (a) walkArms.push({ arm: a.joints.ArmRight[0], leg: a.joints.LegLeft[0] });
}
await page.keyboard.up("KeyW");
await page.waitForTimeout(200);

const armSpread = Math.max(...walkArms.map((w) => w.arm)) - Math.min(...walkArms.map((w) => w.arm));
const legSpread = Math.max(...walkArms.map((w) => w.leg)) - Math.min(...walkArms.map((w) => w.leg));
console.log(`carrying while walking: arm spread ${armSpread.toFixed(3)}, leg spread ${legSpread.toFixed(3)}`);
if (armSpread > 0.05) errors.push(`the carried arm still swings (${armSpread.toFixed(2)} rad)`);
if (legSpread < 0.2) errors.push("the legs stopped walking while carrying");

// Weapons: equip, fire, spend ammo, reload, and damage what is in front.
await ensureBuildMode(false);
const weaponState = () => page.evaluate(() => window.__tonight?.describeWeapon?.());

const idleBefore = await weaponState();
await page.keyboard.press("Digit2");          // assault rifle
await page.waitForTimeout(700);
const equipped = await weaponState();
console.log("equipped:", JSON.stringify(equipped));

if (!equipped || equipped.id !== "weapon.assaultRifle") {
  errors.push(`number key did not equip the rifle (held ${equipped?.id})`);
} else if (equipped.heldParts < 2) {
  errors.push("the rifle mesh did not attach to the hand");
}

// Idling with a weapon out must not fire it. tryFire once returned the same
// value for "fired" and "no trigger", so the sandbox shot continuously without
// spending ammo; this is the regression check for that.
if (equipped && equipped.shotsFired > (idleBefore?.shotsFired ?? 0)) {
  errors.push("the rifle fired without the trigger being pressed");
}

await page.mouse.down();
await page.waitForTimeout(900);
await page.mouse.up();
await page.waitForTimeout(250);
const sprayed = await weaponState();
console.log("after a burst:", JSON.stringify(sprayed));

if (sprayed.shotsFired <= equipped.shotsFired) errors.push("holding the trigger fired nothing");
if (sprayed.ammo >= equipped.ammo) {
  errors.push(`firing did not spend ammo (${equipped.ammo} -> ${sprayed.ammo})`);
}
// Auto fire at 550 rpm is about nine rounds a second: a shot every tick would
// be roughly thirty, and would empty the magazine in one press.
const roundsSpent = equipped.ammo - sprayed.ammo;
if (roundsSpent > 20) errors.push(`fired ${roundsSpent} rounds in 0.9s - the cooldown is not holding`);

await page.keyboard.press("KeyR");
await page.waitForTimeout(2600);
const reloaded = await weaponState();
if (reloaded.ammo !== reloaded.magazine) {
  errors.push(`reload left ${reloaded.ammo} of ${reloaded.magazine}`);
}

// One press of a bolt-action is one shell, and a shell is all its pellets.
await page.keyboard.press("Digit3");          // shotgun
await page.waitForTimeout(800);
const beforeShell = await weaponState();
await page.mouse.down();
await page.waitForTimeout(70);
await page.mouse.up();
await page.waitForTimeout(250);
const afterShell = await weaponState();
const shells = beforeShell.ammo - afterShell.ammo;
const pellets = afterShell.pelletsFired - beforeShell.pelletsFired;
console.log(`shotgun: ${shells} shell, ${pellets} pellets (pelletCount ${afterShell.pelletCount})`);
if (shells !== 1) errors.push(`one press fired ${shells} shells from a bolt-action`);
if (pellets !== afterShell.pelletCount) {
  errors.push(`a shell fired ${pellets} pellets, expected ${afterShell.pelletCount}`);
}

// And a shot has to actually hurt a structure: build a wall and shoot it away.
await ensureBuildMode(true);
await page.keyboard.press("Digit1"); await page.waitForTimeout(120);
await page.keyboard.press("KeyZ"); await page.waitForTimeout(120);
await page.mouse.click(640, 360); await page.waitForTimeout(350);
const builtCount = (await page.evaluate(() => window.__tonight?.describePieces?.() ?? [])).length;
await ensureBuildMode(false);
await page.keyboard.press("Digit2"); await page.waitForTimeout(700);

await page.mouse.down();
let hitStructure = false;
for (let i = 0; i < 14; i++) {
  await page.waitForTimeout(130);
  const now = await weaponState();
  if (now.structureHits > afterShell.structureHits) { hitStructure = true; break; }
}
await page.mouse.up();
await page.waitForTimeout(200);
const remaining = (await page.evaluate(() => window.__tonight?.describePieces?.() ?? [])).length;
console.log(`structure fire: built ${builtCount}, remaining ${remaining}, registered a hit: ${hitStructure}`);
if (!hitStructure) errors.push("firing at a wall registered no structure hit");

// Every material the player can build with has its texture bound. A missing map
// is a flat-colour wall: easy to miss by eye, trivial to assert.
//
// On a cleared world, because the materials are created lazily when a piece is
// first placed and a congested area silently rejects the placement.
await page.keyboard.press("Backspace");
await page.waitForTimeout(300);
// One material per piece *type* rather than per direction: a wall, a floor and
// a ramp occupy three different slots of the same cell, so all three place
// without turning. Turning between placements was flaky -- the third wall kept
// landing somewhere unbuildable, which tested the aim rather than the textures.
for (const [piece, material] of [["Digit1", "KeyZ"], ["Digit2", "KeyX"], ["Digit3", "KeyC"]]) {
  await page.keyboard.press(piece);
  await page.waitForTimeout(100);
  await page.keyboard.press(material);
  await page.waitForTimeout(100);
  await page.mouse.click(640, 360);
  await page.waitForTimeout(320);
}
const materials = await page.evaluate(() => window.__tonight?.describeMaterials?.() ?? {});
console.log("materials:", JSON.stringify(materials));

const buildMaterials = Object.entries(materials).filter(([key]) => !key.startsWith("prop:"));
const untextured = Object.entries(materials).filter(([, m]) => !m.map).map(([k]) => k);
if (untextured.length) errors.push(`materials with no texture: ${untextured.join(", ")}`);
if (buildMaterials.length < 3) {
  errors.push(
    `only ${buildMaterials.length} of 3 build materials were exercised: ` +
      buildMaterials.map(([k]) => k).join(", "),
  );
}

// Swap back to a wall and put one directly ahead, so the edit phase below has a
// known piece under the crosshair rather than whatever the box-building left.
await page.keyboard.press("Backspace");
await page.waitForTimeout(300);
await ensureBuildMode(true);
await page.keyboard.press("Digit1");
await page.waitForTimeout(150);
await page.mouse.click(640, 360);
await page.waitForTimeout(400);

// Edit the wall in front of us into a doorway.
//
// The crosshair is nudged until it sits on the sub-cell we want rather than
// assuming a pixels-per-degree mapping: the point is to prove the whole chain
// -- aim, toggle, commit, load the variant mesh -- not to hard-code a mouse
// path that breaks the first time the field of view changes.
const subCellNow = () =>
  page.evaluate(() => window.__tonight?.describeEdit?.().target ?? { found: false });

/**
 * Put the game into (or out of) build mode, rather than assuming.
 *
 * The number row means pieces while building and weapons otherwise, so a phase
 * that assumes the mode silently selects the wrong thing: Digit1 either picks a
 * wall or equips the pickaxe, and a click either places or swings.
 */
async function ensureBuildMode(on) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const inBuildMode = await page.evaluate(
      () => Boolean(document.querySelector(".hud-piece.selected:not(.dimmed)")),
    );
    if (inBuildMode === on) return true;
    await page.keyboard.press("KeyQ");
    await page.waitForTimeout(180);
  }
  errors.push(`could not get into build mode = ${on}`);
  return false;
}

async function aimAtSubCell(wanted) {
  // One sub-cell is 1.33 m across a wall 8 m away, so roughly ten degrees of
  // view: small steps. Losing the face means the last nudge went off the top or
  // the side, so ease back up and try again.
  const STEP = 3;
  for (let attempt = 0; attempt < 80; attempt++) {
    const target = await subCellNow();
    if (target.found && target.subCell === wanted) return true;
    if (!target.found) {
      await nudge(0, -2);
      continue;
    }
    const dColumn = (wanted % 3) - (target.subCell % 3);
    const dRow = Math.floor(wanted / 3) - Math.floor(target.subCell / 3);
    // Right on screen is +x; screen y and row index both grow downward.
    await nudge(Math.sign(dColumn) * STEP, Math.sign(dRow) * STEP);
  }
  return false;
}

// A doorway clears the middle (4) and bottom-middle (7) cells.
const DOORWAY_CELLS = [4, 7];
let editOk = await aimAtSubCell(DOORWAY_CELLS[0]);
if (!editOk) errors.push("could not aim at the wall to edit it");

if (editOk) {
  await page.keyboard.down("KeyG");      // begin: toggles the cell under the crosshair
  await page.waitForTimeout(150);
  editOk = await aimAtSubCell(DOORWAY_CELLS[1]);   // sweep: toggles the second
  await page.waitForTimeout(150);
  await page.keyboard.up("KeyG");        // release: applies
  await page.waitForTimeout(400);

  const edited = await page.evaluate(() => window.__tonight?.describePieces?.() ?? []);
  const wall = edited.find((p) => p.key.endsWith(":0"));
  console.log("edited wall:", JSON.stringify(wall));
  // The doorway mesh is two of nine cells lighter than the solid wall, so the
  // vertex count is the proof that the *variant* mesh is what loaded.
  if (!wall) errors.push("the wall vanished during the edit");
  else if (wall.vertices >= 408) {
    errors.push(`edit did not change the mesh (${wall.vertices} vertices, solid is 408)`);
  }
}

// The assets actually loaded, and landed where the grid says they should.
const pieces = await page.evaluate(() => window.__tonight?.describePieces?.() ?? []);
console.log("placed pieces:", JSON.stringify(pieces, null, 1));

const CELL = 4;
for (const piece of pieces) {
  // A generated wall carries far more geometry than the 24-vertex box the
  // sandbox used to draw, so this distinguishes "loaded the mesh" from
  // "rendered something".
  if (piece.vertices < 100) {
    errors.push(`${piece.key} has only ${piece.vertices} vertices - is it the generated mesh?`);
  }
  // Authored base-at-cell-floor: a piece placed against the raw slot anchor
  // would float half a cell, so check the span lines up with the grid.
  const height = piece.max[1] - piece.min[1];
  if (height > CELL + 0.5) {
    errors.push(`${piece.key} spans ${height.toFixed(2)} m vertically, over one cell`);
  }
  for (const axis of [0, 2]) {
    if (Math.abs(piece.min[axis] % CELL) > 0.5 && Math.abs(Math.abs(piece.min[axis] % CELL) - CELL) > 0.5) {
      errors.push(`${piece.key} min[${axis}]=${piece.min[axis]} is not near a 4 m grid line`);
    }
  }
}

await page.screenshot({ path: process.argv[3] ?? "/tmp/tonight.png" });
await browser.close();

console.log("boot:", JSON.stringify(info, null, 2));
console.log("after harvest:", JSON.stringify(afterHarvest, null, 2));
console.log("after building:", JSON.stringify(after, null, 2));
console.log("page errors:", errors.length ? errors : "none");
if (errors.length) process.exitCode = 1;
const interesting = logs.filter((l) => l.startsWith("error") || l.startsWith("warning"));
console.log("console errors/warnings:", interesting.length ? interesting.slice(0, 8) : "none");
