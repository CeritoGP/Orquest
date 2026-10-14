import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const profilePath = join(repositoryRoot, "config", "antigravity-permissions.orquest.example.json");
const settingsPath = process.env.ORQUEST_AGY_SETTINGS_PATH ?? join(homedir(), ".gemini", "antigravity-cli", "settings.json");
const apply = process.argv.includes("--apply");

function readJsonObject(path, fallback) {
  if (!existsSync(path)) return fallback;
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected a JSON object: ${path}`);
  }
  return value;
}

const profile = readJsonObject(profilePath, {});
const requestedSettings = profile.settings;
if (
  typeof requestedSettings !== "object" || requestedSettings === null || Array.isArray(requestedSettings) ||
  requestedSettings.toolPermission !== "proceed-in-sandbox" || requestedSettings.enableTerminalSandbox !== true
) {
  throw new Error(`Invalid Orquest sandbox settings profile: ${profilePath}`);
}
const requestedRules = profile.permissions?.allow;
if (!Array.isArray(requestedRules) || requestedRules.some((rule) => typeof rule !== "string" || rule.length === 0)) {
  throw new Error(`Invalid Orquest permission profile: ${profilePath}`);
}

const settings = readJsonObject(settingsPath, {});
const existingPermissions = settings.permissions;
if (existingPermissions !== undefined && (typeof existingPermissions !== "object" || existingPermissions === null || Array.isArray(existingPermissions))) {
  throw new Error(`Invalid permissions object in ${settingsPath}`);
}
const existingAllow = existingPermissions?.allow;
if (existingAllow !== undefined && (!Array.isArray(existingAllow) || existingAllow.some((rule) => typeof rule !== "string"))) {
  throw new Error(`Invalid permissions.allow array in ${settingsPath}`);
}

const currentRules = existingAllow ?? [];
const missingRules = requestedRules.filter((rule) => !currentRules.includes(rule));
const missingSettings = Object.entries(requestedSettings).filter(([key]) => settings[key] === undefined);
const preservedSettings = Object.entries(requestedSettings).filter(([key, value]) => settings[key] !== undefined && settings[key] !== value);
if (!apply) {
  console.log(`${missingRules.length} Orquest permission rule(s) and ${missingSettings.length} sandbox setting(s) missing from ${settingsPath}.`);
  if (preservedSettings.length > 0) console.log(`Existing user settings preserved: ${preservedSettings.map(([key]) => key).join(", ")}.`);
  process.exitCode = missingRules.length === 0 && missingSettings.length === 0 ? 0 : 2;
} else if (missingRules.length === 0 && missingSettings.length === 0) {
  console.log("Orquest permission baseline is already installed.");
} else {
  const mergedSettings = {
    ...settings,
    ...Object.fromEntries(missingSettings),
    permissions: {
      ...existingPermissions,
      allow: [...currentRules, ...missingRules],
    },
  };
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(mergedSettings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`Installed ${missingRules.length} bounded Orquest permission rule(s) and ${missingSettings.length} sandbox setting(s).`);
  if (preservedSettings.length > 0) console.log(`Existing user settings preserved: ${preservedSettings.map(([key]) => key).join(", ")}.`);
}