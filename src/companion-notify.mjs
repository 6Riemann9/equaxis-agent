/**
 * Companion notifications: tell the human what their teammates did.
 *
 * Channels, in order of best-effort delivery:
 *   1. Local feed (always): append to the store's feed.jsonl — the source of
 *      truth for "what happened while I was away".
 *   2. Telegram (optional): configured through environment variables, sent
 *      through the Bot API. fetchImpl is injectable for tests.
 *   3. ntfy (optional): COMPANION_NTFY_URL posts the message body to a topic.
 *   4. Desktop (optional): `notify-send` on Linux via execImpl, failures ignored.
 *
 * Every channel is best-effort: a notification failure must never fail a task.
 */

const TELEGRAM_MAX = 4000; // hard Bot API limit 4096; keep headroom
const NTFY_MAX = 3800; // server default limit ~4096 total

function truncate(text, max = TELEGRAM_MAX) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max - 12)}\n[truncated]`;
}

export function formatTaskMessage(event) {
  const { kind, teammate, task } = event;
  const name = teammate?.name ?? "teammate";
  if (kind === "task_failed") {
    return `[${name}] task failed: ${task?.error ?? "unknown error"}`;
  }
  const result = typeof task?.result === "string" ? task.result : JSON.stringify(task?.result ?? "");
  return `[${name}] task done:\n${truncate(result, 3600)}`;
}

/** Bot API send endpoint built from the configured credential (never logged). */
function telegramEndpoint(credential) {
  return ["https://api.telegram.org", "bot", credential, "sendMessage"].join("/");
}

export function createNotifier({ store, fetchImpl = null, execImpl = null, env = process.env, now = () => new Date().toISOString(), logger = null } = {}) {
  const log = (...args) => logger?.(...args);

  function notifyNtfy(text) {
    const url = env.COMPANION_NTFY_URL;
    if (!url || typeof fetchImpl !== "function") return Promise.resolve(null);
    return fetchImpl(url, {
      method: "POST",
      body: truncate(text, NTFY_MAX)
    })
      .then(async (res) => {
        if (!res?.ok) throw new Error(`ntfy responded ${res?.status}`);
        return true;
      })
      .catch((error) => {
        log(`companion: ntfy notification failed: ${error?.message ?? error}`);
        return false;
      });
  }

  function notifyTelegram(text) {
    const credential = env.COMPANION_TELEGRAM_TOKEN;
    const chatId = env.COMPANION_TELEGRAM_CHAT_ID;
    if (!credential || !chatId || typeof fetchImpl !== "function") return Promise.resolve(null);
    const payload = JSON.stringify({ chat_id: chatId, text: truncate(text) });
    return fetchImpl(telegramEndpoint(credential), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload
    })
      .then(async (res) => {
        if (!res?.ok) throw new Error(`telegram responded ${res?.status}`);
        return true;
      })
      .catch((error) => {
        log(`companion: telegram notification failed: ${error?.message ?? error}`);
        return false;
      });
  }

  function notifyDesktop(title, text) {
    if (typeof execImpl !== "function") return;
    try {
      execImpl("notify-send", ["--", `Equaxis ${title}`, truncate(text, 500)], () => {});
    } catch {
      // best effort
    }
  }

  /**
   * Dispatch a companion event. Always appends to the local feed, then tries
   * the optional channels. Resolves to a delivery report.
   */
  return async function notify(event) {
    const entry = {
      at: now(),
      kind: event.kind,
      teammate: event.teammate?.name ?? null,
      taskId: event.task?.id ?? null,
      text: formatTaskMessage(event)
    };
    try {
      store?.appendFeed(entry);
    } catch (error) {
      log(`companion: feed append failed: ${error?.message ?? error}`);
    }
    const deliveries = { feed: true, telegram: false, ntfy: false, desktop: false };
    deliveries.telegram = (await notifyTelegram(entry.text)) === true;
    deliveries.ntfy = (await notifyNtfy(entry.text)) === true;
    notifyDesktop(entry.teammate ? `@${entry.teammate}` : "companion", entry.text);
    deliveries.desktop = typeof execImpl === "function";
    return deliveries;
  };
}
