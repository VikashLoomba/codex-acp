import {promises as fs} from "node:fs";
import type {Dirent} from "node:fs";
import path from "node:path";
import {parse as parseYaml} from "yaml";
import {formatError, isNotFoundError, isRecord} from "./TypeGuards";

export const CODEX_SKILL_FILE_NAME = "SKILL.md";
export const CODEX_SKILL_METADATA_DIR_NAME = "agents";
export const CODEX_SKILL_METADATA_FILE_NAME = "openai.yaml";
export const CODEX_SKILL_MAX_SCAN_DEPTH = 6;

export type ParsedSkillInterface = {
    displayName?: string;
    shortDescription?: string;
    brandColor?: string;
    defaultPrompt?: string;
};

export type ParsedSkill = {
    name: string;
    description: string;
    shortDescription?: string;
    interface?: ParsedSkillInterface;
    path: string;
    scope: "user";
    enabled: true;
};

export type ParsedSkillError = {
    path: string;
    message: string;
};

export type ParsedSkillLoadResult = {
    skills: ParsedSkill[];
    errors: ParsedSkillError[];
};

type QueueEntry = {
    directory: string;
    depth: number;
};

/**
 * Reads Codex skills from a local skills directory using the same core filesystem conventions as
 * codex app-server: skills are declared by files named exactly `SKILL.md`, with metadata in YAML
 * frontmatter and optional UI metadata in `agents/openai.yaml`.
 */
export async function parseSkillsFromDirectory(rootDir: string): Promise<ParsedSkillLoadResult> {
    const root = path.resolve(rootDir);
    const skills: ParsedSkill[] = [];
    const errors: ParsedSkillError[] = [];
    const queue: QueueEntry[] = [{directory: root, depth: 0}];
    const visitedDirectories = new Set<string>();

    while (queue.length > 0) {
        const entry = queue.shift()!;
        const directory = await canonicalizePath(entry.directory);
        if (visitedDirectories.has(directory)) {
            continue;
        }
        visitedDirectories.add(directory);

        let children: Dirent[];
        try {
            children = await fs.readdir(directory, {withFileTypes: true});
        } catch (err) {
            if (entry.depth === 0 && isNotFoundError(err)) {
                return {skills, errors};
            }
            errors.push({
                path: directory,
                message: `failed to read skills dir: ${formatError(err)}`,
            });
            continue;
        }

        for (const child of children) {
            if (child.name.startsWith(".")) {
                continue;
            }

            const childPath = path.join(directory, child.name);
            if (child.isDirectory()) {
                enqueueDirectory(queue, childPath, entry.depth + 1);
                continue;
            }

            if (child.isSymbolicLink()) {
                await enqueueSymlinkedDirectory(queue, childPath, entry.depth + 1);
                continue;
            }

            if (!child.isFile() || child.name !== CODEX_SKILL_FILE_NAME) {
                continue;
            }

            try {
                skills.push(await parseSkillFile(childPath));
            } catch (err) {
                errors.push({
                    path: childPath,
                    message: formatError(err),
                });
            }
        }
    }

    skills.sort((left, right) => {
        const byName = left.name.localeCompare(right.name);
        return byName !== 0 ? byName : left.path.localeCompare(right.path);
    });
    return {skills, errors};
}

async function parseSkillFile(skillPath: string): Promise<ParsedSkill> {
    const contents = await fs.readFile(skillPath, "utf8");
    const frontmatter = extractFrontmatter(contents);
    if (frontmatter === null) {
        throw new Error("missing YAML frontmatter delimited by ---");
    }

    const metadata = parseYamlRecord(frontmatter);
    const rawName = readYamlString(metadata, ["name"]);
    const name = sanitizeSingleLine(rawName ?? path.basename(path.dirname(skillPath)));
    const description = sanitizeSingleLine(readYamlString(metadata, ["description"]) ?? "");
    const shortDescription = optionalSanitizedValue(readYamlString(metadata, ["metadata", "short-description"]));
    const resolvedPath = await canonicalizePath(skillPath);
    const skillInterface = await readSkillInterface(path.dirname(skillPath));

    return {
        name: name.length > 0 ? name : "skill",
        description,
        ...(shortDescription !== undefined ? {shortDescription} : {}),
        ...(skillInterface !== undefined ? {interface: skillInterface} : {}),
        path: resolvedPath,
        scope: "user",
        enabled: true,
    };
}

function enqueueDirectory(queue: QueueEntry[], directory: string, depth: number): void {
    if (depth > CODEX_SKILL_MAX_SCAN_DEPTH) {
        return;
    }
    queue.push({directory, depth});
}

async function enqueueSymlinkedDirectory(
    queue: QueueEntry[],
    symlinkPath: string,
    depth: number
): Promise<void> {
    if (depth > CODEX_SKILL_MAX_SCAN_DEPTH) {
        return;
    }
    try {
        const stat = await fs.stat(symlinkPath);
        if (stat.isDirectory()) {
            queue.push({directory: symlinkPath, depth});
        }
    } catch {
        // Codex ignores broken symlinked skill entries during discovery.
    }
}

async function readSkillInterface(skillDir: string): Promise<ParsedSkillInterface | undefined> {
    const metadataPath = path.join(
        skillDir,
        CODEX_SKILL_METADATA_DIR_NAME,
        CODEX_SKILL_METADATA_FILE_NAME
    );

    let metadata: string;
    try {
        metadata = await fs.readFile(metadataPath, "utf8");
    } catch {
        return undefined;
    }

    let metadataRoot: Record<string, unknown>;
    try {
        metadataRoot = parseYamlRecord(metadata);
    } catch {
        return undefined;
    }

    const displayName = optionalSanitizedValue(readYamlString(metadataRoot, ["interface", "display_name"]));
    const shortDescription = optionalSanitizedValue(readYamlString(metadataRoot, ["interface", "short_description"]));
    const brandColor = optionalSanitizedValue(readYamlString(metadataRoot, ["interface", "brand_color"]));
    const defaultPrompt = optionalSanitizedValue(readYamlString(metadataRoot, ["interface", "default_prompt"]));
    const skillInterface = {
        ...(displayName !== undefined ? {displayName} : {}),
        ...(shortDescription !== undefined ? {shortDescription} : {}),
        ...(brandColor !== undefined ? {brandColor} : {}),
        ...(defaultPrompt !== undefined ? {defaultPrompt} : {}),
    };

    return Object.keys(skillInterface).length > 0 ? skillInterface : undefined;
}

function parseYamlRecord(contents: string): Record<string, unknown> {
    const parsed = parseYaml(contents, {
        schema: "failsafe",
        stringKeys: true,
        maxAliasCount: 0,
    });
    if (!isRecord(parsed)) {
        return {};
    }
    return parsed;
}

function readYamlString(root: Record<string, unknown>, pathSegments: string[]): string | undefined {
    const dottedKey = pathSegments.join(".");
    const directValue = root[dottedKey];
    if (typeof directValue === "string") {
        return directValue;
    }

    let current: unknown = root;
    for (const segment of pathSegments) {
        if (!isRecord(current)) {
            return undefined;
        }
        current = current[segment];
    }
    return typeof current === "string" ? current : undefined;
}

function extractFrontmatter(contents: string): string | null {
    const lines = contents.split(/\r?\n/);
    if (lines[0]?.trim() !== "---") {
        return null;
    }

    const frontmatterLines: string[] = [];
    for (let index = 1; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (line.trim() === "---") {
            return frontmatterLines.length > 0 ? frontmatterLines.join("\n") : null;
        }
        frontmatterLines.push(line);
    }
    return null;
}

function optionalSanitizedValue(value: string | undefined): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    const sanitized = sanitizeSingleLine(value);
    return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizeSingleLine(value: string): string {
    return value.trim().replace(/\s+/g, " ");
}

async function canonicalizePath(filePath: string): Promise<string> {
    try {
        return await fs.realpath(filePath);
    } catch {
        return path.resolve(filePath);
    }
}
