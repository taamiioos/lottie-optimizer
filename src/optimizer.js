import {ImageProcessor} from './image.js';
import {VideoEncoderUtil} from './video.js';

// base64 из Uint8Array
function _uint8ToBase64(bytes) {
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

const Optimizer = {
    minifyLottieJson(json, options = {}) {
        const {
            precision = 3,
            removeDefaultValues = true,
            removeRedundantKeyframes: shouldRemoveRedundant = true,
        } = options;

        const defaultsToRemove = new Set([
            'ddd', 'hd', 'ao', 'sr', 'st', 'bm', 'ind',
            'ip', 'op', 'nm', 'mn', 'cl', 'ln', 'ct', 'ty',
            'ef', 'ef', 'hasMask', 'maskProperties'
        ]);

        function roundNumber(num) {
            if (typeof num !== 'number' || !isFinite(num)) return num;
            const factor = Math.pow(10, precision);
            return Math.round(num * factor) / factor;
        }

        function isDefaultValue(key, value) {
            if (!removeDefaultValues) return false;
            if (value === 0 || value === false || value === 1) return true;
            if (key === 'nm' && (!value || value.trim() === '')) return true;
            return false;
        }

        function cleanObject(obj) {
            if (!obj || typeof obj !== 'object') return obj;

            if (Array.isArray(obj)) {
                for (let i = 0; i < obj.length; i++) {
                    obj[i] = cleanObject(obj[i]);
                }
                return obj;
            }

            for (const key in obj) {
                let val = obj[key];

                if (typeof val === 'number') {
                    obj[key] = roundNumber(val);
                    continue;
                }

                if (val && typeof val === 'object') {
                    obj[key] = cleanObject(val);
                }

                if (removeDefaultValues &&
                    (defaultsToRemove.has(key) ||
                        (key === 'a' && val === 0) ||
                        (key === 'k' && typeof val === 'number'))) {
                    if (isDefaultValue(key, val)) {
                        delete obj[key];
                    }
                }
            }
            return obj;
        }
        function removeRedundantKeyframesInternal(animProp) {
            if (!animProp || typeof animProp !== 'object' || animProp.a === 0) return animProp;
            if (!Array.isArray(animProp.k) || animProp.k.length <= 1) return animProp;

            const keyframes = animProp.k;
            const firstValue = keyframes[0].s || keyframes[0].e || keyframes[0].k;
            let isStatic = true;

            for (let i = 1; i < keyframes.length; i++) {
                const current = keyframes[i].s || keyframes[i].e || keyframes[i].k;
                if (JSON.stringify(firstValue) !== JSON.stringify(current)) {
                    isStatic = false;
                    break;
                }
            }

            if (isStatic) {
                animProp.a = 0;
                animProp.k = Array.isArray(firstValue) ? firstValue : (keyframes[0].s || keyframes[0].k || firstValue);
                delete animProp.i;
                delete animProp.o;
                delete animProp.n;
                delete animProp.t;
            }
            return animProp;
        }

        function processAnimationProperties(obj) {
            if (!obj || typeof obj !== 'object') return;

            if (Array.isArray(obj)) {
                obj.forEach(processAnimationProperties);
                return;
            }

            if (obj.ks) {
                const ks = obj.ks;
                ['o', 'r', 'p', 'a', 's', 'rx', 'ry', 'rz', 'sk', 'sa'].forEach(prop => {
                    if (ks[prop]) {
                        ks[prop] = removeRedundantKeyframesInternal(ks[prop]);
                    }
                });
            }

            if (obj.shapes && Array.isArray(obj.shapes)) {
                obj.shapes.forEach(shape => {
                    if (shape.it) processAnimationProperties(shape.it);
                    if (shape.ks) shape.ks = removeRedundantKeyframesInternal(shape.ks);
                });
            }

            if (obj.it && Array.isArray(obj.it)) {
                processAnimationProperties(obj.it);
            }

            for (const key in obj) {
                if (!['ks', 'shapes', 'it'].includes(key)) {
                    processAnimationProperties(obj[key]);
                }
            }
        }

        // Основная обработка
        cleanObject(json);

        if (shouldRemoveRedundant) {
            processAnimationProperties(json);
            if (Array.isArray(json.layers)) processAnimationProperties(json.layers);
            if (Array.isArray(json.assets)) processAnimationProperties(json.assets);
        }

        // Удаляем пустые объекты и массивы
        function removeEmpty(obj) {
            if (!obj || typeof obj !== 'object') return;
            for (const key in obj) {
                const val = obj[key];
                if (val && typeof val === 'object') {
                    removeEmpty(val);
                    if ((Array.isArray(val) && val.length === 0) || Object.keys(val).length === 0) {
                        delete obj[key];
                    }
                }
            }
        }
        removeEmpty(json);

        return json;
    },
    // парсим .lottie или принимаем json
    async parseLottieInput(input) {
        if (input && typeof input === 'object' && !(input instanceof Blob) && !(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) {
            const animId = (input.nm || 'animation').replace(/[^a-z0-9_-]/gi, '_').slice(0, 64) || 'animation';
            return {data: input, animId};
        }
        // .lottie распаковываем
        const raw = input instanceof Blob ? await input.arrayBuffer() : input;
        const zip = await JSZip.loadAsync(raw);
        const manifestFile = zip.file('manifest.json');
        const manifest = manifestFile ? JSON.parse(await manifestFile.async('string')) : null;
        const animId = manifest?.animations?.[0]?.id || 'animation';
        const animFile = zip.file(`animations/${animId}.json`);
        if (!animFile) throw new Error(`.lottie: не найден animations/${animId}.json`);
        const data = JSON.parse(await animFile.async('string'));
        // инлайним картинки из images/ в base64, чтобы Optimizer мог их обрабатывать
        for (const asset of (data.assets || [])) {
            if (!asset.p || asset.p.startsWith('data:')) continue;
            const path = asset.u ? asset.u.replace(/\/$/, '') + '/' + asset.p : asset.p;
            const file = zip.file(path) || zip.file('images/' + asset.p);
            if (!file) continue;
            const bytes = await file.async('uint8array');
            const ext = asset.p.split('.').pop().toLowerCase();
            const mime = {
                png: 'image/png',
                jpg: 'image/jpeg',
                jpeg: 'image/jpeg',
                webp: 'image/webp',
                gif: 'image/gif'
            }[ext] || 'image/png';
            asset.p = `data:${mime};base64,${_uint8ToBase64(bytes)}`;
            asset.u = '';
            asset.e = 1;
        }
        return {data, animId};
    },

    // последовательности кадров по id
    findSequences(assets) {
        const imageAssets = assets.filter(a => a.p?.startsWith('data:image') && a.id);
        const groups = new Map();
        for (const asset of imageAssets) {
            let id = asset.id.trim();
            let prefix = '';
            let num = -1;

            // Чистим id от расширений и лишнего
            id = id.replace(/\.(png|jpg|jpeg|webp|gif)$/i, '');
            // Варианты паттернов
            const patterns = [
                /^(.+?)[-_](\d{3,})$/i,
                /^(.+?)(\d{3,})$/i,
                /^(.+?)[-_](\d+)/i,
                /^(\D+)(\d+)$/i,
                /^(\d+)$/
            ];

            for (const regex of patterns) {
                const m = id.match(regex);
                if (m) {
                    prefix = m[1] ? m[1].replace(/[_-]$/, '') : '_numeric';
                    num = parseInt(m[2] || m[1], 10);
                    break;
                }
            }
            if (num === -1) continue;
            if (!groups.has(prefix)) groups.set(prefix, []);
            groups.get(prefix).push({id: asset.id, num});
        }
        const sequences = [];
        for (const [prefix, items] of groups) {
            if (items.length < 2) continue;
            items.sort((a, b) => a.num - b.num);
            // Проверяем, что номера идут подряд (или почти подряд)
            let isConsecutive = true;
            for (let i = 1; i < items.length; i++) {
                if (items[i].num - items[i - 1].num > 2) {
                    isConsecutive = false;
                    break;
                }
            }
            if (!isConsecutive && items.length < 5) continue;
            sequences.push({
                prefix: prefix === '_numeric' ? 'sequence' : prefix,
                from: items[0].num,
                to: items[items.length - 1].num,
                count: items.length,
                ids: items.map(x => x.id)
            });
        }

        return sequences;
    },

    // URL воркера на CDN
    _workerUrl: 'https://cdn.jsdelivr.net/gh/taamiioos/lottie-optimizer@main/src/worker.js',

    // запуск оптимизации в отдельном воркере
    _runInWorker(data, options) {
        // поддерживает ли браузер вообще Web Workers
        if (typeof Worker === 'undefined') {
            const {worker: _w, ...opts} = options;
            return Optimizer.run(data, opts);
        }
        return new Promise((resolve, reject) => {
            let worker;

            try {
                worker = new Worker(Optimizer._workerUrl, {type: 'module'});
            } catch (err) {
                const {worker: _w, ...opts} = options;
                resolve(Optimizer.run(data, opts));
                return;
            }

            const id = Math.random().toString(36).slice(2);
            const {
                onProgress = () => {
                }
            } = options;
            const {onProgress: _p, worker: _w, ...opts} = options;

            worker.onmessage = ({data: msg}) => {
                if (msg.id !== id) return;

                switch (msg.type) {
                    case 'progress':
                        onProgress(msg.info);
                        break;
                    case 'result':
                        worker.terminate();
                        const lottie = new Blob([msg.result.zipBuffer], {type: 'application/zip'});
                        const finalResult = {...msg.result, lottie, zip: lottie, zipBuffer: undefined};
                        if (finalResult.preview?.assets && data.assets?.length) {
                            const origById = new Map(data.assets.map(a => [a.id, a]));
                            for (const pa of finalResult.preview.assets) {
                                if (pa._video && pa.id && !pa.p) {
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

            worker.onerror = (e) => {
                worker.terminate();
                reject(new Error('Worker: ' + e.message));
            };

            worker.postMessage({
                id,
                type: 'optimize',
                data,
                options: opts
            });
        });
    },

    // главная функция оптимизации
    async run(inputData, options = {}) {
        const {
            quality = 0.8,
            convertToVideo = true,
            videoFps,
            videoBitrateMultiplier = 1,
            onProgress = () => {
            },
            worker = false,
            _animId = null,
            jsonPrecision = 3,
            jsonMinify = true,
            removeRedundantKeyframes = true
        } = options;

        // парсим входные данные
        const parsed = await Optimizer.parseLottieInput(inputData);
        const data = parsed.data;
        const animId = _animId || parsed.animId;
        if (worker) return this._runInWorker(data, {...options, _animId: animId});
        const fps = videoFps ?? (data.fr || 24);
        const totalT0 = performance.now();
        // глубокие копии, чтобы не портить оригинальные данные
        const result = structuredClone(data);
        const preview = {...data, assets: JSON.parse(JSON.stringify(data.assets || []))};
        const assets = result.assets || [];
        const previewAssets = preview.assets || [];
        const zip = new JSZip();
        const hashMap = new Map();
        const blobUrls = [];

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
        onProgress({phase: 'analysis', message: 'Загрузка ассетов...', percent: 2});
        const blobCache = new Map();
        for (const a of assets.filter(a => a.p?.startsWith('data:image') && a.id)) {
            if (candidateVideoIds.has(a.id)) continue;
            const blob = ImageProcessor.decodeBase64(a.p);
            if (blob) blobCache.set(a.id, blob);
        }

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
                const fmt = {
                    'image/webp': 'webp',
                    'image/png': 'png',
                    'image/jpeg': 'jpeg',
                    'image/gif': 'gif'
                }[mime] || 'png';
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
                        fps,
                        bitrateMultiplier: videoBitrateMultiplier,
                        onProgress: (pct) => {
                            onProgress({
                                phase: 'video',
                                message: `Видео ${si + 1}/${sequences.length}: ${pct}%`,
                                percent: 10 + Math.round((si + pct / 100) / sequences.length * 40)
                            });
                        }
                    });

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
                    zip.file(videoFile, videoResult.blob, {compression: 'STORE'});

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
                asset.u = 'images/';
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
                asset.u = 'images/';
                asset.p = ref.file;
                asset.e = 0;
                previewAsset.u = '';
                previewAsset.p = ref.url;
                previewAsset.e = 0;
                stats.duplicates++;
                return;
            }

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
                // изображения в images/ — стандартная папка формата .lottie
                zip.file(`images/${fileName}`, outBlob, {compression: 'STORE'});
                const url = URL.createObjectURL(outBlob);
                blobUrls.push(url);
                hashMap.set(hash, {file: fileName, url});
                return {file: fileName, url};
            })();

            processingMap.set(hash, promise);
            const ref = await promise;
            asset.u = 'images/';
            asset.p = ref.file;
            asset.e = 0;
            previewAsset.u = '';
            previewAsset.p = ref.url;
            previewAsset.e = 0;
        }
        // 8 параллельных обработчиков
        const CONCURRENCY = 8;
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

        if (videoAssets.length > 0) {
            result.videoAssets = videoAssets;
        }

        onProgress({phase: 'zip', message: 'Создание .lottie...', percent: 90});

        let finalJson = result;
        if (jsonMinify) {
            finalJson = Optimizer.minifyLottieJson(structuredClone(result), {
                precision: jsonPrecision,
                removeDefaultValues: true,
                removeRedundantKeyframes: removeRedundantKeyframes,   // передаём опцию
                aggressive: false
            });
        }

        // Структура .lottie
        const lottieManifest = {
            animations: [{id: animId, speed: 1, themeColor: '#000000', direction: 1}],
            version: '1.0',
            author: '',
            generator: 'lottie-optimizer'
        };

        zip.file('manifest.json', JSON.stringify(lottieManifest));
        zip.file(`animations/${animId}.json`, JSON.stringify(finalJson));

        const zipT0 = performance.now();
        const lottieBlob = await zip.generateAsync({
            type: 'blob',
            compression: 'DEFLATE',
        }, (meta) => {
            onProgress({
                phase: 'zip',
                message: `.lottie: ${meta.percent.toFixed(0)}%`,
                percent: 90 + Math.round(meta.percent / 100 * 10)
            });
        });

        stats.zipTime = performance.now() - zipT0;
        stats.phaseTiming.zip = stats.zipTime;

        let _origB64Len = 0;
        for (const a of data.assets || []) if (a.p?.startsWith('data:')) _origB64Len += a.p.length;

        stats.originalJsonSize = _origB64Len + 50000;
        stats.optimizedJsonSize = new Blob([JSON.stringify(finalJson)]).size;
        stats.zipFileSize = lottieBlob.size;

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
            json: finalJson,
            preview,
            lottie: lottieBlob,
            zip: lottieBlob,
            urls: blobUrls,
            stats,
            sequences,
            videoAssets,
            animId
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
