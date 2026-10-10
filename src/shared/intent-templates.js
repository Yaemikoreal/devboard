// 意图路由 MVP（issue #142，ADR-0004 第 1 条）：三类警示各配固定 prompt 模板。
// 纯数据模块（与 ai-tools.js 同款纪律：不依赖 Electron、不做 IO），渲染层按钮文案与
// 实际预填 prompt 同源——不会出现「按钮说的和终端里收到的不一致」。
// 边界（ADR-0004，勿越）：
// - 插入点只吃统计事实（分支名、未提交数、领先数、PR 号/标题）与提交信息文本，不上传代码内容
// - 通用「带着近况起 CLI」入口不做，type 字段留扩展位（新增类型在此登记即可）
// - pr 模板做 gh 在/不在双版本：gh CLI 不在时优雅降级为通用网页表述
'use strict';

// 事实装配约定（渲染层装配，见 app.js intentFactsOf）：
//   { branch, dirtyCount, dirtyDays, ahead, prNumber, prTitle, ghAvailable }
// 全部为统计事实；模板绝不接收代码内容字段
const WARNING_TEMPLATES = {
  dirty: {
    buildPrompt(facts) {
      const f = facts || {};
      const branch = f.branch || '当前分支';
      const count = f.dirtyCount || 0;
      return [
        '分支 ' + branch + ' 有 ' + count + ' 个文件未提交（已滞留约 ' + (f.dirtyDays || 3) + ' 天）。',
        '请整理当前改动成合理提交：',
        '- 先用 git status 与 git diff --stat 浏览全部改动，按逻辑分组（不要一次全塞进一个提交）',
        '- 提交信息用中文，说清「为什么改」而不是「改了什么文件」',
        '- 只在本地提交，不要推送，等我确认',
      ].join('\n');
    },
  },
  ahead: {
    buildPrompt(facts) {
      const f = facts || {};
      const branch = f.branch || '当前分支';
      const ahead = f.ahead || 0;
      return [
        '分支 ' + branch + ' 领先远程 ' + ahead + ' 个提交，尚未推送。',
        '请确认这 ' + ahead + ' 个提交完整、信息清晰（git log 远程分支..HEAD 浏览），确认无误后 git push。',
        '- 如遇冲突、需要 force push 或发现不该推的提交，先停下来问我，不要自行处理',
      ].join('\n');
    },
  },
  pr: {
    buildPrompt(facts) {
      const f = facts || {};
      const n = f.prNumber ? '#' + f.prNumber : '';
      const title = f.prTitle ? '（' + f.prTitle + '）' : '';
      const head = '项目有一个开放 PR ' + n + title + '，待处理 review。';
      if (f.ghAvailable) {
        return [
          head,
          '请用 gh CLI 查看这个 PR 的评审意见与 CI 状态（gh pr view / gh pr checks），',
          '把待处理的意见整理成清单给我，标注哪些是必须改的；先不要自行改代码或合并。',
        ].join('\n');
      }
      // gh CLI 不在：优雅降级为通用网页表述（issue 原文要求）
      return [
        head,
        '请打开 GitHub 仓库页面查看这个 PR 的评审意见与 CI 状态，',
        '把待处理的意见整理成清单给我，标注哪些是必须改的；先不要自行改代码或合并。',
        '（本机未安装 gh CLI，无法直接读取 PR 数据）',
      ].join('\n');
    },
  },
};

// 按警示类型取模板；未知类型（ci/review 等无模板类型）返回 null——渲染层据此不挂执行键
function warningTemplate(type) {
  return WARNING_TEMPLATES[type] || null;
}

module.exports = { WARNING_TEMPLATES, warningTemplate };
