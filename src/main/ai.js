// AI 功能内核（issue #29）：prompt 组装 + 本机 Agent CLI 一次性非交互调用 + 输出解析。
// 纯 Node，不依赖 Electron，可被 scripts/test-ai.js 直接引用。
// 原则：不自建后端、不管 API Key；只发送统计事实与提交信息文本，不上传代码内容。
'use strict';

const { spawn } = require('child_process');

const DAY_MS = 24 * 60 * 60 * 1000;
// 单次调用上限：30s 对周报/建议类长 prompt 太紧（实测 kimi 简单 filter 已需 16s），放宽到 90s（issue #41）
const AI_TIMEOUT_MS = 90000;
const MAX_OUTPUT = 4000; // 渲染层展示与缓存的文本上限

// 引擎级错误特征：配额耗尽 / 鉴权失败 / 接口报错。
// 实测 claude 配额耗尽时会立刻输出 429 错误但进程挂起不退出（SessionEnd hook 卡住），
// 必须流式命中即快速失败，否则用户只能干等到超时（issue #41）
const ENGINE_ERROR_RE = /API Error|error[^\n]{0,20}\b(?:401|403|429)\b|\b(?:401|403|429)\b|unauthorized|invalid[-_ ]?api[-_ ]?key|unrecognized_model|quota|insufficient|token plan|用量上限|余额不足/i;

// 从原始输出中提取第一条引擎错误行（无则返回空串）
function engineErrorLine(raw) {
  const lines = stripAnsi(raw).split('\n');
  for (const l of lines) {
    const t = l.trim();
    if (t && ENGINE_ERROR_RE.test(t)) return t.slice(0, 120);
  }
  return '';
}

// 各 CLI 的一次性打印模式调用规格。
// shell: claude 是 npm .cmd shim，Windows 下必须经 shell 启动（Node 对 .cmd 的 CVE 限制）；
// 原生 exe（kimi/codex/grok）直接 spawn，参数转义由 libuv 保证，中文与换行安全。
// stdin: prompt 经 stdin 传入；否则作为最后一个参数传入。
// streamJson: 输出为 JSON 行，取 role=assistant 的 content 作为正文（kimi 文本模式会混入过程 bullet，故用 stream-json）
const TOOL_SPECS = {
  claude: { args: ['-p'], stdin: true, shell: true },
  codex: { args: ['exec'], stdin: false, shell: false },
  kimi: { args: ['-p'], stdin: false, shell: false, streamJson: true },
  grok: { args: ['--single'], stdin: false, shell: false },
};
// 自定义命令无法预知参数形态，按最通行的 stdin 方式喂入
const CUSTOM_SPEC = { args: [], stdin: true, shell: true };

const ANSI_RE = /\[[0-9;?]*[a-zA-Z]|\[[0-9;]*m/g;

function stripAnsi(s) {
  return String(s || '').replace(ANSI_RE, '');
}

// 输出清洗：去 ANSI；stream-json 取 assistant 正文；去掉 kimi 的会话恢复提示尾行
function cleanOutput(raw, spec) {
  const text = stripAnsi(raw);
  if (spec && spec.streamJson) {
    const parts = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        const j = JSON.parse(t);
        if (j && j.role === 'assistant' && typeof j.content === 'string') parts.push(j.content);
      } catch { /* 非 JSON 行跳过 */ }
    }
    if (parts.length) return parts.join('\n').trim().slice(0, MAX_OUTPUT);
  }
  return text
    .split('\n')
    .filter((l) => !/^To resume this session/i.test(l.trim()))
    .join('\n')
    .trim()
    .slice(0, MAX_OUTPUT);
}

// 终止子进程：shell:true 时 child 是 cmd.exe 壳，直接 kill 只杀壳、真 AI 进程成孤儿；
// Windows 下改用 taskkill /T 连带整棵进程树
function killChild(child, spec) {
  try {
    if (spec.shell && process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    } else {
      child.kill();
    }
  } catch { /* 已退出 */ }
}

// 调用本机 CLI：返回 { ok, text, reason }；超时/启动失败/空输出均降级为 ok:false
function runCli(cmd, prompt, opts) {
  const o = opts || {};
  const spec = o.spec || TOOL_SPECS[o.toolId] || CUSTOM_SPEC;
  const timeout = o.timeout || AI_TIMEOUT_MS;
  const args = spec.stdin ? spec.args.slice() : spec.args.concat([prompt]);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        shell: !!spec.shell,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: Object.assign({}, process.env, { NO_COLOR: '1' }),
      });
    } catch (err) {
      resolve({ ok: false, reason: '启动失败：' + err.message });
      return;
    }
    let out = '';
    let errText = '';
    let done = false;
    const finish = (ok, reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok, text: ok ? cleanOutput(out, spec) : '', reason: reason || '' });
    };
    // 超时不等于没结果：进程「输出完毕但不退出」（如 claude SessionEnd hook 挂起）时采用已有输出（issue #41）
    const timer = setTimeout(() => {
      killChild(child, spec);
      const errLine = engineErrorLine(out) || engineErrorLine(errText);
      if (errLine) { finish(false, '引擎报错：' + errLine); return; }
      const partial = cleanOutput(out, spec);
      if (partial) { finish(true); return; }
      finish(false, 'AI 响应超时（' + Math.round(timeout / 1000) + ' 秒）');
    }, timeout);
    child.on('error', (err) => finish(false, '启动失败：' + err.message));
    // 流式检测引擎报错（stdout 与 stderr 都查：claude 的 unrecognized_model 走 stderr）：
    // 命中即终止，快速失败交给上层回退下一引擎（issue #41）
    const checkStream = () => {
      const errLine = engineErrorLine(out) || engineErrorLine(errText);
      if (errLine) {
        killChild(child, spec);
        finish(false, '引擎报错：' + errLine);
      }
    };
    child.stdout.on('data', (d) => { out += d.toString('utf8'); checkStream(); });
    child.stderr.on('data', (d) => { errText += d.toString('utf8'); checkStream(); });
    child.on('close', (code) => {
      const text = cleanOutput(out, spec);
      const errLine = engineErrorLine(text || out) || engineErrorLine(errText);
      // exit 0 也可能是引擎把 API 错误写进 stdout（claude 429 实测如此），不能误判为成功
      if (errLine) finish(false, '引擎报错：' + errLine);
      else if (code === 0 && text) finish(true);
      else finish(false, stripAnsi(errText).trim().split('\n')[0] || '退出码 ' + code);
    });
    // 子进程启动即死时写 stdin 会触发 EPIPE，吞掉避免 uncaughtException
    child.stdin.on('error', () => {});
    if (spec.stdin) child.stdin.write(prompt, 'utf8');
    child.stdin.end();
  });
}

function daysAgo(iso, now) {
  if (!iso) return null;
  return Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS));
}

const PRIVACY_NOTE = '说明：以上仅为统计事实与提交信息文本，不包含代码内容，也不要求查看任何代码。';

// P0 · 周报摘要：近 7 天跨项目提交事实 → 总览 + 逐项目进展 + 建议关注（结构化排版，issue #47）
function buildWeeklyPrompt(projects, now) {
  const active = (projects || [])
    .filter((p) => p.commits7d > 0)
    .sort((a, b) => b.commits7d - a.commits7d)
    .slice(0, 12);
  const lines = active.map((p) => {
    const msgs = (p.recentCommits || []).slice(0, 5).map((c) => c.msg).join('；');
    return `- ${p.name}${p.branch ? '（分支 ' + p.branch + '）' : ''}：近 7 天 ${p.commits7d} 次提交${msgs ? '；最近提交：' + msgs : ''}`;
  });
  return [
    '你在为一位同时推进多个独立开发项目的开发者撰写「本周进展摘要」。',
    '以下是近 7 天各项目的 git 提交事实：',
    lines.join('\n'),
    PRIVACY_NOTE,
    '请用中文输出，严格按以下结构，让读者能一眼看清每个项目的近况：',
    '1. 第一行以「本周总览：」开头，用一句话（60 字以内）概括本周整体进展与精力分布。',
    '2. 随后逐行列出每个项目的进展：每行以「- 」开头，项目名用 **项目名** 加粗，后接一句 45 字以内的描述，点明提交次数与主线内容。每个项目都要单列一行，不要合并或省略。',
    '3. 最后一行以「本周建议关注：」开头，给出 1-2 句最值得关注的方向。',
    '只输出以上内容，不要使用 # 标题符号，不要复述输入数据。',
  ].join('\n');
}

// P0 · 项目建议：单项目 git 信号 → 近况概览 + 下一步建议（结构化排版，issue #48）
function buildAdvicePrompt(p, now) {
  const facts = [`项目名：${p.name}`];
  if (p.branch) facts.push(`当前分支：${p.branch}`);
  const d = daysAgo(p.lastCommitAt, now);
  facts.push(d === null ? '最后提交：无提交记录' : `最后提交：${d} 天前`);
  facts.push(`近 7 天提交：${p.commits7d} 次`);
  if (p.dirtyCount > 0) {
    const dd = daysAgo(p.dirtyAt, now);
    facts.push(`未提交改动：${p.dirtyCount} 个文件${dd !== null ? '，最近修改于 ' + dd + ' 天前' : ''}`);
  }
  if (p.ahead > 0) facts.push(`领先远程：${p.ahead} 个提交未推送`);
  if (p.behind > 0) facts.push(`落后远程：${p.behind} 个提交`);
  if (p.warnings && p.warnings.length) facts.push('警示：' + p.warnings.map((w) => w.label).join('；'));
  const msgs = (p.recentCommits || []).slice(0, 5).map((c) => c.msg);
  if (msgs.length) facts.push('最近提交：' + msgs.join('；'));
  return [
    '你在为一位开发者审阅他的一个项目当前状态，并给出下一步行动建议。',
    '该项目的 git 事实如下：',
    facts.join('\n'),
    PRIVACY_NOTE,
    '请用中文输出，严格按以下结构：',
    '1. 第一行以「近况概览：」开头，用 1-2 句话概括该项目当前进度与状态（活跃度、未提交/未推送等待办风险），结合最近提交说明在做什么。',
    '2. 随后给出 2-4 条具体、可执行的下一步建议，每条一行、以「- 」开头、不超过 50 字，紧扣上面的 git 事实。',
    '只输出以上内容，不要使用 # 标题符号，不要复述输入数据。',
  ].join('\n');
}

// P1 · 自然语言筛选：把搜索框输入解析为结构化筛选条件（严格 JSON）
function buildFilterPrompt(query) {
  return [
    '把用户对项目列表的自然语言筛选请求解析为结构化 JSON。',
    '可用的活跃分带（band）枚举与含义：',
    'hot=活跃（3 天内有活动）、active=近期（3-7 天）、cooling=渐冷（7-30 天）、stale=沉睡（30-90 天）、archive=归档（90 天以上）。',
    '输出 JSON 格式：{"band": 枚举值或 null, "keyword": 用于匹配项目名/备忘的关键词或 null, "activeWithinDays": 数字或 null}。',
    '规则：涉及「最近/上周/N 天内动过」用 activeWithinDays；涉及语言或技术栈（如 python）放入 keyword；都不满足时 keyword 放原文关键词。',
    '只输出 JSON 本身，不要任何解释或代码块标记。',
    '用户输入：' + query,
  ].join('\n');
}

// 从 AI 输出中提取筛选 JSON（允许夹在散文中）；非法结构返回 null，由调用方回退关键字搜索
function parseFilter(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try {
    j = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const BANDS = ['hot', 'active', 'cooling', 'stale', 'archive'];
  const out = {
    band: BANDS.indexOf(j.band) >= 0 ? j.band : null,
    keyword: typeof j.keyword === 'string' && j.keyword.trim() ? j.keyword.trim() : null,
    days: Number.isFinite(j.activeWithinDays) && j.activeWithinDays > 0 ? Math.min(365, Math.round(j.activeWithinDays)) : null,
  };
  return out.band || out.keyword || out.days ? out : null;
}

module.exports = {
  TOOL_SPECS,
  AI_TIMEOUT_MS,
  ENGINE_ERROR_RE,
  engineErrorLine,
  runCli,
  cleanOutput,
  buildWeeklyPrompt,
  buildAdvicePrompt,
  buildFilterPrompt,
  parseFilter,
};
