document.addEventListener('DOMContentLoaded', () => {
    const $ = id => document.getElementById(id);
    const state = { json: null, zip: null, anim: null };
    // логирование
    const logEl = $('logContent');
    const log = {
        clear()  { logEl.innerHTML = ''; },
        add(text, cls = '') {
            const d = document.createElement('div');
            d.className = 'logLine ' + cls;
            d.textContent = text;
            logEl.appendChild(d);
            logEl.scrollTop = logEl.scrollHeight;
        },
        info(t)  { this.add(t); },
        ok(t)    { this.add(t, 'success'); },
        err(t)   { this.add(t, 'error'); },
        warn(t)  { this.add(t, 'warn'); },
        phase(t) { this.add(t, 'phase'); }
    };

    // прогресс
    const pFill  = $('progressFill');
    const pLabel = $('progressLabel');

    function setProgress(pct, text) {
        pFill.style.width = pct + '%';
        pLabel.textContent = text;
    }
    // форматирование
    function fmt(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024, s = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + s[i];
    }

    function fmtTime(ms) {
        return ms < 1000 ? ms.toFixed(0) + ' мс' : (ms / 1000).toFixed(2) + ' с';
    }

    // зона загрузки
    function markZoneLoaded(zoneId, iconId, hintId, sizeId, filename, size) {
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
    function setupZone(zoneId, inputId, onFile) {
        const zone  = $(zoneId);
        const input = $(inputId);
        // клик по зоне — открываем file picker
        zone.addEventListener('click', () => input.click());
        // drag-and-drop
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
    async function loadJsonFile(file) {
        try {
            state.json = JSON.parse(await file.text());
            markZoneLoaded('zoneJson', 'jsonIcon', 'jsonHint', 'jsonSize', file.name, file.size);
            log.ok(`JSON загружен: ${file.name} (${fmt(file.size)})`);
        } catch (err) {
            log.err(`Ошибка парсинга JSON: ${err.message}`);
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
    async function loadZipFile(file) {
        const t0 = performance.now();
        try {
            state.zip = await JSZip.loadAsync(await file.arrayBuffer());
            const parseTime = performance.now() - t0;
            markZoneLoaded('zoneZip', 'zipIcon', 'zipHint', 'zipSize', file.name, file.size);
            log.ok(`ZIP загружен: ${file.name} (${fmt(file.size)}, разобран за ${fmtTime(parseTime)})`);

            // список содержимого ZIP
            const allFiles = Object.values(state.zip.files).filter(f => !f.dir);
            log.info(`Содержимое ZIP: ${allFiles.length} файлов`);
            const videos = allFiles.filter(f => f.name.endsWith('.mp4'));
            const images = allFiles.filter(f => !f.name.endsWith('.mp4'));
            if (videos.length) {
                log.info(`  Видео (${videos.length}): ${videos.map(f => f.name.split('/').pop()).join(', ')}`);
            }
            if (images.length) {
                const extCounts = images.reduce((acc, f) => {
                    const ext = f.name.split('.').pop().toUpperCase();
                    acc[ext] = (acc[ext] || 0) + 1;
                    return acc;
                }, {});
                const extStr = Object.entries(extCounts).map(([k, v]) => `${k}: ${v}`).join(', ');
                log.info(`  Изображений (${images.length}): ${extStr}`);
            }
        } catch (err) {
            log.err(`Ошибка загрузки ZIP: ${err.message}`);
        }
        checkReady();
    }

    setupZone('zoneZip', 'zipInput', loadZipFile);

    $('zipInput').onchange = async (e) => {
        const file = e.target.files[0];
        if (file) await loadZipFile(file);
        e.target.value = '';
    };

    function checkReady() {
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
            imageCount: 0, imageDecodeTime: 0, imageTotalSize: 0,
            videoCount: 0, videoDecodeTime: 0, videoTotalFrames: 0, videoTotalSize: 0,
            videoDetails: [],
            totalTime: 0, lottieInitTime: 0,
            webCodecsUsed: false
        };

        // глубокая копия — не трогаем оригинал
        const data        = JSON.parse(JSON.stringify(state.json));
        const assets      = data.assets      || [];
        const videoAssets = data.videoAssets || [];

        // ассеты
        log.phase('Извлечение изображений из ZIP...');
        setProgress(5, 'Извлечение изображений...');

        const imgT0     = performance.now();
        let   imgDone   = 0;
        const totalImgs = assets.filter(a => a.u && a.p && !a._video).length;
        const videoAssetCount = (data.videoAssets || []).length;
        const videoFrameCount = (data.videoAssets || []).reduce((s, v) => s + v.frames, 0);

        log.info(`Ассетов в JSON: изображений ${totalImgs}, видео ${videoAssetCount} (${videoFrameCount} кадров)`);

        for (const asset of assets) {
            if (!(asset.u && asset.p && !asset._video)) continue;

            const zipPath = asset.u + asset.p;
            const zipFile = state.zip.file(zipPath);

            if (!zipFile) {
                log.warn(`Файл не найден в ZIP: ${zipPath}`);
                continue;
            }

            const blob = await zipFile.async('blob');
            stats.imageTotalSize += blob.size;
            asset.u = '';
            asset.p = URL.createObjectURL(blob);

            stats.imageCount++;
            imgDone++;

            // логируем каждый файл
            log.info(`  ← ${zipPath} (${fmt(blob.size)})`);

            setProgress(5 + Math.round(imgDone / Math.max(totalImgs, 1) * 30),
                `Картинка ${imgDone}/${totalImgs}`);
        }
        stats.imageDecodeTime = performance.now() - imgT0;
        const imgRate = stats.imageDecodeTime > 0
            ? (stats.imageCount / (stats.imageDecodeTime / 1000)).toFixed(1) : '—';
        log.ok(`Картинок: ${stats.imageCount} (${fmt(stats.imageTotalSize)}) за ${fmtTime(stats.imageDecodeTime)} — ${imgRate} файл/с`);

        // видео
        log.phase(`Декодирование видео: ${videoAssets.length} файл(ов)...`);

        const vidT0 = performance.now();

        for (let vi = 0; vi < videoAssets.length; vi++) {
            const va      = videoAssets[vi];
            const zipFile = state.zip.file(va.file);

            if (!zipFile) {
                log.warn(`Видео не найдено в ZIP: ${va.file}`);
                continue;
            }

            setProgress(35 + Math.round(vi / Math.max(videoAssets.length, 1) * 50),
                `Видео ${vi + 1}/${videoAssets.length}: ${va.file}...`);

            const vdStat = {
                file:            va.file,
                frames:          va.frames,
                fps:             va.fps,
                width:           va.width,
                height:          va.height,
                fileSize:        0,
                extractTime:     0,
                avgFrameExtract: 0,
                hardwareAccel:   'неизвестно',
                decoderApi:      'video element'
            };

            const videoBlob   = await zipFile.async('blob');
            vdStat.fileSize   = videoBlob.size;
            stats.videoTotalSize += videoBlob.size;
            log.info(`[${va.file}] ${va.width}×${va.height}, ${va.frames} кадров @ ${va.fps} fps, ${fmt(videoBlob.size)}`);
            const frameT0 = performance.now();
            let frames;

            try {
                log.info(`[${va.file}] Метод: WebCodecs API — запуск демультиплексирования MP4...`);
                frames = await extractFramesWebCodecs(
                    videoBlob, va.frames, va.fps,
                    (cur, total) => {
                        if (cur === 1 || cur % Math.max(1, Math.floor(total / 4)) === 0 || cur === total) {
                            log.info(`[${va.file}] декодировано ${cur}/${total} кадров`);
                        }
                        setProgress(
                            35 + Math.round((vi + cur / Math.max(total, 1)) / Math.max(videoAssets.length, 1) * 50),
                            `Видео ${vi + 1}/${videoAssets.length}: кадр ${cur}/${total}`
                        );
                    },
                    (accel) => {
                        vdStat.hardwareAccel = accel;
                        log.info(`[${va.file}] Ускорение: ${accel === 'GPU' ? 'GPU (аппаратное)' : 'CPU (программное)'}`);
                    }
                );
                stats.webCodecsUsed = true;
                vdStat.decoderApi   = 'WebCodecs';
                log.ok(`[${va.file}] WebCodecs: ${frames.length} кадров → ${frames.length} PNG blob URL`);
            } catch (err) {
                log.warn(`[${va.file}] WebCodecs недоступен (${err.message})`);
                log.warn(`[${va.file}] Переключаемся на <video> element + seek...`);
                frames = await extractFramesFallback(
                    videoBlob, va.frames, va.fps,
                    (cur, total) => {
                        if (cur === 1 || cur % Math.max(1, Math.floor(total / 4)) === 0 || cur === total) {
                            log.info(`[${va.file}] seek ${cur}/${total}`);
                        }
                        setProgress(
                            35 + Math.round((vi + cur / Math.max(total, 1)) / Math.max(videoAssets.length, 1) * 50),
                            `Видео ${vi + 1}/${videoAssets.length}: кадр ${cur}/${total}`
                        );
                    }
                );
                log.ok(`[${va.file}] video element: ${frames.length} кадров извлечено`);
            }
            vdStat.extractTime     = performance.now() - frameT0;
            vdStat.avgFrameExtract = va.frames > 0 ? vdStat.extractTime / va.frames : 0;
            const frameRate = vdStat.extractTime > 0
                ? (frames.length / (vdStat.extractTime / 1000)).toFixed(1) : '—';
            log.info(`[${va.file}] скорость декодирования: ${frameRate} кадр/с, среднее на кадр: ${fmtTime(vdStat.avgFrameExtract)}`);
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

            log.ok(`[${va.file}] готово за ${fmtTime(vdStat.extractTime)}`);
        }
        stats.videoDecodeTime = performance.now() - vidT0;

        // lottie
        setProgress(90, 'Инициализация Lottie...');
        log.phase('Запуск Lottie...');

        const lottieT0 = performance.now();

        state.anim?.destroy();
        $('player').innerHTML = '';

        state.anim = lottie.loadAnimation({
            container:     $('player'),
            renderer:      'canvas',
            loop:          true,
            autoplay:      true,
            animationData: data
        });

        stats.lottieInitTime = performance.now() - lottieT0;
        stats.totalTime      = performance.now() - totalT0;

        // плеер запущен — показываем свечение, скрываем заглушку
        $('playerWrap').classList.add('playing');
        $('playerPlaceholder').classList.add('hidden');

        pFill.classList.add('done');
        setProgress(100, `${fmtTime(stats.totalTime)}`);

        log.ok(`Всё готово! Итого: ${fmtTime(stats.totalTime)}`);

        $('btnPlay').disabled = false;
        $('btnPlay').textContent = '▶ Воспроизвести';

        renderStats(stats);
        setupControls(state.anim);
    };

    // управление воспроизведением
    function setupControls(anim) {
        const controls  = $('playerControls');
        const scrubber  = $('scrubber');
        const frameInfo = $('frameInfo');
        const btnPause  = $('btnPause');
        const btnStop   = $('btnStop');
        const speedSel  = $('speedSelect');
        const btnLoop   = $('btnLoop');

        controls.style.display = '';

        const totalFrames = Math.max(0, Math.floor(anim.totalFrames) - 1);
        scrubber.max = totalFrames;

        let playing   = true;  // autoplay: true
        let scrubbing = false;
        let looping   = true;

        function updateFrameLabel(f) {
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

    // WebCodecs VideoDecoder + MP4Box
    async function extractFramesWebCodecs(videoBlob, frameCount, fps, onFrame, onAccel) {
        if (!('VideoDecoder' in window)) {
            throw new Error('WebCodecs API не поддерживается');
        }

        const arrayBuf = await videoBlob.arrayBuffer();

        // шаг 1 — демультиплексируем MP4 через mp4box, собираем все семплы
        const { samples, trackInfo, description } = await new Promise((resolve, reject) => {
            const mp4file   = MP4Box.createFile();
            const collected = [];
            let info        = null;
            let desc        = null;

            mp4file.onReady = (mp4info) => {
                const track = mp4info.videoTracks[0];
                if (!track) return reject(new Error('Нет видеотрека в файле'));
                info = track;

                // AVCDecoderConfigurationRecord нужен VideoDecoder для H.264
                const trak = mp4file.getTrackById(track.id);
                for (const entry of trak.mdia.minf.stbl.stsd.entries) {
                    if (entry.avcC) {
                        const s = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                        entry.avcC.write(s);
                        desc = new Uint8Array(s.buffer, 8);
                        break;
                    }
                }

                mp4file.setExtractionOptions(track.id, null, { nbSamples: Infinity });
                mp4file.start();
            };

            mp4file.onSamples = (id, user, samples) => {
                collected.push(...samples);
                // ждём все семплы трека
                if (collected.length >= info.nb_samples) {
                    resolve({ samples: collected, trackInfo: info, description: desc });
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
                codec:                trackInfo.codec,
                codedWidth:           trackInfo.video.width,
                codedHeight:          trackInfo.video.height,
                hardwareAcceleration: 'prefer-hardware'
            });
            if (support.supported) hwAccel = 'prefer-hardware';
        } catch { }

        if (onAccel) onAccel(hwAccel === 'prefer-hardware' ? 'GPU' : 'CPU');

        // шаг 2 — декодируем семплы через VideoDecoder
        const framePromises = [];
        let   outputCount   = 0;

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
                        const blob = await canvas.convertToBlob({ type: 'image/png' });
                        return URL.createObjectURL(blob);
                    })();

                    framePromises.push(p);
                },
                error: (e) => reject(new Error('VideoDecoder: ' + e.message))
            });

            decoder.configure({
                codec:                trackInfo.codec,
                codedWidth:           trackInfo.video.width,
                codedHeight:          trackInfo.video.height,
                description,
                hardwareAcceleration: hwAccel
            });

            // скармливаем все семплы
            for (const sample of samples) {
                decoder.decode(new EncodedVideoChunk({
                    type:      sample.is_sync ? 'key' : 'delta',
                    timestamp: sample.cts      * 1_000_000 / sample.timescale,
                    duration:  sample.duration * 1_000_000 / sample.timescale,
                    data:      sample.data
                }));
            }

            decoder.flush().then(() => { decoder.close(); resolve(); }).catch(reject);
        });

        // дожидаемся всех async convertToBlob
        return await Promise.all(framePromises);
    }

    // фоллбэк — video element + seek
    // медленнее но работает везде где нет WebCodecs
    async function extractFramesFallback(videoBlob, count, fps, onFrame) {
        return new Promise((resolve, reject) => {
            const video  = document.createElement('video');
            video.muted  = true;
            video.src    = URL.createObjectURL(videoBlob);

            video.onloadedmetadata = async () => {
                const frames = [];
                const step   = 1 / fps;

                for (let i = 0; i < count; i++) {
                    video.currentTime = Math.min(i * step, video.duration - 0.001);
                    await new Promise(r => { video.onseeked = r; });

                    const canvas  = document.createElement('canvas');
                    canvas.width  = video.videoWidth;
                    canvas.height = video.videoHeight;
                    canvas.getContext('2d').drawImage(video, 0, 0);

                    frames.push(URL.createObjectURL(
                        await new Promise(r => canvas.toBlob(r, 'image/png'))
                    ));

                    if (onFrame) onFrame(i + 1, count);
                }

                URL.revokeObjectURL(video.src);
                resolve(frames);
            };

            video.onerror = () => reject(new Error('Не удалось загрузить видео'));
        });
    }

    // статистика
    function renderStats(s) {
        const section = $('statsSection');
        const body    = $('statsBody');
        section.style.display = '';
        document.querySelector('.pl-bottom').classList.add('has-stats');

        let html = '<div class="statsInner">';
        // три главные карточки
        html += '<div class="statsGrid">';
        html += `<div class="statBox">
            <div class="statLabel">Время декодирования</div>
            <div class="statValue">${fmtTime(s.totalTime)}</div>
        </div>`;
        html += `<div class="statBox">
            <div class="statLabel">Картинки</div>
            <div class="statValue">${s.imageCount}</div>
            <div class="statDetail">${fmt(s.imageTotalSize)}</div>
        </div>`;
        html += `<div class="statBox">
            <div class="statLabel">Видеокадры</div>
            <div class="statValue">${s.videoTotalFrames}</div>
            <div class="statDetail">${s.videoCount} видео</div>
        </div>`;
        html += '</div>';

        // тайминги по фазам
        const total = s.imageDecodeTime + s.videoDecodeTime + s.lottieInitTime || 1;
        html += '<div class="statsTableTitle">Время работы</div>';
        html += '<div class="timingBar">';
        html += `<div class="timingSegment images" style="width:${s.imageDecodeTime / total * 100}%"></div>`;
        html += `<div class="timingSegment video"  style="width:${s.videoDecodeTime / total * 100}%"></div>`;
        html += `<div class="timingSegment zip"    style="width:${s.lottieInitTime  / total * 100}%"></div>`;
        html += '</div>';
        html += '<div class="timingLegend">';
        html += `<span class="tImages">Картинки&nbsp;${fmtTime(s.imageDecodeTime)}</span>`;
        html += `<span class="tVideo">Видео&nbsp;${fmtTime(s.videoDecodeTime)}</span>`;
        html += `<span class="tZip">Lottie init&nbsp;${fmtTime(s.lottieInitTime)}</span>`;
        html += '</div>';

        // детальная таблица
        html += '<table class="statsTable">';
        html += `<tr><td>Итого</td><td>${fmtTime(s.totalTime)}</td></tr>`;
        html += `<tr><td>Извлечение картинок</td><td>${fmtTime(s.imageDecodeTime)}</td></tr>`;
        html += `<tr><td>Декодирование видео</td><td>${fmtTime(s.videoDecodeTime)}</td></tr>`;
        html += `<tr><td>Инициализация Lottie</td><td>${fmtTime(s.lottieInitTime)}</td></tr>`;
        html += `<tr><td>Картинок декодировано</td><td>${s.imageCount} (${fmt(s.imageTotalSize)})</td></tr>`;
        html += `<tr><td>Видеокадров декодировано</td><td>${s.videoTotalFrames}</td></tr>`;
        html += `<tr><td>Видеофайлов</td><td>${s.videoCount} (${fmt(s.videoTotalSize)})</td></tr>`;
        if (s.imageCount > 0 && s.imageDecodeTime > 0) {
            html += `<tr><td>Скорость картинок</td><td>${(s.imageCount / (s.imageDecodeTime / 1000)).toFixed(1)} изобр./с</td></tr>`;
        }
        if (s.videoTotalFrames > 0 && s.videoDecodeTime > 0) {
            html += `<tr><td>Скорость кадров</td><td>${(s.videoTotalFrames / (s.videoDecodeTime / 1000)).toFixed(1)} кадр/с</td></tr>`;
        }
        html += `<tr><td>API декодирования</td><td>${s.webCodecsUsed ? 'WebCodecs + MP4Box' : 'Video Element'}</td></tr>`;
        html += '</table>';

        // детали по каждому видео
        if (s.videoDetails.length > 0) {
            html += '<div class="statsTableTitle" style="margin-top:12px">Видеофайлы</div>';
            for (const vd of s.videoDetails) {
                html += '<div class="videoDetailCard">';
                html += `<div class="videoDetailTitle">${vd.file}</div>`;
                html += '<div class="videoDetailGrid">';
                html += `<span>Разрешение</span><strong>${vd.width}×${vd.height}</strong>`;
                html += `<span>Кадров</span><strong>${vd.frames} @ ${vd.fps} fps</strong>`;
                html += `<span>Размер файла</span><strong>${fmt(vd.fileSize)}</strong>`;
                html += `<span>Время извлечения</span><strong>${fmtTime(vd.extractTime)}</strong>`;
                html += `<span>Среднее на кадр</span><strong>${fmtTime(vd.avgFrameExtract)}</strong>`;
                html += `<span>Ускорение</span><strong>${vd.hardwareAccel}</strong>`;
                html += `<span>Decoder API</span><strong>${vd.decoderApi}</strong>`;
                html += '</div>';
                html += '</div>';
            }
        }

        html += '</div>';
        body.innerHTML = html;
    }
});
