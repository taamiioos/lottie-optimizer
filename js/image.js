// обработка изображений с фоллбэком на webp
const ImageProcessor = {
    _webpSupported: null, // кэшируем результат проверки, чтобы не проверять каждый раз
    async canWebP() {
        // если уже проверяли — сразу возвращаем
        if (this._webpSupported !== null) return this._webpSupported;
        try {
            const c = document.createElement('canvas');
            c.width = 1;
            c.height = 1;
            // пытаемся сохранить канвас в webp
            const blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.5));
            this._webpSupported = blob !== null && blob.type === 'image/webp';
        } catch {
            this._webpSupported = false;
        }

        return this._webpSupported;
    },

    // разбираем base64 data url на mime и байты
    decodeBase64(dataUrl) {
        const match = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
        if (!match) return null;
        const [, mime, b64] = match;
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
            bytes[i] = bin.charCodeAt(i);
        }
        return { mime, bytes };
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
        const url = URL.createObjectURL(blob);

        try {
            return await new Promise((resolve, reject) => {
                const img = new Image();

                img.onload = () => {
                    URL.revokeObjectURL(url);

                    const c = document.createElement('canvas');
                    c.width = img.width;
                    c.height = img.height;

                    c.getContext('2d').drawImage(img, 0, 0);

                    c.toBlob(b => {
                        if (b) resolve(b);
                        else reject(new Error('toBlob вернул null'));
                    }, 'image/webp', quality);
                };

                img.onerror = () => {
                    URL.revokeObjectURL(url);
                    reject(new Error('не удалось загрузить изображение'));
                };

                img.src = url;
            });
        } catch (e) {
            URL.revokeObjectURL(url);
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