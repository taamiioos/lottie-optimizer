import {ImageProcessor} from './image.js';
import {VideoEncoderUtil} from './video.js';

const Optimizer = {
    // последовательности кадров по id
    findSequences(assets) {
        // только картинки с data:image и id
        const imageAssets = assets.filter(a => a.p?.startsWith('data:image') && a.id);
        const groups = new Map();
        for (const asset of imageAssets) {
            const id = asset.id;
            let prefix = '', num = -1;
            // числовой id
            if (/^\d+$/.test(id)) {
                prefix = '_seq_numeric';
                num = parseInt(id);
            }
            // frame_0000_хеш или image-001-uuid
            if (num === -1) {
                const m = id.match(/^(.+?)[-_](\d{2,})[-_][a-f0-9-]+$/i);
                if (m) {
                    prefix = m[1];
                    num = parseInt(m[2]);
                }
            }
            // image_0, frame_1, img-12
            if (num === -1) {
                const m = id.match(/^(.+?)[-_](\d+)$/);
                if (m) {
                    prefix = m[1];
                    num = parseInt(m[2]);
                }
            }
            // img0
            if (num === -1) {
                const m = id.match(/^([a-zA-Z]+)(\d+)$/);
                if (m) {
                    prefix = m[1];
                    num = parseInt(m[2]);
                }
            }
            if (num === -1) continue; // не подошло под последовательность
            if (!groups.has(prefix)) groups.set(prefix, []);
            groups.get(prefix).push({id, num});
        }
        const sequences = [];
        for (const [prefix, items] of groups) {
            if (items.length < 3) continue; // меньше 3 кадров — не считаем последовательностью
            items.sort((a, b) => a.num - b.num);
            const outPrefix = prefix === '_seq_numeric' ? 'sequence' : prefix;
            sequences.push({
                prefix: outPrefix,
                from: items[0].num,
                to: items[items.length - 1].num,
                count: items.length,
                ids: items.map(x => x.id)
            });
        }

        return sequences;
    },
    // URL воркера на CDN — пользователю ничего не нужно копировать
    _workerUrl: 'https://cdn.jsdelivr.net/gh/taamiioos/lottie-optimizer@main/src/worker.js',

    // запуск оптимизации в отдельном воркере — не блокирует основной поток
    _runInWorker(data, options) {
        // поддерживает ли браузер вообще Web Workers
        if (typeof Worker === 'undefined') {
            // Если нет
            // просто запускаем ту же функцию Optimizer.run синхронно в текущем потоке
            const {worker: _w, ...opts} = options;   // убираем опцию worker
            return Optimizer.run(data, opts);
        }
        return new Promise((resolve, reject) => {
            let worker;

            // пытаемся создать Worker
            try {
                // ссылка
                worker = new Worker(Optimizer._workerUrl, { type: 'module' });
            } catch (err) {
                // Если создание Worker провалилось, то fallback в главный поток
                const {worker: _w, ...opts} = options;
                resolve(Optimizer.run(data, opts));   // запускаем синхронно
                return;
            }

            // генерируем уникальный id для сообщений
            const id = Math.random().toString(36).slice(2);

            // достаём колбэк onProgress
            const { onProgress = () => {} } = options;

            // готовим чистые options без worker и onProgress
            const { onProgress: _p, worker: _w, ...opts } = options;

            // слушаем сообщения ОТ worker в главный поток
            worker.onmessage = ({ data: msg }) => {
                // Проверяем, что сообщение именно для нашего запроса
                if (msg.id !== id) return;

                switch (msg.type) {
                    case 'progress':
                        onProgress(msg.info);
                        break;
                    case 'result':
                        worker.terminate();  // закрываем worker, больше не нужен

                        // восстанавливаем Blob из ArrayBuffer (zipBuffer пришёл transferable)
                        const zip = new Blob([msg.result.zipBuffer], { type: 'application/zip' });

                        // Формируем финальный объект результата
                        const finalResult = { ...msg.result, zip, zipBuffer: undefined };
                        if (finalResult.preview?.assets && data.assets?.length) {
                            const origById = new Map(data.assets.map(a => [a.id, a]));
                            for (const pa of finalResult.preview.assets) {
                                if (pa._video && pa.id && !pa.p) {           // это видео-кадр без base64
                                    const orig = origById.get(pa.id);
                                    if (orig?.p) pa.p = orig.p;
                                }
                            }
                        }
                        resolve(finalResult);
                        break;

                    case 'error':
                        worker.terminate();
                        reject(new Error(msg.message));
                        break;
                }
            };

            // ловим критические ошибки создания/выполнения worker'а
            worker.onerror = (e) => {
                worker.terminate();
                reject(new Error('Worker: ' + e.message));
            };

            // отправляем задачу В worker
            worker.postMessage({
                id,
                type: 'optimize',
                data,           // исходные данные Lottie (json с assets)
                options: opts   // очищенные опции (без worker и onProgress)
            });
        });
    },
    // главная функция оптимизации
    async run(data, options = {}) {
        const {
            quality = 0.8,
            convertToVideo = true,
            videoFps = data.fr || 24,
            videoBitrateMultiplier = 1,
            onProgress = () => {},
            worker = false
        } = options;

        // если попросили воркер — делегируем всю работу туда
        if (worker) return this._runInWorker(data, options);
        const totalT0 = performance.now();
        // глубокие копии, чтобы не портить оригинальные данные
        // не гоняет данные через строку и обратно
        // result — будет в ZIP (без blob url), preview — для показа в браузере (с blob url)
        const result = structuredClone(data);
        const preview = { ...data, assets: JSON.parse(JSON.stringify(data.assets || [])) };
        const assets = result.assets || [];
        const previewAssets = preview.assets || [];
        const zip = new JSZip();
        const hashMap = new Map(); // для поиска дубликатов по sha-256
        const blobUrls = [];

        // вся статистика сюда
        const stats = {
            totalImages: 0,
            uniqueImages: 0,
            duplicates: 0,
            sizeBefore: 0,
            sizeAfter: 0,
            formats: {},
            sequences: 0,
            framesInVideo: 0,
            videoSize: 0,
            totalTime: 0,
            analysisTime: 0,
            videoEncodingTime: 0,
            imageProcessingTime: 0,
            zipTime: 0,
            avgImageSize: 0,
            largestImage: 0,
            smallestImage: Infinity,
            compressionRatio: 0,
            webpConversions: 0,
            keptOriginal: 0,
            webpSavings: 0,
            singleImagesSizeBefore: 0,
            videoDetails: [],
            imageDetails: [],
            originalJsonSize: 0,
            optimizedJsonSize: 0,
            zipFileSize: 0,
            totalSaved: 0,
            totalSavedPct: 0,
            phaseTiming: {},
            videoSkipped: 0
        };
        const sequences = this.findSequences(assets);
        const videoAssets = [];
        const videoFrameIds = new Set();
        const videoFrameSeqIndex = new Map();
        const candidateVideoIds = new Set(sequences.flatMap(s => s.ids));
        const analysisT0 = performance.now();
        onProgress({ phase: 'analysis', message: 'Загрузка ассетов...', percent: 2 });
        const blobCache = new Map();
        for (const a of assets.filter(a => a.p?.startsWith('data:image') && a.id)) {
            if (candidateVideoIds.has(a.id)) continue;
            const blob = ImageProcessor.decodeBase64(a.p);
            if (blob) blobCache.set(a.id, blob);
        }

        // анализ
        await Promise.all(assets.map(async asset => {
            if (!asset.p?.startsWith('data:image')) return;
            stats.totalImages++;
            if (candidateVideoIds.has(asset.id)) {
                const comma = asset.p.indexOf(',');
                const b64len = comma >= 0 ? asset.p.length - comma - 1 : 0;
                const sz = Math.floor(b64len * 0.75);
                stats.sizeBefore += sz;
                if (sz > stats.largestImage) stats.largestImage = sz;
                if (sz < stats.smallestImage) stats.smallestImage = sz;
                const mime = comma > 0 ? asset.p.slice(5, comma).split(';')[0] : '';
                const fmt = {'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif'}[mime] || 'png';
                stats.formats[fmt] = (stats.formats[fmt] || 0) + 1;
                return;
            }
            const blob = blobCache.get(asset.id);
            if (!blob) return;
            const sz = blob.size;
            stats.sizeBefore += sz;
            if (sz > stats.largestImage) stats.largestImage = sz;
            if (sz < stats.smallestImage) stats.smallestImage = sz;
            const header = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
            const fmt = ImageProcessor.detectFormat(header);
            stats.formats[fmt] = (stats.formats[fmt] || 0) + 1;
        }));
        if (stats.totalImages > 0) {
            stats.avgImageSize = Math.round(stats.sizeBefore / stats.totalImages);
        }
        if (stats.smallestImage === Infinity) stats.smallestImage = 0;
        stats.analysisTime = performance.now() - analysisT0;
        stats.phaseTiming.analysis = stats.analysisTime;

        onProgress({
            phase: 'analysis',
            message: `Анализ: ${stats.totalImages} изображений, ${formatSize(stats.sizeBefore)}`,
            percent: 5
        });

        if (sequences.length > 0) {
            onProgress({
                phase: 'sequences',
                message: `Найдено ${sequences.length} последовательность(ей)`,
                percent: 10
            });
        }

        // кодируем найденные последовательности в mp4
        const videoT0 = performance.now();
        let videoCounter = 0;
        const assetById = new Map(assets.map(a => [a.id, a]));
        if (convertToVideo && sequences.length > 0) {
            for (let si = 0; si < sequences.length; si++) {
                const seq = sequences[si];
                onProgress({
                    phase: 'video',
                    message: `Видео ${si + 1}/${sequences.length}: ${seq.count} кадров`,
                    percent: 10 + Math.round(si / sequences.length * 40)
                });
                const frames = [];
                let originalSize = 0;

                for (const id of seq.ids) {
                    const asset = assetById.get(id);
                    if (!asset?.p?.startsWith('data:image')) continue;
                    const comma = asset.p.indexOf(',');
                    const b64len = comma >= 0 ? asset.p.length - comma - 1 : 0;
                    originalSize += Math.floor(b64len * 0.75);
                    frames.push(asset.p);
                }
                if (frames.length < 3) continue;

                try {
                    const videoResult = await VideoEncoderUtil.encode(frames, {
                        fps: videoFps,
                        bitrateMultiplier: videoBitrateMultiplier,
                        onProgress: (pct) => {
                            onProgress({
                                phase: 'video',
                                message: `Видео ${si + 1}/${sequences.length}: ${pct}%`,
                                percent: 10 + Math.round((si + pct / 100) / sequences.length * 40)
                            });
                        }
                    });

                    // если видео получилось больше оригиналов — не берём его
                    if (videoResult.blob.size >= originalSize) {
                        stats.videoSkipped++;
                        onProgress({
                            phase: 'video',
                            message: `Видео ${si + 1}: больше оригиналов, пропускаем`,
                            percent: 10 + Math.round((si + 1) / sequences.length * 40)
                        });
                        continue;
                    }

                    const videoFile = `video/seq_${videoCounter}.mp4`;
                    zip.file(videoFile, videoResult.blob, { compression: 'STORE' });

                    const videoDetail = {
                        id: `video_${videoCounter}`,
                        file: videoFile,
                        width: videoResult.width,
                        height: videoResult.height,
                        frames: videoResult.frames,
                        fps: videoResult.fps,
                        codec: videoResult.codec,
                        frameIds: seq.ids,
                        duration: videoResult.duration,
                        fileSize: videoResult.blob.size,
                        originalSize,
                        compressionRatio: originalSize > 0
                            ? (videoResult.blob.size / originalSize * 100).toFixed(1) : 0,
                        encodingStats: videoResult.encodingStats
                    };

                    videoAssets.push(videoDetail);
                    stats.videoDetails.push(videoDetail);
                    stats.sequences++;
                    stats.framesInVideo += frames.length;
                    stats.videoSize += videoResult.blob.size;

                    seq.ids.forEach(id => {
                        videoFrameIds.add(id);
                        videoFrameSeqIndex.set(id, videoCounter);
                    });
                    videoCounter++;
                } catch (err) {
                    onProgress({
                        phase: 'video',
                        message: `Видео ${si + 1}: ошибка — ${err.message}`,
                        percent: 10 + Math.round((si + 1) / sequences.length * 40),
                        error: true
                    });
                    console.error(`Ошибка кодирования видео ${si}:`, err);
                }
            }
        }
        stats.videoEncodingTime = performance.now() - videoT0;
        stats.phaseTiming.videoEncoding = stats.videoEncodingTime;

        // картинки, которые не ушли в видео — конвертируем в webp и кладём в zip
        const imgT0 = performance.now();

        // собираем кандидатов на обработку, видеокадры закрываем сразу
        const candidates = [];
        for (let i = 0; i < assets.length; i++) {
            const asset = assets[i];
            if (!asset.p?.startsWith('data:image')) continue;
            if (videoFrameIds.has(asset.id)) {
                asset.p = '';
                asset.u = '';
                asset._video = `video_${videoFrameSeqIndex.get(asset.id)}`;
                previewAssets[i]._video = `video_${videoFrameSeqIndex.get(asset.id)}`;
                continue;
            }
            candidates.push({asset, previewAsset: previewAssets[i]});
        }

        const totalImagesForProcessing = candidates.length;
        let processedCount = 0;
        const processingMap = new Map();

        const processOne = async ({asset, previewAsset}) => {
            const n = ++processedCount;
            onProgress({
                phase: 'images',
                message: `Изображение ${n}/${totalImagesForProcessing}`,
                percent: 50 + Math.round(n / Math.max(totalImagesForProcessing, 1) * 35)
            });
            const blob = blobCache.get(asset.id);
            if (!blob) return;
            const origSize = blob.size;
            stats.singleImagesSizeBefore += origSize;
            const bytes = new Uint8Array(await blob.arrayBuffer());

            const hash = await ImageProcessor.hash(bytes);
            if (hashMap.has(hash)) {
                const ref = hashMap.get(hash);
                asset.u = 'assets/';
                asset.p = ref.file;
                asset.e = 0;
                previewAsset.u = '';
                previewAsset.p = ref.url;
                previewAsset.e = 0;
                stats.duplicates++;
                return;
            }
            // та же картинка уже обрабатывается другим параллельным воркером — ждём его результата
            if (processingMap.has(hash)) {
                const ref = await processingMap.get(hash);
                asset.u = 'assets/';
                asset.p = ref.file;
                asset.e = 0;
                previewAsset.u = '';
                previewAsset.p = ref.url;
                previewAsset.e = 0;
                stats.duplicates++;
                return;
            }

            // уникальное изображение — стартуем конвертацию и сразу регистрируем промис
            const promise = (async () => {
                const processed = await ImageProcessor.process(blob, quality, bytes);
                const outBlob = processed.blob;
                const outFormat = processed.format;
                const ext = ImageProcessor.extFromFormat(outFormat);
                const newSize = outBlob.size;

                stats.sizeAfter += newSize;
                stats.uniqueImages++;
                if (outFormat === 'webp') {
                    stats.webpConversions++;
                    stats.webpSavings += origSize - newSize;
                } else {
                    stats.keptOriginal++;
                }
                stats.imageDetails.push({
                    id: asset.id,
                    originalSize: origSize,
                    optimizedSize: newSize,
                    format: outFormat,
                    savings: origSize - newSize,
                    ratio: origSize > 0 ? ((1 - newSize / origSize) * 100).toFixed(1) : 0
                });

                const fileName = `img_${hash.slice(0, 8)}.${ext}`;
                zip.file(`assets/${fileName}`, outBlob, { compression: 'STORE' });
                const url = URL.createObjectURL(outBlob);
                blobUrls.push(url);
                hashMap.set(hash, {file: fileName, url});
                return {file: fileName, url};
            })();

            processingMap.set(hash, promise);
            const ref = await promise;
            asset.u = 'assets/';
            asset.p = ref.file;
            asset.e = 0;
            previewAsset.u = '';
            previewAsset.p = ref.url;
            previewAsset.e = 0;
        }
        // 8 параллельных обработчиков — баланс между скоростью и памятью
        const CONCURRENCY = 8;
        const queue = [...candidates];

        // каждый воркер берёт задачи из общей очереди пока она не пуста
        const imgWorker = async () => {
            while (queue.length > 0) await processOne(queue.shift())
        };

        await Promise.all(
            Array.from({length: Math.min(CONCURRENCY, candidates.length)}, imgWorker)
        );

        stats.imageProcessingTime = performance.now() - imgT0;
        stats.phaseTiming.imageProcessing = stats.imageProcessingTime;

        onProgress({
            phase: 'images',
            message: `Уникальных: ${stats.uniqueImages}, дубликатов: ${stats.duplicates}, WebP: ${stats.webpConversions}, оригинал: ${stats.keptOriginal}`,
            percent: 88
        });

        // считаем итоги и собираем результат
        if (videoAssets.length > 0) {
            result.videoAssets = videoAssets;
        }

        onProgress({phase: 'zip', message: 'Создание ZIP...', percent: 90});

        const zipT0 = performance.now();
        const zipBlob = await zip.generateAsync({
            type: 'blob',
            compression: 'DEFLATE'
        }, (meta) => {
            onProgress({
                phase: 'zip',
                message: `ZIP: ${meta.percent.toFixed(0)}%`,
                percent: 90 + Math.round(meta.percent / 100 * 10)
            });
        });

        stats.zipTime = performance.now() - zipT0;
        stats.phaseTiming.zip = stats.zipTime;
        let _origB64Len = 0;
        for (const a of data.assets || []) if (a.p?.startsWith('data:')) _origB64Len += a.p.length;
        stats.originalJsonSize = _origB64Len + 50000; // +50KB JSON-структура без изображений
        stats.optimizedJsonSize = new Blob([JSON.stringify(result)]).size; // result без base64 — быстро
        stats.zipFileSize = zipBlob.size;

        stats.totalSaved = stats.originalJsonSize - (stats.optimizedJsonSize + stats.zipFileSize);
        stats.totalSavedPct = stats.originalJsonSize > 0
            ? ((stats.totalSaved / stats.originalJsonSize) * 100).toFixed(1)
            : 0;

        stats.compressionRatio = stats.sizeBefore > 0
            ? ((stats.sizeAfter + stats.videoSize) / stats.sizeBefore * 100).toFixed(1)
            : 0;

        stats.totalTime = performance.now() - totalT0;
        stats.phaseTiming.total = stats.totalTime;

        onProgress({phase: 'done', message: 'Готово!', percent: 100});

        return {
            json: result,
            preview,
            zip: zipBlob,
            urls: blobUrls,
            stats,
            sequences,
            videoAssets
        };
    }
};

// для красивого вывода размера
const formatSize = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export {Optimizer, formatSize};