export interface RecallNoticeInfo {
    operator_id?: number | string
    user_id?: number | string
    group_id?: number | string
    notice_type?: string
    time?: number
}

interface CachedChatEntry {
    selfId: string
    chatType: 'group' | 'user'
    chatId: string
    messageId: string
    message: Record<string, any>
}

function normalizeId(value: unknown): string {
    if (value === null || value === undefined) return ''
    return String(value)
}

function normalizeChatType(type?: string, groupId?: unknown): 'group' | 'user' {
    if (groupId != null || type === 'group') return 'group'
    return 'user'
}

function cloneMessage<T extends Record<string, any>>(
    message: T,
    overrides?: Record<string, any>,
): T {
    const cloned = {
        ...message,
        message: Array.isArray(message.message) ? [...message.message] : message.message,
        ...(overrides ?? {}),
    } as T
    // Keep preprocess marker across shallow clones so non-idempotent steps (e.g. mface filtering) do not re-run.
    if (message?._preprocessed) {
        Object.defineProperty(cloned, '_preprocessed', {
            value: true,
            enumerable: false,
            configurable: true,
        })
    }
    return cloned
}

function buildRecallInfo(
    existing?: RecallNoticeInfo,
    notice?: any,
): RecallNoticeInfo {
    const info: RecallNoticeInfo = { ...(existing ?? {}) }
    if (notice?.operator_id !== undefined) info.operator_id = notice.operator_id
    if (notice?.user_id !== undefined) info.user_id = notice.user_id
    if (notice?.group_id !== undefined) info.group_id = notice.group_id
    if (notice?.notice_type !== undefined) info.notice_type = notice.notice_type
    if (notice?.time !== undefined) info.time = notice.time
    return info
}

function hasReadableContent(message: any): boolean {
    return Boolean(
        message &&
        message.post_type !== 'notice' &&
        Array.isArray(message.message) &&
        message.message.length > 0,
    )
}

function setLru<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
    if (map.has(key)) map.delete(key)
    map.set(key, value)
    while (map.size > limit) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
    }
}

function resolveMessageChat(
    selfId: string,
    message: any,
    fallbackChat?: { type?: string; id?: string | number },
): { chatType: 'group' | 'user'; chatId: string } {
    const rawGroupId = message?.group_id ?? message?.infoList?.group_id
    const rawPrivateId = message?.infoList?.private_id ?? message?.user_id
    const chatType = normalizeChatType(
        message?.message_type ?? (rawGroupId == null && rawPrivateId == null ? fallbackChat?.type : undefined),
        rawGroupId,
    )
    if (chatType === 'group') {
        const groupId = rawGroupId ?? (fallbackChat?.type === 'group' ? fallbackChat.id : undefined)
        return { chatType, chatId: normalizeId(groupId) }
    }
    const senderId = normalizeId(message?.sender?.user_id ?? message?.infoList?.sender)
    let peerId: unknown
    if (senderId === selfId) {
        peerId =
            message?.target_id ??
            message?.infoList?.target_id ??
            message?.infoList?.private_id ??
            message?.user_id ??
            (fallbackChat?.type !== 'group' ? fallbackChat?.id : undefined)
    } else {
        peerId =
            message?.user_id ??
            message?.sender?.user_id ??
            message?.infoList?.private_id ??
            message?.infoList?.sender ??
            (fallbackChat?.type !== 'group' ? fallbackChat?.id : undefined)
    }
    return { chatType, chatId: normalizeId(peerId) }
}

/**
 * 判断撤回事件是否由当前登录用户撤回自己发送的消息。
 * 自己撤回自己的消息时应保留默认“重新编辑”流程；管理员撤回己方消息或他人撤回则触发防撤回。
 */
export function isSelfRecallNotice(
    notice: any,
    selfUin: number | string | undefined,
    targetMsg?: any,
): boolean {
    const self = normalizeId(selfUin)
    if (!self) return false

    const isGroup = Boolean(notice?.group_id != null || notice?.notice_type?.includes('group'))
    const authorId = targetMsg?.sender?.user_id ?? notice?.user_id

    if (!isGroup && notice?.operator_id == null) {
        return authorId != null && normalizeId(authorId) === self
    }

    const operatorId = notice?.operator_id
    if (operatorId != null && authorId != null) {
        return normalizeId(operatorId) === self && normalizeId(authorId) === self
    }
    return false
}

/**
 * 为被防撤回保留的消息打上 `revoked` 状态与撤回元信息。
 * 绝不设置 `revoke: true`（该字段用于预发送占位及隐藏样式）。
 */
export function markMessageRevoked<T extends Record<string, any>>(
    message: T,
    notice?: any,
): T {
    const recallInfo = buildRecallInfo(message.recall_info, notice)
    return cloneMessage(message, {
        revoked: true,
        recall_info: recallInfo,
    })
}

export class AntiRecallCache {
    private readonly recentLimit: number
    private readonly recalledLimit: number
    private readonly recentMessages = new Map<string, CachedChatEntry>()
    private readonly recalledMessages = new Map<string, CachedChatEntry>()
    private readonly recalledMeta = new Map<string, RecallNoticeInfo>()

    constructor(recentLimit = 500, recalledLimit = 500) {
        this.recentLimit = recentLimit
        this.recalledLimit = recalledLimit
    }

    rememberMessages(
        selfId: string | number,
        messages: any[],
        fallbackChat?: { type?: string; id?: string | number },
    ): void {
        const selfKey = normalizeId(selfId)
        if (!selfKey || !Array.isArray(messages)) return

        for (const msg of messages) {
            if (!hasReadableContent(msg) || msg?.fake_msg || msg?.message_id == null) continue
            const msgId = normalizeId(msg.message_id)
            if (!msgId) continue
            const key = `${selfKey}:${msgId}`
            const { chatType, chatId } = resolveMessageChat(selfKey, msg, fallbackChat)

            let snapshot = cloneMessage(msg)
            const knownRecalled = this.recalledMessages.get(key)
            const knownMeta = knownRecalled?.message.recall_info ?? this.recalledMeta.get(key)
            if (knownRecalled || knownMeta || snapshot.revoked) {
                snapshot = markMessageRevoked(snapshot, knownMeta)
                const recalledChatId = chatId || knownRecalled?.chatId || ''
                const recalledChatType = chatId ? chatType : (knownRecalled?.chatType ?? chatType)
                setLru(this.recalledMessages, key, {
                    selfId: selfKey,
                    chatType: recalledChatType,
                    chatId: recalledChatId,
                    messageId: msgId,
                    message: cloneMessage(snapshot),
                }, this.recalledLimit)
            }

            setLru(this.recentMessages, key, {
                selfId: selfKey,
                chatType,
                chatId,
                messageId: msgId,
                message: snapshot,
            }, this.recentLimit)
        }
    }

    captureRecall(
        selfId: string | number,
        notice: any,
        activeMsg?: any,
    ): any | null {
        const selfKey = normalizeId(selfId)
        const msgId = normalizeId(notice?.message_id)
        if (!selfKey || !msgId) return null

        const key = `${selfKey}:${msgId}`
        const recallInfo = buildRecallInfo(this.recalledMeta.get(key), notice)
        setLru(this.recalledMeta, key, recallInfo, this.recalledLimit)

        const recentEntry = this.recentMessages.get(key)
        const existingRecalled = this.recalledMessages.get(key)
        const source = hasReadableContent(activeMsg)? activeMsg: existingRecalled?.message ?? recentEntry?.message

        if (!source || !hasReadableContent(source)) return null

        const revokedMsg = markMessageRevoked(source, recallInfo)
        const isGroup = Boolean(notice?.group_id != null || notice?.notice_type?.includes('group'))
        const chatType: 'group' | 'user' = isGroup ? 'group' : 'user'
        const resolvedChatId = isGroup? (notice?.group_id ?? source.group_id ?? source.infoList?.group_id ?? existingRecalled?.chatId ?? recentEntry?.chatId): (notice?.user_id ??
                (normalizeId(source.sender?.user_id) === selfKey? (source.target_id ?? source.infoList?.target_id ?? source.infoList?.private_id ?? source.user_id): (source.user_id ?? source.sender?.user_id ?? source.infoList?.private_id)) ??
                existingRecalled?.chatId ??
                recentEntry?.chatId)

        const entry: CachedChatEntry = {
            selfId: selfKey,
            chatType,
            chatId: normalizeId(resolvedChatId),
            messageId: msgId,
            message: cloneMessage(revokedMsg),
        }
        setLru(this.recalledMessages, key, entry, this.recalledLimit)

        if (recentEntry) {
            setLru(this.recentMessages, key, {
                ...recentEntry,
                message: cloneMessage(revokedMsg),
            }, this.recentLimit)
        }

        return cloneMessage(revokedMsg)
    }

    getRecalledMessage(selfId: string | number, messageId: string | number): any | null {
        const selfKey = normalizeId(selfId)
        const msgId = normalizeId(messageId)
        if (!selfKey || !msgId) return null
        const entry = this.recalledMessages.get(`${selfKey}:${msgId}`)
        return entry ? cloneMessage(entry.message) : null
    }

    getRecentMessage(selfId: string | number, messageId: string | number): any | null {
        const selfKey = normalizeId(selfId)
        const msgId = normalizeId(messageId)
        if (!selfKey || !msgId) return null
        const entry = this.recentMessages.get(`${selfKey}:${msgId}`)
        return entry ? cloneMessage(entry.message) : null
    }

    applyRecallMetaIfKnown<T extends Record<string, any>>(
        selfId: string | number,
        message: T,
    ): T {
        const selfKey = normalizeId(selfId)
        const msgId = normalizeId(message?.message_id)
        if (!selfKey || !msgId) return message
        const key = `${selfKey}:${msgId}`
        const recalled = this.recalledMessages.get(key)
        const meta = recalled?.message.recall_info ?? this.recalledMeta.get(key)
        if (!recalled && !meta) return message
        return markMessageRevoked(message, meta)
    }

    restoreRecalledInHistory(
        selfId: string | number,
        chatType: string,
        chatId: string | number,
        list: any[],
        options?: { isLatestPage?: boolean },
    ): any[] {
        const selfKey = normalizeId(selfId)
        const targetType = normalizeChatType(chatType)
        const targetId = normalizeId(chatId)
        if (!selfKey || !targetId || !Array.isArray(list)) return list

        const result = list.map((item) => {
            const msgId = normalizeId(item?.message_id)
            if (!msgId) return item
            const key = `${selfKey}:${msgId}`
            const recalled = this.recalledMessages.get(key)
            const meta = recalled?.message.recall_info ?? this.recalledMeta.get(key)
            const isEmpty = !Array.isArray(item?.message) || item.message.length === 0

            if (recalled && isEmpty) {
                const patch: Record<string, any> = {}
                if (recalled.message.time == null && item?.time != null) {
                    patch.time = item.time
                }
                if (item?.message_seq !== undefined && recalled.message.message_seq === undefined) {
                    patch.message_seq = item.message_seq
                }
                if (item?.seq_id !== undefined && recalled.message.seq_id === undefined) {
                    patch.seq_id = item.seq_id
                }
                return cloneMessage(recalled.message, patch)
            }
            if (recalled || meta) {
                return markMessageRevoked(item, meta)
            }
            return item
        })

        const existingIds = new Set(
            result.map((m) => normalizeId(m?.message_id)).filter(Boolean),
        )
        const times = result
            .map((m) => Number(m?.time))
            .filter((t) => Number.isFinite(t) && t > 0)
        const minTime = times.length > 0 ? Math.min(...times) : -Infinity
        const maxTime = times.length > 0 ? Math.max(...times) : Infinity
        const isLatest = Boolean(options?.isLatestPage)
        const isShortFullChat = isLatest && result.length < 20

        const injected: any[] = []
        for (const entry of this.recalledMessages.values()) {
            if (
                entry.selfId !== selfKey ||
                entry.chatType !== targetType ||
                entry.chatId !== targetId ||
                existingIds.has(entry.messageId)
            ) {
                continue
            }
            const t = Number(entry.message?.time)
            const inWindow = result.length === 0? isLatest: (Number.isFinite(t) && (isShortFullChat || t >= minTime) && (isLatest || t <= maxTime))
            if (inWindow) {
                injected.push(cloneMessage(entry.message))
            }
        }

        return injected.length > 0 ? [...result, ...injected] : result
    }

    clear(): void {
        this.recentMessages.clear()
        this.recalledMessages.clear()
        this.recalledMeta.clear()
    }
}

export const antiRecallCache = new AntiRecallCache()
