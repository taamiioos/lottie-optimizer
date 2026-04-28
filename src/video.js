import {_detectKeyFrames, _pickAvcCodec} from "./utils.js";
import {ImageProcessor} from "./image.js";

const VideoEncoderUtil = {
    /**
     * Кодирует массив кадров (data URL или Blob) в MP4/H.264 через WebCodecs
     * @param {(string|Blob)[]} frames — массив кадров
     * @param {EncodeOptions}   [options] — fps, качество, прогресс
     */
    async encode(frames, options = {}) {
        const {
            fps = 24, bitrateMultiplier = 1, onProgress = () => {
            }
        } = options;
        if (typeof VideoEncoder === 'undefined')
            throw new Error('WebCodecs API не поддерживается в этом браузере');
        const t0 = performance.now();
        // Подготовка: первый кадр, размеры, настройки кодека
        const firstImg = await this._loadImage(frames[0]);
        const cfg = this._prepare(firstImg, fps, bitrateMultiplier);
        // Создаём и настраиваем VideoEncoder
        const {encoder, state, configureTime} = await this._setupEncoder(cfg);
        // загружаем уменьшенные копии кадров (для детектора ключевых кадров)
        const thumbT0 = performance.now();
        const thumbs = await this._loadThumbs(frames);
        const loadTime = performance.now() - thumbT0;
        if (state.error) throw state.error;
        // Определяем, какие кадры сделать ключевыми
        const keyFrameSet = await _detectKeyFrames(thumbs);
        thumbs.forEach(t => t?.close());
        // Кодируем все кадры, передаём в энкодер
        const encodeT0 = performance.now();
        await this._encodeFrames(encoder, frames, firstImg, cfg, keyFrameSet, state, onProgress);
        const encodeTime = performance.now() - encodeT0;
        if (state.error) throw state.error;
        // Завершаем кодирование и проверяем результат
        await encoder.flush();
        encoder.close();
        if (state.error) throw state.error;
        if (state.chunks.length === 0) throw new Error('Энкодер не вернул ни одного чанка');
        if (!state.decoderConfig?.description) throw new Error('Не получен avcDecoderConfig от энкодера');
        // Упаковываем полученные чанки в MP4-контейнер
        const muxT0 = performance.now();
        const mp4blob = this._muxToMP4(state.chunks, {
            width: cfg.encWidth, height: cfg.encHeight,
            timescale: cfg.timescale, sampleDuration: cfg.sampleDuration,
            encoderConfig: state.decoderConfig,
        });
        const muxTime = performance.now() - muxT0;
        // обираем статистику кодирования
        const encodingStats = this._buildStats({
            cfg, state, mp4blob,
            t0, configureTime, loadTime, encodeTime, muxTime,
            totalFrames: frames.length,
        });
        return {
            blob: mp4blob,
            width: cfg.encWidth, height: cfg.encHeight,
            codec: 'h264', mime: 'video/mp4',
            frames: frames.length, fps,
            duration: frames.length / fps,
            encodingStats,
        };
    },
    /**
     * Вычисляет параметры кодирования по первому кадру и fps
     */
    _prepare(firstImg, fps, bitrateMultiplier) {
        const width = firstImg.naturalWidth || firstImg.width;
        const height = firstImg.naturalHeight || firstImg.height;
        // H.264 требует чётных размеров
        const encWidth = width % 2 === 0 ? width : width + 1;
        const encHeight = height % 2 === 0 ? height : height + 1;
        const timescale = 90000;
        const sampleDuration = Math.round(timescale / fps);
        const frameDurationUs = Math.round(1_000_000 / fps);
        // Битрейт
        const bitrateTarget = Math.max(
            200_000,
            Math.min(8_000_000, Math.round(encWidth * encHeight * 0.15 * fps * bitrateMultiplier))
        );
        return {
            width, height, encWidth, encHeight,
            needsPadding: width !== encWidth || height !== encHeight,
            fps, timescale, sampleDuration, frameDurationUs,
            codec: _pickAvcCodec(encWidth, encHeight),
            bitrateTarget,
        };
    },
    /**
     * Создаёт и настраивает VideoEncoder, возвращает энкодер и состояние
     */
    async _setupEncoder(cfg) {
        const {codec, encWidth, encHeight, bitrateTarget, fps, sampleDuration} = cfg;
        // Проверяем, поддерживается ли аппаратное ускорение
        const support = await VideoEncoder.isConfigSupported({
            codec, width: encWidth, height: encHeight,
            bitrate: bitrateTarget, framerate: fps,
            hardwareAcceleration: 'prefer-hardware',
        });
        const hwAccel = support.supported ? 'prefer-hardware' : 'prefer-software';
        // Состояние: накопленные чанки, конфиг декодера, ошибка
        const state = {chunks: [], decoderConfig: null, error: null, hwAccel};
        const t0 = performance.now();
        const encoder = new VideoEncoder({
            output: (chunk, metadata) => {
                // Копируем данные чанка
                const buf = new ArrayBuffer(chunk.byteLength);
                chunk.copyTo(buf);
                state.chunks.push({
                    data: buf,
                    timestamp: chunk.timestamp,
                    duration: chunk.duration || sampleDuration,
                    isKey: chunk.type === 'key',
                });
                if (metadata?.decoderConfig && !state.decoderConfig)
                    state.decoderConfig = metadata.decoderConfig;
            },
            error: (e) => {
                state.error = e;
            },
        });

        encoder.configure({
            codec, width: encWidth, height: encHeight,
            bitrate: bitrateTarget, framerate: fps,
            hardwareAcceleration: hwAccel,
            latencyMode: 'quality',
            avc: {format: 'avc'},
        });

        return {encoder, state, configureTime: performance.now() - t0};
    },
    /**
     * Загружает уменьшенные копии кадров для детектора ключевых кадров
     */
    _loadThumbs(frames) {
        return Promise.all(
            frames.map(f => {
                const src = typeof f === 'string' ? ImageProcessor.decodeBase64(f) : f;
                return createImageBitmap(src, {resizeWidth: 32, resizeHeight: 32}).catch(() => null);
            })
        );
    },
    /**
     * Кодирует все кадры, передаёт в энкодер с учётом ключевых кадров
     */
    async _encodeFrames(encoder, frames, firstImg, cfg, keyFrameSet, state, onProgress) {
        const {encWidth, encHeight, needsPadding, frameDurationUs} = cfg;
        const canvas = needsPadding ? new OffscreenCanvas(encWidth, encHeight) : null;
        const ctx = canvas?.getContext('2d');
        // Предзагрузка следующих кадров
        const PREFETCH = 4;
        const preloaded = new Array(frames.length).fill(null);
        for (let p = 1; p <= Math.min(PREFETCH, frames.length - 1); p++)
            preloaded[p] = this._loadImage(frames[p]);

        for (let i = 0; i < frames.length; i++) {
            if (state.error) throw state.error;
            // Берём текущий кадр: первый – уже загружен, остальные – из предзагрузки
            const img = i === 0 ? firstImg : await preloaded[i];
            preloaded[i] = null;
            // Загружаем следующий в ожидании
            if (i + PREFETCH + 1 < frames.length)
                preloaded[i + PREFETCH + 1] = this._loadImage(frames[i + PREFETCH + 1]);
            let vf;
            if (needsPadding) {
                ctx.clearRect(0, 0, encWidth, encHeight);
                ctx.drawImage(img, 0, 0, encWidth, encHeight);
                vf = new VideoFrame(canvas, {timestamp: i * frameDurationUs, duration: frameDurationUs});
            } else {
                vf = new VideoFrame(img, {timestamp: i * frameDurationUs, duration: frameDurationUs});
            }

            if (img.close) img.close();
            encoder.encode(vf, {keyFrame: keyFrameSet.has(i)});
            vf.close();

            onProgress(Math.round((i + 1) / frames.length * 100), i + 1, frames.length);
        }
    },

    /**
     * Упаковывает закодированные чанки в MP4-контейнер через MP4Box
     */
    _muxToMP4(chunks, {width, height, timescale, sampleDuration, encoderConfig}) {
        const mp4file = MP4Box.createFile();
        const description = this._toArrayBuffer(encoderConfig.description);
        // Добавляем видеодорожку с конфигурацией H.264
        const trackId = mp4file.addTrack({
            timescale, width, height,
            nb_samples: chunks.length,
            brands: ['isom', 'iso2', 'avc1', 'mp41'],
            avcDecoderConfigRecord: description,
        });
        // Добавляем каждый сэмпл
        for (let i = 0; i < chunks.length; i++) {
            mp4file.addSample(trackId, this._toArrayBuffer(chunks[i].data), {
                duration: sampleDuration,
                is_sync: chunks[i].isKey,
                cts: 0,
                dts: i * sampleDuration,
            });
        }

        const stream = new DataStream();
        stream.endianness = DataStream.BIG_ENDIAN;
        mp4file.write(stream);
        return new Blob([stream.buffer], {type: 'video/mp4'});
    },

    /**
     * Формирует детальную статистику кодирования
     */
    _buildStats({cfg, state, mp4blob, t0, configureTime, loadTime, encodeTime, muxTime, totalFrames}) {
        const {fps, encWidth, encHeight, width, height, bitrateTarget} = cfg;
        const {chunks, hwAccel} = state;
        const totalEncodedBytes = chunks.reduce((s, c) => s + c.data.byteLength, 0);
        const keyFrames = chunks.filter(c => c.isKey).length;
        const durationSec = totalFrames / fps;
        const sizes = chunks.map(c => c.data.byteLength);
        return {
            configureTime, loadTime, encodeTime, muxTime,
            totalTime: performance.now() - t0,
            framesEncoded: totalFrames,
            keyFrames, deltaFrames: totalFrames - keyFrames,
            totalEncodedBytes,
            avgBitsPerFrame: chunks.length > 0 ? Math.round(totalEncodedBytes * 8 / chunks.length) : 0,
            peakFrameSize: sizes.length > 0 ? Math.max(...sizes) : 0,
            minFrameSize: sizes.length > 0 ? Math.min(...sizes) : 0,
            hardwareAcceleration: hwAccel,
            inputResolution: `${width}x${height}`,
            encodedResolution: `${encWidth}x${encHeight}`,
            bitrateTarget,
            bitrateActual: durationSec > 0 ? Math.round(totalEncodedBytes * 8 / durationSec) : 0,
            containerOverhead: mp4blob.size - totalEncodedBytes,
            encodingFps: encodeTime > 0 ? (totalFrames / (encodeTime / 1000)).toFixed(1) : 0,
            fps,
        };
    },
    /**
     * Приводит ArrayBuffer или TypedArray к чистому ArrayBuffer
     */
    _toArrayBuffer(source) {
        if (source instanceof ArrayBuffer) return source;
        if (ArrayBuffer.isView(source))
            return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
        return new Uint8Array(source).buffer;
    },
    /**
     * Загружает изображение: data URL или Blob в ImageBitmap
     */
    async _loadImage(src) {
        const blob = typeof src === 'string' ? ImageProcessor.decodeBase64(src) : src;
        if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
        // фоллбэк для окружений без createImageBitmap
        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(blob);
            img.onload = () => {
                URL.revokeObjectURL(url);
                resolve(img);
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Не удалось загрузить изображение'));
            };
            img.src = url;
        });
    },
};

export {VideoEncoderUtil};
