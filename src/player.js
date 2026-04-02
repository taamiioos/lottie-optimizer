// Функция для извлечения кадров из видео через WebCodecs + MP4Box
const extractFramesWebCodecs = async (videoBlob, frameCount, fps, onFrame, onAccel, {workerSafe = false} = {}) => {

    // Проверяем, поддерживается ли WebCodecs в браузере
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
            info = track; // сохраняем информацию о треке
            const trak = mp4file.getTrackById(track.id); // получаем доступ к полной структуре трека

            // Ищем H.264 codec description
            for (const entry of trak.mdia.minf.stbl.stsd.entries) {
                if (entry.avcC) {
                    const s = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                    entry.avcC.write(s); // записываем данные в поток
                    desc = new Uint8Array(s.buffer, 8); // отрезаем первые 8 байт – получаем описание кодека
                    break;
                }
            }
            // Настраиваем MP4Box на извлечение всех семплов
            mp4file.setExtractionOptions(track.id, null, {nbSamples: Infinity});
            mp4file.start(); // начинаем извлечение
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
        buf.fileStart = 0; // обязательно указываем стартовый оффсет
        mp4file.appendBuffer(buf); // добавляем буфер
        mp4file.flush(); // сообщаем MP4Box, что данные закончились
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
    } catch {}
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
        decoder.flush().then(() => { decoder.close(); resolve(); }).catch(reject);
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
                await new Promise(r => { video.onseeked = r; });

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

// Функция восстановления анимации из JSON + ZIP с ассетами
const restoreAnimation = async (json, zipBlob, {onProgress = () => {}, workerSafe = false} = {}) => {
    // Копируем JSON, чтобы не менять оригинал
    const data = JSON.parse(JSON.stringify(json));
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
        if (!zipFile) return;                        // если нет – пропускаем

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
            }, (accel) => { vdStat.hardwareAccel = accel; }, {workerSafe});
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
            if (asset && frames[i]) { asset.u = ''; asset.p = frames[i]; }
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

// Проверяет, совпадают ли данные JSON анимации и ZIP с ассетами
const validateFilesMatch = async (json, zipBlob) => {
    // Если json не передан или это не объект
    if (!json || typeof json !== 'object')
        return {requiresZip: false, errors: ['Not a valid JSON file'], warnings: []};

    // Проверяем минимальные свойства Lottie-анимации: версия, fps, ширина, высота
    if (!json.v || !json.fr || !json.w || !json.h)
        return {requiresZip: false, errors: ['Not a valid Lottie animation'], warnings: []};

    // Собираем ассеты из JSON
    const assets = json.assets || [];
    const videoAssets = json.videoAssets || [];

    // Находим внешние картинки
    const externalImages = assets.filter(a => a.u && a.p && !a._video);
    // Находим видеоассеты
    const externalVideos = videoAssets.filter(va => va.file);
    // Нужно ли для анимации ZIP? Да, если есть внешние картинки или видео
    const requiresZip = externalImages.length > 0 || externalVideos.length > 0;
    if (!requiresZip)
        return {requiresZip: false, errors: [], warnings: []}; // ZIP не требуется
    // ZIP обязателен, но его нет — ошибка
    if (!zipBlob) {
        const desc = [
            externalImages.length > 0 && `${externalImages.length} images`,
            externalVideos.length > 0 && `${externalVideos.length} videos`
        ].filter(Boolean).join(', ');
        return {requiresZip: true, errors: [`ZIP archive required (${desc})`], warnings: []};
    }
    // Пробуем открыть ZIP
    let zip;
    try {
        zip = await JSZip.loadAsync(await zipBlob.arrayBuffer());
    }
    catch {
        return {requiresZip: true, errors: ['Failed to read ZIP archive'], warnings: []};
    }
    // Получаем все файлы в ZIP
    const zipFiles = new Set(Object.keys(zip.files));
    const errors = [];
    const warnings = [];
    // Проверяем, какие картинки отсутствуют в ZIP
    const missingImgs = externalImages.filter(a => !zipFiles.has(a.u + a.p));
    if (missingImgs.length > 0) {
        // Показываем первые 3 файла и указываем сколько ещё пропущено
        const sample = missingImgs.slice(0, 3).map(a => a.u + a.p).join(', ');
        const extra  = missingImgs.length > 3 ? ` и ещё ${missingImgs.length - 3}` : '';
        errors.push(`Files missing from ZIP: ${sample}${extra}`);
    }
    // Проверяем, какие видео отсутствуют в ZIP
    const missingVids = externalVideos.filter(va => !zipFiles.has(va.file));
    if (missingVids.length > 0) {
        errors.push(`Videos missing from ZIP: ${missingVids.map(va => va.file).join(', ')}`);
    }
    // Предупреждение: в ZIP есть файлы, которых нет в JSON
    if (errors.length > 0) {
        const expectedPaths = new Set([
            ...externalImages.map(a => a.u + a.p),
            ...externalVideos.map(va => va.file)
        ]);
        const extraCount = Object.values(zip.files)
            .filter(f => !f.dir && !expectedPaths.has(f.name))
            .length;
        if (extraCount > 0)
            warnings.push(`ZIP contains ${extraCount} unexpected files — possibly wrong archive`);
    }
    return {requiresZip: true, errors, warnings};
};

// Основной объект Player для работы с Lottie-анимацией
const Player = {
    // Восстановление анимации (с извлечением изображений и видео)
    restore: restoreAnimation,
    // Проверка соответствия JSON и ZIP
    validate: validateFilesMatch,
    // URL скрипта воркера для фоновой обработки анимации
    _workerUrl: 'https://cdn.jsdelivr.net/gh/taamiioos/lottie-optimizer@main/src/worker.js',
    // Метод восстановления анимации в воркере
    async restoreInWorker(json, zipBlob, {onProgress = () => {}} = {}) {
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
                // Создаём новый воркер по URL, используем модульный формат
                worker = new Worker(Player._workerUrl, {type: 'module'});
            } catch {
                // Не удалось создать воркер — fallback на главный поток
                resolve(restoreAnimation(json, zipBlob, {onProgress}));
                return;
            }
            // Генерируем уникальный ID для текущей задачи воркера
            const id = Math.random().toString(36).slice(2);
            // Слушаем сообщения от воркера
            worker.onmessage = ({data: msg}) => {
                if (msg.id !== id) return;
                // Сообщения прогресса
                if (msg.type === 'progress') {
                    onProgress(msg.info);
                    // Сообщение с результатом восстановления
                } else if (msg.type === 'restore-result') {
                    worker.terminate(); // завершение воркера
                    const result = msg.result;
                    for (const asset of (result.data?.assets || [])) {
                        if (asset.p instanceof Blob) {
                            asset.p = URL.createObjectURL(asset.p);
                        }
                    }
                    // Возвращаем результат
                    resolve(result);
                } else if (msg.type === 'error') {
                    worker.terminate();
                    reject(new Error(msg.message));
                }
            };
            // Обработчик ошибок воркера
            worker.onerror = (e) => {
                worker.terminate();
                // fallback на главный поток если воркер не загрузился или упал
                restoreAnimation(json, zipBlob, {onProgress}).then(resolve).catch(reject);
            };
            // Передаём ZIP в воркер как transferable объект, чтобы не копировать память
            const zipBuffer = await zipBlob.arrayBuffer();
            worker.postMessage({id, type: 'restore', json, zipBuffer}, [zipBuffer]);
        });
    }
};

export {Player, extractFramesWebCodecs, extractFramesFallback, restoreAnimation, validateFilesMatch};

