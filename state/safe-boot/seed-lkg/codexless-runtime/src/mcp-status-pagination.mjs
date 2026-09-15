const DEFAULT_PAGE_LIMIT = 50;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_SERVERS = 5_000;

export async function listAllMcpServerStatus(
  requestPage,
  {
    detail = "toolsAndAuthOnly",
    limit = DEFAULT_PAGE_LIMIT,
    maxPages = DEFAULT_MAX_PAGES,
    maxServers = DEFAULT_MAX_SERVERS,
  } = {}
) {
  if (typeof requestPage !== "function") throw new Error("requestPage must be a function");
  if (!Number.isInteger(limit) || limit < 1) throw new Error("MCP status page limit must be a positive integer");
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("MCP status maxPages must be a positive integer");
  if (!Number.isInteger(maxServers) || maxServers < 1) throw new Error("MCP status maxServers must be a positive integer");

  const data = [];
  const seenCursors = new Set();
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    const params = { detail, limit, ...(cursor === null ? {} : { cursor }) };
    const result = await requestPage(params);
    if (!Array.isArray(result?.data)) throw new Error("mcpServerStatus/list returned invalid data");
    data.push(...result.data);
    if (data.length > maxServers) throw new Error(`mcpServerStatus/list exceeded ${maxServers} servers`);

    const nextCursor = result?.nextCursor ?? null;
    if (nextCursor === null) return { data, nextCursor: null };
    if (typeof nextCursor !== "string" || !nextCursor) {
      throw new Error("mcpServerStatus/list returned an invalid nextCursor");
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error("mcpServerStatus/list repeated a pagination cursor");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error(`mcpServerStatus/list exceeded ${maxPages} pages`);
}
