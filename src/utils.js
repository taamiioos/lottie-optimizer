// уровень H.264 по количеству макроблоков
export const _pickAvcCodec = (width, height) => {
    const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
    if (mbs <= 1620)  return 'avc1.42E01E';
    if (mbs <= 3600)  return 'avc1.42E01F';
    if (mbs <= 5120)  return 'avc1.42E020';
    if (mbs <= 8192)  return 'avc1.42E028';
    if (mbs <= 8704)  return 'avc1.42E02A';
    if (mbs <= 22080) return 'avc1.42E032';
    return 'avc1.42E033';
};

// определяет ключевые кадры по попиксельному diff миниатюр (32×32)
export const _detectKeyFrames = async (images, threshold = 45) => {
    const kf = new Set([0]); // первый кадр всегда ключевой
    if (images.length <= 1) return kf;
    const SIZE = 32;
    const canvas = new OffscreenCanvas(SIZE, SIZE);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let prevBuf = new Uint8ClampedArray(SIZE * SIZE * 4);
    let currBuf = new Uint8ClampedArray(SIZE * SIZE * 4);
    let hasPrev = false;
    for (let i = 0; i < images.length; i++) {
        if (!images[i]) continue;
        ctx.drawImage(images[i], 0, 0, SIZE, SIZE);
        const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
        currBuf.set(data);
        if (hasPrev) {
            let diff = 0;
            for (let p = 0; p < currBuf.length; p += 4) {
                diff += Math.abs(currBuf[p] - prevBuf[p]) +
                    Math.abs(currBuf[p+1] - prevBuf[p+1]) +
                    Math.abs(currBuf[p+2] - prevBuf[p+2]);
            }
            const avgDiff = diff / (SIZE * SIZE * 3);
            if (avgDiff > threshold) kf.add(i);
        }
        [prevBuf, currBuf] = [currBuf, prevBuf];
        hasPrev = true;
    }
    return kf;
};

// Форматирует количество байт в читаемую строку
export const formatSize = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

// Конвертирует Uint8Array в строку base64
export function _uint8ToBase64(bytes) {
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}
