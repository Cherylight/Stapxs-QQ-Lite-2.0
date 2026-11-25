import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
    VIDEO_FILE_EXTENSIONS,
    getFileExtension,
    getFileItemName,
    getVideoLoadKey,
    isVideoFileExt,
    isVideoFileItem,
    shouldAutoFetchFilePreview,
    shouldDeferVideoLoad,
} from '../src/renderer/src/function/utils/videoLoad.ts'

test('getFileExtension and isVideoFileExt handle uppercase, paths, queries, and invalid inputs', () => {
    assert.deepEqual(VIDEO_FILE_EXTENSIONS, ['mp4', 'avi', 'mkv', 'flv'])
    assert.equal(getFileExtension('CLIP.MP4'), 'mp4')
    assert.equal(getFileExtension('/tmp/folder/demo.video.MKV?token=abc#1'), 'mkv')
    assert.equal(getFileExtension('C:\\Users\\demo\\test.Avi'), 'avi')
    assert.equal(getFileExtension('stream.flv#section'), 'flv')
    assert.equal(getFileExtension('noext'), '')
    assert.equal(getFileExtension('.hidden'), '')
    assert.equal(getFileExtension('trailing.'), '')
    assert.equal(getFileExtension(undefined), '')

    assert.equal(isVideoFileExt('MP4'), true)
    assert.equal(isVideoFileExt(' flv '), true)
    assert.equal(isVideoFileExt('png'), false)
    assert.equal(isVideoFileExt(''), false)
})

test('getFileItemName and isVideoFileItem identify video files regardless of name field', () => {
    assert.equal(getFileItemName({ name: 'a.mp4', file_name: 'b.mkv' }), 'a.mp4')
    assert.equal(getFileItemName({ file_name: 'b.MKV', file: 'c.flv' }), 'b.MKV')
    assert.equal(getFileItemName({ file: 'c.avi' }), 'c.avi')
    assert.equal(getFileItemName(undefined), '')

    assert.equal(isVideoFileItem({ type: 'file', name: 'movie.mp4' }), true)
    assert.equal(isVideoFileItem({ type: 'file', file_name: 'record.AVI' }), true)
    assert.equal(isVideoFileItem({ type: 'file', file: 'clip.mkv' }), true)
    assert.equal(isVideoFileItem({ type: 'file', name: 'photo.png' }), false)
    assert.equal(isVideoFileItem({ type: 'video', name: 'movie.mp4' }), false)
})

test('getVideoLoadKey generates distinct keys for normal messages and forward nodes without message_id', () => {
    assert.equal(
        getVideoLoadKey({ message_id: 'm100', time: 1700000000 }, 0, 'https://example.com/a.mp4'),
        'm100-0-https://example.com/a.mp4',
    )
    assert.equal(
        getVideoLoadKey({ time: 1700000001 }, 1, 'file-1'),
        '1700000001-1-file-1',
    )
    assert.equal(getVideoLoadKey(undefined, 2, undefined), 'msg-2-')
})

test('shouldDeferVideoLoad and shouldAutoFetchFilePreview gate video rendering and file URL fetching', () => {
    assert.equal(shouldDeferVideoLoad(false, false), false)
    assert.equal(shouldDeferVideoLoad(undefined, undefined), false)
    assert.equal(shouldDeferVideoLoad(true, undefined), true)
    assert.equal(shouldDeferVideoLoad(true, false), true)
    assert.equal(shouldDeferVideoLoad(true, true), false)

    // File video preview URL fetch is deferred when opt_no_auto_load_video is enabled
    assert.equal(shouldAutoFetchFilePreview('mp4', true, false), false)
    assert.equal(shouldAutoFetchFilePreview('MKV', true, undefined), false)
    assert.equal(shouldAutoFetchFilePreview('mp4', true, true), true)
    assert.equal(shouldAutoFetchFilePreview('avi', false, false), true)

    // Non-video file previews (images / text) remain unaffected by video setting
    assert.equal(shouldAutoFetchFilePreview('png', true, false), true)
    assert.equal(shouldAutoFetchFilePreview('txt', true, false), true)
})

test('option.ts, OptFunction.vue, MsgBody.vue, and msg.ts wire opt_no_auto_load_video without mounting eager <video>', () => {
    const optionSource = readFileSync(
        new URL('../src/renderer/src/function/option.ts', import.meta.url),
        'utf8',
    )
    const optFunctionSource = readFileSync(
        new URL('../src/renderer/src/pages/options/OptFunction.vue', import.meta.url),
        'utf8',
    )
    const msgBodySource = readFileSync(
        new URL('../src/renderer/src/components/MsgBody.vue', import.meta.url),
        'utf8',
    )
    const msgSource = readFileSync(
        new URL('../src/renderer/src/function/msg.ts', import.meta.url),
        'utf8',
    )

    assert.match(optionSource, /opt_no_auto_load_image:\s*false,\s*\r?\n\s*opt_no_auto_load_video:\s*false,/)

    const imageSwitchIndex = optFunctionSource.indexOf('opt-function-no-auto-load-image')
    const videoSwitchIndex = optFunctionSource.indexOf('opt-function-no-auto-load-video')
    assert.ok(imageSwitchIndex !== -1 && videoSwitchIndex > imageSwitchIndex)
    assert.match(optFunctionSource, /v-model="settingsStore\.sysConfig\.opt_no_auto_load_video"/)

    // Video message template uses v-if placeholder before v-else <video> (never v-show around <video>)
    const videoBlockMatch = msgBodySource.match(
        /<template v-else-if="item\.type == 'video'">[\s\S]*?<\/template>/,
    )
    assert.ok(videoBlockMatch, 'video segment template block should exist')
    assert.match(videoBlockMatch[0], /<button v-if="shouldShowVideoPlaceholder\(item, Number\(index\)\)"/)
    assert.match(videoBlockMatch[0], /<div v-else[\s\S]*?<video/)
    assert.doesNotMatch(videoBlockMatch[0], /v-show/)

    // File video template puts placeholder before <video> and loadFileBase checks shouldAutoFetchFilePreview
    const fileViewMatch = msgBodySource.match(
        /<div v-if="shouldShowFileView\(item, Number\(index\)\)"[\s\S]*?<\/div>\s*\r?\n\s*<\/div>\s*\r?\n\s*<template v-else-if="item\.type == 'video'">/,
    )
    assert.ok(fileViewMatch, 'file-view template block should exist')
    assert.match(fileViewMatch[0], /<button v-else-if="shouldShowFileVideoPlaceholder\(item, Number\(index\)\)"/)
    assert.match(fileViewMatch[0], /<video v-else-if="isFileViewVideo\(fileView\)"/)
    assert.match(msgBodySource, /function loadFileBase[\s\S]*?shouldAutoFetchFilePreview\(/)

    // msg.ts loadFileBase resolves forward stack messages too
    const msgLoadFileBaseMatch = msgSource.match(/loadFileBase:\s*\([\s\S]*?(?=\n\s*\/\*\*)/)
    assert.ok(msgLoadFileBaseMatch, 'loadFileBase handler should exist in msg.ts')
    assert.match(msgLoadFileBaseMatch[0], /mergeMsgStack/)
})
