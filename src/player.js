// WebCodecs VideoDecoder + MP4Box
const extractFramesWebCodecs = async (videoBlob, frameCount, fps, onFrame, onAccel) => {
    if (!('VideoDecoder' in window)) {
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
            // ждём все семплы трека
            if (collected.length >= info.nb_samples) {
                resolve({samples: collected, trackInfo: info, description: desc});
            }
        };

        mp4file.onError = (e) => reject(new Error('MP4Box: ' + e));

        // передаём весь файл сразу
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
    } catch {
    }

    if (onAccel) onAccel(hwAccel === 'prefer-hardware' ? 'GPU' : 'CPU');

    // декодируем семплы через VideoDecoder
    const framePromises = [];
    let outputCount = 0;

    await new Promise((resolve, reject) => {
        const decoder = new VideoDecoder({
            output: (frame) => {
                outputCount++;
                if (onFrame) onFrame(outputCount, frameCount);

                // рисуем в OffscreenCanvas и конвертируем в blob url
                const p = (async () => {
                    const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
                    canvas.getContext('2d').drawImage(frame, 0, 0);
                    frame.close();
                    // ОПТИМИЗАЦИЯ: раньше кадры сохранялись как PNG.
                    // Теперь WebP quality 0.92 — визуально неотличимо, но в 2–5 раз меньше размер blob.
                    const blob = await canvas.convertToBlob({type: 'image/webp', quality: 0.92});
                    return URL.createObjectURL(blob);
                })();

                framePromises.push(p);
            }, error: (e) => reject(new Error('VideoDecoder: ' + e.message))
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

        decoder.flush().then(() => {
            decoder.close();
            resolve();
        }).catch(reject);
    });
    // контроль очереди
    // дожидаемся всех async convertToBlob
    return await Promise.all(framePromises);
}

// фоллбэк — video element + seek
// медленнее но работает везде где нет WebCodecs
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
                await new Promise(r => {
                    video.onseeked = r;
                });

                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                canvas.getContext('2d').drawImage(video, 0, 0);

                frames.push(URL.createObjectURL(await new Promise(r => canvas.toBlob(r, 'image/png'))));

                if (onFrame) onFrame(i + 1, count);
            }

            URL.revokeObjectURL(video.src);
            resolve(frames);
        };

        video.onerror = () => reject(new Error('Не удалось загрузить видео'));
    });
}

// управление воспроизведением
const setupControls = (anim) => {
    const $ = id => document.getElementById(id);
    const controls = $('playerControls');
    const scrubber = $('scrubber');
    const frameInfo = $('frameInfo');
    const btnPause = $('btnPause');
    const btnStop = $('btnStop');
    const speedSel = $('speedSelect');
    const btnLoop = $('btnLoop');

    controls.style.display = '';

    const totalFrames = Math.max(0, Math.floor(anim.totalFrames) - 1);
    scrubber.max = totalFrames;

    let playing = true;
    let scrubbing = false;
    let looping = true;

    const updateFrameLabel = (f) => {
        frameInfo.textContent = `${Math.floor(f)} / ${totalFrames}`;
    }

    updateFrameLabel(0);

    // обновляем ползунок на каждом кадре
    anim.addEventListener('enterFrame', (e) => {
        if (scrubbing) return;
        scrubber.value = Math.floor(e.currentTime);
        updateFrameLabel(e.currentTime);
    });

    // когда анимация добегает до конца
    anim.addEventListener('complete', () => {
        playing = false;
        btnPause.innerHTML = '▶';
    });

    // скраббер — перетаскивание
    scrubber.addEventListener('pointerdown', () => {
        scrubbing = true;
        if (playing) anim.pause();
    });

    scrubber.addEventListener('input', () => {
        const f = parseInt(scrubber.value);
        anim.goToAndStop(f, true);
        updateFrameLabel(f);
    });

    scrubber.addEventListener('pointerup', () => {
        scrubbing = false;
        if (playing) anim.play();
    });

    // пауза / воспроизведение
    btnPause.onclick = () => {
        if (playing) {
            anim.pause();
            playing = false;
            btnPause.innerHTML = '▶';
        } else {
            anim.play();
            playing = true;
            btnPause.innerHTML = '⏸&ensp;Пауза';
        }
    };

    // стоп — в начало
    btnStop.onclick = () => {
        anim.stop();
        playing = false;
        scrubber.value = 0;
        updateFrameLabel(0);
        btnPause.innerHTML = '▶';
    };

    // скорость воспроизведения
    speedSel.onchange = () => {
        anim.setSpeed(parseFloat(speedSel.value));
    };

    // повтор вкл/выкл
    btnLoop.onclick = () => {
        looping = !looping;
        anim.setLoop(looping);
        btnLoop.classList.toggle('active', looping);
    };
}

document.addEventListener('DOMContentLoaded', () => {
    const $ = id => document.getElementById(id);
    const state = {json: null, zip: null, anim: null};
    // прогресс
    const pFill = $('progressFill');
    const pLabel = $('progressLabel');

    const setProgress = (pct, text) => {
        pFill.style.width = pct + '%';
        pLabel.textContent = text;
    }

    // форматирование
    const fmt = (bytes) => {
        if (bytes === 0) return '0 B';
        const k = 1024, s = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + s[i];
    }

    const fmtTime = (ms) => ms < 1000 ? ms.toFixed(0) + ' мс' : (ms / 1000).toFixed(2) + ' с';


    // зона загрузки
    const markZoneLoaded = (zoneId, iconId, hintId, sizeId, filename, size) => {
        const zone = $(zoneId);
        zone.classList.add('loaded');
        const iconEl = $(iconId);
        if (iconEl) iconEl.textContent = '';
        const hintEl = $(hintId);
        if (hintEl) {
            hintEl.className = 'pl-zone-file';
            hintEl.textContent = filename;
        }
        // показываем размер
        const sizeEl = $(sizeId);
        if (sizeEl) {
            sizeEl.textContent = fmt(size);
            sizeEl.style.display = '';
        }
    }

    // drag-and-drop для зоны
    const setupZone = (zoneId, inputId, onFile) => {
        const zone = $(zoneId);
        const input = $(inputId);
        zone.addEventListener('click', () => input.click());
        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            zone.classList.add('drag');
        });
        zone.addEventListener('dragleave', (e) => {
            if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag');
        });
        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('drag');
            const file = e.dataTransfer.files[0];
            if (file) onFile(file);
        });
    }

    // json
    const loadJsonFile = async (file) => {
        try {
            state.json = JSON.parse(await file.text());
            markZoneLoaded('zoneJson', 'jsonIcon', 'jsonHint', 'jsonSize', file.name, file.size);
        } catch (err) {
            console.error(err);
        }
        checkReady();
    }

    setupZone('zoneJson', 'jsonInput', loadJsonFile);

    $('jsonInput').onchange = async (e) => {
        const file = e.target.files[0];
        if (file) await loadJsonFile(file);
        e.target.value = '';
    };

    // zip
    const loadZipFile = async (file) => {
        try {
            state.zip = await JSZip.loadAsync(await file.arrayBuffer());
            markZoneLoaded('zoneZip', 'zipIcon', 'zipHint', 'zipSize', file.name, file.size);
        } catch (err) {
            console.error(err);
        }
        checkReady();
    }

    setupZone('zoneZip', 'zipInput', loadZipFile);

    $('zipInput').onchange = async (e) => {
        const file = e.target.files[0];
        if (file) await loadZipFile(file);
        e.target.value = '';
    };

    const checkReady = () => {
        $('btnPlay').disabled = !(state.json && state.zip);
    }

    // воспроизведение
    $('btnPlay').onclick = async () => {
        $('btnPlay').disabled = true;
        $('btnPlay').textContent = 'Декодирование...';
        pFill.classList.remove('done', 'error');
        setProgress(0, 'Запуск...');

        const totalT0 = performance.now();

        // всё что потом покажем в статистике
        const stats = {
            imageCount: 0,
            imageDecodeTime: 0,
            imageTotalSize: 0,
            videoCount: 0,
            videoDecodeTime: 0,
            videoTotalFrames: 0,
            videoTotalSize: 0,
            videoDetails: [],
            totalTime: 0,
            lottieInitTime: 0,
            webCodecsUsed: false
        };

        // глубокая копия — не трогаем оригинал
        const data = JSON.parse(JSON.stringify(state.json));
        const assets = data.assets || [];
        const videoAssets = data.videoAssets || [];

        // ассеты
        setProgress(5, 'Извлечение изображений...');

        const imgT0 = performance.now();
        let imgDone = 0;
        const imageCandidates = assets.filter(a => a.u && a.p && !a._video);
        const totalImgs = imageCandidates.length;

        // параллельно извлекаем все картинки из ZIP
        // ОПТИМИЗАЦИЯ: раньше был последовательный for с await на каждом файле
        // Теперь Promise.all запускает все распаковки одновременно
        await Promise.all(imageCandidates.map(async (asset) => {
            const zipPath = asset.u + asset.p;
            const zipFile = state.zip.file(zipPath);

            if (!zipFile) return;

            const blob = await zipFile.async('blob');
            stats.imageTotalSize += blob.size;
            asset.u = '';
            asset.p = URL.createObjectURL(blob);

            stats.imageCount++;
            const done = ++imgDone;
            setProgress(5 + Math.round(done / Math.max(totalImgs, 1) * 30), `Картинка ${done}/${totalImgs}`);
        }));
        stats.imageDecodeTime = performance.now() - imgT0;

        const vidT0 = performance.now();

        for (let vi = 0; vi < videoAssets.length; vi++) {
            const va = videoAssets[vi];
            const zipFile = state.zip.file(va.file);

            if (!zipFile) continue;

            setProgress(35 + Math.round(vi / Math.max(videoAssets.length, 1) * 50), `Видео ${vi + 1}/${videoAssets.length}: ${va.file}...`);

            const vdStat = {
                file: va.file,
                frames: va.frames,
                fps: va.fps,
                width: va.width,
                height: va.height,
                fileSize: 0,
                extractTime: 0,
                avgFrameExtract: 0,
                hardwareAccel: 'неизвестно',
                decoderApi: 'video element'
            };

            const videoBlob = await zipFile.async('blob');
            vdStat.fileSize = videoBlob.size;
            stats.videoTotalSize += videoBlob.size;
            const frameT0 = performance.now();
            let frames;

            try {
                frames = await extractFramesWebCodecs(videoBlob, va.frames, va.fps, (cur, total) => {
                    setProgress(35 + Math.round((vi + cur / Math.max(total, 1)) / Math.max(videoAssets.length, 1) * 50), `Видео ${vi + 1}/${videoAssets.length}: кадр ${cur}/${total}`);
                }, (accel) => {
                    vdStat.hardwareAccel = accel;
                });
                stats.webCodecsUsed = true;
                vdStat.decoderApi = 'WebCodecs';
            } catch (err) {
                frames = await extractFramesFallback(videoBlob, va.frames, va.fps, (cur, total) => {
                    setProgress(35 + Math.round((vi + cur / Math.max(total, 1)) / Math.max(videoAssets.length, 1) * 50), `Видео ${vi + 1}/${videoAssets.length}: кадр ${cur}/${total}`);
                });
            }
            vdStat.extractTime = performance.now() - frameT0;
            vdStat.avgFrameExtract = va.frames > 0 ? vdStat.extractTime / va.frames : 0;
            // подставляем кадры в ассеты
            va.frameIds.forEach((id, i) => {
                const asset = assets.find(a => a.id === id);
                if (asset && frames[i]) {
                    asset.u = '';
                    asset.p = frames[i];
                }
            });
            stats.videoCount++;
            stats.videoTotalFrames += va.frames;
            stats.videoDetails.push(vdStat);
        }
        stats.videoDecodeTime = performance.now() - vidT0;

        // lottie
        setProgress(90, 'Инициализация Lottie...');

        const lottieT0 = performance.now();

        state.anim?.destroy();
        $('player').innerHTML = '';

        $('playerWrap').style.display = '';
        $('playerWrap').classList.add('playing');
        $('playerPlaceholder').classList.add('hidden');

        // адаптируем контейнер под соотношение сторон анимации
        if (data.w && data.h) {
            $('player').style.aspectRatio = `${data.w} / ${data.h}`;
        }

        state.anim = lottie.loadAnimation({
            container: $('player'), renderer: 'canvas', loop: true, autoplay: true, animationData: data
        });

        stats.lottieInitTime = performance.now() - lottieT0;
        stats.totalTime = performance.now() - totalT0;

        pFill.classList.add('done');
        setProgress(100, `${fmtTime(stats.totalTime)}`);

        $('btnPlay').disabled = false;
        $('btnPlay').textContent = '▶ Воспроизвести';

        renderStats(stats);
        setupControls(state.anim);
    };
    const renderStats = (s) => {
        const el = $('statsSection');
        el.style.display = '';

        const row = (pfx, key, val, valCls = '') => `<div class="rtRow">
                <span class="rtPfx">${pfx}</span>
                <span class="rtKey">${key}</span>
                <span class="rtVal${valCls ? ' ' + valCls : ''}">${val}</span>
            </div>`;

        const rows = (items) => items.map((item, i) => row(i === items.length - 1 ? '└' : '├', item[0], item[1], item[2] || '')).join('');

        let html = '<div class="statsInner">';

        // три верхних карточки
        html += `<div class="statsGrid">
            <div class="statBox">
                <div class="statLabel">Итого</div>
                <div class="statValue">${fmtTime(s.totalTime)}</div>
            </div>
            <div class="statBox">
                <div class="statLabel">Картинки</div>
                <div class="statValue">${s.imageCount}</div>
                <div class="statDetail">${fmt(s.imageTotalSize)}</div>
            </div>
            <div class="statBox">
                <div class="statLabel">Кадры видео</div>
                <div class="statValue">${s.videoTotalFrames}</div>
                <div class="statDetail">${s.videoCount} видео · ${fmt(s.videoTotalSize)}</div>
            </div>
        </div>`;

        // тайминг-бар
        const phaseSum = s.imageDecodeTime + s.videoDecodeTime + s.lottieInitTime || 1;
        html += '<div class="statsTableTitle">Время работы</div>';
        html += '<div class="timingBar">';
        html += `<div class="timingSegment images" style="width:${s.imageDecodeTime / phaseSum * 100}%"></div>`;
        html += `<div class="timingSegment video"  style="width:${s.videoDecodeTime / phaseSum * 100}%"></div>`;
        html += `<div class="timingSegment zip"    style="width:${s.lottieInitTime / phaseSum * 100}%"></div>`;
        html += '</div>';
        html += '<div class="timingLegend">';
        html += `<span class="tImages">Картинки&nbsp;${fmtTime(s.imageDecodeTime)}</span>`;
        html += `<span class="tVideo">Видео&nbsp;${fmtTime(s.videoDecodeTime)}</span>`;
        html += `<span class="tZip">Запуск&nbsp;${fmtTime(s.lottieInitTime)}</span>`;
        html += '</div>';

        html += '<table class="statsTable">';
        html += `<tr><td>Итого</td><td>${fmtTime(s.totalTime)}</td></tr>`;
        html += '</table>';

        html += '<div class="resultBlock">';

        // блок картинки
        if (s.imageCount > 0) {
            const imgItems = [['Файлов', `${s.imageCount} шт.`], ['Суммарный размер', fmt(s.imageTotalSize)], ['Время', fmtTime(s.imageDecodeTime)],];
            if (s.imageCount > 0 && s.imageDecodeTime > 0) imgItems.push(['Скорость', `${(s.imageCount / (s.imageDecodeTime / 1000)).toFixed(1)} файл/с`]);
            html += `<div class="resultCard" style="border-left-color:var(--accent)">
                <div class="rcHead">
                    <span class="rcTitle">ИЗОБРАЖЕНИЯ</span>
                    <span class="rcBadge">${s.imageCount} файлов</span>
                </div>
                <div class="rtBody">${rows(imgItems)}</div>
            </div>`;
        }

        // блок на каждое видео
        for (const vd of s.videoDetails) {
            const vItems = [['Разрешение', `${vd.width}×${vd.height} px`], ['Кадров', `${vd.frames} шт. @ ${vd.fps} fps`], ['Размер', fmt(vd.fileSize)], ['Время', fmtTime(vd.extractTime)], ['Среднее на кадр', fmtTime(vd.avgFrameExtract)], ['Ускорение', vd.hardwareAccel], ['Decoder API', vd.decoderApi],];
            if (vd.frames > 0 && vd.extractTime > 0) vItems.push(['Скорость', `${(vd.frames / (vd.extractTime / 1000)).toFixed(1)} кадр/с`]);
            html += `<div class="resultCard" style="border-left-color:#6366f1">
                <div class="rcHead">
                    <span class="rcTitle">ВИДЕО</span>
                    <span class="rcBadge">${vd.file}</span>
                </div>
                <div class="rtBody">${rows(vItems)}</div>
            </div>`;
        }

        html += '</div>';
        html += '</div>';
        el.innerHTML = html;
    }
});

export {extractFramesWebCodecs, extractFramesFallback, setupControls};
