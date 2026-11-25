export const VIDEO_FILE_EXTENSIONS = ['mp4', 'avi', 'mkv', 'flv'] as const

export function getFileExtension(name: unknown): string {
    if (typeof name !== 'string' || !name) return ''
    const cleanPath = name.split(/[?#]/)[0]
    const fileName = cleanPath.split(/[\\/]/).pop() ?? ''
    const dotIndex = fileName.lastIndexOf('.')
    if (dotIndex <= 0 || dotIndex === fileName.length - 1) return ''
    return fileName.slice(dotIndex + 1).toLowerCase()
}

export function isVideoFileExt(ext: unknown): boolean {
    if (typeof ext !== 'string' || !ext) return false
    const normalized = ext.trim().toLowerCase()
    return (VIDEO_FILE_EXTENSIONS as readonly string[]).includes(normalized)
}

export function getFileItemName(item: Record<string, any> | undefined): string {
    return String(item?.name ?? item?.file_name ?? item?.file ?? '')
}

export function isVideoFileItem(item: Record<string, any> | undefined): boolean {
    return item?.type === 'file' && isVideoFileExt(getFileExtension(getFileItemName(item)))
}

export function getVideoLoadKey(
    msg: Record<string, any> | undefined,
    index: number,
    source?: unknown,
): string {
    return `${msg?.message_id ?? msg?.time ?? 'msg'}-${index}-${String(source ?? '')}`
}

export function shouldDeferVideoLoad(
    noAutoLoadVideo: boolean | undefined,
    manualLoaded: boolean | undefined,
): boolean {
    return noAutoLoadVideo === true && manualLoaded !== true
}

export function shouldAutoFetchFilePreview(
    ext: string,
    noAutoLoadVideo: boolean | undefined,
    manualLoaded: boolean | undefined,
): boolean {
    if (isVideoFileExt(ext)) {
        return !shouldDeferVideoLoad(noAutoLoadVideo, manualLoaded)
    }
    return true
}
