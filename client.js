// dsh-session-show-load —— 会话加载内容面板（浏览器端）
// 思路：
//   1) 主数据来自宿主只读接口 GET /session-show-load/data?sessionId=...
//      它读的是完整会话日志，因此能看到视口外被挤出的系统提示词/指令文件/技能目录；
//   2) 若接口不可用，则退回当前对话快照（useChat + useTrajectory）尽力展示，可能不全；
//   3) 各文本块可点「翻译」，由宿主 POST /session-show-load/translate 调用 AI 翻译。
window.__ModuleLoader__.load({
  id: '@lwfjyjy/session-show-load',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'sessionShowLoad';

    // ---------- 字典（中文兼作无 locale 服务时的兜底） ----------
    const zh = {
      tab: '加载',
      title: '当前对话已加载的内容',
      subtitle: '这里汇总本次对话注入给模型的全部上下文。每一项都标注了数据来源。',
      sourceLabel: '数据来源',
      sourcePrompt: '读取会话日志里的 system/message 事件（模型的基础系统提示词）。',
      sourceInstr: '读取 user/message 中 source.kind = agent-instructions 的注入记录（如 ~/.dsh/AGENTS.md）。',
      sourceSkills: '读取 source.kind = skill-catalog 的技能清单注入。',
      sourceTools: '读取最近一次模型请求 request/header 里的 tools 定义。',
      sourceEnv: '读取 runtime-context / time-context 快照注入（工作目录、沙箱、审批、时区等）。',
      sourceOthers: '读取 session-reference / notice / relay 等其它注入内容。',
      scopeProject: '项目',
      scopeUser: '用户',
      scopeBuiltin: '内置',
      emptyScope: '（无）',
      systemPrompt: '系统提示词',
      instructions: '指令文件',
      skills: '技能',
      tools: '工具',
      env: '运行环境',
      others: '其它注入',
      history: '翻译记录',
      historyHint: '每份 AI 译文都会自动保存（桌面客户端本机最多 50 份，浏览器最多 10 份）。',
      historyEmpty: '还没有翻译记录。',
      delete: '删除',
      unitChar: '字符',
      unitItem: '项',
      empty: '当前对话还没有加载额外内容。',
      injectedText: '注入文本',
      noDesc: '（无描述）',
      expand: '展开',
      tokenWarn: '由 AI 翻译，可能需要几秒',
      privacyWarn: '原文将发送给所选翻译服务',
      collapse: '收起',
      toolsHint: '工具清单来自最近一次模型请求。',
      othersHint: 'notice / relay / recall 等其它注入内容。',
      translate: '翻译',
      translating: '翻译中…',
      retry: '重试',
      original: '原文',
      translation: '译文',
      copy: '复制',
      copied: '已复制',
      loadingData: '正在读取会话完整日志…',
      fallbackData: '读取完整日志失败，以下为当前视口内容（可能不全）',
    };
    const en = {
      tab: 'Loaded',
      title: 'Loaded into this conversation',
      subtitle: 'Everything injected into this conversation. Each item shows where it comes from.',
      sourceLabel: 'Source',
      sourcePrompt: 'Read from system/message events in the session log (the base system prompt).',
      sourceInstr: 'Read from user/message records whose source.kind = agent-instructions (e.g. ~/.dsh/AGENTS.md).',
      sourceSkills: 'Read from the skill-catalog injection (source.kind = skill-catalog).',
      sourceTools: 'Read from the tools definition in the latest request/header.',
      sourceEnv: 'Read from runtime-context / time-context snapshot injections (cwd, sandbox, approval, timezone).',
      sourceOthers: 'Read from other injections such as session-reference / notice / relay.',
      scopeProject: 'Project',
      scopeUser: 'User',
      scopeBuiltin: 'Built-in',
      emptyScope: '(none)',
      systemPrompt: 'System prompt',
      instructions: 'Instruction files',
      skills: 'Skills',
      tools: 'Tools',
      env: 'Environment',
      others: 'Other injections',
      history: 'Translation history',
      historyHint: 'Every AI translation is saved automatically (up to 50 locally in the desktop app, 10 in a browser).',
      historyEmpty: 'No translations yet.',
      delete: 'Delete',
      unitChar: 'chars',
      unitItem: 'items',
      empty: 'Nothing extra loaded into this conversation yet.',
      injectedText: 'Injected text',
      noDesc: '(no description)',
      expand: 'Expand',
      tokenWarn: 'Translated by AI, may take a few seconds',
      privacyWarn: 'Original text is sent to the selected service',
      collapse: 'Collapse',
      toolsHint: 'Tool list comes from the latest model request.',
      othersHint: 'Other injections such as notice / relay / recall.',
      translate: 'Translate',
      translating: 'Translating…',
      retry: 'Retry',
      original: 'Original',
      translation: 'Translation',
      copy: 'Copy',
      copied: 'Copied',
      loadingData: 'Reading the full session log…',
      fallbackData: 'Failed to read the full log; showing the current viewport only (may be incomplete)',
    };
    const FALLBACK = zh;

    // ---------- 小工具 ----------
    const EMPTY = [];
    // 内容块数组 → 纯文本
    const blocksToText = (blocks) =>
      (Array.isArray(blocks) ? blocks : EMPTY)
        .map((b) => (b && typeof b.text === 'string' ? b.text : ''))
        .join('');
    const fmtSize = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n));
    // 记录 id：时间戳 + 随机串，避免同一毫秒内多次翻译产生重复 id
    const newId = () => String(Date.now()) + Math.random().toString(36).slice(2, 8);
    // 会话 id 统一成宿主的 branded 形式（session-uuid）
    const toSessionId = (id) => {
      const s = String(id || '');
      return s && s.indexOf('session-') !== 0 ? 'session-' + s : s;
    };

    // 按段落把长文本切成 <= max 的若干块，避免超出翻译服务的单次长度上限
    function chunkText(text, max) {
      if (!max || text.length <= max) return [text];
      // 先按空行拆段；超长段硬切
      const pieces = [];
      for (const para of text.split(/\n{2,}/)) {
        if (para.length > max) {
          for (let i = 0; i < para.length; i += max) pieces.push(para.slice(i, i + max));
        } else if (para) {
          pieces.push(para);
        }
      }
      // 再把相邻小段拼回接近上限的块，减少请求数、保留上下文
      const out = [];
      let buf = '';
      for (const p of pieces) {
        if (!buf) buf = p;
        else if (buf.length + 2 + p.length <= max) buf = buf + '\n\n' + p;
        else { out.push(buf); buf = p; }
      }
      if (buf) out.push(buf);
      return out.length ? out : [text];
    }

    // ---------- 数据归纳：从 chat 节点 + trajectory 请求里提取各类加载项 ----------
    function buildModel(nodes, requests) {
      let prompt = '';
      const instr = new Map(); // path -> action
      const instrText = [];
      const skills = new Map(); // name -> description
      const env = new Map(); // name -> text
      const others = [];

      for (const node of nodes) {
        const data = node && node.data;
        if (!data) continue;
        // 系统提示词
        if (node.kind === 'system-prompt') {
          if (typeof data.text === 'string' && data.text) prompt = data.text;
          continue;
        }
        if (node.kind !== 'context') continue;
        const src = data.source || {};
        const kind = src.kind;
        if (kind === 'agent-instructions') {
          for (const ch of Array.isArray(src.changes) ? src.changes : EMPTY) {
            if (ch && ch.path) instr.set(ch.path, ch.action || 'set');
          }
          const txt = blocksToText(data.content);
          if (txt.trim()) instrText.push(txt);
        } else if (kind === 'skill-catalog') {
          for (const e of Array.isArray(src.entries) ? src.entries : EMPTY) {
            if (e && e.name && !skills.has(e.name)) skills.set(e.name, { description: e.description || '', scope: e.scope });
          }
        } else if (kind === 'skill-invocation') {
          // 技能被调用时别再拿空描述覆盖目录里已有的描述
          if (src.name && !skills.has(src.name)) skills.set(src.name, { description: src.description || '', scope: src.scope });
        } else if (data.form === 'snapshot' || src.form === 'snapshot') {
          for (const s of Array.isArray(src.sections) ? src.sections : EMPTY) {
            if (s && s.name) env.set(s.name, s.text || '');
          }
        } else {
          const txt = blocksToText(data.content);
          if (txt.trim()) others.push({ label: (data.producer && data.producer.label) || kind || 'context', text: txt });
        }
      }

      // 工具：取最近一次带 tools 的请求
      let tools = EMPTY;
      for (let i = requests.length - 1; i >= 0; i--) {
        const p = requests[i] && requests[i].prompt;
        if (p && Array.isArray(p.tools) && p.tools.length) { tools = p.tools; break; }
      }

      return {
        prompt,
        instr: Array.from(instr, ([path, action]) => ({ path, action })),
        instrText: instrText.join('\n\n'),
        skills: Array.from(skills, ([name, v]) => ({ name, description: v.description, scope: v.scope })),
        env: Array.from(env, ([name, text]) => ({ name, text })),
        tools: tools.map((x) => ({ name: x.name || '', description: x.description || '' })),
        others,
      };
    }

    // ---------- 文本块 + 翻译按钮 ----------
    // 每个文本块独立翻译（“一个个块”）：点按钮才请求 AI 翻译，结果缓存于本组件 state，
    // 可在原文/译文之间切换；加载中与失败都有明确提示。
    function TransText({ text, variant, translate, t, bare, warnText, cache, recTitle }) {
      const cached = cache && cache.has(text) ? cache.get(text) : '';
      const [status, setStatus] = React.useState(cached ? 'done' : 'idle'); // idle | loading | done | error
      const [translated, setTranslated] = React.useState(cached);
      // 历史记录异步加载完成后，把已翻译过的块恢复成「已翻译」状态
      React.useEffect(() => {
        if (status !== 'idle') return;
        if (cache && cache.has(text)) { setTranslated(cache.get(text)); setStatus('done'); }
      }, [cache, text, status]);
      const [showTrans, setShowTrans] = React.useState(true); // true=译文 false=原文
      const [error, setError] = React.useState('');
      const [copied, setCopied] = React.useState(false);

      const start = async () => {
        if (status === 'loading') return;
        setStatus('loading');
        setError('');
        try {
          const result = await translate(text);
          setTranslated(result);
          setStatus('done');
          setShowTrans(true);
          try { if (translate && translate.record) translate.record(text, result, recTitle); } catch (e) { /* 忽略 */ }
        } catch (e) {
          setStatus('error');
          setError((e && e.message) || String(e));
        }
      };

      const body = (isPre, value, extra) =>
        h(isPre ? 'pre' : 'div', { className: (isPre ? 'dshLoadPrompt' : 'dshLoadItemDesc') + (bare ? ' dshLoadBare' : '') + (extra ? ' ' + extra : '') }, value);

      // 一键复制当前显示的内容（译文显示中则复制译文，否则复制原文）
      const onCopy = async () => {
        const value = status === 'done' && showTrans ? translated : text;
        const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1500); };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(value);
            done();
            return;
          }
          throw new Error('no clipboard');
        } catch (e) {
          // 兜底：老式 execCommand 复制
          const ta = document.createElement('textarea');
          ta.value = value;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); done(); } catch (_) { /* 忽略 */ }
          document.body.removeChild(ta);
        }
      };
      const copyBtn = h('button', {
        type: 'button',
        className: 'dshLoadCopyBtn' + (copied ? ' isCopied' : ''),
        onClick: onCopy,
        title: t('copy'),
      }, copied ? t('copied') : t('copy'));

      // 工具条：翻译中/未翻译/失败=按钮；成功后=「原文 ⇄ 译文」开关
      let bar;
      if (status === 'done') {
        const seg = (on, label, val) =>
          h('button', { type: 'button', className: 'dshLoadSegBtn' + (on ? ' isOn' : ''), 'aria-pressed': on, onClick: () => setShowTrans(val) }, label);
        bar = h('div', { className: 'dshLoadSeg' }, seg(!showTrans, t('original'), false), seg(showTrans, t('translation'), true));
      } else {
        const label = status === 'loading' ? t('translating') : status === 'error' ? t('retry') : t('translate');
        bar = h('button', { type: 'button', className: 'dshLoadTransBtn', onClick: start, disabled: status === 'loading', 'aria-busy': status === 'loading' },
          status === 'loading' ? h('span', { className: 'dshLoadSpin' }) : null, label);
      }

      const showingTrans = status === 'done' && showTrans;
      return h(
        'div',
        { className: 'dshLoadTextBlock' },
        h('div', { className: 'dshLoadTextBar' },
          status !== 'done' ? h('span', { className: 'dshLoadWarn' }, 'ℹ ' + (warnText || t('tokenWarn'))) : null,
          bar, copyBtn),
        body(variant === 'pre', showingTrans ? translated : text, null),
        error ? h('div', { className: 'dshLoadTransErr' }, '⚠ ' + error) : null,
      );
    }

    // 统一的可折叠条目：默认收起只显示标题，展开后用统一背景块展示描述
    // 技能 / 工具 / 环境 三处共用，保证样式一致
    function ItemBlock({ name, text, variant, translate, t, warnText, cache, recTitle }) {
      const [open, setOpen] = React.useState(false);
      const inner = text
        ? (translate
            ? h(TransText, { text, variant, bare: true, translate, t, warnText, cache, recTitle })
            : h(variant === 'pre' ? 'pre' : 'div', { className: 'dshLoadBare' + (variant === 'pre' ? ' dshLoadBarePre' : '') }, text))
        : h('div', { className: 'dshLoadMuted' }, t('noDesc'));
      return h(
        'div',
        { className: 'dshLoadItem dshLoadItemBlock' },
        h(
          'button',
          { type: 'button', className: 'dshLoadItemHead', 'aria-expanded': open, onClick: () => setOpen(!open) },
          h('span', { className: 'dshLoadChev' + (open ? ' isOpen' : '') }),
          h('span', { className: 'dshLoadItemName' }, name),
          h('span', { className: 'dshLoadItemToggle' }, open ? t('collapse') : t('expand')),
        ),
        open ? h('div', { className: 'dshLoadDetailBlock' }, inner) : null,
      );
    }

    // 技能按来源分「项目 / 用户 / 内置」三个子 tab，避免平铺太长
    function SkillTabs({ skills, translate, t, warnText, cache }) {
      const buckets = { project: [], user: [], builtin: [] };
      skills.forEach((s) => (buckets[s.scope] || buckets.builtin).push(s));
      const tabs = [['project', t('scopeProject')], ['user', t('scopeUser')], ['builtin', t('scopeBuiltin')]];
      const first = (tabs.find((row) => buckets[row[0]].length) || tabs[2])[0];
      const [active, setActive] = React.useState(first);
      const list = buckets[active] || [];
      return h(
        'div',
        { className: 'dshLoadSubtabs' },
        h(
          'div',
          { className: 'dshLoadSubtabBar' },
          tabs.map((row) =>
            h(
              'button',
              { type: 'button', key: row[0], className: 'dshLoadSubtab' + (active === row[0] ? ' isOn' : ''), onClick: () => setActive(row[0]) },
              h('span', null, row[1]),
              h('b', null, buckets[row[0]].length),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dshLoadSubtabBody' },
          list.length
            ? list.map((s, i) => h(ItemBlock, { key: active + i, name: s.name, text: s.description, variant: 'desc', translate, t, warnText, cache, recTitle: t('skills') + '：' + s.name }))
            : h('div', { className: 'dshLoadSkillEmpty' }, t('emptyScope')),
        ),
      );
    }

    // ---------- 主面板 ----------
    // 把接口返回规整成面板统一结构（缺失字段补空）
    const normalizeModel = (d) => ({
      prompt: typeof d.prompt === 'string' ? d.prompt : '',
      instr: Array.isArray(d.instr) ? d.instr : EMPTY,
      instrText: typeof d.instrText === 'string' ? d.instrText : '',
      skills: Array.isArray(d.skills) ? d.skills : EMPTY,
      env: Array.isArray(d.env) ? d.env : EMPTY,
      tools: Array.isArray(d.tools) ? d.tools : EMPTY,
      others: Array.isArray(d.others) ? d.others : EMPTY,
    });

    // 翻译记录列表：每条可展开看原文/译文，可删除
    function HistoryView({ history, translate, t }) {
      const oneLine = (v) => String(v || '').replace(/\s+/g, ' ').trim();
      return h(React.Fragment, null,
        h('div', { className: 'dshLoadHint' }, t('historyHint')),
        history.length
          ? history.map((it, i) => {
              const text = oneLine(it.text);
              return h('details', { className: 'dshLoadDetails dshLoadHist', key: it.id || i },
                h('summary', { className: 'dshLoadHistSummary' },
                  it.title ? h('span', { className: 'dshLoadHistTitle' }, it.title) : null,
                  h('span', { className: 'dshLoadHistLabel' }, text.slice(0, 60) + (text.length > 60 ? '…' : '')),
                  translate && translate.remove
                    ? h('button', {
                        type: 'button',
                        className: 'dshLoadDelBtn',
                        title: t('delete'),
                        onClick: (e) => { e.preventDefault(); e.stopPropagation(); translate.remove(it.id); },
                      }, t('delete'))
                    : null),
                h('div', { className: 'dshLoadDetailBlock' },
                  h('div', { className: 'dshLoadHistLabel' }, t('original')),
                  h('pre', { className: 'dshLoadBare dshLoadBarePre' }, it.text),
                  h('div', { className: 'dshLoadHistLabel' }, t('translation')),
                  h('pre', { className: 'dshLoadBare dshLoadBarePre' }, it.translated)));
            })
          : h('div', { className: 'dshLoadEmpty' }, t('historyEmpty')));
    }

    function LoadPanel(props) {
      const t = typeof props.t === 'function' ? props.t : (k) => FALLBACK[k] || k;
      const translate = typeof props.translate === 'function' ? props.translate : null;
      const sessionId = props.sessionId;
      const useChat = typeof props.useChat === 'function' ? props.useChat : () => undefined;
      const useTrajectory = typeof props.useTrajectory === 'function' ? props.useTrajectory : () => undefined;

      // 兜底：当前对话快照（视口内可见部分，可能不含会话起始的注入）
      const store = useChat((s) => s && s.nodes) || null;
      const snapNodes = React.useMemo(() => {
        if (!store || typeof store.values !== 'function') return EMPTY;
        return Array.from(store.values()).sort((a, b) => (a.anchorSeq ?? 0) - (b.anchorSeq ?? 0));
      }, [store]);
      const requests = useTrajectory((s) => s && s.requests) || EMPTY;
      const fallback = React.useMemo(() => buildModel(snapNodes, requests), [snapNodes, requests]);

      // 主数据：宿主读完整会话日志后归纳（含会话起始、已不在视口里的注入）
      const [remoteModel, setRemoteModel] = React.useState(null);
      const [transInfo, setTransInfo] = React.useState('');
      const [history, setHistory] = React.useState([]);
      const [desktopMode, setDesktopMode] = React.useState(isDesktopApp);
      const [showHistory, setShowHistory] = React.useState(false);
      const [active, setActive] = React.useState(null); // 左侧当前选中的分类 id
      // 原文 -> 译文 映射：用于把已翻译过的块自动恢复成「已翻译」
      const transCache = React.useMemo(() => {
        const map = new Map();
        history.forEach((it) => { if (it && it.text) map.set(it.text, it.translated || ''); });
        return map;
      }, [history]);
      const [status, setStatus] = React.useState('loading'); // loading | done | error
      const [err, setErr] = React.useState('');
      React.useEffect(() => {
        if (!sessionId) { setStatus('done'); return; }
        let alive = true;
        setStatus('loading');
        setErr('');
        setRemoteModel(null);
        fetch('/session-show-load/translation-info')
          .then((r) => (r.ok ? r.json() : null))
          .then((info) => { if (!alive || !info || info.error) return; setTransInfo(info); if (typeof info.desktop === 'boolean') setDesktopMode(info.desktop); })
          .catch(() => {});
        fetch('/session-show-load/data?sessionId=' + encodeURIComponent(toSessionId(sessionId)))
          .then((r) => r.json())
          .then((d) => {
            if (!alive) return;
            if (d && d.error) throw new Error(d.error);
            setRemoteModel(normalizeModel(d));
            setStatus('done');
          })
          .catch((e) => {
            if (!alive) return;
            setErr((e && e.message) || String(e));
            setStatus('error');
          });
        return () => { alive = false; };
      }, [sessionId]);

      // 翻译记录：加载历史；每完成一次翻译就追加保存（最多 50/10 条）
      React.useEffect(() => {
        let alive = true;
        loadHistory(desktopMode).then((items) => { if (alive) setHistory(items); });
        if (translate) {
          translate.record = (text, translated, title) => {
            const rec = { id: newId(), text, translated, title: title || '', at: Date.now() };
            setHistory((prev) => [rec, ...prev.filter((x) => !(x.text === text && (x.title || '') === rec.title))].slice(0, HISTORY_MAX));
            saveHistoryRecord(rec, desktopMode);
          };
          // 删除单条翻译记录（同步删除本机/浏览器存储）
          translate.remove = (id) => {
            setHistory((prev) => {
              const next = prev.filter((x) => x.id !== id);
              if (!desktopMode) writeBrowserHistory(next);
              return next;
            });
            if (desktopMode) fetch('/session-show-load/translations?id=' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
          };
        }
        return () => { alive = false; if (translate) { translate.record = null; translate.remove = null; } };
      }, [translate, desktopMode]);

      const m = remoteModel || fallback;
      // 提示文案：免费服务提示隐私，付费（DeepSeek）才提示消耗 Token
      const trInfo = transInfo && typeof transInfo === 'object' ? transInfo : null;
      const warnText = trInfo && trInfo.available && !trInfo.paid ? t('privacyWarn') : t('tokenWarn');

      // 顶部计数 chips
      const chips = [];
      if (m.prompt) chips.push([t('systemPrompt'), fmtSize(m.prompt.length) + ' ' + t('unitChar')]);
      if (m.instr.length) chips.push([t('instructions'), m.instr.length + ' ' + t('unitItem')]);
      if (m.skills.length) chips.push([t('skills'), m.skills.length + ' ' + t('unitItem')]);
      if (m.tools.length) chips.push([t('tools'), m.tools.length + ' ' + t('unitItem')]);
      if (m.env.length) chips.push([t('env'), m.env.length + ' ' + t('unitItem')]);

      const isEmpty = !m.prompt && !m.instr.length && !m.skills.length && !m.tools.length && !m.env.length && !m.others.length;

      // 左侧分类 tab（有内容的才出现）：label + 数量 + 右侧内容
      const groups = [];
      if (m.prompt) {
        groups.push({ id: 'prompt', label: t('systemPrompt'), meta: fmtSize(m.prompt.length) + ' ' + t('unitChar'), node: h(TransText, { key: 'p', text: m.prompt, variant: 'pre', translate, t, warnText, cache: transCache, recTitle: t('systemPrompt') }) });
      }
      if (m.instr.length) {
        const instrNode = h(
          React.Fragment,
          { key: 'i' },
          m.instr.map(function (it, i) {
            return h('div', { className: 'dshLoadRow', key: i },
              h('span', { className: 'dshLoadBadge' }, it.action),
              h('span', { className: 'dshLoadPath', title: it.path }, it.path));
          }),
          m.instrText ? h('details', { className: 'dshLoadDetails' },
            h('summary', null, t('injectedText') + ' · ' + fmtSize(m.instrText.length) + ' ' + t('unitChar')),
            h(TransText, { text: m.instrText, variant: 'pre', translate, t, warnText, cache: transCache, recTitle: t('instructions') })) : null,
        );
        groups.push({ id: 'instr', label: t('instructions'), meta: m.instr.length + ' ' + t('unitItem'), node: instrNode });
      }
      if (m.skills.length) {
        groups.push({ id: 'skills', label: t('skills'), meta: m.skills.length + ' ' + t('unitItem'), node: h(SkillTabs, { key: 's', skills: m.skills, translate, t, warnText, cache: transCache }) });
      }
      if (m.tools.length) {
        groups.push({ id: 'tools', label: t('tools'), meta: m.tools.length + ' ' + t('unitItem'), node: h(React.Fragment, { key: 't' },
          h('div', { className: 'dshLoadHint' }, t('toolsHint')),
          m.tools.map(function (s, i) { return h(ItemBlock, { key: i, name: s.name, text: s.description, variant: 'desc', translate, t, warnText, cache: transCache, recTitle: t('tools') + '：' + s.name }); })) });
      }
      if (m.env.length) {
        groups.push({ id: 'env', label: t('env'), meta: m.env.length + ' ' + t('unitItem'), node: h(React.Fragment, { key: 'e' },
          m.env.map(function (s, i) {
            return h(ItemBlock, { key: i, name: s.name, text: s.text, variant: 'pre', translate, t, warnText, cache: transCache, recTitle: t('env') + '：' + s.name });
          })) });
      }
      if (m.others.length) {
        groups.push({ id: 'others', label: t('others'), meta: m.others.length + ' ' + t('unitItem'), node: h(React.Fragment, { key: 'o' },
          h('div', { className: 'dshLoadHint' }, t('othersHint')),
          m.others.map(function (s, i) {
            return h('div', { className: 'dshLoadItem', key: i },
              h('div', { className: 'dshLoadItemName' }, s.label),
              h(TransText, { text: s.text, variant: 'pre', translate, t, warnText, cache: transCache, recTitle: t('others') + '：' + s.label }));
          })) });
      }
      // 翻译记录不再是左侧 tab，改为顶部入口打开后在这里展示
      const historyNode = h(HistoryView, { history, translate, t });
      const sources = { prompt: t('sourcePrompt'), instr: t('sourceInstr'), skills: t('sourceSkills'), tools: t('sourceTools'), env: t('sourceEnv'), others: t('sourceOthers') };
      groups.forEach((g) => { g.source = sources[g.id]; });

      const current = groups.find((g) => g.id === active) || groups[0] || null;

      return h(
        'div',
        { className: 'dshLoadRoot' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dshLoadHeader' },
          h('div', { className: 'dshLoadTitle' }, t('title')),
          h('div', { className: 'dshLoadSubtitle' }, t('subtitle')),
          status === 'loading' ? h('div', { className: 'dshLoadStatus' }, t('loadingData')) : null,
          status === 'error'
            ? h('div', { className: 'dshLoadStatus dshLoadStatus--err' }, '⚠ ' + t('fallbackData') + (err ? '：' + err : ''))
            : null,
          h(
            'div',
            { className: 'dshLoadChips' },
            chips.map(([label, value], i) =>
              h('span', { className: 'dshLoadChip', key: i }, h('b', null, value), label),
            ),
            // 翻译记录入口常驻，即使 0 条也能打开
            h('button', {
              type: 'button',
              className: 'dshLoadChip dshLoadChip--link' + (showHistory ? ' isOn' : ''),
              onClick: () => setShowHistory(true),
              title: t('historyHint'),
            }, h('b', null, history.length + ' ' + t('unitItem')), t('history'), h('span', { className: 'dshLoadChipGo' }, '→')),
          ),
        ),
        (isEmpty && !showHistory)
          ? h('div', { className: 'dshLoadEmpty' }, t('empty'))
          : h(
              'div',
              { className: 'dshLoadBody' },
              h(
                'div',
                { className: 'dshLoadNav' },
                groups.map((g) =>
                  h(
                    'button',
                    {
                      type: 'button',
                      key: g.id,
                      title: g.source,
                      className: 'dshLoadNavItem' + (!showHistory && current && current.id === g.id ? ' isActive' : ''),
                      onClick: () => { setShowHistory(false); setActive(g.id); },
                    },
                    h('span', { className: 'dshLoadNavLabel' }, g.label),
                    h('span', { className: 'dshLoadNavMeta' }, g.meta),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'dshLoadContent' },
                h(
                  'div',
                  { className: 'dshLoadContentInner' + (showHistory ? ' dshLoadContentInner--wide' : '') },
                  showHistory
                    ? historyNode
                    : h(React.Fragment, null,
                        current && current.source
                          ? h('div', { className: 'dshLoadSource' },
                              h('span', { className: 'dshLoadSourceTag' }, t('sourceLabel')),
                              current.source)
                          : null,
                        current ? current.node : null),
                ),
              ),
            ),
      );
    }

    // ---------- 样式（全部走主题 CSS 变量，跟随明暗色） ----------
    const CSS = `
.dshLoadRoot{box-sizing:border-box;width:100%;height:100%;min-height:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);}
.dshLoadHeader{flex:none;padding:18px 28px 14px;border-bottom:.5px solid var(--dsw-alias-border-l3);}
.dshLoadTitle{font-size:16px;font-weight:600;line-height:24px;}
.dshLoadSubtitle{margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}
.dshLoadStatus{margin-top:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}
.dshLoadStatus--err{color:var(--dsw-alias-state-warning-primary,#b7791f);}
.dshLoadChips{margin-top:12px;display:flex;flex-wrap:wrap;gap:8px;}
.dshLoadChip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px;}
.dshLoadChip b{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums;}
.dshLoadChip--link{cursor:pointer;font-family:inherit;background:var(--dsw-alias-state-business-primary,#3b6ef0);border-color:transparent;color:#fff;}
.dshLoadChip--link b{color:#fff;}
.dshLoadChip--link:hover{opacity:.9;}
.dshLoadChip--link.isOn{box-shadow:0 0 0 2px rgba(59,110,240,.25);}
.dshLoadChipGo{font-weight:700;}
.dshLoadBody{flex:1;min-height:0;display:flex;overflow:hidden;}
.dshLoadNav{flex:none;width:196px;box-sizing:border-box;padding:12px 10px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;border-right:.5px solid var(--dsw-alias-border-l2);}
.dshLoadNavItem{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:0;border-radius:var(--dsw-radius-md);background:0 0;cursor:pointer;font-family:inherit;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary);text-align:left;}
.dshLoadNavItem:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dshLoadNavItem.isActive{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600;}
.dshLoadNavLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dshLoadNavMeta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums;}
.dshLoadContent{flex:1;min-width:0;overflow-y:auto;padding:18px 28px 40px;scrollbar-gutter:stable;}

.dshLoadContentInner{max-width:760px;margin:0 auto;}
.dshLoadContentInner--wide{max-width:none;}
.dshLoadSource{display:flex;gap:8px;align-items:baseline;margin-bottom:14px;padding:8px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-markdown-code-block,rgba(127,127,127,.06));color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}
.dshLoadSourceTag{flex:none;padding:0 6px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;}
.dshLoadEmpty{flex:1;color:var(--dsw-alias-label-tertiary);font-size:13px;padding:40px 0;text-align:center;}
@media (max-width:640px){
.dshLoadBody{flex-direction:column;}
.dshLoadNav{width:auto;flex:0 0 auto;flex-direction:row;border-right:0;border-bottom:.5px solid var(--dsw-alias-border-l2);overflow-x:auto;overflow-y:hidden;padding:8px;}
.dshLoadNavItem{width:auto;white-space:nowrap;}
.dshLoadNavMeta{display:none;}
.dshLoadContent{padding:14px 16px 32px;}
}
.dshLoadChev{flex:none;width:0;height:0;margin-right:2px;border-left:5px solid var(--dsw-alias-label-tertiary);border-top:4px solid transparent;border-bottom:4px solid transparent;transition:transform .12s;}
.dshLoadHint{margin:6px 0 2px;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;}
.dshLoadRow{display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;line-height:18px;}
.dshLoadBadge{flex:none;padding:1px 7px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;}
.dshLoadPath{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-primary);}
.dshLoadSubtabs{display:block;}
.dshLoadSubtabBar{display:flex;gap:4px;margin-bottom:14px;border-bottom:.5px solid var(--dsw-alias-border-l2);}
.dshLoadSubtab{display:inline-flex;align-items:center;gap:6px;padding:6px 10px 8px;border:0;background:0 0;border-bottom:2px solid transparent;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:13px;line-height:18px;cursor:pointer;transition:color .12s,border-color .12s;}
.dshLoadSubtab:hover{color:var(--dsw-alias-label-secondary);}
.dshLoadSubtab.isOn{color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--dsw-alias-state-business-primary);}
.dshLoadSubtab b{padding:0 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;font-weight:600;font-variant-numeric:tabular-nums;}
.dshLoadSubtabBody{display:block;}
.dshLoadSkillEmpty{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;padding:6px 0;}
.dshLoadItem{padding:8px 0;border-top:.5px dashed var(--dsw-alias-border-l3);}
.dshLoadItem:first-child{border-top:0;}
.dshLoadItemName{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);font-weight:600;word-break:break-all;}
.dshLoadItemDesc{margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
.dshLoadDetails{margin-top:8px;}
.dshLoadHist{margin:0 0 6px;padding:5px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);}
.dshLoadHist>summary{color:var(--dsw-alias-label-primary);list-style:none;}
.dshLoadHist>summary::before{content:'▸';margin-right:6px;color:var(--dsw-alias-label-tertiary);}
.dshLoadHist[open]>summary::before{content:'▾';}
.dshLoadDetails>summary{cursor:pointer;color:var(--dsw-alias-state-business-primary);font-size:12px;line-height:18px;list-style:none;}
.dshLoadDetails>summary::-webkit-details-marker{display:none;}
.dshLoadItemBlock{padding:0;}
.dshLoadItemHead{display:flex;align-items:center;gap:8px;width:100%;padding:10px 2px;border:0;background:0 0;font-family:inherit;text-align:left;cursor:pointer;color:inherit;}
.dshLoadItemHead:hover .dshLoadItemName{color:var(--dsw-alias-state-business-primary);}
.dshLoadItemHead .dshLoadChev.isOpen{transform:rotate(90deg);}
.dshLoadItemToggle{margin-left:auto;flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;}
.dshLoadDetailBlock{margin:0;padding:0;box-sizing:border-box;background:0 0;}
.dshLoadBare{margin:0;padding:0;border:0;background:0 0;max-height:none;overflow:visible;display:block;-webkit-line-clamp:unset;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;}
.dshLoadBarePre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
.dshLoadMuted{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;}
.dshLoadPrompt{box-sizing:border-box;margin:0;padding:0;max-height:none;overflow:visible;border-radius:0;background:0 0;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;}
.dshLoadTextBlock{position:relative;box-sizing:border-box;margin:0 0 10px;padding:8px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-markdown-code-block,rgba(127,127,127,.08));}
.dshLoadTextBar{display:flex;justify-content:flex-end;align-items:center;gap:6px;margin:0 0 4px;}
.dshLoadHistLabel{margin:6px 0 3px;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:600;}
.dshLoadHistSummary{display:flex;align-items:center;gap:8px;line-height:18px;}
.dshLoadHistTitle{flex:none;padding:0 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dshLoadHistSummary .dshLoadHistLabel{margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-weight:400;}
.dshLoadDelBtn{flex:none;margin-left:auto;border:.5px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:11px;line-height:16px;padding:1px 8px;border-radius:999px;cursor:pointer;}
.dshLoadDelBtn:hover{color:var(--dsw-alias-state-danger-primary,#d64545);border-color:currentColor;}
.dshLoadWarn{color:var(--dsw-alias-label-tertiary,#8a8a95);font-size:11px;line-height:16px;white-space:nowrap;}
.dshLoadTransBtn{display:inline-flex;align-items:center;gap:5px;padding:2px 10px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-state-business-primary);font-family:inherit;font-size:11px;line-height:16px;cursor:pointer;transition:background .12s;}
.dshLoadTransBtn:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dshLoadTransBtn:disabled{cursor:default;opacity:.6;}
.dshLoadCopyBtn{display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11px;line-height:16px;cursor:pointer;transition:background .12s,color .12s;}
.dshLoadCopyBtn:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dshLoadCopyBtn.isCopied{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);}
.dshLoadSeg{display:inline-flex;gap:2px;padding:2px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);}
.dshLoadSegBtn{appearance:none;border:0;background:0 0;padding:2px 12px;border-radius:999px;font-family:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background .12s,color .12s;}
.dshLoadSegBtn.isOn{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 0 0 .5px var(--dsw-alias-border-l2);}
.dshLoadSpin{width:10px;height:10px;box-sizing:border-box;border:1.5px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-state-business-primary);border-radius:50%;display:inline-block;animation:dshLoadSpin .7s linear infinite;}
@keyframes dshLoadSpin{to{transform:rotate(360deg)}}
.dshLoadTransErr{margin-top:6px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;}
`;

    // ---------- 翻译记录：桌面客户端存本机文件（50 条），浏览器存 localStorage（10 条） ----------
    const isDesktopApp = (() => { try { return /Electron/i.test(navigator.userAgent) || !!(window.process && window.process.versions && window.process.versions.electron); } catch (e) { return false; } })();
    const HISTORY_MAX = isDesktopApp ? 50 : 10;
    const asHistory = (v) => (Array.isArray(v) ? v.filter((x) => x && x.text) : []).slice(0, HISTORY_MAX);
    function writeBrowserHistory(items) {
      try { window.localStorage.setItem('dsh-ssl-history', JSON.stringify(asHistory(items))); } catch (e) { /* 忽略 */ }
    }
    function loadHistory(desktop) {
      if (desktop) {
        return fetch('/session-show-load/translations')
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => asHistory(d && d.items))
          .catch(() => []);
      }
      try { return Promise.resolve(asHistory(JSON.parse(window.localStorage.getItem('dsh-ssl-history') || '[]'))); }
      catch (e) { return Promise.resolve([]); }
    }
    function saveHistoryRecord(rec, desktop) {
      if (desktop) {
        fetch('/session-show-load/translations', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: rec.id, text: rec.text, translated: rec.translated, title: rec.title }),
        }).catch(() => {});
        return;
      }
      try {
        const prev = asHistory(JSON.parse(window.localStorage.getItem('dsh-ssl-history') || '[]'))
          .filter((x) => !(x.text === rec.text && (x.title || '') === (rec.title || '')));
        writeBrowserHistory([rec, ...prev]);
      } catch (e) { /* 忽略 */ }
    }

    // ---------- AI 翻译：请求宿主 /session-show-load/translate ----------
    // 宿主侧会直接用默认大模型新发一次独立调用（不依赖其它插件）；本函数只负责切块与串行请求。
    function createTranslator() {
      return async function translate(text, sessionId) {
        const out = [];
        for (const part of chunkText(text, 8000)) {
          const res = await fetch('/session-show-load/translate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: part, targetLanguage: 'zh-CN', sessionId: toSessionId(sessionId) }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || (data && data.error)) {
            throw new Error((data && data.error) || 'HTTP ' + res.status);
          }
          out.push((data && data.text) || '');
        }
        return out.join('\n\n');
      };
    }

    // ---------- 注册：新增一个 conversation.view tab ----------
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-show-load: dictionaries');
      const t = ctx.locale.bind(NS);
      const translate = createTranslator();
      // 包一层，把翻译函数（绑定当前 sessionId）注入面板
      const View = (props) => {
        const sid = props && props.sessionId;
        // 稳定引用，避免每次渲染都触发 LoadPanel 重新拉数据/历史
        const boundTranslate = React.useMemo(() => (text) => translate(text, sid), [sid]);
        return h(LoadPanel, Object.assign({}, props, { translate: boundTranslate }));
      };
      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register(
          { name: 'conversation.view', id: 'session-show-load', order: 20, label: () => t('tab'), locale: NS },
          View,
        ),
      );
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
