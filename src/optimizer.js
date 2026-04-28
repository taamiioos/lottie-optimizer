import {ImageProcessor} from './image.js';
import {VideoEncoderUtil} from './video.js';
import {_uint8ToBase64, formatSize} from './utils.js';

const Optimizer = {
    _workerUrl: new URL('./worker.js', import.meta.url),
    /**
     * Превращает входные данные (JSON, Blob, ArrayBuffer) в объект анимации
     * Если это .lottie — распаковывает, находит JSON, встраивает картинки как base64
     */
    async parseLottieInput(input) {
        // обычный JSON-объект — сразу возвращаем
        if (input && typeof input === 'object'
            && !(input instanceof Blob)
            && !(input instanceof ArrayBuffer)
            && !ArrayBuffer.isView(input)) {
            const animId = (input.nm || 'animation').replace(/[^a-z0-9_-]/gi, '_').slice(0, 64) || 'animation';
            return {data: input, animId};
        }
        // .lottie ZIP
        const raw = input instanceof Blob ? await input.arrayBuffer() : input;
        const zip = await JSZip.loadAsync(raw);
        const manifestFile = zip.file('manifest.json');
        const manifest = manifestFile ? JSON.parse(await manifestFile.async('string')) : null;
        const animId = manifest?.animations?.[0]?.id || 'animation';
        const animFile = zip.file(`animations/${animId}.json`);
        if (!animFile) throw new Error(`.lottie: не найден animations/${animId}.json`);
        const data = JSON.parse(await animFile.async('string'));
        // Встраиваем картинки из ZIP как data:image base64
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
            }[ext] ?? 'image/png';
            asset.p = `data:${mime};base64,${_uint8ToBase64(bytes)}`;
            asset.u = '';
            asset.e = 1;
        }
        return {data, animId};
    },
    /**
     * Ищет в списке ассетов последовательности кадров по именам с числовыми суффиксами
     */
    findSequences(assets) {
        const imageAssets = assets.filter(a => a.p?.startsWith('data:image') && a.id);
        const groups = new Map();
        for (const asset of imageAssets) {
            let id = asset.id.trim().replace(/\.(png|jpe?g|webp|gif)$/i, '');
            const match = id.match(/^(.+?)(?:[_-])?(\d+)$/i);
            if (!match) continue;
            let prefix = match[1].replace(/[_-]+$/, '') || '_numeric';
            const num = parseInt(match[2], 10);
            if (!groups.has(prefix)) groups.set(prefix, []);
            groups.get(prefix).push({id: asset.id, num});
        }
        const sequences = [];
        for (const [prefix, items] of groups) {
            if (items.length < 2) continue;
            items.sort((a, b) => a.num - b.num);
            let gaps = 0;
            for (let i = 1; i < items.length; i++) {
                if (items[i].num - items[i - 1].num > 2) gaps++;
            }
            if (gaps > Math.floor(items.length * 0.15) && items.length < 6) continue;
            sequences.push({
                prefix: prefix === '_numeric' ? 'sequence' : prefix,
                from: items[0].num,
                to: items[items.length - 1].num,
                count: items.length,
                ids: items.map(x => x.id),
            });
        }

        return sequences;
    },
    /**
     * Минифицирует JSON анимации:
     * - округляет числа до заданной точности
     * - удаляет свойства с дефолтными значениями
     * - схлопывает статичные анимированные ключи в константы
     * - убирает пустые объекты/массивы
     */
    minifyLottieJson(json, options = {}) {
        const {
            precision = 3,
            removeDefaultValues = true,
            removeRedundantKeyframes: shouldRemoveRedundant = true,
        } = options;
        const defaultsToRemove = new Set([
            'ddd', 'hd', 'ao', 'sr', 'st', 'bm', 'ind',
            'ip', 'op', 'nm', 'mn', 'cl', 'ln', 'ct', 'ty',
            'ef', 'hasMask', 'maskProperties',
        ]);
        const factor = Math.pow(10, precision);
        const roundNumber = (num) => {
            if (typeof num !== 'number' || !isFinite(num)) return num;
            return Math.round(num * factor) / factor;
        };
        const isDefaultValue = (key, value) => {
            if (!removeDefaultValues) return false;
            if (value === 0 || value === false || value === 1) return true;
            if (key === 'nm' && (!value || value.trim() === '')) return true;
            return false;
        };

        // Рекурсивно обходит объект, округляет числа и удаляет дефолтные ключи
        function cleanObject(obj) {
            if (!obj || typeof obj !== 'object') return obj;
            if (Array.isArray(obj)) {
                for (let i = 0; i < obj.length; i++) obj[i] = cleanObject(obj[i]);
                return obj;
            }
            for (const key in obj) {
                const val = obj[key];
                if (typeof val === 'number') {
                    obj[key] = roundNumber(val);
                    continue;
                }
                if (val && typeof val === 'object') obj[key] = cleanObject(val);
                if (removeDefaultValues && defaultsToRemove.has(key) && isDefaultValue(key, val)) delete obj[key];
            }
            return obj;
        }

        // Схлопывает статичные keyframes: если все ключи одинаковые, превращает в константу
        function collapseStaticKeyframes(animProp) {
            if (!animProp || typeof animProp !== 'object' || animProp.a === 0) return animProp;
            if (!Array.isArray(animProp.k) || animProp.k.length <= 1) return animProp;
            const keyframes = animProp.k;
            const firstValue = keyframes[0].s || keyframes[0].e || keyframes[0].k;
            const isStatic = keyframes.every(kf => JSON.stringify(firstValue) === JSON.stringify(kf.s || kf.e || kf.k));
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

        // Применяет collapse ко всем анимированным свойствам
        function processAnimProps(obj) {
            if (!obj || typeof obj !== 'object') return;
            if (Array.isArray(obj)) {
                obj.forEach(processAnimProps);
                return;
            }
            if (obj.ks) {
                const ks = obj.ks;
                for (const prop of ['o', 'r', 'p', 'a', 's', 'rx', 'ry', 'rz', 'sk', 'sa']) {
                    if (ks[prop]) ks[prop] = collapseStaticKeyframes(ks[prop]);
                }
            }
            if (Array.isArray(obj.shapes)) {
                obj.shapes.forEach(shape => {
                    if (shape.it) processAnimProps(shape.it);
                    if (shape.ks) shape.ks = collapseStaticKeyframes(shape.ks);
                });
            }
            if (Array.isArray(obj.it)) processAnimProps(obj.it);
            for (const key in obj) {
                if (!['ks', 'shapes', 'it'].includes(key)) processAnimProps(obj[key]);
            }
        }

        // Удаляет пустые объекты и массивы
        function removeEmpty(obj) {
            if (!obj || typeof obj !== 'object') return;
            for (const key in obj) {
                const val = obj[key];
                if (val && typeof val === 'object') {
                    removeEmpty(val);
                    if ((Array.isArray(val) && val.length === 0) || Object.keys(val).length === 0) delete obj[key];
                }
            }
        }

        cleanObject(json);
        if (shouldRemoveRedundant) processAnimProps(json);
        removeEmpty(json);

        return json;
    },
    /**
     * Запускает оптимизацию в Web Worker, чтобы не блокировать UI
     * Если Worker не поддерживается или ошибка — падает на основном потоке
     */
    _runInWorker(data, options) {
        if (typeof Worker === 'undefined') {
            const {worker: _w, ...opts} = options;
            return Optimizer.run(data, opts);
        }
        return new Promise((resolve, reject) => {
            let worker;
            try {
                worker = new Worker(Optimizer._workerUrl, {type: 'module'});
            } catch {
                const {worker: _w, ...opts} = options;
                resolve(Optimizer.run(data, opts));
                return;
            }
            const id = Math.random().toString(36).slice(2);
            const {
                onProgress = () => {
                }, worker: _w, ...opts
            } = options;
            worker.onmessage = ({data: msg}) => {
                if (msg.id !== id) return;
                switch (msg.type) {
                    case 'progress':
                        onProgress(msg.info);
                        break;
                    case 'result': {
                        worker.terminate();
                        const lottieBlob = new Blob([msg.result.zipBuffer], {type: 'application/zip'});
                        const finalResult = {...msg.result, lottie: lottieBlob, zip: lottieBlob, zipBuffer: undefined};
                        // восстанавливаем preview-кадры для видеоассетов из оригинала
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
                    }
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
            worker.postMessage({id, data, options: opts});
        });
    },
    /**
     * Главный метод оптимизации Lottie-анимации
     * Возвращает готовый .lottie файл, preview-данные, статистику
     */
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
            removeRedundantKeyframes = true,
        } = options;
        // Парсим входные данные
        const parsed = await Optimizer.parseLottieInput(inputData);
        const data = parsed.data;
        const animId = _animId || parsed.animId;
        if (worker) return this._runInWorker(data, {...options, _animId: animId});
        const fps = videoFps ?? (data.fr || 24);
        const t0 = performance.now();
        // Инициализируем внутренний контекст
        const ctx = this._initContext(data, animId, {
            fps,
            quality,
            videoBitrateMultiplier,
            jsonMinify,
            jsonPrecision,
            removeRedundantKeyframes
        });
        // Анализируем ассеты: считаем размеры, форматы, находим последовательности
        await this._analyseAssets(ctx, onProgress);
        // Если есть последовательности и включена конвертация – кодируем их в MP4
        if (convertToVideo && ctx.sequences.length > 0)
            await this._encodeSequences(ctx, onProgress);
        // Обрабатываем одиночные изображения: дедупликация, конвертация в WebP
        await this._processImages(ctx, onProgress);
        // Упаковываем результат в .lottie ZIP (JSON + картинки + видео)
        const {lottieBlob, finalJson} = await this._packZip(ctx, onProgress);
        // финальная статистика
        this._finalizeStats(ctx, lottieBlob, finalJson, t0);
        onProgress({phase: 'done', message: 'Готово!', percent: 100});

        return {
            json: finalJson,
            preview: ctx.preview,
            lottie: lottieBlob, zip: lottieBlob,
            urls: ctx.blobUrls,
            stats: ctx.stats,
            sequences: ctx.sequences,
            videoAssets: ctx.videoAssets,
            animId,
        };
    },
    /**
     * Создаёт контекст оптимизации: копии данных, пустые коллекции, счётчики
     */
    _initContext(data, animId, opts) {
        const _cloneAssets = (src) => (src || []).map(a => structuredClone(a));
        const result = {...data, assets: _cloneAssets(data.assets)};
        const preview = {...data, assets: _cloneAssets(data.assets)};
        const assets = result.assets || [];
        const sequences = this.findSequences(assets);
        const candidateVideoIds = new Set(sequences.flatMap(s => s.ids));
        // Кэш Blob для картинок, которые не входят в видео-последовательности
        const blobCache = new Map();
        for (const a of assets.filter(a => a.p?.startsWith('data:image') && a.id && !candidateVideoIds.has(a.id))) {
            const blob = ImageProcessor.decodeBase64(a.p);
            if (blob) blobCache.set(a.id, blob);
        }
        return {
            data, animId, ...opts,
            result, preview,
            assets, previewAssets: preview.assets || [],
            sequences, candidateVideoIds,
            blobCache,
            zip: new JSZip(),
            hashMap: new Map(),
            blobUrls: [],
            videoAssets: [],
            videoFrameIds: new Set(),
            videoFrameSeqIndex: new Map(),
            stats: {
                totalImages: 0, uniqueImages: 0, duplicates: 0,
                sizeBefore: 0, sizeAfter: 0, formats: {},
                sequences: 0, framesInVideo: 0, videoSize: 0, videoSkipped: 0,
                webpConversions: 0, keptOriginal: 0, webpSavings: 0,
                singleImagesSizeBefore: 0,
                avgImageSize: 0, largestImage: 0, smallestImage: Infinity,
                compressionRatio: 0,
                originalJsonSize: 0, optimizedJsonSize: 0, zipFileSize: 0,
                totalSaved: 0, totalSavedPct: 0, totalTime: 0,
                phaseTiming: {},
                videoDetails: [], imageDetails: [],
                analysisTime: 0, videoEncodingTime: 0, imageProcessingTime: 0, zipTime: 0,
            },
        };
    },

    /**
     * Анализирует все ассеты: считает размер, формат, общий объём
     */
    async _analyseAssets(ctx, onProgress) {
        const {assets, candidateVideoIds, blobCache, stats} = ctx;
        const t0 = performance.now();
        onProgress({phase: 'analysis', message: 'Загрузка ассетов...', percent: 2});
        // Проходим по каждому ассету с картинкой
        await Promise.all(assets.map(async asset => {
            if (!asset.p?.startsWith('data:image')) return;
            stats.totalImages++;
            const comma = asset.p.indexOf(',');
            const sz = comma >= 0 ? Math.floor((asset.p.length - comma - 1) * 0.75) : 0;
            if (sz > stats.largestImage) stats.largestImage = sz;
            if (sz < stats.smallestImage) stats.smallestImage = sz;
            if (candidateVideoIds.has(asset.id)) {
                stats.sizeBefore += sz;
                const mime = comma > 0 ? asset.p.slice(5, comma).split(';')[0] : '';
                const fmt = {
                    'image/webp': 'webp',
                    'image/png': 'png',
                    'image/jpeg': 'jpeg',
                    'image/gif': 'gif'
                }[mime] ?? 'png';
                stats.formats[fmt] = (stats.formats[fmt] || 0) + 1;
                return;
            }
            const blob = blobCache.get(asset.id);
            if (!blob) return;
            stats.sizeBefore += blob.size;
            const header = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
            const fmt = ImageProcessor.detectFormat(header);
            stats.formats[fmt] = (stats.formats[fmt] || 0) + 1;
        }));
        if (stats.totalImages > 0) stats.avgImageSize = Math.round(stats.sizeBefore / stats.totalImages);
        if (stats.smallestImage === Infinity) stats.smallestImage = 0;
        stats.analysisTime = performance.now() - t0;
        stats.phaseTiming.analysis = stats.analysisTime;
        onProgress({
            phase: 'analysis',
            message: `Анализ: ${stats.totalImages} изображений, ${formatSize(stats.sizeBefore)}`,
            percent: 5
        });
        if (ctx.sequences.length > 0)
            onProgress({
                phase: 'sequences',
                message: `Найдено ${ctx.sequences.length} последовательность(ей)`,
                percent: 10
            });
    },
    /**
     * Кодирует найденные последовательности кадров в MP4 через VideoEncoderUtil
     * Если результат меньше оригиналов — сохраняет видео в архив
     */
    async _encodeSequences(ctx, onProgress) {
        const {
            sequences,
            assets,
            fps,
            videoBitrateMultiplier,
            zip,
            stats,
            videoAssets,
            videoFrameIds,
            videoFrameSeqIndex
        } = ctx;
        const assetById = new Map(assets.map(a => [a.id, a]));
        const t0 = performance.now();
        let videoCounter = 0;

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
                originalSize += comma >= 0 ? Math.floor((asset.p.length - comma - 1) * 0.75) : 0;
                frames.push(asset.p);
            }
            if (frames.length < 3) continue;

            try {
                const videoResult = await VideoEncoderUtil.encode(frames, {
                    fps,
                    bitrateMultiplier: videoBitrateMultiplier,
                    onProgress: (pct) => onProgress({
                        phase: 'video',
                        message: `Видео ${si + 1}/${sequences.length}: ${pct}%`,
                        percent: 10 + Math.round((si + pct / 100) / sequences.length * 40),
                    }),
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
                const videoDetail = {
                    id: `video_${videoCounter}`,
                    file: videoFile,
                    width: videoResult.width, height: videoResult.height,
                    frames: videoResult.frames, fps: videoResult.fps,
                    codec: videoResult.codec,
                    frameIds: seq.ids,
                    duration: videoResult.duration,
                    fileSize: videoResult.blob.size, originalSize,
                    compressionRatio: originalSize > 0 ? (videoResult.blob.size / originalSize * 100).toFixed(1) : 0,
                    encodingStats: videoResult.encodingStats,
                };

                zip.file(videoFile, videoResult.blob, {compression: 'STORE'});
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

        stats.videoEncodingTime = performance.now() - t0;
        stats.phaseTiming.videoEncoding = stats.videoEncodingTime;
    },
    /**
     * Обрабатывает одиночные изображения (не вошедшие в видео):
     * - дедупликация по хэшу
     * - конвертация в WebP
     * - сохранение в архив как images/
     */
    async _processImages(ctx, onProgress) {
        const {
            assets,
            previewAssets,
            videoFrameIds,
            videoFrameSeqIndex,
            blobCache,
            zip,
            hashMap,
            blobUrls,
            stats,
            quality
        } = ctx;
        const t0 = performance.now();
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
        const total = candidates.length;
        let processed = 0;
        const processingMap = new Map();
        const processOne = async ({asset, previewAsset}) => {
            const n = ++processed;
            onProgress({
                phase: 'images',
                message: `Изображение ${n}/${total}`,
                percent: 50 + Math.round(n / Math.max(total, 1) * 35)
            });
            const blob = blobCache.get(asset.id);
            if (!blob) return;
            const origSize = blob.size;
            stats.singleImagesSizeBefore += origSize;
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const hash = await ImageProcessor.hash(bytes);

            // уже готово
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
            // параллельный дубликат — ждём первого
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
                const ext = ImageProcessor.extFromFormat(processed.format);
                const newSize = outBlob.size;
                stats.sizeAfter += newSize;
                stats.uniqueImages++;
                if (processed.format === 'webp') {
                    stats.webpConversions++;
                    stats.webpSavings += origSize - newSize;
                } else stats.keptOriginal++;
                stats.imageDetails.push({
                    id: asset.id,
                    originalSize: origSize,
                    optimizedSize: newSize,
                    format: processed.format,
                    savings: origSize - newSize,
                    ratio: origSize > 0 ? ((1 - newSize / origSize) * 100).toFixed(1) : 0
                });

                const fileName = `img_${hash.slice(0, 8)}.${ext}`;
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
        };

        // 8 параллельных обработчиков
        const queue = [...candidates];
        await Promise.all(Array.from({length: Math.min(8, candidates.length)}, async () => {
            while (queue.length > 0) await processOne(queue.shift());
        }));
        stats.imageProcessingTime = performance.now() - t0;
        stats.phaseTiming.imageProcessing = stats.imageProcessingTime;
        onProgress({
            phase: 'images',
            message: `Уникальных: ${stats.uniqueImages}, дубликатов: ${stats.duplicates}, WebP: ${stats.webpConversions}`,
            percent: 88
        });
    },

    /**
     * Собирает итоговый .lottie архив:
     * - записывает JSON
     * - добавляет картинки и видео
     * - создаёт manifest.json
     */
    async _packZip(ctx, onProgress) {
        const {result, animId, zip, videoAssets, jsonMinify, jsonPrecision, removeRedundantKeyframes} = ctx;
        if (videoAssets.length > 0) result.videoAssets = videoAssets;
        onProgress({phase: 'zip', message: 'Создание .lottie...', percent: 90});
        const finalJson = jsonMinify
            ? Optimizer.minifyLottieJson(structuredClone(result))
            : structuredClone(result);
        zip.file('manifest.json', JSON.stringify({
            animations: [{id: animId, speed: 1, themeColor: '#000000', direction: 1}],
            version: '1.0', author: '', generator: 'lottie-optimizer',
        }));
        zip.file(`animations/${animId}.json`, JSON.stringify(finalJson));
        const t0 = performance.now();
        const lottieBlob = await zip.generateAsync({type: 'blob', compression: 'DEFLATE'}, (meta) => {
            onProgress({
                phase: 'zip',
                message: `.lottie: ${meta.percent.toFixed(0)}%`,
                percent: 90 + Math.round(meta.percent / 100 * 10)
            });
        });
        ctx.stats.zipTime = performance.now() - t0;
        ctx.stats.phaseTiming.zip = ctx.stats.zipTime;
        return {lottieBlob, finalJson};
    },
    /**
     * Подсчитывает финальную статистику: исходный размер, выигрыш, проценты
     */
    _finalizeStats(ctx, lottieBlob, finalJson, t0) {
        const {data, stats} = ctx;
        // оцениваем исходный размер
        let origB64Len = 0;
        for (const a of data.assets || []) {
            if (a.p?.startsWith('data:')) {
                const comma = a.p.indexOf(',');
                origB64Len += comma >= 0 ? Math.floor((a.p.length - comma - 1) * 0.75) : 0;
            }
        }

        stats.originalJsonSize = origB64Len + 50000;
        stats.optimizedJsonSize = new Blob([JSON.stringify(finalJson)]).size;
        stats.zipFileSize = lottieBlob.size;
        stats.totalSaved = stats.originalJsonSize - (stats.optimizedJsonSize + stats.zipFileSize);
        stats.totalSavedPct = stats.originalJsonSize > 0 ? ((stats.totalSaved / stats.originalJsonSize) * 100).toFixed(1) : 0;
        stats.compressionRatio = stats.sizeBefore > 0 ? ((stats.sizeAfter + stats.videoSize) / stats.sizeBefore * 100).toFixed(1) : 0;
        stats.totalTime = performance.now() - t0;
        stats.phaseTiming.total = stats.totalTime;
    },
};

export {Optimizer};
