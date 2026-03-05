import {ImageProcessor} from './image.js';
import {VideoEncoderUtil} from './video.js';

// оптимизатор — главная функция, которая всё сжимает, ищет последовательности, делает видео и пакует в zip
const Optimizer = {
    // ищем последовательности кадров по id
    findSequences(assets) {
        // берём только картинки с data:image и id
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
    // главная функция оптимизации
    async run(data, options = {}) {
        const {
            quality = 0.8,
            convertToVideo = true,
            videoFps = 24,
            videoBitrateMultiplier = 1,
            onProgress = () => {}
        } = options;

        const totalT0 = performance.now();
        // делаем глубокие копии, чтобы не портить оригинальные данные
        const result = JSON.parse(JSON.stringify(data));
        const preview = JSON.parse(JSON.stringify(data));
        const assets = result.assets || [];
        const previewAssets = preview.assets || [];
        const zip = new JSZip();
        const hashMap = new Map(); // для поиска дубликатов по sha-256
        const blobUrls = []; // чтобы потом можно было отозвать

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

        // предзагружаем все блобы параллельно — одно декодирование base64 на всё
        // ОПТИМИЗАЦИЯ: раньше каждая функция декодировала base64 сама.
        // Теперь один параллельный проход в начале — дальше все работают с готовыми Blob из кэша.
        const analysisT0 = performance.now();
        onProgress({ phase: 'analysis', message: 'Загрузка ассетов...', percent: 2 });

        const blobCache = new Map(); // asset.id → Blob
        await Promise.all(
            assets
                .filter(a => a.p?.startsWith('data:image') && a.id)
                .map(async a => {
                    const blob = await ImageProcessor.decodeBase64(a.p);
                    if (blob) blobCache.set(a.id, blob);
                })
        );

        // анализ — считаем статистику из уже загруженных блобов
        for (const asset of assets) {
            if (!asset.p?.startsWith('data:image')) continue;
            stats.totalImages++;
            const blob = blobCache.get(asset.id);
            if (blob) {
                const sz = blob.size;
                stats.sizeBefore += sz;
                if (sz > stats.largestImage) stats.largestImage = sz;
                if (sz < stats.smallestImage) stats.smallestImage = sz;
                const bytes = new Uint8Array(await blob.arrayBuffer());
                const fmt = ImageProcessor.detectFormat(bytes);
                stats.formats[fmt] = (stats.formats[fmt] || 0) + 1;
            }
        }
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

        // ищем последовательности кадров для кодирования в видео
        const sequences = this.findSequences(assets);
        const videoAssets = [];
        const videoFrameIds = new Set();
        const videoFrameSeqIndex = new Map();

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
                    const blob = blobCache.get(id);
                    if (!blob) continue;

                    originalSize += blob.size;
                    frames.push(blob);
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
                    zip.file(videoFile, videoResult.blob);

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
                const processed = await ImageProcessor.process(blob, quality);
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
                zip.file(`assets/${fileName}`, outBlob);
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

        // ОПТИМИЗАЦИЯ: параллельная обработка изображений через пул из 4 воркеров.
        // Раньше был последовательный цикл — каждый await блокировал следующий.
        // Теперь 4 картинки конвертируются одновременно, остальные ждут в очереди.
        const CONCURRENCY = 4;
        const queue = [...candidates];

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

        stats.originalJsonSize = new Blob([JSON.stringify(data)]).size;
        stats.optimizedJsonSize = new Blob([JSON.stringify(result)]).size;
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