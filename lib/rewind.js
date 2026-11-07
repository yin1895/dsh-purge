const DRAFT_TTL_MS = 10 * 60 * 1000;
const pendingDrafts = new Map();
let lastPending = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ignoreSettled(value) {
  Promise.resolve(value).catch(() => {});
}

function errorText(err) {
  if (!err) return "Undo failed";
  if (typeof err === "string") return err;
  return err.message || err.code || String(err);
}

function asEventList(events) {
  if (Array.isArray(events)) return events;
  if (events && typeof events[Symbol.iterator] === "function") {
    try {
      return [...events];
    } catch {
      return [];
    }
  }
  return [];
}

function service(ctx, name) {
  if (!ctx || typeof ctx.get !== "function") return undefined;
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

function userTextFromEvent(event) {
  const data = event?.data;
  const content = data?.content ?? data?.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (block.type === "text" || typeof block.text === "string") {
      parts.push(String(block.text ?? ""));
    }
  }
  return parts.join("").trim();
}

function isPluginDraft(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  return /^\[MNEMON\]/i.test(value)
    || /MNEMON RUNTIME MEMORY SNAPSHOT/i.test(value)
    || /^MNEMON VIEW TOOLS/im.test(value);
}

function isRewindMarkerEvent(event) {
  if (!event || event.type !== "user/message") return false;
  const id = event.data?.id;
  return typeof id === "string" && id.startsWith("rewind-");
}

function isHumanUserEvent(event) {
  if (event?.type !== "user/message") return false;
  const source = event.data?.source;
  if (source?.kind === "plugin") return false;
  if (source?.kind && source.kind !== "user") return false;
  const text = userTextFromEvent(event);
  if (!text || isPluginDraft(text)) return false;
  return true;
}

/** 这一轮真正发出去的那句。手打是 user；goal 各轮也算（含 round 0 的首轮 goal）。 */
function isRoundPromptEvent(event) {
  if (!event || event.type !== "user/message" || isRewindMarkerEvent(event)) return false;
  const source = event.data?.source;
  const kind = source?.kind;
  if (kind === "plugin") return false;
  const text = userTextFromEvent(event);
  if (!text || isPluginDraft(text)) return false;
  if (!kind || kind === "user") return true;
  if (kind === "goal") return Number.isFinite(Number(source.round)) && Number(source.round) >= 0;
  return false;
}

/**
 * 最近一轮已经 turn/end 的边界。用 turn 窗口找提示，避免第二轮完成却退回第一句。
 * [unrestricted] A(1.1.71) 兼容保留：本版 planRewind 改成 step/turn 双模式，
 * 不再走 turn 窗口，这个 helper 留给外部按 seq 定位一轮边界的调用方，行为与 A 版逐字一致。
 */
function lastClosedTurnBounds(events) {
  const list = asEventList(events);
  let endIdx = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.type === "turn/end") {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return null;
  const endEvent = list[endIdx];
  const endSeq = Number(endEvent.seq);
  const turnNum = endEvent.data?.turn;
  let floorSeq = -1;
  for (let i = 0; i < endIdx; i += 1) {
    if (list[i]?.type === "turn/end") floorSeq = Math.max(floorSeq, Number(list[i].seq));
  }
  let startSeq = -1;
  if (turnNum != null) {
    for (const e of list) {
      if (e?.type !== "turn/start" || e.data?.turn !== turnNum) continue;
      const seq = Number(e.seq);
      if (seq <= endSeq && seq > floorSeq) startSeq = seq;
    }
  }
  return { turn: turnNum, startSeq, endSeq, floorSeq };
}

function eventsInOrder(events) {
  return asEventList(events)
    .map((event, index) => ({ event, seq: Number.isFinite(Number(event?.seq)) ? Number(event.seq) : index }))
    .sort((left, right) => left.seq - right.seq);
}

function lastOpenTurn(events) {
  const list = asEventList(events);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const type = list[i]?.type;
    if (type === "turn/start") return list[i];
    if (type === "turn/end") return null;
  }
  return null;
}

function isSubagentHeader(header) {
  if (!header) return false;
  return header.origin === "subagent" || (header.delegationDepth ?? 0) > 0;
}

export function pendingInboxInserts(events) {
  const list = Array.isArray(events) ? events : [];
  let lastEnd = -1;
  let lastStart = -1;
  for (const event of list) {
    if (event?.type === "turn/end") lastEnd = event.seq;
    if (event?.type === "turn/start") lastStart = event.seq;
  }
  const after = lastEnd >= 0 ? lastEnd : -1;
  const ids = [];
  const seen = new Set();
  for (const event of list) {
    if (!event || event.seq <= after) continue;
    if (lastStart > after && event.seq >= lastStart) continue;
    if (event.type !== "agent/inbox/spliced") continue;
    if (event.data?.target && event.data.target !== "next-turn") continue;
    for (const message of event.data?.inserted || []) {
      const id = message?.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function lastTurnSubagentIds(events, fromSeq = -1) {
  const list = Array.isArray(events) ? events : [];
  let floor = Number(fromSeq);
  if (!Number.isFinite(floor) || floor < 0) {
    floor = -1;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]?.type === "turn/start") {
        floor = list[i].seq;
        break;
      }
    }
  }
  if (floor < 0) return [];
  const ids = [];
  const seen = new Set();
  for (const event of list) {
    if (!event || event.seq < floor) continue;
    if (event.type !== "subagent/catalog" && event.type !== "subagent/descriptor") continue;
    const id = event.data?.childId || event.data?.sessionId || event.data?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function seqBefore(events, cutSeq) {
  const floor = Number(cutSeq);
  let prev = null;
  for (const row of eventsInOrder(events)) {
    if (!Number.isFinite(row.seq)) continue;
    if (Number.isFinite(floor) && row.seq >= floor) break;
    prev = row;
  }
  return prev && Number.isFinite(prev.seq) ? prev.seq : null;
}

function lastEventOfType(events, type) {
  const list = asEventList(events);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.type === type) return list[i];
  }
  return null;
}

function userTextFromRange(events, fromSeq) {
  const list = asEventList(events);
  const floor = Number(fromSeq);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i];
    const seq = Number(event?.seq);
    if (Number.isFinite(floor) && Number.isFinite(seq) && seq < floor) break;
    if (isRoundPromptEvent(event)) return userTextFromEvent(event);
  }
  return "";
}

function isFirstStepOfTurn(events, start) {
  if (!start) return true;
  const turn = start.data?.turn;
  const startSeq = Number(start.seq);
  return !asEventList(events).some((event) => (
    event?.type === "step/start"
    && event !== start
    && Number(event.seq) < startSeq
    && (turn == null || event.data?.turn === turn)
  ));
}

function turnStartFor(events, turn, beforeSeq) {
  const limit = Number(beforeSeq);
  let found = null;
  for (const event of asEventList(events)) {
    const seq = Number(event?.seq);
    if (Number.isFinite(limit) && Number.isFinite(seq) && seq > limit) break;
    if (event?.type === "turn/start" && (turn == null || event.data?.turn === turn)) found = event;
  }
  return found;
}

/** once = 撤最后一步；round = 撤最后一整轮。fork 的 atSeq 含这一条，之后的消息都不要。 */
export function planRewind(events, mode = "once") {
  return mode === "round" ? planRewindTurn(events) : planRewindStep(events);
}

function planRewindStep(events) {
  const start = lastEventOfType(events, "step/start");
  if (!start) return planRewindTurn(events);
  const turn = start.data?.turn;
  const step = start.data?.step;
  let cutSeq = Number(start.seq);
  if (isFirstStepOfTurn(events, start)) {
    const turnStart = turnStartFor(events, turn, start.seq);
    if (turnStart && Number.isFinite(Number(turnStart.seq))) cutSeq = Number(turnStart.seq);
  }
  const text = userTextFromRange(events, cutSeq);
  const atSeq = seqBefore(events, cutSeq);
  if (atSeq == null) {
    if (!text) return { ok: false, error: "Nothing to undo" };
    return { ok: true, mode: "blank", text, unit: "step", turn, step, fromSeq: cutSeq };
  }
  return { ok: true, mode: "fork", atSeq, text, unit: "step", turn, step, fromSeq: cutSeq };
}

function planRewindTurn(events) {
  const list = asEventList(events);
  const open = lastOpenTurn(list);
  let turnStart = open;
  if (!turnStart) {
    const ended = lastEventOfType(list, "turn/end");
    if (ended) turnStart = turnStartFor(list, ended.data?.turn, ended.seq) || ended;
  }
  if (!turnStart) {
    const lastUser = [...list].reverse().find((event) => isRoundPromptEvent(event));
    if (!lastUser) return { ok: false, error: "Nothing to undo" };
    const cutSeq = Number(lastUser.seq);
    const text = userTextFromEvent(lastUser);
    const atSeq = seqBefore(list, cutSeq);
    if (atSeq == null) return { ok: true, mode: "blank", text, unit: "turn", fromSeq: cutSeq };
    return { ok: true, mode: "fork", atSeq, text, unit: "turn", fromSeq: cutSeq };
  }
  const cutSeq = Number(turnStart.seq);
  const text = userTextFromRange(list, cutSeq);
  const atSeq = seqBefore(list, cutSeq);
  if (!text && atSeq == null) return { ok: false, error: "Nothing to undo" };
  if (atSeq == null) return { ok: true, mode: "blank", text, unit: "turn", fromSeq: cutSeq };
  return { ok: true, mode: "fork", atSeq, text, unit: "turn", fromSeq: cutSeq };
}

/** 回退标记只占表面位置，不能再进下一轮模型请求。 */
export function isRewindDerivedMessage(message) {
  if (!message) return true;
  const id = message.id;
  return typeof id === "string" && id.startsWith("rewind-");
}

/** 只拿掉 fromSeq 及之后的表面节点。系统提示停在节点 0 时不动它。前面连续的回退空标记一并清掉，避免下一次发送还带着上一轮。 */
export function cutSurfaceNodes(nodes, fromSeq, eventAt) {
  const list = (Array.isArray(nodes) ? nodes : []).map((seq) => Number(seq));
  const floor = Number(fromSeq);
  let startIdx = list.findIndex((seq) => Number.isFinite(floor) ? seq >= floor : true);
  if (startIdx < 0) return [];
  const lookup = typeof eventAt === "function" ? eventAt : () => null;
  if (startIdx === 0 && lookup(list[0])?.type === "system/message") startIdx = 1;
  while (startIdx > 0) {
    const prev = lookup(list[startIdx - 1]);
    if (!prev || prev.type === "system/message" || !isRewindMarkerEvent(prev)) break;
    startIdx -= 1;
  }
  if (startIdx === 0 && lookup(list[0])?.type === "system/message") startIdx = 1;
  if (startIdx >= list.length) return [];
  return list.slice(startIdx);
}

function rememberDraft(sessionId, text, parentId) {
  const rec = {
    sessionId,
    parentId,
    text: text || "",
    at: Date.now(),
  };
  pendingDrafts.set(sessionId, rec);
  lastPending = rec;
  const now = Date.now();
  for (const [id, row] of pendingDrafts) {
    if (now - row.at > DRAFT_TTL_MS) pendingDrafts.delete(id);
  }
  return rec;
}

export function getDraft(sessionId) {
  if (!sessionId) return null;
  const rec = pendingDrafts.get(sessionId);
  if (!rec) return null;
  if (Date.now() - rec.at > DRAFT_TTL_MS) {
    pendingDrafts.delete(sessionId);
    return null;
  }
  return rec;
}

export function takeDraft(sessionId) {
  const rec = getDraft(sessionId);
  if (rec) pendingDrafts.delete(sessionId);
  return rec;
}

export function getPending() {
  if (!lastPending) return null;
  if (Date.now() - lastPending.at > DRAFT_TTL_MS) {
    lastPending = null;
    return null;
  }
  return lastPending;
}

export function lastHumanUserText(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (isHumanUserEvent(list[i])) return userTextFromEvent(list[i]);
  }
  return "";
}

export async function readLastUserText(ctx, sessionId) {
  if (!sessionId) return { ok: false, text: "", error: "No active session" };
  try {
    const log = await readSessionLog(ctx, sessionId);
    return { ok: true, text: lastHumanUserText(log.events) };
  } catch (err) {
    return { ok: false, text: "", error: errorText(err) };
  }
}

function disposeObservation(observed) {
  try {
    observed?.[Symbol.dispose]?.();
  } catch {
    /* ignore */
  }
}

async function readSessionLog(ctx, sessionId) {
  const store = service(ctx, "sessions");
  const live = store?.get?.(sessionId);
  if (live?.snapshotEvents) {
    return {
      events: asEventList(live.snapshotEvents()),
      header: live.header,
      cwd: live.header?.cwd,
    };
  }

  const controller = service(ctx, "sessionController");
  if (typeof controller?.inspect === "function") {
    const inspected = await controller.inspect(sessionId);
    return {
      events: asEventList(inspected?.events),
      header: inspected?.meta || inspected?.header,
      cwd: inspected?.meta?.cwd || inspected?.header?.cwd,
    };
  }

  const query = service(ctx, "sessionQuery");
  if (typeof query?.observeSession === "function") {
    const observed = await query.observeSession(sessionId, { projectionMode: "none" });
    try {
      return {
        events: asEventList(observed?.events),
        header: observed?.header,
        cwd: observed?.header?.cwd,
      };
    } finally {
      disposeObservation(observed);
    }
  }

  throw new Error("Cannot find the current session");
}

async function waitTurnClosed(ctx, sessionId, timeoutMs = 8000) {
  const started = Date.now();
  let last = await readSessionLog(ctx, sessionId);
  while (lastOpenTurn(last.events)) {
    if (Date.now() - started >= timeoutMs) {
      throw new Error("The turn is still running. Click Stop first, then undo.");
    }
    await sleep(80);
    last = await readSessionLog(ctx, sessionId);
  }
  return last;
}

function getAgent(ctx, sessionId) {
  const agents = service(ctx, "agents");
  try {
    return agents?.get?.(sessionId) || agents?.agent?.(sessionId) || undefined;
  } catch {
    return undefined;
  }
}

/** 回退后下一句按新请求开，不要接着上一轮的 request/header series。 */
function resetRequestSeries(ctx, sessionId) {
  const agent = getAgent(ctx, sessionId);
  if (!agent) return;
  try { agent.requestHeaderLogged = false; } catch { /* ignore */ }
  try { agent.requestSurfaceGeneration = -1; } catch { /* ignore */ }
  try { agent.frozenMessages?.clear?.(); } catch { /* ignore */ }
}

/** surface replace 后强制丢掉 derive 缓存，避免仍带着被切掉的旧消息。 */
function invalidateDerivedCache(session) {
  if (!session) return;
  try { session.derived = []; } catch { /* ignore */ }
  try { session.derivedNodes = 0; } catch { /* ignore */ }
  try { session.derivedGeneration = -1; } catch { /* ignore */ }
}

/**
 * 把「回退标记」这类派生消息从会话派生/分叉内容里过滤掉（A 版原文）。
 * [unrestricted] 这是 lib/index.js installRewindDeriveFilter() 唯一调用的入口
 * （index.js:842 的 try/catch 会把缺导出的 TypeError 吞掉，缺了就是永久静默空操作），
 * 所以这里必须保持导出名与签名不变。
 * 本版 rewind 改成 fork 新会话后，派生历史里的回退标记仍要滤掉，语义与 A 版一致。
 */
export function wrapSessionDeriveMessages(session) {
  if (!session || typeof session.deriveMessages !== "function" || session.__dshPurgeRewindDerive) return session;
  const orig = session.deriveMessages.bind(session);
  session.deriveMessages = function deriveMessagesWithoutRewind() {
    // 抛错不能改成空数组。空历史仍会发出请求，界面停在进行中，模型没有可答的内容。
    const messages = orig();
    if (!Array.isArray(messages)) return [];
    return messages.filter((message) => !isRewindDerivedMessage(message));
  };
  session.__dshPurgeRewindDerive = true;
  return session;
}

async function disarmRewoundSession(ctx, sessionId, options = {}) {
  if (!sessionId) return;
  const controller = service(ctx, "sessionController");
  const agent = getAgent(ctx, sessionId);
  // 只清 inbox。fork 出的新会话不要 cancel：abort 后再发会走官方 wakingAfterAbort，等于误唤醒。
  if (options.cancel !== false) {
    const runningAbort = agent?.phase?.kind && agent.phase.kind !== "idle" ? agent.phase.abort : null;
    if (runningAbort) {
      try { ignoreSettled(agent.cancel({ kind: "user" }, { keepInbox: true })); } catch { /* ignore */ }
    }
  }

  const ids = [];
  try {
    const log = await readSessionLog(ctx, sessionId);
    ids.push(...pendingInboxInserts(log.events));
  } catch { /* ignore */ }
  try {
    for (const message of [...(agent?.inbox?.nextTurn || []), ...(agent?.inbox?.nextStep || [])]) {
      if (message?.id) ids.push(message.id);
    }
  } catch { /* ignore */ }

  const seen = new Set();
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    try {
      await controller?.updateQueue?.({
        sessionId,
        itemId: id,
        action: { kind: "remove" },
      });
    } catch { /* ignore */ }
  }
}

export function invocationSessionId(invocation) {
  return invocation?.agent?.session?.id
    || invocation?.agent?.sessionId
    || invocation?.agent?.session?.header?.id;
}

async function resolveMainSession(ctx, sessionId) {
  const headers = new Map();
  let currentId = sessionId;
  const seen = new Set();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const log = await readSessionLog(ctx, currentId);
    const header = log.header || {};
    headers.set(currentId, header);
    if (!isSubagentHeader(header) || !header.parentSession) {
      return { sessionId: currentId, log };
    }
    currentId = header.parentSession;
  }
  return { sessionId, log: await readSessionLog(ctx, sessionId) };
}

function liveSession(ctx, sessionId) {
  const store = service(ctx, "sessions");
  try {
    return store?.get?.(sessionId) || null;
  } catch {
    return null;
  }
}

async function createBlank(ctx, controller, sourceId, cwd) {
  const workspace = findWorkspace(ctx, sourceId, cwd);
  if (workspace?.id) return controller.create({ workspaceId: workspace.id });
  if (cwd) return controller.create({ cwd });
  return controller.create({});
}

function findWorkspace(ctx, sessionId, cwd) {
  const registry = service(ctx, "workspaceRegistry");
  const list = registry?.list?.() || [];
  return list.find((workspace) => (workspace?.sessionIds || []).includes(sessionId))
    || (cwd ? list.find((workspace) => workspace?.path === cwd) : undefined);
}

function flatMessageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!block) return "";
    if (typeof block === "string") return block;
    return typeof block.text === "string" ? block.text : "";
  }).join("");
}

function derivedStillContains(session, text) {
  const needle = String(text || "").trim();
  if (!needle || typeof session?.deriveMessages !== "function") return false;
  let messages = [];
  try {
    messages = session.deriveMessages();
  } catch {
    return false;
  }
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (!message || message.role === "system" || isRewindDerivedMessage(message)) continue;
    if (flatMessageText(message).includes(needle)) return true;
  }
  return false;
}

/**
 * [unrestricted] A 版签名与语义的就地清理路径：留在当前会话，把 fromSeq 起的表面节点
 * 从模型请求里拿掉（追加一条 rewind- 标记消息，再由 wrapSessionDeriveMessages 滤掉）。
 *
 * 本版 rewind 默认走 controller.fork + hideRewoundSource（见 doRewindOneSession），
 * 就地切表面只是兼容路径，所以这里把 A 版的「失败即 throw」改成返回结果对象：
 *   { ok: boolean, cleared: boolean, reason: string }
 * 调用方拿到明确原因，不存在被 try/catch 吞掉的静默分支。
 */
export function clearModelHistory(session, text, fromSeq = 0) {
  if (!session || typeof session.append !== "function" || !session.surface) {
    return { ok: false, cleared: false, reason: "this session has no in-place surface" };
  }
  const nodes = session.surface.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    if (derivedStillContains(session, text)) {
      return { ok: false, cleared: false, reason: "derived history still holds the text" };
    }
    return { ok: true, cleared: false, reason: "surface empty, nothing to cut" };
  }
  const events = asEventList(typeof session.snapshotEvents === "function" ? session.snapshotEvents() : []);
  const eventAt = (seq) => events.find((event) => event?.seq === seq) || session.eventAt?.(seq);
  const shadowed = cutSurfaceNodes(nodes, fromSeq, eventAt);
  if (shadowed.length === 0) {
    if (derivedStillContains(session, text)) {
      return { ok: false, cleared: false, reason: "derived history still holds the text" };
    }
    return { ok: true, cleared: false, reason: "nothing at or after fromSeq" };
  }
  const startSeq = shadowed[0];
  const endSeq = shadowed[shadowed.length - 1];
  if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq)) {
    return { ok: false, cleared: false, reason: "invalid surface bounds" };
  }
  session.append("user/message", {
    id: `rewind-${Date.now().toString(36)}-${shadowed.length}`,
    role: "user",
    source: { kind: "user" },
    content: [],
  }, {
    surfaceOp: { op: "replace", startSeq, endSeq },
    sourceEventSeqs: shadowed,
  });
  invalidateDerivedCache(session);
  const left = new Set((session.surface.nodes || []).map((seq) => Number(seq)));
  if (shadowed.some((seq) => left.has(seq))) {
    return { ok: false, cleared: false, reason: "surface still holds the cut nodes" };
  }
  if (derivedStillContains(session, text)) {
    return { ok: false, cleared: false, reason: "derived history still holds the text" };
  }
  return { ok: true, cleared: true, reason: "surface replaced" };
}

async function hideRewoundSource(ctx, sessionId) {
  if (!sessionId) return false;
  const registry = service(ctx, "workspaceRegistry");
  const workspaces = service(ctx, "workspaces");
  const target = typeof registry?.archiveSession === "function"
    ? registry
    : (typeof workspaces?.archiveSession === "function" ? workspaces : null);
  let hidden = false;
  if (target) {
    await target.archiveSession(sessionId, { stopActivity: true });
    hidden = true;
  }
  const listed = findWorkspace(ctx, sessionId);
  const entity = listed?.id && typeof registry?.get === "function" ? registry.get(listed.id) : null;
  if (entity && typeof entity.detachSession === "function") {
    await entity.detachSession(sessionId);
    hidden = true;
  }
  return hidden;
}

const rewindLocks = new Map();

/** 官方 fork 要求 events[atSeq].seq === atSeq（从 0 起连续）。 */
function officialForkBoundary(events, atSeq) {
  const list = asEventList(events);
  let n = Number(atSeq);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  while (n >= 0) {
    if (list[n]?.seq === n) return n;
    n -= 1;
  }
  return null;
}

function prepareForkedChild(ctx, childId) {
  resetRequestSeries(ctx, childId);
  return liveSession(ctx, childId);
}

async function doRewindOneSession(ctx, controller, sessionId, options = {}) {
  if (!controller || typeof controller.fork !== "function" || typeof controller.create !== "function") {
    return { ok: false, error: "This dsh build has no session rewind API." };
  }
  let log = await readSessionLog(ctx, sessionId);
  if (lastOpenTurn(log.events)) {
    try { ignoreSettled(controller.cancel?.({ sessionId })); } catch { /* ignore */ }
    log = await waitTurnClosed(ctx, sessionId);
  }
  const plan = planRewind(log.events, options.mode === "round" ? "round" : "once");
  if (!plan.ok) return plan;

  let created;
  if (plan.mode === "fork") {
    const atSeq = officialForkBoundary(log.events, plan.atSeq);
    if (atSeq == null) return { ok: false, error: "Nothing to undo" };
    created = await controller.fork({ sessionId, atSeq });
  } else {
    created = await createBlank(ctx, controller, sessionId, log.cwd);
  }
  const childId = created?.sessionId || (typeof created === "string" ? created : "");
  if (!childId) return { ok: false, error: "Failed to create the rewound session" };

  prepareForkedChild(ctx, childId);
  await disarmRewoundSession(ctx, childId, { cancel: false });
  let archived = false;
  try {
    archived = await hideRewoundSource(ctx, sessionId);
  } catch { /* 旧会话没藏住也不挡新会话重发 */ }

  const rec = rememberDraft(childId, plan.text, sessionId);
  return {
    ok: true,
    sessionId: childId,
    parentId: sessionId,
    archived,
    cleared: true,
    text: rec.text,
    cut: plan.unit || plan.mode,
    at: rec.at,
  };
}

async function rewindOneSession(ctx, controller, sessionId, options = {}) {
  const key = String(sessionId || "");
  if (!key) return doRewindOneSession(ctx, controller, sessionId, options);
  const prev = rewindLocks.get(key) || Promise.resolve();
  const next = prev.then(async () => {
    try {
      return await doRewindOneSession(ctx, controller, sessionId, options);
    } finally {
      if (rewindLocks.get(key) === next) rewindLocks.delete(key);
    }
  }, async () => {
    try {
      return await doRewindOneSession(ctx, controller, sessionId, options);
    } finally {
      if (rewindLocks.get(key) === next) rewindLocks.delete(key);
    }
  });
  rewindLocks.set(key, next);
  return next;
}

export async function analyzeRewind(ctx, sessionId) {
  if (!sessionId) return { ok: false, error: "No active session" };
  try {
    const log = await readSessionLog(ctx, sessionId);
    const kind = isSubagentHeader(log.header) ? "subagent" : "main";
    const subagentIds = kind === "main" ? lastTurnSubagentIds(log.events) : [];
    return {
      ok: true,
      kind,
      sessionId,
      hasSubagents: subagentIds.length > 0,
      subagentIds,
    };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

export async function applyRewind(ctx, sessionId, mode) {
  if (!sessionId) return { ok: false, error: "No active session" };
  const controller = service(ctx, "sessionController");

  const action = mode === "round" ? "round" : "once";
  try {
    if (action === "round") {
      const target = await resolveMainSession(ctx, sessionId);
      if (sessionId !== target.sessionId) {
        try { ignoreSettled(controller.cancel?.({ sessionId })); } catch { /* ignore */ }
      }
      const preview = planRewind(target.log?.events || [], "round");
      const children = preview.ok ? lastTurnSubagentIds(target.log.events, preview.fromSeq) : [];
      const result = await rewindOneSession(ctx, controller, target.sessionId, { mode: "round" });
      if (!result.ok) return result;
      for (const childId of children) {
        if (!childId || childId === target.sessionId) continue;
        try { ignoreSettled(controller.cancel?.({ sessionId: childId })); } catch { /* ignore */ }
        try { await hideRewoundSource(ctx, childId); } catch { /* ignore */ }
      }
      return { ...result, sourceId: sessionId, mode: "round" };
    }

    const result = await rewindOneSession(ctx, controller, sessionId, { mode: "once" });
    if (!result.ok) return result;
    return { ...result, sourceId: sessionId, mode: "once" };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}
