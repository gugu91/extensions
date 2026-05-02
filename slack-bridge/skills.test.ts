import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.join(packageDir, "skills", "pinet-skin-creator");

function readSkillFile(relativePath: string): string {
  return readFileSync(path.join(skillDir, relativePath), "utf8");
}

describe("bundled skills", () => {
  it("declares the package skills directory for pi packaging", () => {
    const packageJson = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
      files?: string[];
      pi?: { skills?: string[] };
    };

    expect(packageJson.files).toContain("skills/");
    expect(packageJson.pi?.skills).toContain("./skills");
  });

  it("packages a Pinet skin creator skill with required references", () => {
    const skill = readSkillFile("SKILL.md");

    expect(skill).toContain("name: pinet-skin-creator");
    expect(skill).toContain(
      "description: Guides safe creation and editing of Pinet skin descriptors",
    );
    expect(skill).toContain("Default/classic stays random");
    expect(skill).toContain("No LLM in startup/join");
    expect(skill).toContain("references/descriptor-format.md");
    expect(skill).toContain("references/safety-checklist.md");
    expect(skill).toContain("templates/pinet-skin-descriptor.json");

    expect(readSkillFile("references/descriptor-format.md")).toContain("statusVocabulary");
    expect(readSkillFile("references/safety-checklist.md")).toContain(
      "No LLM/model/API call is required during extension startup",
    );
  });

  it("includes a valid descriptor template with role-specific curated characters", () => {
    const template = JSON.parse(readSkillFile("templates/pinet-skin-descriptor.json")) as {
      key?: string;
      fallback?: string;
      roles?: Record<
        string,
        {
          characterPool?: string[];
          namePattern?: string;
        }
      >;
      characters?: Record<string, { name?: string; emoji?: string; persona?: string }>;
      statusVocabulary?: Record<string, string>;
    };

    expect(template.key).toBe("example-skin");
    expect(template.fallback).toBe("default");
    expect(Object.keys(template.roles ?? {}).sort()).toEqual([
      "broker",
      "pm",
      "reviewer",
      "worker",
    ]);
    expect(template.roles?.worker.characterPool?.length).toBeGreaterThanOrEqual(2);
    expect(template.roles?.worker.namePattern).toBe("{character}");
    expect(template.characters?.["broker-signal-warden"]).toMatchObject({
      name: "Signal Warden",
      emoji: "🧭",
    });
    expect(template.characters?.["broker-signal-warden"].persona).toContain("coordinator");
    expect(template.statusVocabulary?.healthy).toBe("signal clear");
  });
});
