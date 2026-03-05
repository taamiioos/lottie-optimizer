// кодирование видео через webcodecs + mp4box
const VideoEncoderUtil = {
    async encode(frames, options = {}) {
        const { fps = 24, bitrateMultiplier = 1, onProgress = () => {} } = options;
        // сначала проверяем, вообще есть ли в браузере нужный api
        if (!('VideoEncoder' in window)) {
            throw new Error('webcodecs api не поддерживается в этом браузере');
        }
        const t0 = performance.now();
        // размеры берём из первого кадра, остальные могут быть такими же
        const firstImg = await this._loadImage(frames[0]);
        const width = firstImg.naturalWidth || firstImg.width;
        const height = firstImg.naturalHeight || firstImg.height;
        const encWidth = width % 2 === 0 ? width : width + 1;
        const encHeight = height % 2 === 0 ? height : height + 1;

        // создаём оффскрин канвас нужного размера
        const canvas = new OffscreenCanvas(encWidth, encHeight);
        const ctx = canvas.getContext('2d');

        const encodedChunks = []; // сюда будем складывать все закодированные чанки
        let encoderConfig = null; // потом понадобится для mp4

        const timescale = 90000; // стандартное значение для mp4
        const sampleDuration = Math.round(timescale / fps); // сколько тиков длится один кадр
        // объект со всей статистикой
        const encodingStats = {
            configureTime: 0,
            loadTime: 0,
            encodeTime: 0,
            muxTime: 0,
            totalTime: 0,
            framesEncoded: 0,
            keyFrames: 0,
            deltaFrames: 0,
            totalEncodedBytes: 0,
            avgBitsPerFrame: 0,
            peakFrameSize: 0,
            minFrameSize: Infinity,
            hardwareAcceleration: 'unknown',
            inputResolution: `${width}x${height}`,
            encodedResolution: `${encWidth}x${encHeight}`,
            bitrateActual: 0,
            bitrateTarget: 0,
            fps
        };

        // подбираем битрейт автоматически под разрешение
        const pixelsPerFrame = encWidth * encHeight;
        const bitrateTarget = Math.max(200_000, Math.min(8_000_000, Math.round(pixelsPerFrame * 0.15 * fps * bitrateMultiplier)));
        encodingStats.bitrateTarget = bitrateTarget;

        const configT0 = performance.now();
        // выбираем уровень H.264 под конкретное разрешение
        const codec = _pickAvcCodec(encWidth, encHeight);

        // пытаемся включить аппаратное ускорение
        let hwAccel = 'prefer-software';
        try {
            const support = await VideoEncoder.isConfigSupported({
                codec,
                width: encWidth,
                height: encHeight,
                bitrate: bitrateTarget,
                framerate: fps,
                hardwareAcceleration: 'prefer-hardware'
            });
            if (support.supported) hwAccel = 'prefer-hardware';
        } catch (e) {
        }

        encodingStats.hardwareAcceleration = hwAccel;

        const encoderCfg = {
            codec,
            width: encWidth,
            height: encHeight,
            bitrate: bitrateTarget,
            framerate: fps,
            hardwareAcceleration: hwAccel,
            latencyMode: 'quality',
            avc: { format: 'avc' }
        };

        let encoderError = null;
        // создаём сам энкодер и вешаем колбэки
        const encoder = new VideoEncoder({
            output: (chunk, metadata) => {
                const buf = new ArrayBuffer(chunk.byteLength);
                chunk.copyTo(buf);

                const isKey = chunk.type === 'key';

                encodedChunks.push({
                    data: buf,
                    timestamp: chunk.timestamp,
                    duration: chunk.duration || sampleDuration,
                    isKey
                });

                // собираем статистику по кадрам
                if (isKey) encodingStats.keyFrames++;
                else encodingStats.deltaFrames++;

                encodingStats.totalEncodedBytes += chunk.byteLength;

                if (chunk.byteLength > encodingStats.peakFrameSize) encodingStats.peakFrameSize = chunk.byteLength;
                if (chunk.byteLength < encodingStats.minFrameSize) encodingStats.minFrameSize = chunk.byteLength;

                // сохраняем decoderConfig, он нужен для mp4
                if (metadata?.decoderConfig && !encoderConfig) {
                    encoderConfig = metadata.decoderConfig;
                }
            },
            error: (e) => { encoderError = e; }
        });

        encoder.configure(encoderCfg);
        encodingStats.configureTime = performance.now() - configT0;

        const frameDurationUs = Math.round(1_000_000 / fps); // длительность кадра в микросекундах

        // параллельно декодируем все кадры в ImageBitmap
        // ОПТИМИЗАЦИЯ: раньше был await в цикле — каждый кадр ждал предыдущего.
        // Теперь Promise.all грузит все сразу, пока энкодер настраивается.
        const loadT0 = performance.now();
        const images = await Promise.all(
            frames.map((f, i) => i === 0 ? Promise.resolve(firstImg) : this._loadImage(f))
        );
        encodingStats.loadTime = performance.now() - loadT0;
        if (encoderError) throw encoderError;

        const encodeT0 = performance.now();

        // определяем где ключевые кадры — первый всегда, плюс там где сцена резко изменилась
        const keyFrameSet = _detectKeyFrames(images);

        // если размер кадров совпадает с размером энкодера — canvas не нужен,
        // VideoFrame создаём прямо из ImageBitmap
        // ОПТИМИЗАЦИЯ: раньше каждый кадр проходил на canvas.
        // Теперь при чётных размерах VideoFrame создаётся прямо из ImageBitmap
        const needsPadding = width !== encWidth || height !== encHeight;
        // основной цикл кодирования — строго последовательно
        for (let i = 0; i < images.length; i++) {
            if (encoderError) throw encoderError;
            const img = images[i];
            let vf;
            if (needsPadding) {
                ctx.clearRect(0, 0, encWidth, encHeight);
                ctx.drawImage(img, 0, 0, encWidth, encHeight);
                vf = new VideoFrame(canvas, { timestamp: i * frameDurationUs, duration: frameDurationUs });
            } else {
                vf = new VideoFrame(img, { timestamp: i * frameDurationUs, duration: frameDurationUs });
            }
            if (img.close) img.close(); // освобождаем память

            encoder.encode(vf, { keyFrame: keyFrameSet.has(i) });
            vf.close();

            encodingStats.framesEncoded++;
            onProgress(Math.round((i + 1) / images.length * 100), i + 1, images.length);
        }
        if (!encoderError) {
            await encoder.flush();
        }
        encoder.close();
        if (encoderError) throw encoderError;
        if (encodedChunks.length === 0) throw new Error('энкодер вообще ничего не выдал');
        if (!encoderConfig?.description) throw new Error('не получили avc decoder config');
        // теперь пакуем всё в mp4 контейнер
        const muxT0 = performance.now();
        encodingStats.encodeTime = muxT0 - encodeT0; // только сам энкодинг, без мультиплексирования
        const mp4blob = this._muxToMP4(encodedChunks, {
            width: encWidth,
            height: encHeight,
            timescale,
            sampleDuration,
            fps,
            encoderConfig
        });

        encodingStats.muxTime = performance.now() - muxT0;
        encodingStats.totalTime = performance.now() - t0;
        // финальные расчёты статистики
        if (encodingStats.minFrameSize === Infinity) encodingStats.minFrameSize = 0;

        const durationSec = frames.length / fps;
        encodingStats.avgBitsPerFrame = encodedChunks.length > 0
            ? Math.round(encodingStats.totalEncodedBytes * 8 / encodedChunks.length)
            : 0;

        encodingStats.bitrateActual = durationSec > 0
            ? Math.round(encodingStats.totalEncodedBytes * 8 / durationSec)
            : 0;

        encodingStats.containerOverhead = mp4blob.size - encodingStats.totalEncodedBytes;
        encodingStats.encodingFps = encodingStats.encodeTime > 0
            ? (frames.length / (encodingStats.encodeTime / 1000)).toFixed(1)
            : 0;

        return {
            blob: mp4blob,
            width: encWidth,
            height: encHeight,
            codec: 'h264',
            mime: 'video/mp4',
            frames: frames.length,
            fps,
            duration: durationSec,
            encodingStats
        };
    },
    // webcodecs может вернуть что угодно, а mp4box хочет именно ArrayBuffer
    _toArrayBuffer(source) {
        if (source instanceof ArrayBuffer) return source;
        if (ArrayBuffer.isView(source)) {
            return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
        }
        return new Uint8Array(source).buffer;
    },
    // мультиплексирование всех чанков в mp4
    _muxToMP4(chunks, opts) {
        const { width, height, timescale, sampleDuration, encoderConfig } = opts;

        const mp4file = MP4Box.createFile();
        // mp4box требует ArrayBuffer
        const description = this._toArrayBuffer(encoderConfig.description);

        const trackId = mp4file.addTrack({
            timescale,
            width,
            height,
            nb_samples: chunks.length,
            brands: ['isom', 'iso2', 'avc1', 'mp41'],
            avcDecoderConfigRecord: description
        });
        // добавляем все сэмплы
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const ab = chunk.data instanceof ArrayBuffer ? chunk.data : this._toArrayBuffer(chunk.data);

            mp4file.addSample(trackId, ab, {
                duration: sampleDuration,
                is_sync: chunk.isKey,
                cts: 0,
                dts: i * sampleDuration
            });
        }
        const stream = new DataStream();
        stream.endianness = DataStream.BIG_ENDIAN;
        mp4file.write(stream);

        return new Blob([stream.buffer], { type: 'video/mp4' });
    },
    // загрузка картинки в Image или createImageBitmap
    async _loadImage(blob) {
        if (typeof createImageBitmap === 'function') {
            return createImageBitmap(blob);
        }
        // старый способ через Image
        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(blob);

            img.onload = () => {
                URL.revokeObjectURL(url);
                resolve(img);
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('не удалось загрузить изображение'));
            };
            img.src = url;
        });
    }
};

// ОПТИМИЗАЦИЯ: раньше ключевые кадры ставились механически каждые 30 кадров.
// Теперь сравниваем соседние кадры — ключевой кадр только при реальной смене сцены.
const _detectKeyFrames = (images, threshold = 45) => {
    const kf = new Set([0]); // первый всегда ключевой
    if (images.length <= 1) return kf;
    const SIZE = 32;
    const canvas = new OffscreenCanvas(SIZE, SIZE);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    let prevPixels = null;
    for (let i = 0; i < images.length; i++) {
        ctx.drawImage(images[i], 0, 0, SIZE, SIZE);
        const curr = ctx.getImageData(0, 0, SIZE, SIZE).data;

        if (prevPixels) {
            let diff = 0;
            for (let p = 0; p < curr.length; p += 4) {
                diff += Math.abs(curr[p]     - prevPixels[p])
                      + Math.abs(curr[p + 1] - prevPixels[p + 1])
                      + Math.abs(curr[p + 2] - prevPixels[p + 2]);
            }
            if (diff / (SIZE * SIZE * 3) > threshold) kf.add(i);
        }

        prevPixels = curr.slice();
    }
    return kf;
}
const _pickAvcCodec = (width, height) => {
    const mbW = Math.ceil(width  / 16);
    const mbH = Math.ceil(height / 16);
    const mbs = mbW * mbH;

    if (mbs <=  1620) return 'avc1.42E01E';
    if (mbs <=  3600) return 'avc1.42E01F';
    if (mbs <=  5120) return 'avc1.42E020';
    if (mbs <=  8192) return 'avc1.42E028';
    if (mbs <=  8704) return 'avc1.42E02A';
    if (mbs <= 22080) return 'avc1.42E032';
                      return 'avc1.42E033';
}

export { VideoEncoderUtil };