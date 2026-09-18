// AI 引擎链（issue-24）：从 doAiAsk 抽出「按候选链跑引擎、失败入黑名单、成功写 lastGood、聚合中文类别」，
// 依赖全部注入（不 require electron/store），脚本侧可用假 run 直接单测回退与拉黑语义。
'use strict';

// AI 引擎错误归类（issue #138）：抛给渲染层的失败原因映射为中文类别，普通用户读得懂；
// 原始（多为英文）错误行由调用方的 onFail 进 console.error 供排查
function aiErrorCategory(reason) {
  const s = String(reason || '');
  if (/超时|timed? ?out/i.test(s)) return '响应超时';
  if (/401|403|unauthorized|forbidden|未授权|鉴权|invalid[-_ ]?api[-_ ]?key/i.test(s)) return '鉴权失败（请在终端重新登录该引擎）';
  if (/429|quota|rate.?limit|insufficient|token plan|用量上限|余额不足|超限/i.test(s)) return '配额不足或已达用量上限';
  if (/启动失败|ENOENT|not found|找不到|未安装/i.test(s)) return '引擎未安装或命令不可用';
  if (/ECONN|ENOTFOUND|EAI_AGAIN|网络|network/i.test(s)) return '网络连接失败';
  if (/输出无法解析/.test(s)) return '输出无法解析';
  if (/命令行过长/.test(s)) return '提示词超出命令行长度上限';
  if (/输出超限/.test(s)) return '输出异常（内容过长）';
  return '调用失败';
}

// 按候选链依次调用引擎，任一成功即返回；全部失败聚合中文类别清单。
// 入参：
//   engines     —— 候选引擎 [{ id, label, cmd }]，按优先级排序
//   badEngines  —— 会话级黑名单 Set（issue #41）：链首先做健康过滤（全灭时照旧全试，可能已恢复）；
//                  失败/产出不可解析的引擎就地加入
//   run(engine) —— 跑单引擎，返回 { ok, text, reason }（超时等参数由调用方闭包携带，issue #132）
//   onFail(engine, reason) —— 可选；调用失败的原始错误行出口（console.error，issue #138）
//   validate(text) —— 可选；产出校验（filter 的 parseFilter），返回假值视同引擎失败，
//                     类别固定「输出无法解析」，不算调用失败、不触 onFail（无原始错误行，issue #137）
//   onLastGood(engineId) —— 可选；成功时记最近可用引擎（filter 走这里，issue #137）；
//                     weekly/advice 的 lastGood 随缓存写回落（issue #41），不传此回调
//   firstOnly   —— 可选；只打链首首选引擎（filter，issue #132），在健康过滤之后截取
// 返回：{ ok, engine, text, extra, fails }；engine 为 { id, label, cmd }，extra 为 validate 的产出
async function runEngineChain({ engines, badEngines, run, categorize, onFail, validate, onLastGood, firstOnly }) {
  const cat = categorize || aiErrorCategory;
  const fails = [];
  const healthy = engines.filter((t) => !badEngines.has(t.id));
  if (healthy.length) engines = healthy; // 全灭时也照旧全试一遍（可能已恢复）
  if (firstOnly) engines = engines.slice(0, 1); // filter 只打链首首选引擎（issue #132）

  for (const engine of engines) {
    const engineInfo = { id: engine.id, label: engine.label, cmd: engine.cmd };
    const r = await run(engine);
    if (!r.ok) {
      badEngines.add(engine.id);
      if (onFail) onFail(engine, r.reason); // 原始错误行进 console（issue #138）
      fails.push(engine.label + '：' + cat(r.reason)); // 上屏只给中文类别（issue #138）
      continue;
    }
    if (validate) {
      const extra = validate(r.text);
      if (!extra) {
        // 输出无法解析视同引擎失败拉黑（issue #137）：对 filter 持续输出噪音的引擎不再被首选重试
        badEngines.add(engine.id);
        fails.push(engine.label + '：输出无法解析');
        continue;
      }
      if (onLastGood) onLastGood(engine.id); // filter 成功同样记最近可用引擎（issue #137）
      return { ok: true, engine: engineInfo, text: r.text, extra, fails };
    }
    if (onLastGood) onLastGood(engine.id);
    return { ok: true, engine: engineInfo, text: r.text, fails };
  }
  return { ok: false, fails };
}

module.exports = { runEngineChain, aiErrorCategory };
