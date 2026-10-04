import type { ToolSpec } from "./registry.js";
import type { SkillCatalog } from "../skills/types.js";

interface SkillArgs {
  name: string;
}

/** Build the `skill` tool from a catalog. The catalog is captured by closure
 *  so the tool can be re-registered when the active skill set changes. */
export function makeSkillTool(getCatalog: () => SkillCatalog | null): ToolSpec<SkillArgs> {
  return {
    name: "skill",
    description: [
      "Load the full instructions for a named skill (an `agentskills`-spec SKILL.md playbook).",
      "Call this when the session prefix lists a skill that matches what the user is asking for —",
      "the catalog only shows name + description; the body holds the actual guidance.",
      "Pass the exact `name` (e.g. 'cloudflare-worker-deploy'). Returns the raw markdown body.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The kebab-case name of the skill to load.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    needsPermission: false,
    render: ({ name }) => ({ title: `skill ${name}` }),
    async run(args) {
      const catalog = getCatalog();
      if (!catalog) {
        return "No skills are available in this session.";
      }
      const requested = (args.name ?? "").trim();
      if (!requested) {
        return errorWithList(catalog, "Error: skill name is required.");
      }
      const record = catalog.get(requested);
      if (!record) {
        return errorWithList(catalog, `Error: unknown skill "${requested}".`);
      }
      return record.body;
    },
  };
}

function errorWithList(catalog: SkillCatalog, prefix: string): string {
  const names = catalog
    .list()
    .map((r) => r.name)
    .sort();
  if (names.length === 0) return `${prefix} No skills are loaded.`;
  return `${prefix} Available skills: ${names.join(", ")}.`;
}
