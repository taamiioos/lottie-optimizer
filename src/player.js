// WebCodecs VideoDecoder + MP4Box
const extractFramesWebCodecs = async (videoBlob, frameCount, fps, onFrame, onAccel, {workerSafe = false} = {}) => {
    if (!('VideoDecoder' in self)) {
        throw new Error('WebCodecs API не поддерживается');
    }
    const arrayBuf = await videoBlob.arrayBuffer();
    // демультиплексируем MP4 через mp4box, собираем все семплы
    const {samples, trackInfo, description} = await new Promise((resolve, reject) => {
        const mp4file = MP4Box.createFile();
        const collected = [];
        let info = null;
        let desc = null;

        mp4file.onReady = (mp4info) => {
            const track = mp4info.videoTracks[0];
            if (!track) return reject(new Error('Нет видеотрека в файле'));
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

        mp4file.onSamples = (id, user, samples) => {
            collected.push(...samples);
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

    // проверяем поддержку аппаратного ускорения
    let hwAccel = 'prefer-software';
    try {
        const support = await VideoDecoder.isConfigSupported({
            codec: trackInfo.codec,
            codedWidth: trackInfo.video.width,
            codedHeight: trackInfo.video.height,
            hardwareAcceleration: 'prefer-hardware'
        });
        if (support.supported) hwAccel = 'prefer-hardware';
    } catch {}

    if (onAccel) onAccel(hwAccel === 'prefer-hardware' ? 'GPU' : 'CPU');

    const framePromises = [];
    let outputCount = 0;

    await new Promise((resolve, reject) => {
        const decoder = new VideoDecoder({
            output: (frame) => {
                outputCount++;
                if (onFrame) onFrame(outputCount, frameCount);
                const p = (async () => {
                    const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
                    canvas.getContext('2d').drawImage(frame, 0, 0);
                    frame.close();
                    // WebP 0.8 = дефолт оптимайзера: качество совпадает с исходниками,
                    // и в ~2.5x быстрее чем 0.92 которое было раньше
                    const blob = await canvas.convertToBlob({type: 'image/webp', quality: 0.8});
                    // в воркере возвращаем Blob — он клонируется через postMessage,
                    // на главном потоке из него создадут blob URL (который не умрёт)
                    return workerSafe ? blob : URL.createObjectURL(blob);
                })();
                framePromises.push(p);
            },
            error: (e) => reject(new Error('VideoDecoder: ' + e.message))
        });

        decoder.configure({
            codec: trackInfo.codec,
            codedWidth: trackInfo.video.width,
            codedHeight: trackInfo.video.height,
            description,
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

    return await Promise.all(framePromises);
};

// фоллбэк — video element + seek, работает везде где нет WebCodecs
const extractFramesFallback = (videoBlob, count, fps, onFrame) => {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.muted = true;
        video.src = URL.createObjectURL(videoBlob);

        video.onloadedmetadata = async () => {
            const frames = [];
            const step = 1 / fps;

            for (let i = 0; i < count; i++) {
                video.currentTime = Math.min(i * step, video.duration - 0.001);
                await new Promise(r => { video.onseeked = r; });

                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                canvas.getContext('2d').drawImage(video, 0, 0);
                frames.push(URL.createObjectURL(await new Promise(r => canvas.toBlob(r, 'image/webp', 0.8))));

                if (onFrame) onFrame(i + 1, count);
            }

            URL.revokeObjectURL(video.src);
            resolve(frames);
        };

        video.onerror = () => reject(new Error('Не удалось загрузить видео'));
    });
};

const restoreAnimation = async (json, zipBlob, {onProgress = () => {}, workerSafe = false} = {}) => {
    const data = JSON.parse(JSON.stringify(json));
    const assets = data.assets || [];
    const videoAssets = data.videoAssets || [];

    const stats = {
        imageCount: 0, imageTotalSize: 0, imageDecodeTime: 0,
        videoCount: 0, videoTotalFrames: 0, videoTotalSize: 0,
        videoDetails: [], videoDecodeTime: 0
    };

    const externalImages = assets.filter(a => a.u && a.p && !a._video);
    const externalVideos = videoAssets.filter(va => va.file);

    // самодостаточный JSON — нет внешних ассетов, ZIP не нужен
    if (externalImages.length === 0 && externalVideos.length === 0) {
        onProgress({phase: 'done', percent: 100});
        return {data, stats};
    }

    if (!zipBlob) throw new Error('Анимация требует ZIP архив с ассетами');

    const zip = await JSZip.loadAsync(await zipBlob.arrayBuffer());

    // извлекаем картинки из ZIP параллельно
    const imgT0 = performance.now();
    let imgDone = 0;

    await Promise.all(externalImages.map(async (asset) => {
        const zipFile = zip.file(asset.u + asset.p);
        if (!zipFile) return;
        const blob = await zipFile.async('blob');
        stats.imageTotalSize += blob.size;
        asset.u = '';
        // в воркере — кладём Blob, postMessage клонирует его на главный поток
        asset.p = workerSafe ? blob : URL.createObjectURL(blob);
        const done = ++imgDone;
        onProgress({
            phase: 'images', current: done, total: externalImages.length,
            percent: Math.round(done / Math.max(externalImages.length, 1) * 30)
        });
    }));
    stats.imageCount = imgDone;
    stats.imageDecodeTime = performance.now() - imgT0;

    // извлекаем видеокадры из ZIP
    const vidT0 = performance.now();
    for (let vi = 0; vi < externalVideos.length; vi++) {
        const va = externalVideos[vi];
        const zipFile = zip.file(va.file);
        if (!zipFile) continue;

        onProgress({
            phase: 'video',
            message: `Видео ${vi + 1}/${externalVideos.length}: ${va.file}...`,
            percent: 35 + Math.round(vi / Math.max(externalVideos.length, 1) * 50)
        });

        const videoBlob = await zipFile.async('blob');
        const vdStat = {
            file: va.file, frames: va.frames, fps: va.fps,
            width: va.width, height: va.height,
            fileSize: videoBlob.size, extractTime: 0, avgFrameExtract: 0,
            hardwareAccel: 'неизвестно', decoderApi: 'video element'
        };
        stats.videoTotalSize += videoBlob.size;

        const frameT0 = performance.now();
        let frames;
        try {
            frames = await extractFramesWebCodecs(videoBlob, va.frames, va.fps, (cur, total) => {
                onProgress({
                    phase: 'video',
                    message: `Кадр ${cur}/${total}`,
                    percent: 35 + Math.round((vi + cur / Math.max(total, 1)) / Math.max(externalVideos.length, 1) * 50)
                });
            }, (accel) => { vdStat.hardwareAccel = accel; }, {workerSafe});
            vdStat.decoderApi = 'WebCodecs';
        } catch (e) {
            // в воркере нет document — video element fallback недоступен
            if (workerSafe) throw new Error(`WebCodecs не сработал, fallback недоступен в воркере: ${e.message}`);
            frames = await extractFramesFallback(videoBlob, va.frames, va.fps, (cur, total) => {
                onProgress({
                    phase: 'video',
                    message: `Кадр ${cur}/${total}`,
                    percent: 35 + Math.round((vi + cur / Math.max(total, 1)) / Math.max(externalVideos.length, 1) * 50)
                });
            });
        }

        vdStat.extractTime = performance.now() - frameT0;
        vdStat.avgFrameExtract = va.frames > 0 ? vdStat.extractTime / va.frames : 0;

        va.frameIds.forEach((id, i) => {
            const asset = assets.find(a => a.id === id);
            if (asset && frames[i]) { asset.u = ''; asset.p = frames[i]; }
        });

        stats.videoCount++;
        stats.videoTotalFrames += va.frames;
        stats.videoDetails.push(vdStat);
    }
    stats.videoDecodeTime = performance.now() - vidT0;

    onProgress({phase: 'done', percent: 100});
    return {data, stats};
};

// проверяет совместимость JSON и ZIP перед воспроизведением
const validateFilesMatch = async (json, zipBlob) => {
    if (!json || typeof json !== 'object') return {requiresZip: false, errors: ['Файл не является валидным JSON'], warnings: []};
    if (!json.v || !json.fr || !json.w || !json.h) return {requiresZip: false, errors: ['Файл не является Lottie анимацией'], warnings: []};

    const assets = json.assets || [];
    const videoAssets = json.videoAssets || [];
    const externalImages = assets.filter(a => a.u && a.p && !a._video);
    const externalVideos = videoAssets.filter(va => va.file);
    const requiresZip = externalImages.length > 0 || externalVideos.length > 0;
    if (!requiresZip) return {requiresZip: false, errors: [], warnings: []};
    if (!zipBlob) {
        const desc = [
            externalImages.length > 0 && `${externalImages.length} изображений`,
            externalVideos.length > 0 && `${externalVideos.length} видео`
        ].filter(Boolean).join(', ');
        return {requiresZip: true, errors: [`Нужен ZIP архив (${desc})`], warnings: []};
    }

    let zip;
    try { zip = await JSZip.loadAsync(await zipBlob.arrayBuffer()); }
    catch { return {requiresZip: true, errors: ['Не удалось прочитать ZIP архив'], warnings: []}; }

    const zipFiles = new Set(Object.keys(zip.files));
    const errors = [];
    const warnings = [];

    const missingImgs = externalImages.filter(a => !zipFiles.has(a.u + a.p));
    if (missingImgs.length > 0) {
        const sample = missingImgs.slice(0, 3).map(a => a.u + a.p).join(', ');
        const extra  = missingImgs.length > 3 ? ` и ещё ${missingImgs.length - 3}` : '';
        errors.push(`В ZIP нет файлов: ${sample}${extra}`);
    }

    const missingVids = externalVideos.filter(va => !zipFiles.has(va.file));
    if (missingVids.length > 0) {
        errors.push(`В ZIP нет видео: ${missingVids.map(va => va.file).join(', ')}`);
    }

    // предупреждение: в ZIP есть файлы, которых нет в JSON — возможно другой архив
    if (errors.length > 0) {
        const expectedPaths = new Set([
            ...externalImages.map(a => a.u + a.p),
            ...externalVideos.map(va => va.file)
        ]);
        const extraCount = Object.values(zip.files).filter(f => !f.dir && !expectedPaths.has(f.name)).length;
        if (extraCount > 0) warnings.push(`ZIP содержит ${extraCount} лишних файлов — возможно не тот архив`);
    }

    return {requiresZip: true, errors, warnings};
};

const Player = {
    restore: restoreAnimation,
    validate: validateFilesMatch,
    _workerUrl: 'https://cdn.jsdelivr.net/gh/taamiioos/lottie-optimizer@main/src/worker.js',
    async restoreInWorker(json, zipBlob, {onProgress = () => {}} = {}) {
        // если браузер не поддерживает воркеры — fallback на главный поток
        if (typeof Worker === 'undefined') {
            return restoreAnimation(json, zipBlob, {onProgress});
        }
        if (!zipBlob) {
            return restoreAnimation(json, null, {onProgress});
        }
        return new Promise(async (resolve, reject) => {
            let worker;
            try {
                worker = new Worker(Player._workerUrl, {type: 'module'});
            } catch {
                // не удалось создать воркер — fallback
                resolve(restoreAnimation(json, zipBlob, {onProgress}));
                return;
            }
            const id = Math.random().toString(36).slice(2);
            worker.onmessage = ({data: msg}) => {
                if (msg.id !== id) return;
                if (msg.type === 'progress') {
                    onProgress(msg.info);
                } else if (msg.type === 'restore-result') {
                    worker.terminate();
                    const result = msg.result;
                    for (const asset of (result.data?.assets || [])) {
                        if (asset.p instanceof Blob) {
                            asset.p = URL.createObjectURL(asset.p);
                        }
                    }
                    resolve(result);
                } else if (msg.type === 'error') {
                    worker.terminate();
                    reject(new Error(msg.message));
                }
            };

            worker.onerror = (e) => {
                worker.terminate();
                // fallback на главный поток если воркер не загрузился
                restoreAnimation(json, zipBlob, {onProgress}).then(resolve).catch(reject);
            };

            // ZIP передаём как transferable — без копирования
            const zipBuffer = await zipBlob.arrayBuffer();
            worker.postMessage({id, type: 'restore', json, zipBuffer}, [zipBuffer]);
        });
    }
};

export {Player, extractFramesWebCodecs, extractFramesFallback, restoreAnimation, validateFilesMatch};

