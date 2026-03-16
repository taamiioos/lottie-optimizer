
const _seekTo = (video, time) => new Promise(res => {
    if (Math.abs(video.currentTime - time) < 0.001) { res(); return; }
    const done = () => { video.removeEventListener('seeked', done); res(); };
    video.addEventListener('seeked', done);
    video.currentTime = time;
});

const _canvasToBlob = (canvas, quality) => {
    if (canvas.convertToBlob) return canvas.convertToBlob({type: 'image/webp', quality});
    return new Promise(r => canvas.toBlob(r, 'image/webp', quality));
};

// извлекает кадры из видеофайла
const extractFrames = async (videoFile, fps, maxFrames, quality, onProgress) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(videoFile);
    video.src = url;

    await new Promise((res, rej) => {
        video.onloadedmetadata = res;
        video.onerror = () => rej(new Error('Браузер не смог загрузить видео'));
    });

    const {videoWidth: w, videoHeight: h, duration} = video;
    if (!w || !h) throw new Error('Видео не содержит видеодорожки');

    const total = Math.min(Math.ceil(duration * fps), maxFrames);

    let canvas, ctx;
    if (typeof OffscreenCanvas !== 'undefined') {
        canvas = new OffscreenCanvas(w, h);
    } else {
        canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
    }
    ctx = canvas.getContext('2d');

    const frames = [];
    for (let i = 0; i < total; i++) {
        await _seekTo(video, i / fps);
        ctx.drawImage(video, 0, 0);
        frames.push(await _canvasToBlob(canvas, quality));
        onProgress(i + 1, total, 'extract');
        if (i % 5 === 4) await new Promise(r => setTimeout(r, 0));
    }

    URL.revokeObjectURL(url);
    return {frames, width: w, height: h, duration, fps, total};
};

const buildLottieJson = async (frames, width, height, fps, name, onProgress) => {
    const assets = [], layers = [];

    for (let i = 0; i < frames.length; i++) {
        const p = await new Promise(r => {
            const fr = new FileReader();
            fr.onload = () => r(fr.result);
            fr.readAsDataURL(frames[i]);
        });

        assets.push({id: `frame_${i}`, w: width, h: height, p, u: '', e: 1});
        layers.push({
            ty: 2, refId: `frame_${i}`, nm: `frame_${i}`, ind: i + 1,
            ip: i, op: i + 1, st: 0, sr: 1, ao: 0, bm: 0, ddd: 0,
            ks: {
                o: {a: 0, k: 100}, r: {a: 0, k: 0},
                p: {a: 0, k: [width / 2, height / 2, 0]},
                a: {a: 0, k: [width / 2, height / 2, 0]},
                s: {a: 0, k: [100, 100, 100]}
            }
        });

        onProgress(i + 1, frames.length, 'build');
        if (i % 10 === 9) await new Promise(r => setTimeout(r, 0));
    }

    return {
        v: '5.7.4', fr: fps, ip: 0, op: frames.length,
        w: width, h: height, nm: name, ddd: 0, assets, layers
    };
};
const convertVideoToLottie = async (videoFile, {fps = 24, maxFrames = 150, quality = 0.85, onProgress = () => {}} = {}) => {
    const name = videoFile.name.replace(/\.[^.]+$/, '');

    const {frames, width, height} = await extractFrames(videoFile, fps, maxFrames, quality, (cur, total) => {
        onProgress({
            phase: 'extract', message: `Извлечение кадров: ${cur} / ${total}`,
            current: cur, total, percent: Math.round(cur / total * 50)
        });
    });
    onProgress({phase: 'build', message: 'Сборка Lottie JSON...', current: 0, total: frames.length, percent: 50});

    const json = await buildLottieJson(frames, width, height, fps, name, (cur, total) => {
        onProgress({
            phase: 'build', message: `Кодирование: ${cur} / ${total}`,
            current: cur, total, percent: 50 + Math.round(cur / total * 50)
        });
    });

    return json;
};

export {extractFrames, buildLottieJson, convertVideoToLottie};
