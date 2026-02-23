import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const dashboardPath = resolve(import.meta.dir, "dashboard", "index.html");

function openPath(target: string) {
  if (process.platform === "darwin") {
    return spawnSync("open", [target], { stdio: "inherit" });
  }

  if (process.platform === "win32") {
    return spawnSync("cmd", ["/c", "start", "", target], {
      stdio: "inherit",
      shell: false,
    });
  }

  return spawnSync("xdg-open", [target], { stdio: "inherit" });
}

const result = openPath(dashboardPath);
if (result.error) {
  console.error(`Could not open dashboard: ${result.error.message}`);
  process.exit(1);
}
if (typeof result.status === "number" && result.status !== 0) {
  process.exit(result.status);
}

console.log(`Opened Quipbench dashboard: ${dashboardPath}`);
