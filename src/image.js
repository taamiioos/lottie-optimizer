// обработка изображений с фоллбэком на webp
const ImageProcessor = {
    _webpSupported: null, // кэшируем результат проверки, чтобы не проверять каждый раз
    async canWebP() {

        if (this._webpSupported !== null) return this._webpSupported;

        const canvas = document.createElement("canvas");

        this._webpSupported =
            canvas.toDataURL("image/webp").startsWith("data:image/webp");

        return this._webpSupported;
    },

    // разбираем base64 data url на mime и байты
    async decodeBase64(dataUrl) {
        try {
            const res = await fetch(dataUrl);
            const blob = await res.blob();
            return blob;
        } catch {
            return null;
        }
    },

    // считаем sha-256 хеш от байтов
    async hash(bytes) {
        const buf = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(buf))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    },

    // определяем формат по первым байтам
    detectFormat(bytes) {
        if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
        if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpeg';
        if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'gif';
        if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'webp';
        return 'png';
    },

    // возвращаем нормальное расширение для формата
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

    // конвертируем любой blob в webp через canvas
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

    // главная функция
    async process(blob, quality = 0.8) {
        const supportsWebP = await this.canWebP();
        // если браузер поддерживает webp — пробуем сжать
        if (supportsWebP) {
            try {
                const webpBlob = await this.toWebP(blob, quality);
                // если webp получился меньше оригинала — возвращаем его
                if (webpBlob && webpBlob.size < blob.size) {
                    return { blob: webpBlob, format: 'webp' };
                }
            } catch (e) {
            }
        }
        // если webp не поддерживается или не помог — возвращаем оригинал + определяем его формат
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const format = this.detectFormat(bytes);
        return { blob, format };
    }
};

export { ImageProcessor };