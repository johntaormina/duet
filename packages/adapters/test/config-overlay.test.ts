import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAssetResolver, DEFAULT_CONFIG, loadAdapters, loadConfig } from "../src/index.ts";

function tmp(name: string) {
  return mkdtempSync(join(tmpdir(), `duet-${name}-`));
}

describe("configuration", () => {
  // @spec ADPT-CFG-001
  it("resolves settings from defaults, user, repository, overlay, then flags, each overriding the last", () => {
    const home = tmp("home");
    const repo = tmp("repo");
    const overlay = tmp("overlay");
    mkdirSync(join(home, "duet"), { recursive: true });
    writeFileSync(join(home, "duet", "config.json"), JSON.stringify({ concurrency: 2, confidenceThreshold: 70, contextBudget: 5000 }));
    writeFileSync(join(repo, "duet.config.yaml"), `confidenceThreshold: 75\noverlay: ${overlay}\nstakes:\n  infra-ci: low\n`);
    writeFileSync(join(overlay, "config.json"), JSON.stringify({ confidenceThreshold: 85, contextBudget: 9000 }));
    const cfg = loadConfig({ repoRoot: repo, userConfigDir: home, flags: { contextBudget: 1234 } });
    expect(cfg.concurrency).toBe(2);
    expect(cfg.confidenceThreshold).toBe(85);
    expect(cfg.contextBudget).toBe(1234);
    expect(cfg.stakes["infra-ci"]).toBe("low");
    expect(cfg.root).toBe(DEFAULT_CONFIG.root);
  });

  // @spec ADPT-CFG-002
  it("covers every setting the design lists", () => {
    for (const key of ["root", "stages", "concurrency", "confidenceThreshold", "stakes", "generatedPaths", "resolvers",
      "toolOutput", "reviewer", "defaultSource", "overlay", "claudeArgs"]) {
      expect(DEFAULT_CONFIG, key).toHaveProperty(key);
    }
    expect(DEFAULT_CONFIG.concurrency).toBe(3);
    expect(DEFAULT_CONFIG.confidenceThreshold).toBe(80);
  });
});

describe("overlay", () => {
  function layout() {
    const core = tmp("core");
    const overlay = tmp("ovl");
    mkdirSync(join(core, "prompts"), { recursive: true });
    mkdirSync(join(overlay, "prompts"), { recursive: true });
    writeFileSync(join(core, "prompts", "briefing.md"), "core briefing");
    writeFileSync(join(core, "prompts", "cards.md"), "core cards");
    writeFileSync(join(overlay, "prompts", "cards.md"), "overlay cards");
    return { core, overlay };
  }

  // @spec ADPT-OVL-001
  it("uses an overlay file in place of the core file at the same relative path", () => {
    const { core, overlay } = layout();
    expect(createAssetResolver(core, overlay).read("prompts/cards.md")).toBe("overlay cards");
  });

  // @spec ADPT-OVL-002
  it("falls through to the core file when the overlay lacks the path", () => {
    const { core, overlay } = layout();
    const assets = createAssetResolver(core, overlay);
    expect(assets.read("prompts/briefing.md")).toBe("core briefing");
    expect(createAssetResolver(core, null).read("prompts/cards.md")).toBe("core cards");
  });

  // @spec ADPT-OVL-003, ADPT-SRC-008
  it("loads sources, sinks, caller resolvers, and tool-output providers from overlay modules", async () => {
    const overlay = tmp("ovl-mod");
    mkdirSync(join(overlay, "adapters"));
    writeFileSync(
      join(overlay, "adapters", "work.js"),
      `export const sources = [{ name: "mcp", resolve: async () => ({}) }];
       export const sinks = [{ name: "mcp-sink", send: async () => ({ ok: true }) }];
       export const resolvers = [{ ecosystem: "dbt", matches: () => true, callers: async () => [] }];
       export const toolOutput = [{ name: "plan", produce: async () => "plan output" }];`,
    );
    const reg = await loadAdapters({ overlay, modules: [] });
    expect(reg.sources.map((s) => s.name)).toContain("mcp");
    expect(reg.sinks.map((s) => s.name)).toContain("mcp-sink");
    expect(reg.resolvers.map((r) => r.ecosystem)).toEqual(["dbt"]);
    expect(reg.toolOutput.map((t) => t.name)).toEqual(["plan"]);
  });
});
