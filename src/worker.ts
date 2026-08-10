import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import type { Config } from "./config.js";
import { R2RepoFs } from "./fs/r2.js";
import { createLampaServer } from "./server.js";
import { PublicHandler, resolveGitHubPat } from "./auth/github-handler.js";

export interface WorkerEnv {
  LAMPA_SOURCE: R2Bucket;
  OAUTH_KV: KVNamespace;
  /** Optional comma-separated GitHub logins allowed to use the MCP server. */
  ALLOWED_GITHUB_USERS?: string;
  SNAPSHOT_PREFIX?: string;
}

function workerConfig(env: WorkerEnv): Config {
  const prefix = env.SNAPSHOT_PREFIX ?? "lampa/";
  return {
    fs: new R2RepoFs(env.LAMPA_SOURCE, prefix),
    label: `r2://lampa-source/${prefix}`,
    docsPath: "build/doc",
  };
}

function createServer(env: WorkerEnv) {
  const config = workerConfig(env);
  const server = createLampaServer(config);

  server.registerTool(
    "whoami",
    {
      description: "Return the authenticated GitHub user for this MCP session.",
      inputSchema: {},
    },
    async () => {
      const auth = getMcpAuthContext();
      const props = auth?.props as
        | { login?: string; name?: string; email?: string }
        | undefined;
      if (!props?.login) {
        return {
          content: [{ type: "text" as const, text: "Not authenticated." }],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { login: props.login, name: props.name, email: props.email },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  return server;
}

const apiHandler = {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    return createMcpHandler(() => createServer(env), {
      route: "/mcp",
    })(request, env, ctx);
  },
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler: {
    fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
      return PublicHandler.fetch(request, env, ctx);
    },
  },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: {
    scopes_supported: ["mcp:read"],
  },
  /**
   * Accept a GitHub PAT in `Authorization: Bearer <token>`.
   * No GitHub OAuth App (client id/secret) is required.
   */
  resolveExternalToken: async ({ token, env }) => {
    const props = await resolveGitHubPat(token, env);
    if (!props) return null;
    return { props };
  },
});
