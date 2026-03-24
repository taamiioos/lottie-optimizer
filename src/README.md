

## Optimizer

### Optimizer.run(data, options)

Оптимизирует Lottie JSON. Конвертирует изображения в WebP, последовательности кадров кодирует в H.264/MP4, упаковывает всё в ZIP.

**Параметры**

| Параметр | Тип | По умолчанию | Описание |
|---|---|---|---|
| data | object | — | Lottie JSON объект |
| quality | number | 0.8 | Качество WebP для одиночных изображений (0–1) |
| convertToVideo | boolean | true | Кодировать последовательности кадров в MP4 |
| videoFps | number | data.fr или 24 | FPS видео |
| videoBitrateMultiplier | number | 1 | Множитель битрейта видео |
| onProgress | function | — | Колбэк прогресса |
| worker | boolean | false | Запустить в Web Worker — не блокирует UI (необязательно) |

**Возвращает** `Promise<result>`

| Поле | Тип | Описание |
|---|---|---|
| json | object | Оптимизированный Lottie JSON |
| zip | Blob | ZIP-архив с ассетами |
| preview | object | JSON для превью (с blob URL вместо base64) |
| stats | object | Статистика оптимизации |
| sequences | array | Найденные последовательности кадров |
| videoAssets | array | Метаданные закодированных видео |
| urls | array | Blob URL для превью (нужно освободить после использования) |

**Колбэк onProgress**

```js
onProgress({ phase, message, percent })
// phase: 'analysis' | 'video' | 'images' | 'zip' | 'done'
// percent: 0–100
```

**Примеры**

```js
// Базовое использование
const result = await Optimizer.run(lottieJson);
```

```js
// С настройками и прогрессом
const result = await Optimizer.run(lottieJson, {
    quality: 0.85,
    videoFps: 30,
    onProgress: ({ message, percent }) => {
        console.log(`${percent}% — ${message}`);
    }
});

// Скачать ZIP
const zipUrl = URL.createObjectURL(result.zip);
const a = document.createElement('a');
a.href = zipUrl;
a.download = 'assets.zip';
a.click();
```

```js
// В Web Worker — не блокирует UI во время оптимизации
const result = await Optimizer.run(lottieJson, { worker: true });
```

---

## Player

### Player.restore(json, zipBlob, options)

Восстанавливает анимацию из оптимизированного JSON + ZIP. Распаковывает ассеты, декодирует видеокадры через WebCodecs, подставляет blob URL в JSON. Возвращает данные, готовые для передачи в `lottie.loadAnimation()`.

**Параметры**

| Параметр | Тип | Описание |
|---|---|---|
| json | object | Оптимизированный Lottie JSON |
| zipBlob | Blob или null | ZIP с ассетами (null если анимация самодостаточна) |
| options.onProgress | function | Колбэк прогресса |

**Возвращает** `Promise<{ data, stats }>`

| Поле | Тип | Описание |
|---|---|---|
| data | object | Lottie JSON с blob URL вместо ссылок на файлы |
| stats | object | Статистика восстановления |

**Пример**

```js
const { data } = await Player.restore(json, zipBlob, {
    onProgress: ({ phase, percent }) => {
        progressBar.style.width = percent + '%';
    }
});

lottie.loadAnimation({
    container: document.getElementById('player'),
    renderer: 'canvas',
    loop: true,
    autoplay: true,
    animationData: data
});
```

---

### Player.restoreInWorker(json, zipBlob, options)

То же что `restore()`, но работает в Web Worker — не блокирует основной поток. Автоматически падает обратно на `restore()` если браузер не поддерживает Workers или WebCodecs.

Если воркер не нужен — используйте `Player.restore()` напрямую.

**Параметры**

| Параметр | Тип | Описание |
|---|---|---|
| json | object | Оптимизированный Lottie JSON |
| zipBlob | Blob или null | ZIP с ассетами |
| options.onProgress | function | Колбэк прогресса |
**Пример**

```js
const { data } = await Player.restoreInWorker(json, zipBlob, {
    onProgress: ({ percent }) => {...}
});
```

---

### Player.validate(json, zipBlob)

Проверяет совместимость JSON и ZIP перед воспроизведением. Полезно показать понятную ошибку пользователю до начала загрузки.

**Возвращает** `Promise<{ requiresZip, errors, warnings }>`

| Поле | Тип | Описание |
|---|---|---|
| requiresZip | boolean | Анимация требует ZIP |
| errors | string[] | Критические ошибки (ZIP не тот, файлы отсутствуют) |
| warnings | string[] | Предупреждения (лишние файлы в ZIP) |

**Пример**

```js
const { errors, warnings } = await Player.validate(json, zipBlob);

if (errors.length > 0) {
    showError(errors.join('\n'));
    return;
}

const { data } = await Player.restore(json, zipBlob);
```

---

## Модули

| Файл | Экспорт | Описание |
|---|---|---|
| optimizer.js | Optimizer, formatSize | Пайплайн оптимизации |
| player.js | Player, restoreAnimation, validateFilesMatch | Восстановление анимации |
| image.js | ImageProcessor | Конвертация WebP, SHA-256 хеш, детект формата |
| video.js | VideoEncoderUtil | Кодирование кадров в H.264/MP4, детект ключевых кадров |
| worker.js | — | Module Worker (optimize + restore) |
| index.js | Optimizer, Player | Публичный реэкспорт |

---

## Как работает оптимизатор

**Анализ** — проходит по ассетам, считает хеши, определяет форматы по magic bytes, вычисляет размеры.

**Поиск последовательностей** — группирует ассеты по id-паттернам (числовой id, `frame_001_uuid`, `image_01`, `img0`). Группа из 3+ ассетов с одним префиксом и последовательными числами считается видеопоследовательностью.

**Кодирование в H.264** — каждый кадр рисуется в OffscreenCanvas, из него создаётся VideoFrame, VideoEncoder кодирует поток. Уровень кодека выбирается автоматически по количеству макроблоков. Если итоговый MP4 тяжелее оригинала — кодирование отбрасывается.

**Обработка изображений** — SHA-256 хеш для дедупликации, попытка конвертации в WebP, откат к оригиналу если WebP тяжелее.

**Упаковка** — изображения в `assets/`, видео в `video/`. Хранение без дополнительного сжатия (MP4 и WebP уже сжаты).

## Как работает плеер

**Распаковка изображений** — файлы из ZIP превращаются в blob URL и подставляются в поля `p` ассетов.

**Декодирование видео** — MP4Box демультиплексирует контейнер, VideoDecoder декодирует кадры в OffscreenCanvas, каждый кадр конвертируется в blob URL. Конвертация всех кадров параллельная. Fallback через `<video>` + seek если WebCodecs недоступен.

**Запуск** — JSON с подставленными blob URL передаётся в `lottie.loadAnimation()`. bodymovin не знает ни о ZIP, ни о видео.
