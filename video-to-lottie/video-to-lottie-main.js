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

const _extractFramesWebCodecs = async (videoFile, fps, maxFrames, quality, onProgress) => {
    const arrayBuf = await videoFile.arrayBuffer();

    const {samples, trackInfo, description} = await new Promise((resolve, reject) => {
        const mp4file = MP4Box.createFile();
        const collected = [];
        let info = null, desc = null;

        mp4file.onReady = (mp4info) => {
            const track = mp4info.videoTracks[0];
            if (!track) return reject(new Error('Нет видеотрека'));
            info = track;
            const trak = mp4file.getTrackById(track.id);
            for (const entry of trak.mdia.minf.stbl.stsd.entries) {
                if (entry.avcC) {
                    const s = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                    entry.avcC.write(s);
                    desc = new Uint8Array(s.buffer, 8);
                    break;
                }
            }
            mp4file.setExtractionOptions(track.id, null, {nbSamples: Infinity});
            mp4file.start();
        };

        mp4file.onSamples = (id, user, batch) => {
            collected.push(...batch);
            if (collected.length >= info.nb_samples) {
                resolve({samples: collected, trackInfo: info, description: desc});
            }
        };

        mp4file.onError = (e) => reject(new Error('MP4Box: ' + e));

        const buf = arrayBuf;
        buf.fileStart = 0;
        mp4file.appendBuffer(buf);
        mp4file.flush();
    });

    const duration = trackInfo.duration / trackInfo.timescale;
    const w = trackInfo.video.width, h = trackInfo.video.height;
    const total = Math.min(Math.ceil(duration * fps), maxFrames);

    let hwAccel = 'prefer-software';
    try {
        const sup = await VideoDecoder.isConfigSupported({
            codec: trackInfo.codec, codedWidth: w, codedHeight: h,
            hardwareAcceleration: 'prefer-hardware'
        });
        if (sup.supported) hwAccel = 'prefer-hardware';
    } catch {}

    const frameCanvases = [];
    let nextTarget = 0;

    await new Promise((resolve, reject) => {
        const decoder = new VideoDecoder({
            output: (frame) => {
                const ts = frame.timestamp / 1_000_000;
                while (nextTarget < total && ts >= nextTarget / fps) {
                    const fc = new OffscreenCanvas(w, h);
                    fc.getContext('2d').drawImage(frame, 0, 0);
                    frameCanvases.push(fc);
                    onProgress(frameCanvases.length, total, 'extract');
                    nextTarget++;
                }
                frame.close();
            },
            error: (e) => reject(new Error('VideoDecoder: ' + e.message))
        });

        decoder.configure({
            codec: trackInfo.codec,
            codedWidth: w,
            codedHeight: h,
            description: description || undefined,
            hardwareAcceleration: hwAccel
        });

        for (const sample of samples) {
            decoder.decode(new EncodedVideoChunk({
                type: sample.is_sync ? 'key' : 'delta',
                timestamp: sample.cts * 1_000_000 / sample.timescale,
                duration: sample.duration * 1_000_000 / sample.timescale,
                data: sample.data
            }));
        }

        decoder.flush().then(() => { decoder.close(); resolve(); }).catch(reject);
    });

    let totalFrameSize = 0;
    const frames = await Promise.all(frameCanvases.map(async (fc) => {
        const blob = await _canvasToBlob(fc, quality);
        totalFrameSize += blob.size;
        return blob;
    }));

    return {frames, width: w, height: h, duration, fps, total: frameCanvases.length, totalFrameSize};
};
const _extractFramesSeeked = async (videoFile, fps, maxFrames, quality, onProgress) => {
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
    const frameCanvases = [];

    for (let i = 0; i < total; i++) {
        await _seekTo(video, i / fps);
        if (typeof OffscreenCanvas !== 'undefined') {
            const fc = new OffscreenCanvas(w, h);
            fc.getContext('2d').drawImage(video, 0, 0);
            frameCanvases.push(fc);
        } else {
            const fc = document.createElement('canvas');
            fc.width = w; fc.height = h;
            fc.getContext('2d').drawImage(video, 0, 0);
            frameCanvases.push(fc);
        }
        onProgress(i + 1, total, 'extract');
        // yield каждые 10 кадров — браузер успевает обновить прогресс-бар
        if (i % 10 === 9) await new Promise(r => setTimeout(r, 0));
    }

    URL.revokeObjectURL(url);

    let totalFrameSize = 0;
    const frames = await Promise.all(frameCanvases.map(async (fc) => {
        const blob = await _canvasToBlob(fc, quality);
        totalFrameSize += blob.size;
        return blob;
    }));

    return {frames, width: w, height: h, duration, fps, total, totalFrameSize};
};

const _extractFrames = async (videoFile, fps, maxFrames, quality, onProgress) => {
    if ('VideoDecoder' in window && typeof MP4Box !== 'undefined') {
        try {
            console.log('[VideoToLottie] Используем WebCodecs + MP4Box (аппаратное/программное декодирование)');
            return await _extractFramesWebCodecs(videoFile, fps, maxFrames, quality, onProgress);
        } catch (err) {
            console.warn('[VideoToLottie] WebCodecs путь упал, переключаемся на seeked-фоллбэк:', err.message);
        }
    }
    // Фоллбэк для старых браузеров
    return await _extractFramesSeeked(videoFile, fps, maxFrames, quality, onProgress);
};

const _buildLottieJson = async (frames, width, height, fps, name, onProgress) => {
    // FileReader асинхронный — читаем батчами по 20 штук и отдаём управление между ними
    const BATCH = 20;
    const dataUrls = new Array(frames.length);

    for (let i = 0; i < frames.length; i += BATCH) {
        const end = Math.min(i + BATCH, frames.length);
        const batch = frames.slice(i, end);
        const results = await Promise.all(batch.map(blob => new Promise(r => {
            const fr = new FileReader();
            fr.onload = () => r(fr.result);
            fr.readAsDataURL(blob);
        })));
        results.forEach((r, j) => { dataUrls[i + j] = r; });
        onProgress(end, frames.length, 'build');
        // yield после каждого батча — страница не замерзает на больших видео
        await new Promise(r => setTimeout(r, 0));
    }

    const assets = dataUrls.map((p, i) => ({id: `frame_${i}`, w: width, h: height, p, u: '', e: 1}));
    const layers = dataUrls.map((_, i) => ({
        ty: 2, refId: `frame_${i}`, nm: `frame_${i}`, ind: i + 1,
        ip: i, op: i + 1, st: 0, sr: 1, ao: 0, bm: 0, ddd: 0,
        ks: {
            o: {a: 0, k: 100}, r: {a: 0, k: 0},
            p: {a: 0, k: [width / 2, height / 2, 0]},
            a: {a: 0, k: [width / 2, height / 2, 0]},
            s: {a: 0, k: [100, 100, 100]}
        }
    }));

    return {v: '5.7.4', fr: fps, ip: 0, op: frames.length, w: width, h: height, nm: name, ddd: 0, assets, layers};
};

const convertVideoToLottie = async (videoFile, {fps = 24, maxFrames = 150, quality = 0.85, onProgress = () => {}} = {}) => {
    const name = videoFile.name.replace(/\.[^.]+$/, '');

    const frameData = await _extractFrames(videoFile, fps, maxFrames, quality, (cur, total) => {
        onProgress({phase: 'extract', message: `Извлечение кадров: ${cur} / ${total}`, current: cur, total, percent: Math.round(cur / total * 50)});
    });
    onProgress({phase: 'build', message: 'Сборка Lottie JSON...', current: 0, total: frameData.frames.length, percent: 50});

    const json = await _buildLottieJson(frameData.frames, frameData.width, frameData.height, fps, name, (cur, total) => {
        onProgress({phase: 'build', message: `Кодирование: ${cur} / ${total}`, current: cur, total, percent: 50 + Math.round(cur / total * 50)});
    });

    return {json, frameStats: {count: frameData.total, totalFrameSize: frameData.totalFrameSize, width: frameData.width, height: frameData.height, duration: frameData.duration, fps}};
};

const formatSize = (b) => { if (!b) return '0 B'; const k = 1024, s = ['B','KB','MB','GB']; const i = Math.floor(Math.log(b)/Math.log(k)); return parseFloat((b/Math.pow(k,i)).toFixed(2))+' '+s[i]; };

const $ = id => document.getElementById(id);

const fmtTime = (sec) => {
    const m = Math.floor(sec / 60), s = (sec % 60).toFixed(1);
    return m > 0 ? `${m}м ${s}с` : `${s}с`;
};

const syncSlider = (rangeId, valId, decimals = 0) => {
    const range = $(rangeId), val = $(valId);
    range.oninput = () => { val.textContent = parseFloat(range.value).toFixed(decimals); updateEstimate(); };
};
syncSlider('fpsRange', 'fpsVal');
$('fpsVal').textContent = '30';
syncSlider('maxFramesRange', 'maxFramesVal');
syncSlider('qualityRange', 'qualityVal', 2);

const uploadArea = $('uploadArea');
const fileInput  = $('fileInput');
let resultJson   = null;
let currentFile  = null;
let probe        = null;

const updateEstimate = () => {
    if (!probe || !currentFile) return;
    const fps = parseInt($('fpsRange').value);
    const maxFrames = parseInt($('maxFramesRange').value);
    const est = Math.min(Math.ceil(probe.duration * fps), maxFrames);
    $('infoEst').textContent = est + ' кадр(ов)';
};

uploadArea.onclick     = () => fileInput.click();
uploadArea.ondragover  = (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); };
uploadArea.ondragleave = () => uploadArea.classList.remove('dragover');
uploadArea.ondrop = (e) => {
    e.preventDefault(); e.stopPropagation();
    uploadArea.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('video/')) onFile(f);
};
fileInput.onchange = (e) => { if (e.target.files[0]) onFile(e.target.files[0]); e.target.value = ''; };

const onFile = (file) => {
    currentFile = file;
    resultJson  = null;

    // один video элемент переиспользуется для всех файлов — не создаём новый каждый раз
    if (!probe) {
        probe = document.createElement('video');
        probe.muted = true;
        probe.style.display = 'none';
        document.body.appendChild(probe);
    }

    const url = URL.createObjectURL(file);
    probe.src = url;
    probe.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        const fps = parseInt($('fpsRange').value);

        $('infoName').textContent = file.name;
        $('infoRes').textContent  = `${probe.videoWidth}×${probe.videoHeight}`;
        $('infoDur').textContent  = fmtTime(probe.duration);
        $('infoEst').textContent  = Math.ceil(probe.duration * fps) + ' кадр(ов)';
        $('mainCard').hidden      = false;
        $('resultBlock').hidden   = true;
        // сбрасываем прогресс-бар
        $('progressFill').style.width = '0%';
        $('progressFill').className   = 'progressBarFill';
        $('progressText').textContent = '';

        uploadArea.querySelector('.uploadText').innerHTML = `<strong>${file.name}</strong> загружено`;
    };
    probe.onerror = () => {
        URL.revokeObjectURL(url);
        uploadArea.querySelector('.uploadText').textContent = 'Не удалось прочитать видео';
    };

    $('convertBtn').onclick = () => startConvert(file);
};

const startConvert = async (file) => {
    const fps       = parseInt($('fpsRange').value);
    const maxFrames = parseInt($('maxFramesRange').value);
    const quality   = parseFloat($('qualityRange').value);

    $('resultBlock').hidden = true;

    // блокируем управление на время конвертации
    const controls = [$('convertBtn'), $('resetSettingsBtn'), $('fpsRange'), $('maxFramesRange'), $('qualityRange')];
    controls.forEach(el => { el.disabled = true; });

    const bar = $('progressFill');
    const txt = $('progressText');
    bar.style.width = '0%';
    bar.className   = 'progressBarFill';
    txt.textContent = '';

    const t0 = performance.now();

    try {
        const {json, frameStats} = await convertVideoToLottie(file, {
            fps, maxFrames, quality,
            onProgress: ({message, percent}) => {
                bar.style.width = percent + '%';
                txt.textContent = message;
            }
        });

        const elapsed = performance.now() - t0;
        bar.style.width = '100%';
        bar.classList.add('done');
        txt.textContent = 'Готово за ' + fmtTime(elapsed / 1000);
        resultJson = json;
        showResult(json, frameStats, elapsed);
    } catch (err) {
        bar.className   = 'progressBarFill error';
        txt.textContent = 'Ошибка: ' + err.message;
        console.error(err);
    } finally {
        // разблокируем управление
        controls.forEach(el => { el.disabled = false; });
    }
};

const showResult = (json, frameStats, elapsed = 0) => {
    $('resultBlock').hidden = false;

    const jsonStr   = JSON.stringify(json);
    const jsonBytes = new Blob([jsonStr]).size;
    const rawBytes  = frameStats?.totalFrameSize || 0;

    $('resFrames').textContent = frameStats?.count ?? json.op;
    $('resTime').textContent   = fmtTime(elapsed / 1000);
    $('resFps').textContent    = (frameStats?.fps ?? json.fr) + ' fps';
    $('resRes').textContent    = `${frameStats?.width ?? json.w}×${frameStats?.height ?? json.h}`;
    $('resSize').textContent   = rawBytes > 0
        ? `${formatSize(jsonBytes)}`
        : formatSize(jsonBytes);

    $('downloadBtn').onclick = () => {
        const blob = new Blob([jsonStr], {type: 'application/json'});
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = (json.nm || 'animation') + '.lottie.json'; a.click();
        URL.revokeObjectURL(url);
    };

    const box = $('previewBox');
    box.innerHTML = '';
    try {
        lottie.loadAnimation({container: box, renderer: 'canvas', loop: true, autoplay: true, animationData: json, assetsPath: ''});
    } catch { box.textContent = 'Превью недоступно'; }
};

const resetTool = () => {
    currentFile = null;
    resultJson  = null;
    $('resultBlock').hidden = true;
    $('mainCard').hidden    = true;
    // сбрасываем прогресс-бар и кнопки
    $('progressFill').style.width = '0%';
    $('progressFill').className   = 'progressBarFill';
    $('progressText').textContent = '';
    [$('convertBtn'), $('resetSettingsBtn'), $('fpsRange'), $('maxFramesRange'), $('qualityRange')]
        .forEach(el => { el.disabled = false; });
    uploadArea.querySelector('.uploadText').textContent = 'Перетащите видео или нажмите для загрузки';
};
$('resetBtn').onclick         = resetTool;
$('resetSettingsBtn').onclick = resetTool;
