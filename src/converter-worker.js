// один canvas на всё время жизни воркера
let canvas = null;
let ctx = null;

self.onmessage = async ({ data: { id, frame, ab, mime, q } }) => {
    try {
        // frame — VideoFrame (transferable), ab — ArrayBuffer обычного изображения
        const src = frame ?? await createImageBitmap(new Blob([ab]));
        const w = src.displayWidth ?? src.width;
        const h = src.displayHeight ?? src.height;

        if (!canvas) {
            canvas = new OffscreenCanvas(w, h);
            ctx = canvas.getContext('2d');
        } else if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }

        ctx.drawImage(src, 0, 0);
        src.close();

        const out = await canvas.convertToBlob({ type: mime ?? 'image/jpeg', quality: q ?? 0.8 });
        const res = await out.arrayBuffer();
        self.postMessage({ id, ab: res, mime: out.type }, [res]);
    } catch (e) {
        self.postMessage({ id, err: e.message });
    }
};
