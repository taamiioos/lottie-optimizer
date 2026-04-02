// проверяет, является ли значение бинарным
const _isBinary = (x) => x instanceof Blob || x instanceof ArrayBuffer || ArrayBuffer.isView(x);

// функция извлекает json анимации из .lottie файла
const _parseLottieBlob = async (input) => {
    const raw = input instanceof Blob ? input : new Blob([input]);
    // читаем Blob как ArrayBuffer и передаем в JSZip для распаковки архива
    const zip = await JSZip.loadAsync(await raw.arrayBuffer());
    // пытаемся найти файл manifest.json
    const manifestFile = zip.file('manifest.json');
    // читаем его как строку и парсим JSON
    const manifest = manifestFile ? JSON.parse(await manifestFile.async('string')) : null;
    // из manifest берём id первой анимации
    const animId = manifest?.animations?.[0]?.id || 'animation';
    // ищем JSON анимации внутри папки animations/
    const animFile = zip.file(`animations/${animId}.json`);
    // если JSON не найден — это некорректный .lottie файл
    if (!animFile) throw new Error(`.lottie: не найден animations/${animId}.json`);
    // читаем файл анимации как строку и парсим JSON
    const json = JSON.parse(await animFile.async('string'));
    // получаем список ассетов
    const assets = json.assets || [];
    // проходим по всем ассетам
    for (const asset of assets) {
        // если у ассета есть поле p
        if (asset.p) {
            // формируем путь к файлу внутри архива
            const path = (asset.u || '') + asset.p;
            // пытаемся найти файл по нескольким возможным путям
            const file =
                zip.file(path) ||
                zip.file(`images/${asset.p}`) ||
                zip.file(`assets/${asset.p}`);
            if (file) {
                const blob = await file.async('blob');
                asset.u = '';
                // создаём временный URL для Blob, чтобы Lottie renderer мог загрузить изображение напрямую
                asset.p = URL.createObjectURL(blob);
            }
        }
    }
    return {json, zipBlob: raw};
};

// Функция для извлечения кадров из видео через WebCodecs + MP4Box
const extractFramesWebCodecs = async (videoBlob, frameCount, fps, onFrame, onAccel, {workerSafe = false} = {}) => {
    if (!('VideoDecoder' in self)) {
        throw new Error('WebCodecs API not supported');
    }
    // Читаем видео в виде ArrayBuffer, чтобы MP4Box мог работать с ним
    const arrayBuf = await videoBlob.arrayBuffer();
    // Демультиплексируем MP4 через MP4Box
    const {samples, trackInfo, description} = await new Promise((resolve, reject) => {
        const mp4file = MP4Box.createFile(); // создаем объект MP4Box
        const collected = []; // массив для накопления всех семплов
        let info = null; // сюда запишем информацию о видеотреке
        let desc = null; // сюда запишем описание кодека

        // Событие вызывается, когда MP4Box прочитал структуру файла
        mp4file.onReady = (mp4info) => {
            const track = mp4info.videoTracks[0]; // берём первый видеотрек
            if (!track) return reject(new Error('No video track in file'));
            info = track;   // сохраняем информацию о треке
            const trak = mp4file.getTrackById(track.id); // получаем доступ к полной структуре трека

            // Ищем H.264 codec description
            for (const entry of trak.mdia.minf.stbl.stsd.entries) {
                if (entry.avcC) {
                    const s = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                    entry.avcC.write(s);
                    desc = new Uint8Array(s.buffer, 8); //  получаем описание кодека
                    break;
                }
            }
            // Настраиваем MP4Box на извлечение всех семплов
            mp4file.setExtractionOptions(track.id, null, {nbSamples: Infinity});
            mp4file.start();
        };
        // Событие, когда MP4Box получил новые семплы
        mp4file.onSamples = (id, user, samples) => {
            collected.push(...samples); // добавляем их в общий массив
            // если собрали все семплы, резолвим промис
            if (collected.length >= info.nb_samples) {
                resolve({samples: collected, trackInfo: info, description: desc});
            }
        };
        mp4file.onError = (e) => reject(new Error('MP4Box: ' + e));
        // Передаём видео в MP4Box для обработки
        const buf = arrayBuf;
        buf.fileStart = 0;
        mp4file.appendBuffer(buf);
        mp4file.flush();
    });

    // Проверяем, есть ли поддержка аппаратного ускорения
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

    // Настройка пула воркеров
    // Каждый воркер держит свой OffscreenCanvas и делает convertToBlob параллельно
    const workerUrl = new URL('./converter-worker.js', import.meta.url).href;
    const poolSize = Math.min(typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4, 8);
    const poolWorkers = [];
    const free = []; // свободные воркеры
    const queue = []; // очередь кадров для обработки
    const tasks = new Map(); // сопоставление id задачи c промисом
    let tid = 0; // уникальный id задачи

    // Функция, которая раздаёт задачи воркерам
    const flushPool = () => {
        while (free.length && queue.length) {
            const w = free.pop(); // берём свободного воркера
            const {id, frame} = queue.shift(); // берём кадр из очереди
            w.postMessage({id, frame, mime: 'image/jpeg', q: 0.8}, [frame]); // отправляем кадр в воркер
        }
    };

    // Создаём воркеры и настраиваем их обработку сообщений
    for (let i = 0; i < poolSize; i++) {
        const w = new Worker(workerUrl);
        w.onmessage = ({data}) => {
            free.push(w); // воркер освободился
            const t = tasks.get(data.id); // находим задачу
            tasks.delete(data.id);
            if (data.err) t.reject(new Error(data.err));
            else t.resolve(new Blob([data.ab], {type: data.mime}));
            flushPool(); // запускаем следующую задачу
        };
        poolWorkers.push(w);
        free.push(w);
    }

    // Обёртка для отправки кадра в воркер и получения результата
    const encodeFrame = (frame) => new Promise((resolve, reject) => {
        const id = ++tid; // новый уникальный id
        tasks.set(id, {resolve, reject}); // сохраняем промис
        queue.push({id, frame}); // кладём кадр в очередь
        flushPool(); // пробуем запустить обработку
    });

    const framePromises = []; // здесь промисы каждого кадра
    let outputCount = 0; // счётчик обработанных кадров

    // === WebCodecs VideoDecoder ===
    await new Promise((resolve, reject) => {
        const decoder = new VideoDecoder({
            output: (frame) => { // вызывается для каждого декодированного кадра
                if (onFrame) onFrame(++outputCount, frameCount); // вызываем коллбек прогресса
                framePromises.push(
                    encodeFrame(frame).then(blob => workerSafe ? blob : URL.createObjectURL(blob)) // отправляем кадр в воркер
                );
            },
            error: (e) => reject(new Error('VideoDecoder: ' + e.message))
        });

        // Конфигурируем декодер
        decoder.configure({
            codec: trackInfo.codec,
            codedWidth: trackInfo.video.width,
            codedHeight: trackInfo.video.height,
            description, // avcC
            hardwareAcceleration: hwAccel
        });

        // Декодируем все семплы из MP4
        for (const sample of samples) {
            decoder.decode(new EncodedVideoChunk({
                type: sample.is_sync ? 'key' : 'delta', // ключевой или дельта кадр
                timestamp: sample.cts * 1_000_000 / sample.timescale, // время в микросекундах
                duration: sample.duration * 1_000_000 / sample.timescale, // длительность
                data: sample.data // бинарные данные кадра
            }));
        }
        // Ждём, пока все кадры декодируются
        decoder.flush().then(() => {
            decoder.close();
            resolve();
        }).catch(reject);
    });

    // Ждём, пока все воркеры конвертируют кадры в Blob
    const result = await Promise.all(framePromises);

    // Завершаем работу всех воркеров
    poolWorkers.forEach(w => w.terminate());

    // Возвращаем массив Blob с кадрами
    return result;
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
                await new Promise(r => {
                    video.onseeked = r;
                });

                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                canvas.getContext('2d').drawImage(video, 0, 0);
                frames.push(URL.createObjectURL(await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.8))));
                if (onFrame) onFrame(i + 1, count);
            }

            URL.revokeObjectURL(video.src);
            resolve(frames);
        };

        video.onerror = () => reject(new Error('Failed to load video'));
    });
};

// Функция восстановления анимации
const restoreAnimation = async (input, second, third) => {
    let json, zipBlob, options;
    if (_isBinary(input)) {
        const parsed = await _parseLottieBlob(input);
        json = parsed.json;
        zipBlob = parsed.zipBlob;
        options = (second && !_isBinary(second) && typeof second === 'object') ? second : (third || {});
    } else {
        json = input;
        zipBlob = _isBinary(second) ? second : null;
        options = (!_isBinary(second) && second && typeof second === 'object') ? second : (third || {});
    }
    const {
        onProgress = () => {
        }, workerSafe = false
    } = options;

    // Копируем JSON, чтобы не менять оригинал
    const data = structuredClone(json);
    const assets = data.assets || [];
    const videoAssets = data.videoAssets || [];

    // Статистика для отчета о времени и размере обработанных файлов
    const stats = {
        imageCount: 0, imageTotalSize: 0, imageDecodeTime: 0,
        videoCount: 0, videoTotalFrames: 0, videoTotalSize: 0,
        videoDetails: [], videoDecodeTime: 0
    };

    // Отбираем внешние картинки
    const externalImages = assets.filter(a => a.u && a.p && !a._video);
    // Отбираем видеоассеты
    const externalVideos = videoAssets.filter(va => va.file);

    // Если JSON уже самодостаточный (нет внешних ассетов) – просто возвращаем
    if (externalImages.length === 0 && externalVideos.length === 0) {
        onProgress({phase: 'done', percent: 100});
        return {data, stats};
    }
    if (!zipBlob) throw new Error('Animation requires a ZIP archive with assets');

    // Загружаем ZIP через JSZip
    const zip = await JSZip.loadAsync(await zipBlob.arrayBuffer());

    // Обработка картинок
    const imgT0 = performance.now(); // замеряем время начала
    let imgDone = 0;                  // счётчик обработанных картинок

    await Promise.all(externalImages.map(async (asset) => {
        const zipFile = zip.file(asset.u + asset.p); // ищем файл в ZIP
        if (!zipFile) return;

        const blob = await zipFile.async('blob');    // читаем как Blob
        stats.imageTotalSize += blob.size;           // учитываем размер
        asset.u = '';                                // убираем путь, теперь локальный
        asset.p = workerSafe ? blob : URL.createObjectURL(blob); // создаём URL для main thread

        // Коллбек прогресса
        const done = ++imgDone;
        onProgress({
            phase: 'images',
            current: done,
            total: externalImages.length,
            percent: Math.round(done / Math.max(externalImages.length, 1) * 30)
        });
    }));

    stats.imageCount = imgDone;                       // сколько картинок обработано
    stats.imageDecodeTime = performance.now() - imgT0; // время обработки

    // Обработка видео
    const vidT0 = performance.now(); // время начала видео
    for (let vi = 0; vi < externalVideos.length; vi++) {
        const va = externalVideos[vi];
        const zipFile = zip.file(va.file); // ищем видеофайл в ZIP
        if (!zipFile) continue;

        onProgress({
            phase: 'video',
            message: `Видео ${vi + 1}/${externalVideos.length}: ${va.file}...`,
            percent: 35 + Math.round(vi / Math.max(externalVideos.length, 1) * 50)
        });

        const videoBlob = await zipFile.async('blob'); // читаем видео как Blob
        const vdStat = {                          // статистика по каждому видео
            file: va.file, frames: va.frames, fps: va.fps,
            width: va.width, height: va.height,
            fileSize: videoBlob.size, extractTime: 0, avgFrameExtract: 0,
            hardwareAccel: 'неизвестно', decoderApi: 'video element'
        };
        stats.videoTotalSize += videoBlob.size;

        // Извлечение кадров
        const frameT0 = performance.now();
        let frames;
        try {
            // Пробуем WebCodecs
            frames = await extractFramesWebCodecs(videoBlob, va.frames, va.fps, (cur, total) => {
                onProgress({
                    phase: 'video',
                    message: `Кадр ${cur}/${total}`,
                    percent: 35 + Math.round((vi + cur / Math.max(total, 1)) / Math.max(externalVideos.length, 1) * 50)
                });
            }, (accel) => {
                vdStat.hardwareAccel = accel;
            }, {workerSafe});
            vdStat.decoderApi = 'WebCodecs';
        } catch (e) {
            // Если WebCodecs не доступен - fallback
            if (workerSafe) throw new Error(`WebCodecs failed, fallback unavailable in worker: ${e.message}`);
            frames = await extractFramesFallback(videoBlob, va.frames, va.fps, (cur, total) => {
                onProgress({
                    phase: 'video',
                    message: `Кадр ${cur}/${total}`,
                    percent: 35 + Math.round((vi + cur / Math.max(total, 1)) / Math.max(externalVideos.length, 1) * 50)
                });
            });
        }
        // Считаем время извлечения
        vdStat.extractTime = performance.now() - frameT0;
        vdStat.avgFrameExtract = va.frames > 0 ? vdStat.extractTime / va.frames : 0;
        // Привязываем извлеченные кадры к ассетам JSON
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
    onProgress({phase: 'done', percent: 100});

    // Возвращаем JSON с обновленными ассетами и статистику
    return {data, stats};
};

// Основной объект Player для работы с Lottie-анимацией
const Player = {
    // Восстановление анимации (с извлечением изображений и видео)
    restore: restoreAnimation,
    // Проверка соответствия JSON и ZIP
    _workerUrl: 'https://cdn.jsdelivr.net/gh/taamiioos/lottie-optimizer@main/src/worker.js',
    // Метод восстановления анимации в воркере
    async restoreInWorker(input, second, third) {
        // нормализуем аргументы
        let json, zipBlob, options;
        if (_isBinary(input)) {
            const parsed = await _parseLottieBlob(input);
            json = parsed.json;
            zipBlob = parsed.zipBlob;
            options = (second && !_isBinary(second) && typeof second === 'object') ? second : (third || {});
        } else {
            json = input;
            zipBlob = _isBinary(second) ? second : null;
            options = (!_isBinary(second) && second && typeof second === 'object') ? second : (third || {});
        }
        const {
            onProgress = () => {
            }
        } = options;

        // Если воркеры не поддерживаются — fallback на главный поток
        if (typeof Worker === 'undefined') {
            return restoreAnimation(json, zipBlob, {onProgress});
        }
        // Если ZIP отсутствует — тоже fallback на главный поток
        if (!zipBlob) {
            return restoreAnimation(json, null, {onProgress});
        }
        // Создаём Promise, чтобы работать асинхронно с воркером
        return new Promise(async (resolve, reject) => {
            let worker;
            try {
                worker = new Worker(Player._workerUrl, {type: 'module'});
            } catch {
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
                restoreAnimation(json, zipBlob, {onProgress}).then(resolve).catch(reject);
            };
            // Передаём ZIP в воркер как transferable объект, чтобы не копировать память
            const zipBuffer = await zipBlob.arrayBuffer();
            worker.postMessage({id, type: 'restore', json, zipBuffer}, [zipBuffer]);
        });
    }
};

export {Player, extractFramesWebCodecs, extractFramesFallback, restoreAnimation};

