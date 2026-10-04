export type SkillScope = "project" | "user" | "registry";

export interface SkillRecord {
  /** Kebab-case skill name (must match parent directory). */
  name: string;
  /** Short description shown in the catalog (≤1024 chars per spec). */
  description: string;
  /** Full markdown body of `SKILL.md` (frontmatter stripped). */
  body: string;
  /** Absolute path to the `SKILL.md` file on disk. */
  path: string;
  /** Where the skill came from. */
  scope: SkillScope;
  license?: string;
  compatibility?: string;
  /** Experimental `allowed-tools` field from the spec. */
  allowedTools?: string[];
  /** Free-form metadata block (tags, etc.). */
  metadata?: Record<string, unknown>;
}

export interface SkillCatalog {
  get(name: string): SkillRecord | undefined;
  list(): SkillRecord[];
  byScope(scope: SkillScope): SkillRecord[];
}

export class InMemorySkillCatalog implements SkillCatalog {
  private byName = new Map<string, SkillRecord>();

  constructor(records: SkillRecord[]) {
    for (const r of records) this.byName.set(r.name, r);
  }

  get(name: string): SkillRecord | undefined {
    return this.byName.get(name);
  }

  list(): SkillRecord[] {
    return [...this.byName.values()];
  }

  byScope(scope: SkillScope): SkillRecord[] {
    return this.list().filter((r) => r.scope === scope);
  }
}
