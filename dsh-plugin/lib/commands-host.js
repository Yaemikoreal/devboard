// UI 命令（设计 §4「一个操作，两个调用方」的 UI 通路）：Client 经 ctx.remote.commands.execute
// 调用（V5/V6 实测）。写面归属纪律：备忘/置顶/位序/消音仅 UI 可达（无工具对等物）；
// 交接标记完成与 agent 工具 signalboard_handoff_complete 共用同一函数；
// signalboard-weekly / signalboard-advice 是 AI 触发链：把请求注入当前会话并唤醒 agent——
// 复刻 goal-round-driver 的 canonical 注入（createUserMessage 形状 + agent.followup(message)，
// 实测见 dsh-agent-loop ReactLoopAgent.followup = send(input,'next-turn',true)）。
// createUserMessage 本体在 dsh-llm（插件零 bare import），此处按同形状手工构造：
// { id: uuid, role: 'user', content: [{type:'text',text}], source: {...生产者标记} }。
import { randomUUID } from 'node:crypto';
import { handoffs } from './domain.js';

const SOURCE = Object.freeze({ kind: 'plugin', plugin: '@local/signalboard' });

function queueInstruction(agent, text) {
  const message = Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text }]),
    source: SOURCE,
  });
  agent.followup(message); // 追加为 next-turn 并唤醒
}

function parseJson(rawInput) {
  const s = String(rawInput || '').trim();
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

const ok = (text) => ({ kind: 'success', text });
const bad = (text) => ({ kind: 'error', text });

export function registerCommands(ctx, store, svc, t) {
  const defs = [
    {
      name: 'signalboard-memo',
      description: t ? t('cmd.memo') : '保存某项目的备忘（UI 专用写面）',
      input: { hint: 'JSON：{"path": "项目绝对路径", "text": "备忘正文（空串删除）"}' },
      handler: (inv) => {
        const args = parseJson(inv.rawInput);
        if (!args || typeof args.path !== 'string' || !args.path.trim()) {
          return bad('参数需为 JSON：{"path":"项目绝对路径","text":"备忘正文"}');
        }
        store.setMemo(args.path, String(args.text == null ? '' : args.text));
        return ok('备忘已保存');
      },
    },
    {
      name: 'signalboard-pref',
      description: t ? t('cmd.pref') : '更新面板偏好：置顶/位序/警示消音（UI 专用写面）',
      input: { hint: 'JSON：{"action":"pin|unpin|order|snooze|unsnooze", ...}' },
      handler: (inv) => {
        const args = parseJson(inv.rawInput);
        if (!args || typeof args.action !== 'string') {
          return bad('参数需为 JSON：{"action":"pin|unpin|order|snooze|unsnooze",...}');
        }
        const prefs = store.getPrefs();
        const path = String(args.path || '');
        if (args.action === 'pin' || args.action === 'unpin') {
          if (!path) return bad('缺少 path');
          const set = new Set(prefs.pinned);
          if (args.action === 'pin') set.add(path);
          else set.delete(path);
          store.setPrefs({ pinned: [...set] });
          return ok(args.action === 'pin' ? '已置顶' : '已取消置顶');
        }
        if (args.action === 'order') {
          if (!Array.isArray(args.cardOrder)) return bad('缺少 cardOrder 数组');
          store.setPrefs({ cardOrder: args.cardOrder.map(String) });
          return ok('位序已保存');
        }
        if (args.action === 'snooze' || args.action === 'unsnooze') {
          if (!path) return bad('缺少 path');
          const type = String(args.type || '');
          const label = String(args.label || '');
          if (!type) return bad('缺少 warning type');
          const snoozes = Object.assign({}, prefs.snoozes);
          const mine = Object.assign({}, snoozes[path]);
          if (args.action === 'snooze') mine[type] = label;
          else delete mine[type];
          if (!Object.keys(mine).length) delete snoozes[path];
          else snoozes[path] = mine;
          store.setPrefs({ snoozes });
          return ok(args.action === 'snooze' ? '已消音' : '已取消消音');
        }
        return bad('未知 action：' + args.action);
      },
    },
    {
      name: 'signalboard-handoff-done',
      description: t ? t('cmd.handoffDone') : '标记某条交接已被接力完成（与 agent 工具同一函数）',
      input: { hint: 'JSON：{"path": "项目绝对路径", "id": "交接条目 id"}' },
      handler: (inv) => {
        const args = parseJson(inv.rawInput);
        if (!args || !args.path || !args.id) return bad('参数需为 JSON：{"path":"项目绝对路径","id":"交接条目 id"}');
        try {
          handoffs.markDone(store, String(args.path), String(args.id));
          return ok('交接已标记完成');
        } catch (err) {
          return bad((err && err.message) || String(err));
        }
      },
    },
    {
      name: 'signalboard-weekly',
      description: t ? t('cmd.weekly') : '请求本会话生成 SignalBoard 本周总结（事实来自 signalboard_weekly_facts，经 signalboard_save_summary 落缓存）',
      handler: (inv) => {
        const agent = inv && inv.agent;
        if (!agent) return bad('请在会话中运行该命令');
        const instruction = [
          '请为 SignalBoard 生成本周进展摘要：',
          '1. 调用 signalboard_weekly_facts 工具读取近 7 天各项目提交事实；',
          '2. 按以下结构用中文输出：第一行以「本周总览：」开头（60 字以内一句话）；随后逐行「- **项目名**：45 字以内进展描述」；最后一行以「本周建议关注：」开头给 1-2 句建议；',
          '3. 输出完成后调用 signalboard_save_summary 工具（kind="weekly"，text=完整总结文本）落缓存，供面板展示。',
        ].join('\n');
        try {
          queueInstruction(agent, instruction);
        } catch (err) {
          return bad('注入会话失败：' + ((err && err.message) || err));
        }
        return ok('已请求当前会话生成本周总结');
      },
    },
    {
      name: 'signalboard-advice',
      description: t ? t('cmd.advice') : '请求本会话为某项目生成下一步建议（事实来自 signalboard_advice_facts，经 signalboard_save_summary 落缓存）',
      input: { hint: 'JSON：{"path": "项目绝对路径"}' },
      handler: (inv) => {
        const args = parseJson(inv.rawInput);
        if (!args || !args.path) return bad('参数需为 JSON：{"path":"项目绝对路径"}');
        const agent = inv && inv.agent;
        if (!agent) return bad('请在会话中运行该命令');
        const p = String(args.path);
        const instruction = [
          '请为 SignalBoard 项目生成下一步行动建议：',
          '1. 调用 signalboard_advice_facts 工具（path=' + JSON.stringify(p) + '）读取该项目事实；',
          '2. 用中文输出：第一行以「近况概览：」开头（1-2 句）；随后 2-3 条「- 」开头的可执行建议（每条 ≤50 字）；',
          '3. 输出完成后调用 signalboard_save_summary 工具（kind="advice"，path=' + JSON.stringify(p) + '，text=完整建议文本）落缓存。',
        ].join('\n');
        try {
          queueInstruction(agent, instruction);
        } catch (err) {
          return bad('注入会话失败：' + ((err && err.message) || err));
        }
        return ok('已请求当前会话生成项目建议');
      },
    },
  ];
  for (const def of defs) {
    ctx.effect(() => ctx.commands.register(def), 'signalboard: command ' + def.name);
  }
  return defs;
}
