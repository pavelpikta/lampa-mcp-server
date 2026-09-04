import { McpServer } from "@modelcontextprotocol/server";
import type { Config } from "./config.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerAnalysisTools } from "./tools/analysis.js";
import { registerPlanningTools } from "./tools/planning.js";
import { registerEditingTools } from "./tools/editing.js";
import { registerValidationTools } from "./tools/validation.js";
import { registerLampaDeepTools } from "./tools/lampa_deep.js";
import { registerCubTools } from "./tools/cub.js";
import { registerExternalApiTools } from "./tools/external_api.js";
import { registerPluginCatalogTools } from "./tools/plugin_catalog.js";
import { registerResources } from "./resources/index.js";
import pkg from "../package.json" with { type: "json" };

const INSTRUCTIONS = `Lampa MCP helps agents understand and change the Lampa TV app source (local checkout or R2 snapshot). Tools are read-only: they never write the repo. Do not edit public/ or build/ — call resolve_edit_path first.

Preferred loop:
summarize_repo → explain_docs(mode=plugin_docs) | analyze_plugin
  → search_code | list_catalog | trace_symbol
  → resolve_edit_path → plan_change → scaffold_plugin | draft_patch
  → validate_code

CUB cloud work: guide_cub (topic=auth → catalog → sync). For CUB mirrors in source, list_catalog topic=mirrors.
Third-party content APIs (TMDB/KinoPoisk/Alloha/MDBList/Jackett/TorrServer/Jellyfin): guide_external_api. Shipping a plugin into the real catalog: guide_plugin_catalog.
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
  registerExternalApiTools(server, config);
  registerPluginCatalogTools(server, config);
  registerResources(server, config);

  return server;
}
