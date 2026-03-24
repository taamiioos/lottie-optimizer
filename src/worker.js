// воркер для оптимизации Lottie вне основного потока
import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
self.JSZip = JSZip;
import {Optimizer} from './optimizer.js';
import {restoreAnimation} from './player.js';

// нужен и для кодирования (optimize) и для декодирования (restore)
let _mp4boxLoaded = false;
const loadMp4Box = async () => {
    if (_mp4boxLoaded) return;
    const code = await (await fetch('https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js')).text();
    (0, eval)(code);
    _mp4boxLoaded = true;
};

self.onmessage = async ({data: msg}) => {
    const {id, type} = msg;

    try {
        // mp4box нужен обоим операциям
        await loadMp4Box();
        switch (type) {
            case 'optimize': {
                const result = await Optimizer.run(msg.data, {
                    ...msg.options,
                    onProgress: (info) => self.postMessage({id, type: 'progress', info})
                });
                if (result.preview?.assets) {
                    for (const pa of result.preview.assets) {
                        if (pa._video && pa.p?.startsWith('data:')) pa.p = '';
                    }
                }
                const zipBuffer = await result.zip.arrayBuffer();
                self.postMessage({
                    id, type: 'result',
                    result: {
                        json: result.json,
                        preview: result.preview,
                        stats: result.stats,
                        sequences: result.sequences,
                        videoAssets: result.videoAssets,
                        urls: result.urls,
                        zipBuffer
                    }
                }, [zipBuffer]);
                break;
            }

            case 'restore': {
                const zipBlob = new Blob([msg.zipBuffer], {type: 'application/zip'});
                const result = await restoreAnimation(msg.json, zipBlob, {
                    workerSafe: true, // не пытаться использовать document.createElement('video')
                    onProgress: (info) => self.postMessage({id, type: 'progress', info})
                });
                self.postMessage({id, type: 'restore-result', result});
                break;
            }

            default:
                self.postMessage({id, type: 'error', message: `Неизвестный тип сообщения: ${type}`});
        }
    } catch (err) {
        self.postMessage({id, type: 'error', message: err.message});
    }
};
