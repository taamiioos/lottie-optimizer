// Один canvas и его контекст создаются один раз на всё время жизни воркера
let canvas = null;
let ctx = null;

self.onmessage = async ({ data: { id, frame, ab, mime, q } }) => {
    try {
        // frame — VideoFrame (из WebCodecs, transferable)
        // ab — ArrayBuffer с обычным изображением
        // Создаём ImageBitmap из ArrayBuffer, если кадр не пришёл
        const src = frame ?? await createImageBitmap(new Blob([ab]));
        // Определяем ширину и высоту кадра
        const w = src.displayWidth ?? src.width;
        const h = src.displayHeight ?? src.height;
        // Если canvas ещё не создан
        if (!canvas) {
            canvas = new OffscreenCanvas(w, h);
            ctx = canvas.getContext('2d');
        }
        // Если размеры canvas не совпадают с кадром — подстраиваем
        else if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        ctx.drawImage(src, 0, 0);
        src.close();
        // Конвертируем содержимое canvas в Blob нужного формата
        const out = await canvas.convertToBlob({ type: mime ?? 'image/jpeg', quality: q ?? 0.8 });
        const res = await out.arrayBuffer();
        // Отправляем результат обратно в основной поток transferable
        self.postMessage({ id, ab: res, mime: out.type }, [res]);
    } catch (e) {
        self.postMessage({ id, err: e.message });
    }
};