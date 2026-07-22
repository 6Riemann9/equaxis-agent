import { selectWithinBudget } from "./context-budget.mjs";

const DEFAULT_TOOLS = [
  { name: "read", namespace: "workspace", summary: "Read a text file inside the current workspace.", keywords: ["read", "file", "文件", "查看"] },
  { name: "write", namespace: "workspace", summary: "Create or replace a workspace file.", keywords: ["write", "create", "file", "写入", "创建"] },
  { name: "edit", namespace: "workspace", summary: "Apply a targeted edit to a workspace file.", keywords: ["edit", "patch", "modify", "修改", "编辑"] },
  { name: "bash", namespace: "execution", summary: "Run a shell command in the current workspace.", keywords: ["shell", "command", "terminal", "命令", "执行"] },
  { name: "web_crawl", namespace: "web", summary: "Fetch public HTTP(S) pages with SSRF and redirect checks.", keywords: ["web", "http", "url", "网页", "抓取"] },
  { name: "memory_search", namespace: "memory", summary: "Search durable semantic memory.", keywords: ["memory", "search", "recall", "记忆", "搜索"] },
  { name: "memory_remember", namespace: "memory", summary: "Persist durable information for future sessions.", keywords: ["memory", "remember", "persist", "记住", "保存"] },
  { name: "memory_add_fact", namespace: "memory", summary: "Add a subject-predicate-object graph fact.", keywords: ["memory", "fact", "graph", "事实", "知识图谱"] },
  { name: "memory_query_entity", namespace: "memory", summary: "Query facts connected to an entity.", keywords: ["memory", "entity", "graph", "实体", "关系"] }
];

const tokenize = (value) => String(value ?? "").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);

function scoreTool(tool, queryTokens) {
  const nameTokens = tokenize(tool.name.replaceAll("_", " "));
  const searchable = [...nameTokens, ...tokenize(tool.namespace), ...tool.keywords.flatMap(tokenize), ...tokenize(tool.summary)];
  let score = 0;
  for (const token of queryTokens) {
    if (nameTokens.includes(token)) score += 5;
    else if (searchable.includes(token)) score += 2;
    else if (searchable.some((candidate) => candidate.includes(token) || token.includes(candidate))) score += 1;
  }
  return score;
}

export function createToolCatalog(entries = DEFAULT_TOOLS) {
  const tools = entries.map((entry) => ({ ...entry, keywords: [...entry.keywords] }));
  return Object.freeze({
    size: tools.length,
    namespaces: [...new Set(tools.map((tool) => tool.namespace))].sort(),
    search(query, options = {}) {
      const limit = Math.min(10, Math.max(1, Number(options.limit ?? 5)));
      const namespace = options.namespace ? String(options.namespace).toLowerCase() : null;
      const queryTokens = tokenize(query);
      const ranked = tools
        .filter((tool) => !namespace || tool.namespace === namespace)
        .map((tool) => ({ tool, score: scoreTool(tool, queryTokens) }))
        .filter(({ score }) => score > 0 || queryTokens.length === 0)
        .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
        .slice(0, limit)
        .map(({ tool, score }) => ({ name: tool.name, namespace: tool.namespace, summary: tool.summary, score }));
      if (!options.maxTokens) return ranked;
      return selectWithinBudget(ranked, { maxTokens: options.maxTokens }).selected
        .map(({ estimatedTokens: _estimatedTokens, ...tool }) => tool);
    }
  });
}

export const defaultToolCatalog = createToolCatalog();
