// 宿主侧插件入口。
// 为什么需要宿主逻辑：
//   浏览器端只能看到「当前视口内已加载的对话快照」，会话最开始注入的系统提示词、
//   指令文件、技能目录会被挤出视口而丢失。完整内容只存在于会话事件日志里，
//   日志只能由宿主读取。所以这里注册三个只读/翻译接口给浏览器端用：
//     1) GET  /session-show-load/data?sessionId=...   → 归纳“这次对话加载了什么”
//     2) POST /session-show-load/translate            → 用默认大模型独立翻译一段文本
//     3) GET  /session-show-load/translation-info      → 报告可用的翻译模型（前端据此显示提示）
//   另有 GET/POST/DELETE /session-show-load/translations 负责翻译记录的读写。

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// 翻译记录存在当前 profile 目录下（与 .dsh-market 同级）：最多保留 50 条，最新的在最前
const HISTORY_LIMIT = 50;
function historyFile() {
  const profileDir = process.env.DSH_PROFILE_DIR
    || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', process.env.DSH_PROFILE || 'desktop');
  return join(profileDir, '.dsh-session-show-load', 'translations.json');
}
// 旧版本存在 ~/.dsh/session-show-load/，读取时兼容迁移
function legacyHistoryFile() { return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'session-show-load', 'translations.json'); }
// 读出的内容必须是数组，否则当成空，避免脏文件把接口打挂
const asArray = (v) => (Array.isArray(v) ? v : []);
function readHistory() {
  try { return asArray(JSON.parse(readFileSync(historyFile(), 'utf8'))); } catch {
    try { return asArray(JSON.parse(readFileSync(legacyHistoryFile(), 'utf8'))); } catch { return []; }
  }
}
function writeHistory(items) {
  try {
    const file = historyFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(asArray(items).slice(0, HISTORY_LIMIT)));
  } catch { /* 忽略写入失败 */ }
}

const JSON_HEAD = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

// 统一返回 JSON
function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEAD);
  res.end(JSON.stringify(body));
}

// 内容块数组 → 纯文本（只取 text 块）
function blocksToText(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .map((b) => (b && typeof b.text === 'string' ? b.text : ''))
    .join('');
}

// 读取一个技能目录下的子目录名（每个技能一个文件夹），失败返回空集合
function readSkillNames(dir) {
  try {
    return new Set(readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name));
  } catch {
    return new Set();
  }
}

// 给技能标注来源：项目级 / 用户级 / 内置
//   - 项目级：<当前工作目录>/.dsh/skills 或 .agents/skills
//   - 用户级：~/.dsh/skills
//   - 其余：内置（随应用打包，如 office 系列）
function tagSkillScopes(list, cwd) {
  const userSet = readSkillNames(join(homedir(), '.dsh', 'skills'));
  const projSet = new Set();
  if (cwd) {
    readSkillNames(join(cwd, '.dsh', 'skills')).forEach((n) => projSet.add(n));
    readSkillNames(join(cwd, '.agents', 'skills')).forEach((n) => projSet.add(n));
  }
  return list.map((s) => ({
    ...s,
    scope: projSet.has(s.name) ? 'project' : userSet.has(s.name) ? 'user' : 'builtin',
  }));
}

// 从完整事件日志里归纳各类加载项
function extract(events) {
  let systemPrompt = '';
  const instr = new Map(); // 指令文件 path -> action
  const instrSeen = new Set(); // 已收集的注入文本，避免重复轮次重复计入
  const instrText = [];
  const skills = new Map(); // 技能 name -> description
  const env = new Map(); // 环境快照 name -> text
  const others = [];
  let tools = [];

  for (const ev of Array.isArray(events) ? events : []) {
    if (ev.type === 'user/message') {
      const data = ev.data || {};
      const src = data.source || {};
      const text = blocksToText(data.content);
      if (src.kind === 'user' || !src.kind) continue;
      if (src.kind === 'agent-instructions') {
        for (const ch of Array.isArray(src.changes) ? src.changes : []) {
          if (ch && ch.path) instr.set(ch.path, ch.action || 'set');
        }
        if (text.trim() && !instrSeen.has(text)) { instrSeen.add(text); instrText.push(text); }
      } else if (src.kind === 'skill-catalog') {
        for (const e of Array.isArray(src.entries) ? src.entries : []) {
          if (e && e.name && !skills.has(e.name)) skills.set(e.name, e.description || '');
        }
      } else if (src.kind === 'skill-invocation') {
        // 只补缺失的技能，避免“调用记录没有描述”时把技能目录里的描述覆盖成空
        if (src.name && (!skills.has(src.name) || src.description)) skills.set(src.name, src.description || skills.get(src.name) || '');
      } else if (src.form === 'snapshot') {
        for (const s of Array.isArray(src.sections) ? src.sections : []) {
          if (s && s.name) env.set(s.name, s.text || '');
        }
      } else if (text.trim()) {
        others.push({ label: src.kind || 'context', text });
      }
    } else if (ev.type === 'system/message') {
      const msg = (ev.data || {}).message || {};
      const text = blocksToText(msg.content);
      if (text) systemPrompt = text; // 取最后一次
    } else if (ev.type === 'request/header') {
      const hdr = (ev.data || {}).header || {};
      if (Array.isArray(hdr.tools) && hdr.tools.length) tools = hdr.tools; // 取最后一次
    }
  }

  // 当前工作目录（用于区分项目级技能）：从 runtime-context 的快照里取
  const cwdSection = env.get('working-directory:current') || '';
  const cwdMatch = cwdSection.match(/"([^"]+)"/);
  const cwd = cwdMatch ? cwdMatch[1] : '';

  return {
    prompt: systemPrompt,
    instr: Array.from(instr, ([path, action]) => ({ path, action })),
    instrText: instrText.join('\n\n'),
    skills: tagSkillScopes(Array.from(skills, ([name, description]) => ({ name, description })), cwd),
    env: Array.from(env, ([name, text]) => ({ name, text })),
    tools: tools.map((t) => ({ name: t.name || '', description: t.description || '' })),
    others,
  };
}

// 读取完整事件日志：优先 readSession（校验过的完整日志），失败再用实时观测兜底
async function loadEvents(sessionQuery, sessionId) {
  try {
    const snap = await sessionQuery.readSession(sessionId);
    return (snap && snap.events) || [];
  } catch (e) {
    const obs = await sessionQuery.observeSession(sessionId, { projectionMode: 'none' });
    try {
      return Array.from((obs && obs.events) || []);
    } finally {
      if (obs && typeof obs.dispose === 'function') obs.dispose();
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// 注册一个 exact 路由，并统一兜住异常（避免每个接口重复写 try/catch）
function mount(ctx, deps, path, handler, label) {
  ctx.inject(deps, (c) => c.effect(
    () => c.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        try {
          await handler(c, req, res);
        } catch (e) {
          if (!res.headersSent) sendJson(res, 500, { error: (e && e.message) || String(e) });
        }
      },
    }),
    'session-show-load: ' + label,
  ));
}

const queryParam = (req, key) => new URL(req.url || '/', 'http://localhost').searchParams.get(key);

export function apply(ctx) {
  // 数据接口：把会话日志归纳成面板需要的结构
  mount(ctx, ['webServer', 'sessionQuery'], '/session-show-load/data', async (c, req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    const sessionId = queryParam(req, 'sessionId');
    if (!sessionId) return sendJson(res, 400, { error: 'missing sessionId' });
    sendJson(res, 200, extract(await loadEvents(c.sessionQuery, sessionId)));
  }, 'data route');

  // 翻译记录（桌面客户端保存在本机文件，最多 50 条）
  mount(ctx, ['webServer'], '/session-show-load/translations', async (c, req, res) => {
    if (req.method === 'GET') return sendJson(res, 200, { items: readHistory() });
    if (req.method === 'DELETE') {
      // 带 id 删除单条；不带 id 清空全部
      const id = queryParam(req, 'id');
      if (!id) { writeHistory([]); return sendJson(res, 200, { ok: true, total: 0 }); }
      const items = readHistory().filter((it) => it.id !== id);
      writeHistory(items);
      return sendJson(res, 200, { ok: true, total: Math.min(items.length, HISTORY_LIMIT) });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '');
      const translated = String(body.translated || '');
      const title = String(body.title || '').slice(0, 120);
      if (!text.trim() || !translated.trim()) return sendJson(res, 400, { error: 'empty' });
      // 沿用客户端传来的 id，保证前后端记录 id 一致（删除才有效）
      const id = String(body.id || '').slice(0, 64) || String(Date.now()) + Math.random().toString(36).slice(2, 8);
      const items = readHistory().filter((it) => !(it.text === text && (it.title || '') === title));
      items.unshift({ id, text, translated, title, at: Date.now() });
      writeHistory(items);
      return sendJson(res, 200, { ok: true, total: Math.min(items.length, HISTORY_LIMIT) });
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }, 'translations route');

  // 翻译信息：现在直接用默认大模型翻译（不依赖外部翻译插件），所以始终会消耗 Token
  mount(ctx, ['webServer'], '/session-show-load/translation-info', async (c, req, res) => {
    const llm = c.get('llm');
    if (!llm) return sendJson(res, 200, { available: false });
    const sel = await resolveModel(c, llm);
    sendJson(res, 200, {
      available: true,
      paid: true,
      desktop: !!process.versions.electron,
      provider: sel ? sel.provider + ' / ' + sel.model : '',
    });
  }, 'translation info route');

  // 翻译接口：直接用默认大模型新发一次调用（独立请求，不写入当前对话）
  mount(ctx, ['webServer'], '/session-show-load/translate', async (c, req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    const body = await readBody(req);
    const text = String(body.text || '');
    if (!text.trim()) return sendJson(res, 200, { text: '' });
    const llm = c.get('llm');
    if (!llm) return sendJson(res, 503, { error: '没有可用的模型服务，无法翻译。' });
    sendJson(res, 200, { text: await translateByModel(c, llm, text) });
  }, 'translate route');
}

// 翻译用的系统提示词：要求翻译自然、贴合中文表达，不逐字硬译
const TRANSLATE_SYSTEM = [
  '你是一名专业翻译。请把用户发来的整段文本翻译成简体中文。',
  '要求：忠实原意、语句通顺、符合中文表达习惯，不要生搬硬套、不要漏译。',
  '保留原文的 Markdown 结构、代码、命令、文件路径、专有名词（不要翻译代码和路径）。',
  '只输出译文本身，不要任何解释、前缀或后缀。',
].join('\n');

// 直接发起一次独立的模型调用并收集文本（不写入任何对话历史）
async function translateByModel(c, llm, text) {
  const sel = await resolveModel(c, llm);
  if (!sel || !sel.provider || !sel.model) throw new Error('没有可用的模型');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 120000);
  try {
    let out = '';
    for await (const chunk of llm.stream({
      provider: sel.provider,
      model: sel.model,
      system: TRANSLATE_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      temperature: 0.2,
      maxTokens: 8192,
      signal: ac.signal,
    })) {
      if (chunk.type === 'text-delta') out += chunk.text;
      else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        const f = chunk.reason.failure || {};
        throw new Error(f.message || '模型调用失败');
      }
    }
    return out.trim();
  } finally {
    clearTimeout(timer);
  }
}

// 解析默认模型：优先用户当前选择的模型，取不到再退回第一个 provider 的第一个模型
async function resolveModel(c, llm) {
  try {
    const def = c.get('agentDefaultModel');
    const s = def && def.currentSelection();
    if (s && s.provider && s.model) return { provider: s.provider, model: s.model };
  } catch { /* 忽略，走下面的回退 */ }
  try {
    const provs = llm.listProviders() || [];
    if (!provs.length) return null;
    const models = (await llm.listModels(provs[0].id)) || [];
    return { provider: provs[0].id, model: models[0] && models[0].id };
  } catch {
    return null;
  }
}
