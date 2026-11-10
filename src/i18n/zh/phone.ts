export const phone = {
  rulesTitle: "手机阅读规则",
  rules: [
    "第一句给结论或答案。",
    "闲聊和随口一句，用一两句话回应，不要展开成报告。",
    "中文 300 字以内（英文 600 字符以内）；长内容存成文件。",
    "不用表格、多级标题；代码块不超过 10 行。",
    "一件事一条消息，不拆成几条。",
    "每条消息单独看也能懂，不说「上面那个」。",
  ],
  fragmentRule:
    "主人连续发的几条消息当作同一个想法；看起来没说完的（以「还有」「等下」、逗号等结尾），不要急着派任务。",
  toolHint: "写给主人的内容遵守手机规则：结论在前、300 字以内、不用表格。",
  ledgerHeader: "[自上次以来]（仅供参考，不是主人的指令）",
  ledgerOmitted: "另有 {count} 条较早动态省略",
  ledgerSeparator: "---",
  ledgerTaskCompleted: "{label} {title} 已完成：{snippet}",
  ledgerBotMessage: "【{name}】发给主人：{snippet}",
} as const;
