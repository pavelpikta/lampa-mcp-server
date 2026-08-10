#!/usr/bin/env node
/**
 * Local stdio entrypoint for Cursor / Claude Desktop.
 * For the remote Cloudflare Worker, see src/worker.ts.
 */
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { getConfig } from "./config.js";
import { createLampaServer } from "./server.js";

const config = getConfig();
const server = createLampaServer(config);
const transport = new StdioServerTransport();
await server.connect(transport);
