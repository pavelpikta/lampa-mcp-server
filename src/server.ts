import { McpServer } from "@modelcontextprotocol/server";
import type { Config } from "./config.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerAnalysisTools } from "./tools/analysis.js";
import { registerPlanningTools } from "./tools/planning.js";
import { registerEditingTools } from "./tools/editing.js";
import { registerValidationTools } from "./tools/validation.js";
import { registerLampaDeepTools } from "./tools/lampa_deep.js";
import { registerCubTools } from "./tools/cub.js";
import { registerResources } from "./resources/index.js";
import pkg from "../package.json" with { type: "json" };

const INSTRUCTIONS = `Lampa MCP helps agents understand and change the Lampa TV app source (local checkout or R2 snapshot). Tools are read-only: they never write the repo. Do not edit public/ or build/ — call resolve_edit_path first.

Preferred loop:
repo_overview → explain_lampa(mode=plugin_docs) | plugin_deep_dive
  → search_code | map_lampa | trace_lampa
  → resolve_edit_path → plan_change → scaffold_plugin | draft_patch
  → validate_code

CUB cloud work: cub_guide (topic=auth → catalog → sync). For CUB mirrors in source, map_lampa topic=mirrors.
Stdio: LAMPA_REPO_PATH. Worker: GitHub PAT is transport auth only; tools still read the snapshot.`;

export function createLampaServer(config: Config): McpServer {
  const server = new McpServer({
    name: "lampa-mcp-server",
    version: pkg.version,
    title: "Lampa source development assistant",
    description: INSTRUCTIONS,
  });

  registerDiscoveryTools(server, config);
  registerAnalysisTools(server, config);
  registerLampaDeepTools(server, config);
  registerPlanningTools(server, config);
  registerEditingTools(server, config);
  registerValidationTools(server, config);
  registerCubTools(server, config);
  registerResources(server, config);

  return server;
}
