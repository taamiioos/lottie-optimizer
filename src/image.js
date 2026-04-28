const ImageProcessor = {
    _webpSupported: null,
    /**
     * Проверяет поддержку кодирования WebP в текущем окружении
     * Результат кешируется — повторные вызовы бесплатны
     */
    async canWebP() {
        if (this._webpSupported !== null) return this._webpSupported;
        if (typeof OffscreenCanvas !== 'undefined') {
            try {
                const blob = await new OffscreenCanvas(1, 1).convertToBlob({type: 'image/webp'});
                this._webpSupported = blob.type === 'image/webp';
            } catch {
                this._webpSupported = false;
            }
        } else if (typeof document !== 'undefined') {
            const canvas = document.createElement('canvas');
            this._webpSupported = canvas.toDataURL('image/webp').startsWith('data:image/webp');
        } else {
            this._webpSupported = false;
        }
        return this._webpSupported;
    },

    //Декодирует data URL в Blob
    decodeBase64(dataUrl) {
        try {
            const comma = dataUrl.indexOf(',');
            if (comma === -1) return null;
            const mime = dataUrl.slice(5, comma).split(';')[0] || 'image/png';
            const binary = atob(dataUrl.slice(comma + 1));
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return new Blob([bytes], {type: mime});
        } catch {
            return null;
        }
    },

    /**
     * Вычисляет SHA-256 хеш байтов изображения
     * Используется для обнаружения дубликатов
     */
    async hash(bytes) {
        const buf = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(buf))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    },
    /**
     * Определяет формат изображения по magic bytes
     * @param {Uint8Array} bytes — первые 16 байт файла
     */
    detectFormat(bytes) {
        if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
        if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpeg';
        if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'gif';
        if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'webp';
        return 'png';
    },
    // Возвращает расширение файла для формата
    extFromFormat(format) {
        return {png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp'}[format] ?? 'png';
    },
    // Кодирует Blob в WebP через Canvas/OffscreenCanvas
    async toWebP(blob, quality = 0.8) {
        const bitmap = await createImageBitmap(blob);
        try {
            if (typeof OffscreenCanvas !== 'undefined') {
                const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
                canvas.getContext('2d').drawImage(bitmap, 0, 0);
                return await canvas.convertToBlob({type: 'image/webp', quality});
            } else {
                const canvas = document.createElement('canvas');
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                canvas.getContext('2d').drawImage(bitmap, 0, 0);
                return await new Promise((resolve, reject) => {
                    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('toBlob failed')), 'image/webp', quality);
                });
            }
        } finally {
            bitmap.close?.();
        }
    },

    /**
     * Оптимизирует изображение: конвертирует в WebP если это уменьшает размер,
     * иначе возвращает оригинал с определённым форматом.
     * @param {Blob} blob — исходное изображение
     * @param {number} [quality=0.8] — качество WebP
     * @param {Uint8Array|null} [hintBytes] — первые байты для detectFormat
     */
    async process(blob, quality = 0.8, hintBytes = null) {
        if (await this.canWebP()) {
            const webpBlob = await this.toWebP(blob, quality);
            if (webpBlob && webpBlob.size < blob.size) {
                return {blob: webpBlob, format: 'webp'};
            }
        }
        const bytes = hintBytes ?? new Uint8Array(await blob.arrayBuffer());
        return {blob, format: this.detectFormat(bytes)};
    },
};

export {ImageProcessor};
