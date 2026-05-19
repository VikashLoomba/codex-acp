import {promises as fs} from "node:fs";
import path from "node:path";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import {CODEX_SKILL_FILE_NAME} from "./SkillDirectoryParser";
import {logger} from "./Logger";
import {parseSkillsFromDirectory} from "./SkillDirectoryParser";
import {formatError, isNotFoundError, isRecord} from "./TypeGuards";

const AGENTS_DIR = ".agents";
const SKILLS_DIR = "skills";
const PLUGINS_DIR = "plugins";
const GENERATED_DIR = "generated";
const SYNC_METADATA_FILE_NAME = ".codex-acp-sync.json";

// Codex app-server 0.130.0 removed the session/turn `additionalDirectories`
// field. ACP clients can still provide additional roots, so we preserve that
// behavior by turning each provided directory's `.agents/skills` folder into a
// local skills-only plugin marketplace and installing it through app-server.

// Public result consumed by plugin registration/install helpers.
export type LocalSkillMarketplaceResult =
    | {
        ok: true;
        marketplacePath: string;
        marketplaceName: string;
        pluginName: string;
        skills: GeneratedSkillMetadata[];
        changed: boolean;
    }
    | {
        ok: false;
        error: string;
    };

// Shape of <root>/.agents/plugins/marketplace.json.
type MarketplaceManifest = {
    name: string;
    interface?: {
        displayName?: string | null;
    };
    plugins: MarketplacePluginEntry[];
};

// Single catalog entry pointing app-server at the generated skills-only plugin.
type MarketplacePluginEntry = {
    name: string;
    source: {
        source: "local";
        path: string;
    };
    policy: {
        installation: "AVAILABLE";
        authentication: "ON_INSTALL";
    };
    category: "Productivity";
};

// Parsed source skill plus the generated destination paths derived from it.
type SourceSkillDirectory = {
    sourceDir: string;
    skillName: string;
    generatedSkillDir: string;
    generatedSkillPath: string;
};

// Generated skill identity used for app-server validation and sync freshness checks.
export type GeneratedSkillMetadata = {
    name: string;
    sourceDir: string;
    generatedSkillDir: string;
    generatedSkillPath: string;
    sourceLatestMtimeMs: number;
};

// Plugin-level cache of source mtimes, so unchanged generated skills can be skipped.
type PluginSyncMetadata = {
    sourceRoot: string;
    pluginName: string;
    syncedAt: string;
    skills: Record<string, PluginSyncSkillMetadata>;
};

// Per-skill sync state keyed by generated skill directory relative to generatedSkillsRoot.
type PluginSyncSkillMetadata = {
    sourceDir: string;
    generatedSkillPath: string;
    sourceLatestMtimeMs: number;
};

// Internal sync outcome used to decide whether app-server must reinstall the plugin.
type SkillSyncSummary = {
    copied: string[];
    unchanged: string[];
    removed: string[];
    changed: boolean;
};

export async function createMarketplaceFromSkills(
    inputPath: string
): Promise<LocalSkillMarketplaceResult> {
    let root: string;
    try {
        root = await canonicalizeExistingDirectory(inputPath);
    } catch (error) {
        const message = `Invalid additional root ${inputPath}: ${formatError(error)}`;
        logger.log("Local skill marketplace generation skipped", {root: inputPath, error: message});
        return {ok: false, error: message};
    }

    const skillsRoot = path.join(root, AGENTS_DIR, SKILLS_DIR);
    const parsed = await parseSkillsFromDirectory(skillsRoot);
    if (parsed.errors.length > 0) {
        logger.log("Local skill marketplace skill parse errors", {
            root,
            errors: parsed.errors,
        });
    }
    if (parsed.skills.length === 0) {
        const message = `No valid skills found under ${skillsRoot}`;
        logger.log("Local skill marketplace generation skipped", {root, error: message});
        return {ok: false, error: message};
    }

    const marketplaceName = deriveMarketplaceName(root);
    if (marketplaceName === null) {
        const message = `Could not derive marketplace name from ${root}`;
        logger.log("Local skill marketplace generation skipped", {root, error: message});
        return {ok: false, error: message};
    }

    const pluginName = `${marketplaceName}-skills`;
    const marketplacePath = path.join(root, AGENTS_DIR, PLUGINS_DIR, "marketplace.json");
    const pluginRoot = path.join(root, AGENTS_DIR, PLUGINS_DIR, GENERATED_DIR, pluginName);
    const generatedSkillsRoot = path.join(pluginRoot, SKILLS_DIR);
    const sourceSkillDirectories = parsed.skills.map((skill): SourceSkillDirectory => {
        const sourceDir = path.dirname(skill.path);
        const generatedRelativeDir = path.relative(skillsRoot, sourceDir);
        const generatedSkillDir = path.join(generatedSkillsRoot, generatedRelativeDir);
        return {
            sourceDir,
            skillName: skill.name,
            generatedSkillDir,
            generatedSkillPath: path.join(generatedSkillDir, CODEX_SKILL_FILE_NAME),
        };
    });
    let syncedSkills: GeneratedSkillMetadata[];
    let syncSummary: SkillSyncSummary;

    try {
        syncedSkills = await Promise.all(sourceSkillDirectories.map(async (skill) => ({
            name: skill.skillName,
            sourceDir: skill.sourceDir,
            generatedSkillDir: skill.generatedSkillDir,
            generatedSkillPath: skill.generatedSkillPath,
            sourceLatestMtimeMs: await readLatestSourceMtimeMs(skill.sourceDir),
        })));
        await fs.mkdir(generatedSkillsRoot, {recursive: true});
        syncSummary = await syncSkillDirectories({
            sourceRoot: root,
            pluginName,
            pluginRoot,
            generatedSkillsRoot,
            skills: syncedSkills,
        });
        await writePluginManifest(pluginRoot, pluginName, root);
        await ensureMarketplaceEntry({
            marketplacePath,
            marketplaceName,
            pluginName,
            pluginSourcePath: `./${AGENTS_DIR}/${PLUGINS_DIR}/${GENERATED_DIR}/${pluginName}`,
        });
    } catch (error) {
        const message = `Failed to generate local skill marketplace for ${root}: ${formatError(error)}`;
        logger.error("Local skill marketplace generation failed", error);
        return {ok: false, error: message};
    }

    return {
        ok: true,
        marketplacePath,
        marketplaceName,
        pluginName,
        skills: syncedSkills,
        changed: syncSummary.changed,
    };
}

export async function installAdditionalRootSkillMarketplaces(params: {
    codexClient: CodexAppServerClient;
    cwd: string;
    additionalRootPaths: string[];
}): Promise<void> {
    // Workflow:
    // additional root paths -> parse .agents/skills -> generate marketplace.json
    // -> sync generated plugin skills -> write plugin manifest -> marketplace/add
    // -> plugin/list -> plugin/read diff -> plugin/install when stale or unavailable.
    const {codexClient, cwd, additionalRootPaths} = params;
    for (const additionalRootPath of additionalRootPaths) {
        const marketplace = await createMarketplaceFromSkills(additionalRootPath);
        if (!marketplace.ok) {
            logger.log("Additional root skill marketplace skipped", {
                root: additionalRootPath,
                error: marketplace.error,
            });
            continue;
        }
        await installGeneratedSkillPlugin({
            codexClient,
            cwd,
            root: additionalRootPath,
            marketplace,
        });
    }
}

async function installGeneratedSkillPlugin(params: {
    codexClient: CodexAppServerClient;
    cwd: string;
    root: string;
    marketplace: Extract<LocalSkillMarketplaceResult, {ok: true}>;
}): Promise<void> {
    const {codexClient, cwd, root, marketplace} = params;
    try {
        const marketplaceAdd = await codexClient.marketplaceAdd({
            source: root,
            refName: null,
            sparsePaths: null,
        });
        const pluginList = await codexClient.pluginList({
            cwds: cwd ? [cwd] : [],
            marketplaceKinds: ["local", "workspace-directory"],
        });
        const listedMarketplace = pluginList.marketplaces.find((entry) =>
            entry.name === marketplace.marketplaceName || entry.path === marketplace.marketplacePath
        );
        if (!listedMarketplace) {
            logger.log("Generated skill marketplace was not listed after add", {
                root,
                marketplaceName: marketplace.marketplaceName,
                marketplacePath: marketplace.marketplacePath,
                installedRoot: marketplaceAdd.installedRoot,
            });
            return;
        }

        const plugin = listedMarketplace.plugins.find((candidate) =>
            candidate.name === marketplace.pluginName
        );
        if (!plugin) {
            logger.log("Generated skill plugin was not listed after marketplace add", {
                root,
                marketplaceName: marketplace.marketplaceName,
                pluginName: marketplace.pluginName,
            });
            return;
        }

        const marketplacePath = listedMarketplace.path ?? marketplace.marketplacePath;
        let skillDiff = await readGeneratedPluginSkillDiff(
            codexClient,
            marketplacePath,
            marketplace.pluginName,
            marketplace.skills.map((skill) => skill.generatedSkillPath)
        );
        const shouldRefreshInstall = !plugin.installed
            || !plugin.enabled
            || marketplace.changed
            || skillDiff.missing.length > 0
            || skillDiff.extra.length > 0;
        if (skillDiff.missing.length > 0 || skillDiff.extra.length > 0) {
            logger.log("Generated skill plugin contents differ from source before install", {
                root,
                marketplaceName: marketplace.marketplaceName,
                pluginName: marketplace.pluginName,
                missingSkillPaths: skillDiff.missing,
                extraSkillPaths: skillDiff.extra,
                expectedSkills: marketplace.skills.map((skill) => ({
                    name: skill.name,
                    path: skill.generatedSkillPath,
                })),
            });
        }

        if (shouldRefreshInstall) {
            await codexClient.pluginInstall({
                marketplacePath,
                remoteMarketplaceName: null,
                pluginName: marketplace.pluginName,
            });
        }

        logger.log("Additional root skill plugin installed", {
            root,
            marketplaceName: marketplace.marketplaceName,
            pluginName: marketplace.pluginName,
            alreadyAdded: marketplaceAdd.alreadyAdded,
            generatedPluginChanged: marketplace.changed,
            expectedSkillCount: marketplace.skills.length,
            listedSkillCount: skillDiff.actual.length,
        });
    } catch (error) {
        logger.error("Additional root skill plugin install failed", error);
    }
}

async function readGeneratedPluginSkillDiff(
    codexClient: CodexAppServerClient,
    marketplacePath: string,
    pluginName: string,
    expectedSkillPaths: string[]
): Promise<{actual: string[]; missing: string[]; extra: string[]}> {
    const pluginRead = await codexClient.pluginRead({
        marketplacePath,
        remoteMarketplaceName: null,
        pluginName,
    });
    const actualSkillPaths = sortedUnique(pluginRead.plugin.skills
        .map((skill) => skill.path)
        .filter((skillPath): skillPath is string => skillPath !== null));
    return diffSortedValues(sortedUnique(expectedSkillPaths), actualSkillPaths);
}

async function canonicalizeExistingDirectory(directory: string): Promise<string> {
    const resolved = path.resolve(directory);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
        throw new Error("path is not a directory");
    }
    return await fs.realpath(resolved);
}

function deriveMarketplaceName(root: string): string | null {
    const normalized = path.normalize(root);
    const parts = normalized.split(path.sep).filter((part) => part.length > 0);
    const selected = parts.slice(-2).map(normalizeMarketplaceSegment).filter((part) => part.length > 0);
    const marketplaceName = selected.join("-");
    return marketplaceName.length > 0 ? marketplaceName : null;
}

function normalizeMarketplaceSegment(segment: string): string {
    return segment.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function diffSortedValues(expected: string[], actual: string[]): {actual: string[]; missing: string[]; extra: string[]} {
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    return {
        actual,
        missing: expected.filter((name) => !actualSet.has(name)),
        extra: actual.filter((name) => !expectedSet.has(name)),
    };
}

function sortedUnique(values: string[]): string[] {
    return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

async function syncSkillDirectories(params: {
    sourceRoot: string;
    pluginName: string;
    pluginRoot: string;
    generatedSkillsRoot: string;
    skills: GeneratedSkillMetadata[];
}): Promise<SkillSyncSummary> {
    const {sourceRoot, pluginName, pluginRoot, generatedSkillsRoot, skills} = params;
    await fs.mkdir(generatedSkillsRoot, {recursive: true});
    const parsedExistingMetadata = await readPluginSyncMetadata(pluginRoot);
    const existingMetadata = parsedExistingMetadata?.sourceRoot === sourceRoot
        && parsedExistingMetadata.pluginName === pluginName
        ? parsedExistingMetadata
        : null;
    const expectedGeneratedNames = new Set<string>();
    const copiedSkillNames = new Set<string>();
    const nextMetadata: PluginSyncMetadata = {
        sourceRoot,
        pluginName,
        syncedAt: new Date().toISOString(),
        skills: {},
    };
    const syncSummary = {
        copied: [] as string[],
        unchanged: [] as string[],
        removed: [] as string[],
        changed: false,
    };

    for (const skillDir of skills) {
        const generatedRelativeDir = path.relative(generatedSkillsRoot, skillDir.generatedSkillDir);
        // Defensive containment check before removing/copying: generated skill destinations
        // must stay under the generated plugin's skills directory.
        if (generatedRelativeDir.startsWith("..") || path.isAbsolute(generatedRelativeDir) || copiedSkillNames.has(generatedRelativeDir)) {
            continue;
        }
        copiedSkillNames.add(generatedRelativeDir);
        expectedGeneratedNames.add(generatedRelativeDir);

        const destination = skillDir.generatedSkillDir;
        const metadataEntry = existingMetadata?.skills[generatedRelativeDir];
        const generatedSkillExists = await pathExists(skillDir.generatedSkillPath);
        if (isSkillUnchanged(metadataEntry, skillDir) && generatedSkillExists) {
            syncSummary.unchanged.push(generatedRelativeDir);
            nextMetadata.skills[generatedRelativeDir] = metadataEntry;
            continue;
        }

        await fs.rm(destination, {recursive: true, force: true});
        await fs.cp(skillDir.sourceDir, destination, {recursive: true, force: true});
        nextMetadata.skills[generatedRelativeDir] = createPluginSyncSkillMetadata(skillDir);
        syncSummary.copied.push(generatedRelativeDir);
    }

    syncSummary.removed = await pruneStaleGeneratedSkills(generatedSkillsRoot, expectedGeneratedNames);
    syncSummary.changed = syncSummary.copied.length > 0 || syncSummary.removed.length > 0;
    await writePluginSyncMetadata(pluginRoot, nextMetadata);
    logger.log("Local skill marketplace sync completed", syncSummary);
    return syncSummary;
}

function isSkillUnchanged(
    metadataEntry: PluginSyncSkillMetadata | undefined,
    skill: GeneratedSkillMetadata
): metadataEntry is PluginSyncSkillMetadata {
    return metadataEntry !== undefined
        && metadataEntry.sourceDir === skill.sourceDir
        && metadataEntry.generatedSkillPath === skill.generatedSkillPath
        && metadataEntry.sourceLatestMtimeMs === skill.sourceLatestMtimeMs;
}

function createPluginSyncSkillMetadata(
    skill: GeneratedSkillMetadata
): PluginSyncSkillMetadata {
    return {
        sourceDir: skill.sourceDir,
        generatedSkillPath: skill.generatedSkillPath,
        sourceLatestMtimeMs: skill.sourceLatestMtimeMs,
    };
}

async function readLatestSourceMtimeMs(directory: string): Promise<number> {
    let latestMtimeMs = 0;
    const queue = [directory];
    while (queue.length > 0) {
        const currentDirectory = queue.shift()!;
        const directoryStat = await fs.stat(currentDirectory);
        latestMtimeMs = Math.max(latestMtimeMs, directoryStat.mtimeMs);
        const entries = await fs.readdir(currentDirectory, {withFileTypes: true});
        for (const entry of entries) {
            if (entry.name.startsWith(".")) {
                continue;
            }
            const entryPath = path.join(currentDirectory, entry.name);
            if (entry.isDirectory()) {
                queue.push(entryPath);
                continue;
            }
            if (entry.isFile() || entry.isSymbolicLink()) {
                const stat = await fs.stat(entryPath);
                latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs);
            }
        }
    }
    return latestMtimeMs;
}

async function readPluginSyncMetadata(pluginRoot: string): Promise<PluginSyncMetadata | null> {
    const metadataPath = path.join(pluginRoot, SYNC_METADATA_FILE_NAME);
    let contents: string;
    try {
        contents = await fs.readFile(metadataPath, "utf8");
    } catch (error) {
        if (isNotFoundError(error)) {
            return null;
        }
        throw error;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(contents);
    } catch {
        return null;
    }
    if (!isPluginSyncMetadata(parsed)) {
        return null;
    }
    return parsed;
}

async function writePluginSyncMetadata(pluginRoot: string, metadata: PluginSyncMetadata): Promise<void> {
    await fs.writeFile(
        path.join(pluginRoot, SYNC_METADATA_FILE_NAME),
        `${JSON.stringify(metadata, null, 2)}\n`,
        "utf8"
    );
}

async function pruneStaleGeneratedSkills(
    generatedSkillsRoot: string,
    expectedGeneratedNames: Set<string>
): Promise<string[]> {
    const removed: string[] = [];
    const generatedSkillDirs = await readGeneratedSkillDirs(generatedSkillsRoot);
    for (const generatedSkillDir of generatedSkillDirs) {
        const relativeDir = path.relative(generatedSkillsRoot, generatedSkillDir);
        if (expectedGeneratedNames.has(relativeDir)) {
            continue;
        }
        await fs.rm(generatedSkillDir, {recursive: true, force: true});
        removed.push(relativeDir);
    }
    return removed;
}

async function readGeneratedSkillDirs(generatedSkillsRoot: string): Promise<string[]> {
    const skillDirs: string[] = [];
    const queue = [generatedSkillsRoot];
    while (queue.length > 0) {
        const currentDirectory = queue.shift()!;
        const entries = await fs.readdir(currentDirectory, {withFileTypes: true});
        for (const entry of entries) {
            if (entry.name.startsWith(".")) {
                continue;
            }
            const entryPath = path.join(currentDirectory, entry.name);
            if (entry.isDirectory()) {
                queue.push(entryPath);
                continue;
            }
            if (entry.isFile() && entry.name === CODEX_SKILL_FILE_NAME) {
                skillDirs.push(currentDirectory);
            }
        }
    }
    return skillDirs;
}

async function writePluginManifest(pluginRoot: string, pluginName: string, sourceRoot: string): Promise<void> {
    const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
    await fs.mkdir(path.dirname(manifestPath), {recursive: true});
    const manifest = {
        name: pluginName,
        version: "1.0.0",
        description: `Generated skills-only plugin from ${sourceRoot}.`,
        skills: "./skills/",
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function ensureMarketplaceEntry(params: {
    marketplacePath: string;
    marketplaceName: string;
    pluginName: string;
    pluginSourcePath: string;
}): Promise<void> {
    const manifest = await readMarketplaceManifest(params.marketplacePath, params.marketplaceName);
    const entry = createMarketplacePluginEntry(params.pluginName, params.pluginSourcePath);
    const existingIndex = manifest.plugins.findIndex((plugin) => plugin.name === params.pluginName);
    if (existingIndex >= 0) {
        manifest.plugins[existingIndex] = entry;
    } else {
        manifest.plugins.push(entry);
    }

    await fs.mkdir(path.dirname(params.marketplacePath), {recursive: true});
    await fs.writeFile(params.marketplacePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function readMarketplaceManifest(
    marketplacePath: string,
    marketplaceName: string
): Promise<MarketplaceManifest> {
    let contents: string;
    try {
        contents = await fs.readFile(marketplacePath, "utf8");
    } catch (error) {
        if (isNotFoundError(error)) {
            return createMarketplaceManifest(marketplaceName);
        }
        throw error;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(contents);
    } catch (error) {
        throw new Error(`invalid marketplace JSON at ${marketplacePath}: ${formatError(error)}`);
    }

    if (!isMarketplaceManifest(parsed)) {
        throw new Error(`invalid marketplace manifest shape at ${marketplacePath}`);
    }

    return parsed;
}

function createMarketplaceManifest(marketplaceName: string): MarketplaceManifest {
    return {
        name: marketplaceName,
        interface: {
            displayName: marketplaceName,
        },
        plugins: [],
    };
}

function createMarketplacePluginEntry(pluginName: string, pluginSourcePath: string): MarketplacePluginEntry {
    return {
        name: pluginName,
        source: {
            source: "local",
            path: pluginSourcePath,
        },
        policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
        },
        category: "Productivity",
    };
}

function isMarketplaceManifest(value: unknown): value is MarketplaceManifest {
    if (!isRecord(value) || typeof value["name"] !== "string" || !Array.isArray(value["plugins"])) {
        return false;
    }
    const marketplaceInterface = value["interface"];
    return marketplaceInterface === undefined || marketplaceInterface === null || isRecord(marketplaceInterface);
}

function isPluginSyncMetadata(value: unknown): value is PluginSyncMetadata {
    return isRecord(value)
        && typeof value["sourceRoot"] === "string"
        && typeof value["pluginName"] === "string"
        && typeof value["syncedAt"] === "string"
        && isRecord(value["skills"])
        && Object.values(value["skills"]).every(isPluginSyncSkillMetadata);
}

function isPluginSyncSkillMetadata(value: unknown): value is PluginSyncSkillMetadata {
    return isRecord(value)
        && typeof value["sourceDir"] === "string"
        && typeof value["generatedSkillPath"] === "string"
        && typeof value["sourceLatestMtimeMs"] === "number";
}

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fs.stat(filePath);
        return true;
    } catch (error) {
        if (isNotFoundError(error)) {
            return false;
        }
        throw error;
    }
}
