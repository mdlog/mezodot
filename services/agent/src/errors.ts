/** Longest error text the agent returns or logs for one failure. */
const MAX_ERROR_LENGTH = 300;

const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>`]+/gi;

/** Replaces every URL in `text`: RPC and webhook URLs often carry API keys in their path or query. */
export const redactUrls = (text: string): string => text.replace(URL_PATTERN, '[url]');

/**
 * One-line, URL-free description of an error, safe to return over HTTP/MCP and to log. viem puts the RPC URL
 * (and the request body) in `message` after the first line; `shortMessage` is its clean summary.
 */
export function publicError(err: unknown): string {
  const short = err && typeof err === 'object' && 'shortMessage' in err && typeof err.shortMessage === 'string' ? err.shortMessage : undefined;
  const raw = short ?? (err instanceof Error ? err.message : String(err));
  const line = redactUrls(raw.split('\n')[0] ?? '').trim() || (err instanceof Error ? err.name : 'Error');
  return line.length > MAX_ERROR_LENGTH ? `${line.slice(0, MAX_ERROR_LENGTH - 1)}…` : line;
}

/** Host of a URL for logs (`https://rpc.example/v2/KEY` → `rpc.example`), or `[invalid url]`. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '[invalid url]';
  }
}
