import * as debug from './util/debug';
import { NALU } from './util/nalu.js';
import { H264Parser } from './parsers/h264.js';
import { AACParser } from './parsers/aac.js';
import Event from './util/event';
import RemuxController from './controller/remux.js';
import BufferController from './controller/buffer.js';

window.MediaSource = window.MediaSource || window.WebKitMediaSource;

export default class JMuxmer extends Event {

    static isSupported(codec) {
        return (window.MediaSource && window.MediaSource.isTypeSupported(codec));
    }

    constructor(options) {
        super('jmuxer');
        window.MediaSource = window.MediaSource || window.WebKitMediaSource;

        let defaults = {
            node: '',
            mode: 'both', // both, audio, video
            flushingTime: 1500,
            clearBuffer: true,
            onReady: null, // function called when MSE is ready to accept frames
            fps: 30,
            debug: false
        };
        this.options = Object.assign({}, defaults, options);

        if (this.options.debug) {
            debug.setLogger();
        }

        if (typeof this.options.node === 'string' && this.options.node == '') {
            debug.error('no video element were found to render, provide a valid video element');
        }

        if (!this.options.fps) {
            this.options.fps = 30;
        }
        this.frameDuration = (1000 / this.options.fps) | 0; // todo remove

        this.node = typeof this.options.node === 'string' ? document.getElementById(this.options.node) : this.options.node;
    
        this.sourceBuffers = {};
        this.isMSESupported = !!window.MediaSource;
       
        if (!this.isMSESupported) {
            throw 'Oops! Browser does not support media source extension.';
        }

        this.setupMSE();
        this.remuxController = new RemuxController(this.options.clearBuffer); 
        this.remuxController.addTrack(this.options.mode);

        this.mseReady = false;
        this.lastCleaningTime = Date.now();
        this.kfPosition = [];
        this.kfCounter  = 0;

        /* events callback */
        this.remuxController.on('buffer', this.onBuffer.bind(this));
        this.remuxController.on('ready', this.createBuffer.bind(this));
        this.startInterval();

        // since we are streaming realtime, always seek to the latest time after pause
        this.node.addEventListener('play', (event) => {
            this.node.currentTime = this.remuxController.tracks['video'].dts / 1000;
        });
    }

    setupMSE() {
        this.mediaSource = new MediaSource();
        this.node.src = URL.createObjectURL(this.mediaSource);
        this.mediaSource.addEventListener('sourceopen', this.onMSEOpen.bind(this));
        this.mediaSource.addEventListener('sourceclose', this.onMSEClose.bind(this));
        this.mediaSource.addEventListener('webkitsourceopen', this.onMSEOpen.bind(this));
        this.mediaSource.addEventListener('webkitsourceclose', this.onMSEClose.bind(this));
    }

    feed(data) {
        let remux = false,
            slices,
            duration,
            chunks = {
                video: [],
                audio: []
            };

        if (!data || !this.remuxController) return;
        duration = data.duration ? parseInt(data.duration) : 0;
        if (data.video) {  
            slices = H264Parser.extractNALu(data.video);
            if (slices.length > 0) {
                chunks.video = this.getVideoFrames(slices, duration);
                remux = true;
            }
        }
        if (data.audio) {
            slices = AACParser.extractAAC(data.audio);
            if (slices.length > 0) {
                chunks.audio = this.getAudioFrames(slices, duration);
                remux = true;
            }
        }
        if (!remux) {
            debug.error('Input object must have video and/or audio property. Make sure it is a valid typed array');
            return;
        }
        this.remuxController.remux(chunks);
    }

    getVideoFrames(nalus, duration) {
        let units = [],
            frames = [],
            fd = 0,
            tt = 0,
            keyFrame = false,
            vcl = false;

        for (let nalu of nalus) {
            let unit = new NALU(nalu);
            if (unit.type() === NALU.IDR || unit.type() === NALU.NDR) {
                H264Parser.parseHeader(unit);
            }
            if (units.length && vcl && (unit.isfmb || !unit.isvcl)) {
                frames.push({
                    units,
                    keyFrame
                });
                units = [];
                keyFrame = false;
                vcl = false;
            }
            units.push(unit);
            keyFrame = keyFrame || unit.isKeyframe();
            vcl = vcl || unit.isvcl;
        }
        if (units.length) {
            if (vcl || !frames.length) {
                frames.push({
                    units,
                    keyFrame
                });
            } else {
                let last = frames.length - 1;
                frames[last].units = frames[last].units.concat(units);
            }
        }
        fd = duration ? duration / frames.length | 0 : this.frameDuration;
        tt = duration ? (duration - (fd * frames.length)) : 0;
        
        frames.map((frame) => {
            frame.duration = fd;
            if (tt > 0) {
                frame.duration++;
                tt--;
            }
            this.kfCounter++;
            if (frame.keyFrame && this.options.clearBuffer) {
                this.kfPosition.push((this.kfCounter * fd) / 1000);
            }
        });
        debug.log(`jmuxer: No. of frames of the last chunk: ${frames.length}`);
        return frames;
    }

    getAudioFrames(aacFrames, duration) {
        let frames = [],
            fd = 0,
            tt = 0;

        for (let units of aacFrames) {
            frames.push({units});
        }
        fd = duration ? duration / frames.length | 0 : this.frameDuration;
        tt = duration ? (duration - (fd * frames.length)) : 0;
        frames.map((frame) => {
            frame.duration = fd;
            if (tt > 0) {
                frame.duration++;
                tt--;
            }
        });
        return frames;
    }

    destroy() {
        this.stopInterval();
        if (this.mediaSource) {
            try {
                if (this.bufferControllers) {
                    this.mediaSource.endOfStream();
                }
            } catch (e) {
                debug.error(`mediasource is not available to end ${e.message}`);
            }
            this.mediaSource = null;
        }
        if (this.remuxController) {
            this.remuxController.destroy();
            this.remuxController = null;
        }
        if (this.bufferControllers) {
            for (let type in this.bufferControllers) {
                this.bufferControllers[type].destroy();
            }
            this.bufferControllers = null;
        }
        this.node = false;
        this.mseReady = false;
        this.videoStarted = false;
    }

    createBuffer() {
        if (!this.mseReady || !this.remuxController || !this.remuxController.isReady() || this.bufferControllers) return;
        this.bufferControllers = {};
        for (let type in this.remuxController.tracks) {
            let track = this.remuxController.tracks[type];
            if (!JMuxmer.isSupported(`${type}/mp4; codecs="${track.mp4track.codec}"`)) {
                debug.error('Browser does not support codec');
                return false;
            }
            let sb = this.mediaSource.addSourceBuffer(`${type}/mp4; codecs="${track.mp4track.codec}"`);
            this.bufferControllers[type] = new BufferController(sb, type);
            this.sourceBuffers[type] = sb;
            this.bufferControllers[type].on('error', this.onBufferError.bind(this));
        }
    }

    startInterval() {
        this.interval = setInterval(()=>{
            if (this.bufferControllers) {
                this.clearBuffer();
            }
        }, this.options.flushingTime);
    }

    stopInterval() {
        if (this.interval) {
            clearInterval(this.interval);
        }
    }

    releaseBuffer() {
        for (let type in this.bufferControllers) {
            this.bufferControllers[type].doAppend();
        }
    }

    getSafeClearOffsetOfBuffer(offset) {
        let maxLimit = (this.options.mode === 'audio' && offset) || 0,
            adjacentOffset;
        for (let i = 0; i < this.kfPosition.length; i++) {
            if (this.kfPosition[i] >= offset) {
                break;
            }
            adjacentOffset = this.kfPosition[i];
        }
        if (adjacentOffset) {
            this.kfPosition = this.kfPosition.filter( kfDelimiter => {
                if (kfDelimiter < adjacentOffset) {
                    maxLimit = kfDelimiter;
                }
                return kfDelimiter >= adjacentOffset;
            });
        }
        return maxLimit;
    }

    clearBuffer() {
        if (this.options.clearBuffer && (Date.now() - this.lastCleaningTime) > 10000) {
            for (let type in this.bufferControllers) {
                let cleanMaxLimit = this.getSafeClearOffsetOfBuffer(this.node.currentTime);
                this.bufferControllers[type].initCleanup(cleanMaxLimit);
            }
            this.lastCleaningTime = Date.now();
        }
    }

    onBuffer(data) {
        if (this.bufferControllers && this.bufferControllers[data.type]) {
            this.bufferControllers[data.type].feed(data.payload);
        }
        this.releaseBuffer();
    }

    /* Events on MSE */
    onMSEOpen() {
        this.mseReady = true;
        if (typeof this.options.onReady === 'function') {
            this.options.onReady();
            this.options.onReady = null;
        }
        this.createBuffer();
    }

    onMSEClose() {
        this.mseReady = false;
        this.videoStarted = false;
    }

    onBufferError(data) {
        if (data.name == 'QuotaExceeded') {
            this.bufferControllers[data.type].initCleanup(this.node.currentTime);
            return;
        }

        if (this.mediaSource.sourceBuffers.length > 0 && this.sourceBuffers[data.type]) {
            this.mediaSource.removeSourceBuffer(this.sourceBuffers[data.type]);
        }
        if (this.mediaSource.sourceBuffers.length == 0) {
            try {
                this.mediaSource.endOfStream();
            } catch (e) {
                debug.error('mediasource is not available to end');
            }
        }
    }
}