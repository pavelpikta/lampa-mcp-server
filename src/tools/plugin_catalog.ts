import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config.js";
import {
  MANIFEST_SCHEMA_NOTES,
  OBFUSCATION_NOTES,
  ROUTING_NOTES,
  FUNCTIONS_API_NOTES,
  PUBLISHING_CHECKLIST,
} from "../utils/plugin_catalog.js";
import { READ_ONLY_SNAPSHOT, ok, reportOutput } from "./meta.js";

export function registerPluginCatalogTools(server: McpServer, _config: Config): void {
  server.registerTool(
    "guide_plugin_catalog",
    {
      title: "Guide to publishing plugins into the real Lampa plugin catalog",
      description:
        "Document how the separate lampa-plugins repository turns plugin source files into the live catalog agents install into Lampa: the extension.json/plugin-manifest.json schema, the obfuscation presets, Cloudflare Pages Functions routing, and a step-by-step publishing checklist. Curated from that repo's scripts/ and functions/, not from the Lampa app source \u2014 unlike `validate_code` (lints one plugin's code against Lampa conventions) and `scaffold_plugin` (emits new-plugin boilerplate text), this tool covers packaging and distribution once the plugin already works.\\nEach `topic` takes no other parameters and returns a fixed reference document \u2014 it does not read this repo's snapshot and never writes files.",
      inputSchema: {
        topic: z
          .enum(["manifest", "obfuscation", "routing", "functions_api", "publishing_checklist"])
          .describe(
            "manifest=extension.json/plugin-manifest.json schema; obfuscation=javascript-obfuscator presets; routing=Cloudflare Pages _routes.json/_headers; functions_api=the three Pages Functions endpoints; publishing_checklist=ordered steps to ship a new plugin."
          ),
      },
      outputSchema: reportOutput,
      annotations: READ_ONLY_SNAPSHOT,
    },
    ({ topic }) => {
      switch (topic) {
        case "manifest":
          return ok(MANIFEST_SCHEMA_NOTES);
        case "obfuscation":
          return ok(OBFUSCATION_NOTES);
        case "routing":
          return ok(ROUTING_NOTES);
        case "functions_api":
          return ok(FUNCTIONS_API_NOTES);
        case "publishing_checklist":
          return ok(PUBLISHING_CHECKLIST);
      }
    }
  );
}
