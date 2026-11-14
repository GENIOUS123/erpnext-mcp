// Cloudflare environment contract for GitHub OAuth and ERPNext read-only access.
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
declare global {
  interface Env {
    ERP_BASE_URL: string;
    MCP_PUBLIC_ORIGIN: string;
    ERP_API_KEY: string;
    ERP_API_SECRET: string;
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    GITHUB_ALLOWED_USER_ID: string;
    COOKIE_ENCRYPTION_KEY: string;
    OAUTH_KV: KVNamespace;
    OAUTH_PROVIDER: OAuthHelpers;
  }
}
export {};
