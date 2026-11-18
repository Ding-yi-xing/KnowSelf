/**
 * 会话身份解析：把「微信 username」和「人物库 person_id」对齐。
 *
 * 这里有个历史坑：同一个联系人链路上存在**两套 id**
 *   - transport 侧：微信 username（`wxid_xxx`），发送/读未读/建会话都用它，
 *     所以 `wechat_reply_tasks.contact_id` 存的是它（见 routes/wechat-assist.ts 的 `transportContactId`）；
 *   - 历史库侧：`chat_members.person_id`（人物库 UUID），
 *     `replyHistory.listDirectConversations()` 返回的 `contact_id` 是它。
 *
 * `wechat-reply-context.build()` 用它做「联系人与会话必须严格一对一」的校验，
 * 如果把 transport 的 wxid 直接喂进去，每一轮都会抛 `CONTACT_CONVERSATION_MISMATCH`，
 * 三轮之后任务就被「连续 3 次失败」暂停。
 *
 * 会话 ID（`wechat:<wxid>`）才是两侧共同且唯一的锚点，因此这里用会话反查 person_id。
 *
 * @module @knowself/dsh-plugin/reply-context-identity
 */

/** 直聊会话行的最小形状（来自 `replyHistory.listDirectConversations()`）。 */
export interface DirectConversationLike {
  conversation_id: string;
  contact_id: string;
}

/**
 * 用会话 ID 解析出历史库侧的 contact_id（person_id）。
 *
 * @param conversations - 直聊会话列表。
 * @param conversationId - 任务上的会话 ID（`wechat:<username>`）。
 * @returns 命中的 person_id；会话不在直聊列表里时返回 undefined（调用方据此降级为无历史回复）。
 */
export function resolveHistoryContactId(
  conversations: readonly DirectConversationLike[],
  conversationId: string,
): string | undefined {
  return conversations.find((row) => row.conversation_id === conversationId)?.contact_id;
}
