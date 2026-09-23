export type Choice = { id: string; label: string };

export type InboxQuestionContext = {
  projectName: string | null;
  repoName: string | null;
  taskName: string | null;
  chainId: string | null;
  chainIndex: number | null;
};

// Gate cards now carry an artifact preview; Feishu rejects oversized cards, so
// the rendered body is capped independently of whatever the producer wrote.
const CARD_BODY_LIMIT = 3_000;

const cardBody = (body: string): string =>
  body.length <= CARD_BODY_LIMIT ? body : `${body.slice(0, CARD_BODY_LIMIT)}\n…（消息过长已截断，完整内容见 Inbox 页）`;

export const questionCard = (message: {
  id: string;
  body: string;
  choices: Choice[];
  replyRequired: boolean;
} & InboxQuestionContext): Record<string, unknown> => ({
  config: { wide_screen_mode: true },
  header: {
    template: "blue",
    title: {
      tag: "plain_text",
      content: message.choices.length > 0
        ? "Anneal 需要你的决策"
        : message.replyRequired
          ? "Anneal 需要你的回复"
          : "Anneal 需要人工处理",
    },
  },
  elements: [
    {
      tag: "div",
      text: {
        tag: "plain_text",
        content: [
          `项目：${message.projectName ?? "未关联"}`,
          ...(message.repoName ? [`仓库：${message.repoName}`] : []),
          ...(message.taskName ? [`任务：${message.taskName}`] : []),
          ...(message.chainId ? [`Chain：${message.chainId}${message.chainIndex === null ? "" : ` · Step ${message.chainIndex + 1}`}`] : []),
        ].join("\n"),
      },
    },
    { tag: "div", text: { tag: "lark_md", content: `**原因 / 详情：**\n${cardBody(message.body)}` } },
    {
      tag: "div",
      text: {
        tag: "plain_text",
        content: message.choices.length > 0
          ? `需要决策：${message.choices.map((choice) => choice.label).join(" / ")}`
          : message.replyRequired
            ? "需要回复：请在 Inbox 中回复"
            : "需要处理：需调查并在 Inbox 中处理",
      },
    },
    {
      tag: "div",
      text: { tag: "lark_md", content: `[打开 Inbox 处理](https://agentos.novelcatch.com/#/inbox/${message.id})` },
    },
    ...(message.choices.length > 0 ? [{
      tag: "action",
      actions: message.choices.map((choice) => ({
        tag: "button",
        type: choice.id === "approve" ? "primary" : choice.id === "reject" ? "danger" : "default",
        text: { tag: "plain_text", content: choice.label },
        value: { inboxMessageId: message.id, choiceId: choice.id },
      })),
    }] : []),
    ...(message.replyRequired ? [{
      tag: "note",
      elements: [{ tag: "plain_text", content: "也可直接回复此消息；长连接离线期间飞书不会补投事件。" }],
    }] : []),
  ],
});
