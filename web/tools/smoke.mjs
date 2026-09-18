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

await page.screenshot({ path: process.argv[3] ?? "/tmp/tonight.png" });
await browser.close();

console.log("boot:", JSON.stringify(info, null, 2));
console.log("after harvest:", JSON.stringify(afterHarvest, null, 2));
console.log("after building:", JSON.stringify(after, null, 2));
console.log("page errors:", errors.length ? errors : "none");
const interesting = logs.filter((l) => l.startsWith("error") || l.startsWith("warning"));
console.log("console errors/warnings:", interesting.length ? interesting.slice(0, 8) : "none");
