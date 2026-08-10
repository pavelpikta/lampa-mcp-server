import { Hono } from "hono";

export type AuthProps = {
  login: string;
  name: string;
  email: string;
};

type Env = {
  ALLOWED_GITHUB_USERS?: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => {
  return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Lampa MCP</title>
<style>
body{font-family:system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;line-height:1.5}
code{background:#f4f4f5;padding:2px 6px;border-radius:4px}
.endpoint{background:#f4f4f5;padding:10px 12px;border-radius:6px;margin:8px 0;font-family:ui-monospace,monospace}
</style></head><body>
<h1>Lampa MCP Server</h1>
<p>Remote MCP for the Lampa TV app source tree. Authenticate with a <strong>GitHub Personal Access Token</strong> (classic <code>ghp_…</code> or fine-grained <code>github_pat_…</code>).</p>
<p>Send it as <code>Authorization: Bearer &lt;token&gt;</code> on requests to <code>/mcp</code>. Minimum scope: <code>read:user</code>.</p>
<div class="endpoint">POST /mcp — MCP Streamable HTTP (GitHub PAT Bearer required)</div>
</body></html>`);
});

app.get("/authorize", (c) => {
  return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Lampa MCP Auth</title>
<style>
body{font-family:system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;line-height:1.5}
code{background:#f4f4f5;padding:2px 6px;border-radius:4px}
</style></head><body>
<h1>Use a GitHub PAT</h1>
<p>This server does not use a GitHub OAuth App. Create a Personal Access Token with <code>read:user</code>, then configure your MCP client to send:</p>
<pre>Authorization: Bearer ghp_…</pre>
<p><a href="https://github.com/settings/tokens">Create a token on GitHub</a></p>
</body></html>`);
});

/**
 * Validate a GitHub PAT by calling the GitHub API.
 * Returns auth props on success, otherwise null.
 * Does not echo or require storing the raw PAT in props.
 */
export async function resolveGitHubPat(
  token: string,
  env: { ALLOWED_GITHUB_USERS?: string }
): Promise<AuthProps | null> {
  if (!token || token.length < 8) return null;

  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "lampa-mcp-server",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) return null;

  const user = (await res.json()) as {
    login?: string;
    name?: string | null;
    email?: string | null;
  };

  if (!user.login) return null;

  const allowlist = (env.ALLOWED_GITHUB_USERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (allowlist.length > 0 && !allowlist.includes(user.login.toLowerCase())) {
    return null;
  }

  return {
    login: user.login,
    name: user.name ?? user.login,
    email: user.email ?? "",
  };
}

export { app as PublicHandler };
