import { McpServer } from "@modelcontextprotocol/server";
import type { Config } from "./config.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerAnalysisTools } from "./tools/analysis.js";
import { registerPlanningTools } from "./tools/planning.js";
import { registerEditingTools } from "./tools/editing.js";
import { registerValidationTools } from "./tools/validation.js";
import { registerLampaDeepTools } from "./tools/lampa_deep.js";
import { registerAdvancedTools } from "./tools/advanced.js";
import { registerLampaModernTools } from "./tools/lampa_modern.js";
import { registerCubTools } from "./tools/cub.js";
import { registerResources } from "./resources/index.js";

export function createLampaServer(config: Config): McpServer {
  const server = new McpServer({
    name: "lampa-mcp-server",
    version: "1.2.0",
  });

  registerDiscoveryTools(server, config);
  registerAnalysisTools(server, config);
  registerPlanningTools(server, config);
  registerEditingTools(server, config);
  registerValidationTools(server, config);
  registerLampaDeepTools(server, config);
  registerAdvancedTools(server, config);
  registerLampaModernTools(server, config);
  registerCubTools(server, config);
  registerResources(server, config);

  return server;
}
