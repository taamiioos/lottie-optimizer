// обработка изображений с фоллбэком на webp
const ImageProcessor = {
    _webpSupported: null,
    async canWebP() {
        if (this._webpSupported !== null) return this._webpSupported;
        if (typeof OffscreenCanvas !== 'undefined') {
            try {
                const blob = await new OffscreenCanvas(1, 1).convertToBlob({type: 'image/webp'});
                this._webpSupported = blob.type === 'image/webp';
            } catch {
                this._webpSupported = false;
            }
            return this._webpSupported;
        }
        if (typeof document !== 'undefined') {
            const canvas = document.createElement("canvas");
            this._webpSupported = canvas.toDataURL("image/webp").startsWith("data:image/webp");
            return this._webpSupported;
        }
        this._webpSupported = false;
        return false;
    },

    // разбор base64 data url на mime и байты
    decodeBase64(dataUrl) {
        try {
            const comma = dataUrl.indexOf(',');
            if (comma === -1) return null;
            const mime = dataUrl.slice(5, comma).split(';')[0] || 'image/png';
            const b64 = dataUrl.slice(comma + 1);
            const binary = atob(b64);
            const len = binary.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
            return new Blob([bytes], {type: mime});
        } catch {
            return null;
        }
    },

    // sha-256
    async hash(bytes) {
        const buf = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(buf))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    },

    // формат по первым байтам
    detectFormat(bytes) {
        if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
        if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpeg';
        if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'gif';
        if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'webp';
        return 'png';
    },

    // нормальное расширение для формата
    extFromFormat(format) {
        const map = {
            png: 'png',
            jpeg: 'jpg',
            gif: 'gif',
            webp: 'webp',
            other: 'png'
        };
        return map[format] || 'png';
    },

    // любой blob в webp через canvas
    async toWebP(blob, quality = 0.8) {
        const bitmap = await createImageBitmap(blob);

        try {
            if (typeof OffscreenCanvas !== "undefined") {
                const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
                const ctx = canvas.getContext("2d");
                ctx.drawImage(bitmap, 0, 0);
                const out = await canvas.convertToBlob({
                    type: "image/webp",
                    quality
                });

                bitmap.close?.();
                return out;
            }
            const canvas = document.createElement("canvas");
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;

            const ctx = canvas.getContext("2d");
            ctx.drawImage(bitmap, 0, 0);

            const blobOut = await new Promise((resolve, reject) => {
                canvas.toBlob(b => {
                    if (b) resolve(b);
                    else reject(new Error("toBlob returned null"));
                }, "image/webp", quality);
            });

            bitmap.close?.();
            return blobOut;

        } catch (e) {
            bitmap.close?.();
            throw e;
        }
    },

    // конвертирует в webp если браузер поддерживает и если итог меньше оригинала
    // иначе возвращает оригинальный blob без изменений
    async process(blob, quality = 0.8, hintBytes = null) {
        const supportsWebP = await this.canWebP();
        if (supportsWebP) {
            try {
                const webpBlob = await this.toWebP(blob, quality);
                if (webpBlob && webpBlob.size < blob.size) {
                    return { blob: webpBlob, format: 'webp' };
                }
            } catch (e) {
            }
        }
        // webp не выиграл или не поддерживается — определяем формат по байтам и возвращаем как есть
        const bytes = hintBytes ?? new Uint8Array(await blob.arrayBuffer());
        const format = this.detectFormat(bytes);
        return { blob, format };
    }
};

export { ImageProcessor };