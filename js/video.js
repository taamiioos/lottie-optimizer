// кодирование видео через webcodecs + mp4box
const VideoEncoderUtil = {
    async encode(frames, options = {}) {
        const { fps = 24, onProgress = () => {} } = options;

        // сначала проверяем, вообще есть ли в браузере нужный api
        if (!('VideoEncoder' in window)) {
            throw new Error('webcodecs api не поддерживается в этом браузере');
        }

        const t0 = performance.now(); // засекаем общее время

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
        const bitrateTarget = Math.max(200_000, Math.min(4_000_000, Math.round(pixelsPerFrame * 0.15 * fps)));
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

        const encodeT0 = performance.now();
        const frameDurationUs = Math.round(1_000_000 / fps); // длительность кадра в микросекундах

        // основной цикл кодирования
        for (let i = 0; i < frames.length; i++) {
            if (encoderError) throw encoderError;

            // первый кадр уже загружен, остальные грузим по мере надобности
            const img = i === 0 ? firstImg : await this._loadImage(frames[i]);

            // проверяем снова — error callback мог прилететь пока ждали картинку
            // именно здесь и происходила ошибка «encode on closed codec»
            if (encoderError) throw encoderError;

            ctx.clearRect(0, 0, encWidth, encHeight);
            ctx.drawImage(img, 0, 0, encWidth, encHeight);
            if (img.close) img.close(); // освобождаем память

            // создаём VideoFrame и отправляем на кодирование
            const vf = new VideoFrame(canvas, {
                timestamp: i * frameDurationUs,
                duration: frameDurationUs
            });
            const keyFrame = i % 30 === 0;
            encoder.encode(vf, { keyFrame });
            vf.close();

            encodingStats.framesEncoded++;
            onProgress(Math.round((i + 1) / frames.length * 100), i + 1, frames.length);
        }

        // не вызываем flush на уже закрытом энкодере — он выбросит ещё одну ошибку
        if (!encoderError) {
            await encoder.flush();
        }
        encoder.close();

        if (encoderError) throw encoderError;

        if (encodedChunks.length === 0) throw new Error('энкодер вообще ничего не выдал');
        if (!encoderConfig?.description) throw new Error('не получили avc decoder config');

        // теперь пакуем всё в mp4 контейнер
        const muxT0 = performance.now();
        const mp4blob = this._muxToMP4(encodedChunks, {
            width: encWidth,
            height: encHeight,
            timescale,
            sampleDuration,
            fps,
            encoderConfig
        });

        encodingStats.encodeTime = performance.now() - encodeT0;
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

    // маленькая утилита — приводит description к ArrayBuffer
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

        // mp4box требует ArrayBuffer для avcDecoderConfigRecord
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

// выбираем нужный уровень H.264 по количеству макроблоков 16x16
// чем больше разрешение, тем выше нужен уровень
function _pickAvcCodec(width, height) {
    const mbW = Math.ceil(width  / 16);
    const mbH = Math.ceil(height / 16);
    const mbs = mbW * mbH; // макроблоков на кадр

    if (mbs <=  1620) return 'avc1.42E01E';
    if (mbs <=  3600) return 'avc1.42E01F';
    if (mbs <=  5120) return 'avc1.42E020';
    if (mbs <=  8192) return 'avc1.42E028';
    if (mbs <=  8704) return 'avc1.42E02A';
    if (mbs <= 22080) return 'avc1.42E032';
                      return 'avc1.42E033';
}