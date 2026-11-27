import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
    AntiRecallCache,
    isSelfRecallNotice,
    markMessageRevoked,
} from '../src/renderer/src/function/utils/antiRecall.ts'
import {
    canUseHistoryMedia,
    notifyMessageRecall,
    watchMediaRecall,
} from '../src/renderer/src/function/utils/messageMedia.ts'

test('retained media stays available until a matching ordinary recall', () => {
    const message = markMessageRevoked({ message_id: 12, message: [{ type: 'image', url: 'https://example.test/image' }] })
    assert.equal(canUseHistoryMedia(message), true)
    assert.equal(canUseHistoryMedia({ revoked: true }), false)
    const chat = { id: 42, type: 'group' }
    const stop = watchMediaRecall(11, chat, message)
    try {
        notifyMessageRecall({ selfId: 99, chat, messageId: 12 })
        notifyMessageRecall({ selfId: 11, chat: { ...chat, type: 'private' }, messageId: 12 })
        notifyMessageRecall({ selfId: 11, chat, messageId: 13 })
        assert.equal(canUseHistoryMedia(message), true)
        notifyMessageRecall({ selfId: '11', chat, messageId: '12' })
        assert.equal(canUseHistoryMedia(message), false)
    } finally {
        stop()
    }
})

test('isSelfRecallNotice distinguishes self recalls from peer or admin recalls', () => {
    // Private chat: self recalling own message (even when notice.user_id is peer chat ID)
    assert.equal(
        isSelfRecallNotice(
            { post_type: 'notice', notice_type: 'friend_recall', user_id: 222222, message_id: 'm1' },
            10001,
            { sender: { user_id: 10001 } },
        ),
        true,
    )
    // Private chat: peer recalling peer message
    assert.equal(
        isSelfRecallNotice(
            { post_type: 'notice', notice_type: 'friend_recall', user_id: 222222, message_id: 'm2' },
            '10001',
            { sender: { user_id: 222222 } },
        ),
        false,
    )
    // Group chat: self recalling own message (numeric/string mixed UIN)
    assert.equal(
        isSelfRecallNotice(
            { post_type: 'notice', notice_type: 'group_recall', group_id: 9001, user_id: 10001, operator_id: '10001' },
            10001,
            { sender: { user_id: '10001' } },
        ),
        true,
    )
    // Group chat: admin recalling user's own message -> must be intercepted!
    assert.equal(
        isSelfRecallNotice(
            { post_type: 'notice', notice_type: 'group_recall', group_id: 9001, user_id: 10001, operator_id: 88888 },
            10001,
            { sender: { user_id: 10001 } },
        ),
        false,
    )
    // Group chat: another member recalling their own message
    assert.equal(
        isSelfRecallNotice(
            { post_type: 'notice', notice_type: 'group_recall', group_id: 9001, user_id: 33333, operator_id: 33333 },
            10001,
        ),
        false,
    )
    // Missing self UIN safely returns false
    assert.equal(
        isSelfRecallNotice({ notice_type: 'friend_recall', user_id: 10001 }, undefined),
        false,
    )
})

test('markMessageRevoked sets revoked and recall_info without setting revoke, and is idempotent', () => {
    const original = {
        message_id: 'msg-1',
        post_type: 'message',
        sender: { user_id: 222222, nickname: 'Alice' },
        message: [{ type: 'text', text: 'hello' }],
    }
    Object.defineProperty(original, '_preprocessed', {
        value: true,
        enumerable: false,
        configurable: true,
    })

    const first = markMessageRevoked(original, {
        notice_type: 'group_recall',
        group_id: 9001,
        user_id: 222222,
        operator_id: 88888,
        time: 1700000050,
    })
    assert.equal(first.revoked, true)
    assert.equal(first.revoke, undefined)
    assert.equal(first._preprocessed, true)
    assert.deepEqual(first.recall_info, {
        notice_type: 'group_recall',
        group_id: 9001,
        user_id: 222222,
        operator_id: 88888,
        time: 1700000050,
    })
    assert.deepEqual(first.message, [{ type: 'text', text: 'hello' }])
    // Original object untouched
    assert.equal(original.revoked, undefined)

    const second = markMessageRevoked(first, { time: 1700000060 })
    assert.equal(second.revoked, true)
    assert.equal(second.revoke, undefined)
    assert.equal(second.recall_info.operator_id, 88888)
    assert.equal(second.recall_info.time, 1700000060)
})

test('AntiRecallCache captures active & background recalls and restores history placeholders without leaks', () => {
    const cache = new AntiRecallCache(50, 50)
    const selfId = 10001

    // Remember a background group message and a private message
    const bgMsg = {
        post_type: 'message',
        message_id: 'bg-1',
        message_type: 'group',
        group_id: 9001,
        time: 1000,
        sender: { user_id: 222222, nickname: 'Bob' },
        message: [{ type: 'text', text: 'secret message' }],
    }
    const peerMsg = {
        post_type: 'message',
        message_id: 'pm-1',
        message_type: 'private',
        user_id: 333333,
        time: 1050,
        sender: { user_id: 333333, nickname: 'Carol' },
        message: [{ type: 'text', text: 'private secret' }],
    }
    cache.rememberMessages(selfId, [bgMsg, peerMsg])

    // Background recall (activeMsg == null)
    const capturedBg = cache.captureRecall(
        selfId,
        {
            post_type: 'notice',
            notice_type: 'group_recall',
            group_id: 9001,
            user_id: 222222,
            operator_id: 99999,
            message_id: 'bg-1',
            time: 1005,
        },
        null,
    )
    assert.ok(capturedBg)
    assert.equal(capturedBg.revoked, true)
    assert.equal(capturedBg.revoke, undefined)
    assert.deepEqual(capturedBg.message, [{ type: 'text', text: 'secret message' }])

    // Active chat recall passed directly via activeMsg
    const activeMsg = {
        post_type: 'message',
        message_id: 'act-1',
        message_type: 'group',
        group_id: 9001,
        time: 1020,
        sender: { user_id: 444444, nickname: 'Dave' },
        message: [{ type: 'text', text: 'active secret' }],
    }
    const capturedActive = cache.captureRecall(
        selfId,
        {
            post_type: 'notice',
            notice_type: 'group_recall',
            group_id: 9001,
            user_id: 444444,
            operator_id: 444444,
            message_id: 'act-1',
            time: 1025,
        },
        activeMsg,
    )
    assert.equal(capturedActive.revoked, true)
    assert.equal(cache.getRecalledMessage(selfId, 'act-1')?.message[0].text, 'active secret')

    // Recall a private chat message too (should NOT leak into group 9001)
    cache.captureRecall(
        selfId,
        {
            post_type: 'notice',
            notice_type: 'friend_recall',
            user_id: 333333,
            message_id: 'pm-1',
            time: 1055,
        },
        null,
    )

    // NapCat-style empty placeholder + backend that omits act-1 completely
    const restored = cache.restoreRecalledInHistory(
        selfId,
        'group',
        9001,
        [
            {
                post_type: 'message',
                message_id: 'bg-1',
                time: 1000,
                message_seq: 12,
                message: [],
            },
            {
                post_type: 'message',
                message_id: 'normal-1',
                time: 1030,
                sender: { user_id: 555555, nickname: 'Eve' },
                message: [{ type: 'text', text: 'still here' }],
            },
        ],
        { isLatestPage: true },
    )

    assert.equal(restored.length, 3)
    const restoredBg = restored.find((m) => m.message_id === 'bg-1')
    const restoredAct = restored.find((m) => m.message_id === 'act-1')
    assert.equal(restoredBg.revoked, true)
    assert.equal(restoredBg.message[0].text, 'secret message')
    assert.equal(restoredBg.message_seq, 12)
    assert.equal(restoredAct.revoked, true)
    assert.equal(restoredAct.message[0].text, 'active secret')
    // No cross-chat leak from pm-1
    assert.equal(restored.some((m) => m.message_id === 'pm-1'), false)
    // No cross-account leak
    assert.equal(cache.getRecalledMessage(99999, 'bg-1'), null)
    const otherAcc = cache.restoreRecalledInHistory(99999, 'group', 9001, [
        { message_id: 'bg-1', time: 1000, message: [] },
    ], { isLatestPage: true })
    assert.deepEqual(otherAcc[0].message, [])
})

test('AntiRecallCache respects time window for older pages and applies recalled meta to DB rows', () => {
    const cache = new AntiRecallCache(5, 3)
    const selfId = 10001

    // Recall happened for a message not in RAM (e.g. loaded from SQLite later)
    assert.equal(
        cache.captureRecall(selfId, {
            notice_type: 'group_recall',
            group_id: 9001,
            user_id: 222222,
            operator_id: 88888,
            message_id: 'sqlite-1',
            time: 2005,
        }),
        null,
    )

    const hydrated = cache.applyRecallMetaIfKnown(selfId, {
        message_id: 'sqlite-1',
        sender: { user_id: 222222 },
        message: [{ type: 'text', text: 'from sqlite' }],
    })
    assert.equal(hydrated.revoked, true)
    assert.equal(hydrated.recall_info.operator_id, 88888)

    // Message in RAM with newer timestamp should NOT be injected into an older history page
    cache.rememberMessages(selfId, [
        {
            post_type: 'message',
            message_id: 'new-1',
            message_type: 'group',
            group_id: 9001,
            time: 5000,
            sender: { user_id: 222222 },
            message: [{ type: 'text', text: 'newer recalled' }],
        },
    ])
    cache.captureRecall(selfId, {
        notice_type: 'group_recall',
        group_id: 9001,
        user_id: 222222,
        operator_id: 222222,
        message_id: 'new-1',
        time: 5005,
    })

    const olderPage = cache.restoreRecalledInHistory(
        selfId,
        'group',
        9001,
        [{ message_id: 'old-1', time: 1000, message: [{ type: 'text', text: 'old' }] }],
        { isLatestPage: false },
    )
    assert.equal(olderPage.some((m) => m.message_id === 'new-1'), false)

    // LRU eviction on recalledMessages (limit = 3)
    for (const id of ['e1', 'e2', 'e3', 'e4']) {
        cache.captureRecall(
            selfId,
            { notice_type: 'friend_recall', user_id: 777, message_id: id, time: 10 },
            {
                post_type: 'message',
                message_id: id,
                message_type: 'private',
                user_id: 777,
                time: 10,
                sender: { user_id: 777 },
                message: [{ type: 'text', text: id }],
            },
        )
    }
    assert.equal(cache.getRecalledMessage(selfId, 'e1'), null)
    assert.equal(cache.getRecalledMessage(selfId, 'e4')?.message[0].text, 'e4')
})

test('anti_recall option default and settings switch are wired cleanly without joke handler', () => {
    const optionSource = readFileSync(new URL('../src/renderer/src/function/option.ts', import.meta.url), 'utf8')
    const optFunctionSource = readFileSync(new URL('../src/renderer/src/pages/options/OptFunction.vue', import.meta.url), 'utf8')

    assert.match(optionSource, /anti_recall:\s*false/)
    assert.match(optFunctionSource, /v-model="settingsStore\.sysConfig\.anti_recall"/)
    assert.match(optFunctionSource, /name="anti_recall"/)
    assert.doesNotMatch(optFunctionSource, /msgND/)
    assert.doesNotMatch(optFunctionSource, /说了不做这功能就是不做/)
})
