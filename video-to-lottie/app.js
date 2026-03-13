const $ = id => document.getElementById(id);
const yieldToMain = () => new Promise(r => setTimeout(r, 0));

const fmtSize = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const fmtTime = (sec) => {
    const m = Math.floor(sec / 60), s = (sec % 60).toFixed(1);
    return m > 0 ? `${m}м ${s}с` : `${s}с`;
};

const blobToDataUrl = (blob) => new Promise(r => {
    const fr = new FileReader();
    fr.onload = () => r(fr.result);
    fr.readAsDataURL(blob);
});

const seekTo = (video, time) => new Promise(res => {
    if (Math.abs(video.currentTime - time) < 0.001) { res(); return; }
    const done = () => { video.removeEventListener('seeked', done); res(); };
    video.addEventListener('seeked', done);
    video.currentTime = time;
});

const canvasToBlob = (canvas, quality) => {
    if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/webp', quality });
    return new Promise(r => canvas.toBlob(r, 'image/webp', quality));
};

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
    const { videoWidth: w, videoHeight: h, duration } = video;
    if (!w || !h) throw new Error('Видео не содержит видеодорожки');
    const total = Math.min(Math.ceil(duration * fps), maxFrames);
    let canvas, ctx;
    if (typeof OffscreenCanvas !== 'undefined') {
        canvas = new OffscreenCanvas(w, h);
        ctx = canvas.getContext('2d');
    } else {
        canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        ctx = canvas.getContext('2d');
    }

    const frames = [];

    for (let i = 0; i < total; i++) {
        await seekTo(video, i / fps);
        ctx.drawImage(video, 0, 0);
        const blob = await canvasToBlob(canvas, quality);
        frames.push(blob);
        onProgress(i + 1, total, 'extract');
        if (i % 5 === 4) await yieldToMain();
    }
    URL.revokeObjectURL(url);
    return { frames, width: w, height: h, duration, fps, total };
};

const buildLottieJson = async (frames, width, height, fps, name, onProgress) => {
    const assets = [];
    const layers = [];

    for (let i = 0; i < frames.length; i++) {
        const p = await blobToDataUrl(frames[i]);

        assets.push({
            id: `frame_${i}`,
            w: width,
            h: height,
            p,
            u: '',
            e: 1
        });
        layers.push({
            ty: 2,
            refId: `frame_${i}`,
            nm: `frame_${i}`,
            ind: i + 1,
            ip: i,
            op: i + 1,
            st: 0,
            sr: 1,
            ao: 0,
            bm: 0,
            ddd: 0,
            ks: {
                o: { a: 0, k: 100 },
                r: { a: 0, k: 0 },
                p: { a: 0, k: [width / 2, height / 2, 0] },
                a: { a: 0, k: [width / 2, height / 2, 0] },
                s: { a: 0, k: [100, 100, 100] }
            }
        });

        onProgress(i + 1, frames.length, 'build');

        if (i % 10 === 9) await yieldToMain();
    }

    return {
        v: '5.7.4',
        fr: fps,
        ip: 0,
        op: frames.length,
        w: width,
        h: height,
        nm: name,
        ddd: 0,
        assets,
        layers
    };
};
const uploadArea = $('uploadArea');
const fileInput = $('fileInput');
let resultJson = null;
let currentFile = null;
let _fileHandling = false;
const syncSlider = (rangeId, valId, decimals = 0) => {
    const range = $(rangeId), val = $(valId);
    const update = () => {
        val.textContent = parseFloat(range.value).toFixed(decimals);
        updateEstimate();
    };
    range.oninput = update;
};

syncSlider('fpsRange', 'fpsVal');
syncSlider('maxFramesRange', 'maxFramesVal');
syncSlider('qualityRange', 'qualityVal', 2);
const updateEstimate = () => {
    if (!currentFile) return;
    const video = document.querySelector('video[data-info]');
    if (!video) return;
    const fps = parseInt($('fpsRange').value);
    const max = parseInt($('maxFramesRange').value);
    const est = Math.min(Math.ceil(video.duration * fps), max);
    $('infoEst').textContent = est + ' кадр(ов)';
};
uploadArea.onclick = () => fileInput.click();
uploadArea.ondragover = (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); };
uploadArea.ondragleave = () => uploadArea.classList.remove('dragover');
uploadArea.ondrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadArea.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('video/')) onFile(f);
};
fileInput.onchange = (e) => {
    if (e.target.files[0]) onFile(e.target.files[0]);
    e.target.value = '';
};
const onFile = (file) => {
    currentFile = file;
    resultJson = null;
    let probe = document.querySelector('video[data-info]');
    if (!probe) {
        probe = document.createElement('video');
        probe.setAttribute('data-info', '1');
        probe.muted = true;
        probe.style.display = 'none';
        document.body.appendChild(probe);
    }
    const url = URL.createObjectURL(file);
    probe.src = url;
    probe.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        const fps = parseInt($('fpsRange').value);
        const max = parseInt($('maxFramesRange').value);
        const est = Math.min(Math.ceil(probe.duration * fps), max);

        $('infoName').textContent = file.name;
        $('infoRes').textContent = `${probe.videoWidth}×${probe.videoHeight}`;
        $('infoDur').textContent = fmtTime(probe.duration);
        $('infoEst').textContent = est + ' кадр(ов)';
        $('videoInfo').hidden = false;
        $('settingsBlock').hidden = false;
        $('progressBlock').hidden = true;
        $('resultBlock').hidden = true;

        uploadArea.querySelector('.uploadText').innerHTML =
            `<strong>${file.name}</strong> загружено`;
    };
    probe.onerror = () => {
        URL.revokeObjectURL(url);
        uploadArea.querySelector('.uploadText').textContent = 'Не удалось прочитать видео';
    };

    $('convertBtn').onclick = () => startConvert(file);
};

const startConvert = async (file) => {
    const fps = parseInt($('fpsRange').value);
    const maxFrames = parseInt($('maxFramesRange').value);
    const quality = parseFloat($('qualityRange').value);
    const name = file.name.replace(/\.[^.]+$/, '');
    $('settingsBlock').hidden = true;
    $('videoInfo').hidden = true;
    $('progressBlock').hidden = false;
    $('resultBlock').hidden = true;
    const bar = $('progressFill');
    const txt = $('progressText');
    bar.style.width = '0%';
    bar.className = 'progressBarFill';

    const onProgress = (cur, total, phase) => {
        const base = phase === 'extract' ? 0 : 50;
        const pct = base + Math.round(cur / total * 50);
        bar.style.width = pct + '%';
        txt.textContent = phase === 'extract'
            ? `Извлечение кадров: ${cur} / ${total}`
            : `Кодирование base64: ${cur} / ${total}`;
    };

    try {
        const { frames, width, height } = await extractFrames(file, fps, maxFrames, quality, onProgress);

        txt.textContent = 'Сборка Lottie JSON...';
        const json = await buildLottieJson(frames, width, height, fps, name, onProgress);

        bar.style.width = '100%';
        bar.classList.add('done');
        txt.textContent = 'Готово!';
        resultJson = json;
        showResult(json, frames.length, fps, width, height, name);
    } catch (err) {
        bar.className = 'progressBarFill error';
        txt.textContent = 'Ошибка: ' + err.message;
        console.error(err);
        $('settingsBlock').hidden = false;
    }
};

const showResult = (json, frames, fps, width, height, name) => {
    $('progressBlock').hidden = true;
    $('resultBlock').hidden = false;
    const jsonStr = JSON.stringify(json);
    const sizeBytes = new Blob([jsonStr]).size;
    $('resFrames').textContent = frames;
    $('resFps').textContent = fps + ' fps';
    $('resRes').textContent = `${width}×${height}`;
    $('resSize').textContent = fmtSize(sizeBytes);

    const warning = $('resWarning');
    if (sizeBytes > 5 * 1024 * 1024) {
        warning.textContent = `⚠ Файл ${fmtSize(sizeBytes)} — рекомендуем прогнать через оптимизатор`;
        warning.hidden = false;
    } else {
        warning.hidden = true;
    }

    $('downloadBtn').onclick = () => {
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name + '.lottie.json';
        a.click();
        URL.revokeObjectURL(url);
    };
    const box = $('previewBox');
    box.innerHTML = '';
    try {
        lottie.loadAnimation({
            container: box,
            renderer: 'canvas',
            loop: true,
            autoplay: true,
            animationData: json,
            assetsPath: ''
        });
    } catch (e) {
        box.textContent = 'Превью недоступно';
    }
};
const resetTool = () => {
    currentFile = null;
    resultJson = null;
    _fileHandling = false;
    $('resultBlock').hidden = true;
    $('progressBlock').hidden = true;
    $('settingsBlock').hidden = true;
    $('videoInfo').hidden = true;
    uploadArea.querySelector('.uploadText').textContent = 'Перетащите видео или нажмите для загрузки';
};
$('resetBtn').onclick = resetTool;
$('resetSettingsBtn').onclick = resetTool;
