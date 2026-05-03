import * as fs from "node:fs";
import * as os from "node:os";
import { isAbsolute, join, resolve } from "node:path";
export const SETTINGS_KEY = "pm2-processes";
const DEFAULT_CONFIG_CANDIDATES = [
    join(".pi", "pm2", "ecosystem.config.cjs"),
    "ecosystem.config.js",
    "ecosystem.config.cjs",
    "ecosystem.config.json",
];
function readJsonFile(filePath) {
    try {
        return { value: JSON.parse(fs.readFileSync(filePath, "utf8")) };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { diagnostic: `Failed to parse ${filePath}: ${message}` };
    }
}
function readSettingsConfig(settingsPath) {
    if (!fs.existsSync(settingsPath))
        return null;
    const parsed = readJsonFile(settingsPath);
    if (parsed.diagnostic) {
        return {
            pathLabel: settingsPath,
            raw: {},
            diagnostics: [parsed.diagnostic],
        };
    }
    if (!parsed.value || typeof parsed.value !== "object")
        return null;
    const raw = parsed.value[SETTINGS_KEY];
    if (!raw || typeof raw !== "object")
        return null;
    return {
        pathLabel: `${settingsPath}#${SETTINGS_KEY}`,
        raw: raw,
        diagnostics: [],
    };
}
function resolvePath(cwd, input) {
    return isAbsolute(input) ? input : resolve(cwd, input);
}
function cleanString(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
function cleanPositiveInt(value, fallback, min, max) {
    if (!Number.isFinite(value) || value === undefined)
        return fallback;
    return Math.min(max, Math.max(min, Math.floor(value)));
}
function collectSettings(cwd, agentDir) {
    const globalSettings = readSettingsConfig(join(agentDir, "settings.json"));
    const projectSettings = readSettingsConfig(join(cwd, ".pi", "settings.json"));
    return [globalSettings, projectSettings].filter((source) => source !== null);
}
function mergeSettings(sources) {
    return sources.reduce((merged, source) => ({ ...merged, ...source.raw }), {});
}
function resolveExistingFile(cwd, candidates) {
    const searched = [];
    const diagnostics = [];
    for (const candidate of candidates) {
        const absolutePath = resolvePath(cwd, candidate.path);
        searched.push(absolutePath);
        if (fs.existsSync(absolutePath)) {
            return { configPath: absolutePath, configSource: candidate.source, searched, diagnostics };
        }
        diagnostics.push(`PM2 config candidate not found: ${absolutePath} (${candidate.source})`);
    }
    return { searched, diagnostics };
}
export function loadSettings(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const agentDir = options.agentDir ?? join(os.homedir(), ".pi", "agent");
    const env = options.env ?? process.env;
    const sources = collectSettings(cwd, agentDir);
    const merged = mergeSettings(sources);
    const diagnostics = sources.flatMap((source) => source.diagnostics);
    const explicitEnvConfig = cleanString(env.PI_PM2_CONFIG);
    const settingsConfig = cleanString(merged.configPath);
    const candidates = [];
    if (explicitEnvConfig)
        candidates.push({ path: explicitEnvConfig, source: "env:PI_PM2_CONFIG" });
    else if (settingsConfig)
        candidates.push({ path: settingsConfig, source: "settings:configPath" });
    else {
        for (const candidate of DEFAULT_CONFIG_CANDIDATES) {
            candidates.push({ path: candidate, source: `default:${candidate}` });
        }
    }
    const discovered = resolveExistingFile(cwd, candidates);
    diagnostics.push(...discovered.diagnostics);
    const metadataEnv = cleanString(env.PI_PM2_METADATA);
    const metadataSetting = cleanString(merged.metadataPath);
    const defaultMetadata = join(cwd, ".pi", "pm2", "metadata.json");
    let metadataPath;
    let metadataSource;
    if (metadataEnv) {
        metadataPath = resolvePath(cwd, metadataEnv);
        metadataSource = "env:PI_PM2_METADATA";
    }
    else if (metadataSetting) {
        metadataPath = resolvePath(cwd, metadataSetting);
        metadataSource = "settings:metadataPath";
    }
    else if (fs.existsSync(defaultMetadata)) {
        metadataPath = defaultMetadata;
        metadataSource = "default:.pi/pm2/metadata.json";
    }
    if (metadataPath && !fs.existsSync(metadataPath)) {
        diagnostics.push(`PM2 metadata file not found: ${metadataPath} (${metadataSource ?? "unknown"})`);
        metadataPath = undefined;
        metadataSource = undefined;
    }
    return {
        enabled: merged.enabled ?? true,
        configPath: discovered.configPath,
        configSource: discovered.configSource,
        metadataPath,
        metadataSource,
        pm2Bin: cleanString(env.PI_PM2_BIN) ?? cleanString(merged.pm2Bin) ?? "pm2",
        defaultLines: cleanPositiveInt(merged.defaultLines, 80, 1, 2000),
        maxLines: cleanPositiveInt(merged.maxLines, 300, 1, 5000),
        maxBytes: cleanPositiveInt(merged.maxBytes, 50_000, 1_000, 500_000),
        commandTimeoutMs: cleanPositiveInt(merged.commandTimeoutMs, 15_000, 1_000, 120_000),
        readinessTimeoutMs: cleanPositiveInt(merged.readinessTimeoutMs, 1_500, 100, 30_000),
        settingsSources: sources.map((source) => source.pathLabel),
        searchedConfigPaths: discovered.searched,
        diagnostics,
    };
}
