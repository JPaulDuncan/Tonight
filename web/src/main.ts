/**
 * Entry point for the sandbox.
 *
 * Validates the content set before anything else: a broken Blueprint should
 * fail loudly at boot rather than producing a subtly wrong game.
 */

import { validateShippedContent } from "@/blueprints/library";
import { formatFinding } from "@/blueprints/registry";
import { Sandbox } from "@/render/sandbox";

const container = document.querySelector<HTMLDivElement>("#app");
if (!container) throw new Error("No #app element to mount into.");

const findings = validateShippedContent();
const errors = findings.filter((f) => f.severity === "error");

for (const finding of findings) {
  const line = formatFinding(finding);
  if (finding.severity === "error") console.error(line);
  else console.warn(line);
}

if (errors.length > 0) {
  container.innerHTML = `
    <div class="boot-error">
      <h1>Blueprint validation failed</h1>
      <p>${errors.length} error(s). The game will not start with broken content.</p>
      <ul>${errors.map((e) => `<li>${formatFinding(e)}</li>`).join("")}</ul>
    </div>`;
} else {
  // Art loading is async and is allowed to fail the boot: a missing mesh with a
  // live collision grid is an invisible wall, so showing why beats starting.
  Sandbox.create(container).then(
    (sandbox) => sandbox.start(),
    (error: unknown) => {
      console.error(error);
      container.innerHTML = `
        <div class="boot-error">
          <h1>Could not load the art</h1>
          <p>${error instanceof Error ? error.message : String(error)}</p>
          <p>Generate it with <code>npm run art</code>, then reload.</p>
        </div>`;
    },
  );
}
