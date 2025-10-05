// Opcodes
export const MGMT_OP_READ = 0;
export const MGMT_OP_READ_RSP = 1;
export const MGMT_OP_WRITE = 2;
export const MGMT_OP_WRITE_RSP = 3;

// Groups
export const MGMT_GROUP_ID_OS = 0;
export const MGMT_GROUP_ID_IMAGE = 1;
export const MGMT_GROUP_ID_STAT = 2;
export const MGMT_GROUP_ID_CONFIG = 3;
export const MGMT_GROUP_ID_LOG = 4;
export const MGMT_GROUP_ID_CRASH = 5;
export const MGMT_GROUP_ID_SPLIT = 6;
export const MGMT_GROUP_ID_RUN = 7;
export const MGMT_GROUP_ID_FS = 8;
export const MGMT_GROUP_ID_SHELL = 9;

// OS group
export const OS_MGMT_ID_ECHO = 0;
export const OS_MGMT_ID_CONS_ECHO_CTRL = 1;
export const OS_MGMT_ID_TASKSTAT = 2;
export const OS_MGMT_ID_MPSTAT = 3;
export const OS_MGMT_ID_DATETIME_STR = 4;
export const OS_MGMT_ID_RESET = 5;

// Image group
export const IMG_MGMT_ID_STATE = 0;
export const IMG_MGMT_ID_UPLOAD = 1;
export const IMG_MGMT_ID_FILE = 2;
export const IMG_MGMT_ID_CORELIST = 3;
export const IMG_MGMT_ID_CORELOAD = 4;
export const IMG_MGMT_ID_ERASE = 5;

// FS group
export const FS_MGMT_ID_FILE_UPLOAD_DOWNLOAD = 0;
export const FS_MGMT_ID_FILE_STATUS = 1;
export const FS_MGMT_ID_FILE_CLOSE = 4;

import CBOR from './cbor';

// Serial frame states
const SERIAL_FRAME_STATE = {
    IDLE: 'idle',
    RECV_PKT_SECOND: 'recv_pkt_second',
    RECV_FRAG_SECOND: 'recv_frag_second',
    COLLECT_PKT: 'collect_pkt',
    COLLECT_FRAG: 'collect_frag'
};

const MCUMGR_SERIAL_HDR_PKT = 0x0609;
const MCUMGR_SERIAL_HDR_FRAG = 0x0414;
const MCUMGR_SERIAL_MAX_FRAME = 127;
const MCUMGR_SERIAL_HDR_PKT_1 = MCUMGR_SERIAL_HDR_PKT >> 8;
const MCUMGR_SERIAL_HDR_PKT_2 = MCUMGR_SERIAL_HDR_PKT & 0xff;
const MCUMGR_SERIAL_HDR_FRAG_1 = MCUMGR_SERIAL_HDR_FRAG >> 8;
const MCUMGR_SERIAL_HDR_FRAG_2 = MCUMGR_SERIAL_HDR_FRAG & 0xff;
const SERIAL_NEWLINE = 0x0a;

class MCUManager {
    constructor(di = {}) {
        this.SERVICE_UUID = '8d53dc1d-1db7-4cd3-868b-8a527460aa84';
        this.CHARACTERISTIC_UUID = 'da2e7828-fbce-4e01-ae9e-261174997c48';
        this._mtu = 244; // default MTU size
        this._netbuf_size = 2450; // default netbuf size
        this._device = null;
        this._service = null;
        this._characteristic = null;
        this._connectCallback = null;
        this._connectingCallback = null;
        this._disconnectCallback = null;
        this._messageCallback = null;
        this._imageUploadProgressCallback = null;
        this._uploadIsInProgress = false;
        this._chunkTimeout = 500; // 500ms, if sending a chunk is not completed in this time, it will be retried (even 250ms can be too low for some devices)
        this._firstChunkTimeout = 2000; // 2s for the first chunk, as it may take longer for the device to prepare
        this._retryCount = 0;
        this._buffer = new Uint8Array();
        this._logger = di.logger || { info: console.log, error: console.error };
        this._seq = 0;
        this._userRequestedDisconnect = false;
        this._transport = di.transport || 'ble';
        this._bleDisconnectListener = null;
        this._serialPort = null;
        this._serialReader = null;
        this._serialWriter = null;
        this._serialReadLoopActive = false;
        this._serialReadLoopPromise = null;
        this._serialReadChunkSize = di.serialReadChunkSize || 512;
        this._serialWriteChunkSize = di.serialWriteChunkSize || 512;
        this._serialDisconnectListener = null;
        this._serialFrameState = SERIAL_FRAME_STATE.IDLE;
        this._serialCurrentFrame = [];
        this._serialRxContext = {
            buffer: new Uint8Array(),
            expectedLength: null
        };
        this._deviceName = null;
    }

    setTransport(transport) {
        if (!['ble', 'serial'].includes(transport)) {
            throw new Error(`Unsupported transport: ${transport}`);
        }
        this._transport = transport;
        return this;
    }

    setChunkTimeout(timeout) {
        if (typeof timeout !== 'number' || timeout <= 0) {
            throw new Error('Chunk timeout must be a positive number');
        }
        this._chunkTimeout = timeout;
        this._logger.info(`Chunk timeout set to ${timeout}ms`);
        return this;
    }

    _normalizeConnectOptions(options) {
        let transport = this._transport || 'ble';
        let filters = null;
        let serial = {};

        if (Array.isArray(options) || options === null) {
            filters = options;
        } else if (options && typeof options === 'object') {
            transport = options.transport || transport;
            filters = options.filters ?? null;
        }

        return { transport, filters };
    }

    async _requestDevice(filters) {
        console.log(filters);
        const params = {
            acceptAllDevices: true,
            optionalServices: [0x180F, this.SERVICE_UUID]
        };
        if (filters) {
            params.filters = filters;
            params.acceptAllDevices = false;
        }
        return navigator.bluetooth.requestDevice(params);
    }

    async connect(options = null) {
        const { transport, filters } = this._normalizeConnectOptions(options);
        this.setTransport(transport);

        if (transport === 'ble') {
            return this._connectBle(filters);
        } else if (transport === 'serial') {
            return this._connectSerial();
        }

        throw new Error(`Unsupported transport: ${transport}`);
    }

    async _connectBle(filters) {
        try {
            if (this._bleDisconnectListener && this._device) {
                this._device.removeEventListener('gattserverdisconnected', this._bleDisconnectListener);
            }

            this._device = await this._requestDevice(filters);
            this._deviceName = this._device && this._device.name ? this._device.name : 'BLE Device';
            this._logger.info(`Connecting to device ${this.name || 'unknown'} over BLE...`);

            this._bleDisconnectListener = async event => {
                this._logger.info(event);
                if (!this._userRequestedDisconnect) {
                    this._logger.info('Trying to reconnect');
                    this._connectBleWithDelay(1000);
                } else {
                    this._disconnected();
                }
            };

            this._device.addEventListener('gattserverdisconnected', this._bleDisconnectListener);
            this._connectBleWithDelay(0);
        } catch (error) {
            this._logger.error(error);
            await this._disconnected();
        }
    }

    _connectBleWithDelay(delay = 1000) {
        setTimeout(async () => {
            try {
                if (this._connectingCallback) this._connectingCallback();
                const server = await this._device.gatt.connect();
                this._logger.info(`Server connected.`);
                this._service = await server.getPrimaryService(this.SERVICE_UUID);
                this._logger.info(`Service connected.`);
                this._characteristic = await this._service.getCharacteristic(this.CHARACTERISTIC_UUID);
                this._logger.info(`Characteristic connected.`);
                this._characteristic.addEventListener('characteristicvaluechanged', this._notification.bind(this));
                this._logger.info(`Notifications enabled.`);
                await this._characteristic.startNotifications();
                this._logger.info(`Notifications started.`);
                this._mtu = server.mtu || this._mtu;
                this._logger.info(`MTU size: ${this._mtu} bytes`);
                if (this._device && this._device.name) {
                    this._deviceName = this._device.name;
                }
                await this._connected();
                this._logger.info(`Connected.`);
                if (this._uploadIsInProgress) {
                    this._uploadNext();
                }
            } catch (error) {
                this._logger.error(error);
                await this._disconnected();
            }
        }, delay);
    }

    async _connectSerial() {
        try {
            if (!navigator.serial) {
                throw new Error('Web Serial is not supported in this browser.');
            }

            this._logger.info('Requesting serial port...');
            this._serialPort = await navigator.serial.requestPort();
            this._device = this._serialPort;

            if (this._connectingCallback) this._connectingCallback();

            await this._serialPort.open({
                baudRate: 1000000, // Using CDC ACM, so actual baud rate doesn't matter
                flowControl: 'hardware'
            });

            if (this._serialWriter) {
                try {
                    await this._serialWriter.close();
                } catch (e) {
                    this._logger.error('Serial writer close error:', e);
                }
                this._serialWriter = null;
            }

            this._serialWriter = this._serialPort.writable ? this._serialPort.writable.getWriter() : null;
            this._serialReadLoopActive = true;
            this._serialFrameState = SERIAL_FRAME_STATE.IDLE;
            this._serialCurrentFrame = [];
            this._serialRxContext = {
                buffer: new Uint8Array(),
                expectedLength: null
            };
            this._buffer = new Uint8Array();

            this._mtu = 256;

            if (!this._serialDisconnectListener) {
                this._serialDisconnectListener = event => {
                    this._logger.info('Serial port disconnect event received');
                    if (event.target === this._serialPort) {
                        this._logger.info('Serial port disconnected.');
                        this._disconnectSerial(true);
                    }
                };
                navigator.serial.addEventListener('disconnect', this._serialDisconnectListener);
            }

            this._logger.info('Serial port opened.');

            await this._connected();

            this._startSerialReadLoop();

            if (this._uploadIsInProgress) {
                this._uploadNext();
            }

            return this._serialPort;
        } catch (error) {
            this._logger.error(error);
            await this._disconnected();
        }
    }

    _startSerialReadLoop() {
        if (!this._serialPort || !this._serialPort.readable || !this._serialReadLoopActive) {
            return;
        }

        this._serialReader = this._serialPort.readable.getReader();

        const readLoop = async () => {
            try {
                while (this._serialReadLoopActive) {
                    const { value, done } = await this._serialReader.read();
                    if (done) {
                        this._logger.info('Serial stream closed');
                        break;
                    }
                    if (value) {
                        this._handleIncoming(value);
                    }
                }
            } catch (error) {
                this._logger.error('Serial read error:', error);
            } finally {
                if (this._serialReader) {
                    try {
                        this._serialReader.releaseLock();
                    } catch (releaseError) {
                        this._logger.error('Failed to release serial reader lock:', releaseError);
                    }
                    this._serialReader = null;
                }
            }
        };

        this._serialReadLoopPromise = readLoop();
    }

    async _disconnectSerial(triggeredByEvent = false) {
        if (!this._serialPort) {
            await this._disconnected();
            return;
        }

        this._logger.info('Disconnecting serial port...');
        this._serialReadLoopActive = false;

        if (this._serialReader) {
            try {
                await this._serialReader.cancel();
            } catch (error) {
                this._logger.error('Error cancelling serial reader:', error);
            }
        }

        if (this._serialReadLoopPromise) {
            try {
                await Promise.race([
                    this._serialReadLoopPromise,
                    new Promise((resolve) => setTimeout(resolve, 1000)) // 1 second timeout
                ]);
            } catch (error) {
                this._logger.error('Serial read loop error:', error);
            }
            this._serialReadLoopPromise = null;
        }

        if (this._serialWriter) {
            try {
                await this._serialWriter.close();
            } catch (error) {
                this._logger.error('Error closing serial writer:', error);
            }
            this._serialWriter = null;
        }

        if (this._serialDisconnectListener) {
            try {
                navigator.serial.removeEventListener('disconnect', this._serialDisconnectListener);
            } catch (error) {
                this._logger.error('Failed to remove serial disconnect listener:', error);
            }
            this._serialDisconnectListener = null;
        }

        if (typeof this._serialPort?.setSignals === 'function') {
            try {
                await this._serialPort.setSignals({ dataTerminalReady: false });
            } catch (error) {
                // Ignore signal errors on disconnect - device may already be gone
            }
        }

        try {
            await this._serialPort.close();
        } catch (error) {
            this._logger.error('Error closing serial port:', error);
        }

        this._serialPort = null;
        this._serialReader = null;
        this._serialFrameState = SERIAL_FRAME_STATE.IDLE;
        this._serialCurrentFrame = [];
        this._serialRxContext = {
            buffer: new Uint8Array(),
            expectedLength: null
        };

        await this._disconnected();
    }

    async disconnect() {
        this._userRequestedDisconnect = true;

        if (this._transport === 'serial') {
            return this._disconnectSerial();
        }

        if (this._device && this._device.gatt && this._device.gatt.connected) {
            return this._device.gatt.disconnect();
        }

        await this._disconnected();
    }

    onConnecting(callback) {
        this._connectingCallback = callback;
        return this;
    }

    onConnect(callback) {
        this._connectCallback = callback;
        return this;
    }

    onDisconnect(callback) {
        this._disconnectCallback = callback;
        return this;
    }

    onMessage(callback) {
        this._messageCallback = callback;
        return this;
    }

    onImageUploadProgress(callback) {
        this._imageUploadProgressCallback = callback;
        return this;
    }

    onFsUploadProgress(callback) {
        this._fsUploadProgressCallback = callback;
        return this;
    }

    onImageUploadFinished(callback) {
        this._imageUploadFinishedCallback = callback;
        return this;
    }

    onFsUploadFinished(callback) {
        this._fsUploadFinishedCallback = callback;
        return this;
    }

    async _connected() {
        if (this._connectCallback) this._connectCallback();
    }

    async _disconnected() {
        this._logger.info('Disconnected.');
        if (this._disconnectCallback) {
            this._disconnectCallback();
        }
        this._device = null;
        this._service = null;
        this._characteristic = null;
        this._uploadIsInProgress = false;
        this._userRequestedDisconnect = false;
        this._serialPort = null;
        this._serialReader = null;
        this._serialWriter = null;
        this._serialReadLoopActive = false;
        this._serialReadLoopPromise = null;
        this._serialDisconnectListener = null;
        this._serialFrameState = SERIAL_FRAME_STATE.IDLE;
        this._serialCurrentFrame = [];
        this._serialRxContext = {
            buffer: new Uint8Array(),
            expectedLength: null
        };
        this._deviceName = null;
    }

    get name() {
        return this._deviceName;
    }

    isConnected() {
        if (this._transport === 'serial') {
            return Boolean(this._serialPort && this._serialWriter && this._serialReadLoopActive);
        }

        return Boolean(this._device && this._device.gatt && this._device.gatt.connected);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    splitBuffer(buffer, chunkSize = 20) {
        const chunks = [];
        const byteArray = new Uint8Array(buffer);

        for (let i = 0; i < byteArray.length; i += chunkSize) {
            chunks.push(byteArray.slice(i, i + chunkSize));
        }

        return chunks;
    }

    async writeLargeBuffer(buffer, characteristic, mtu = 20, delayMs = 1) {
        const chunks = this.splitBuffer(buffer, mtu);
        for (const chunk of chunks) {
            try {
                characteristic.writeValueWithoutResponse(chunk);
            } catch (e) {
                console.warn("Write failed:", e);
                await this.sleep(delayMs * 2); // backoff before retry
                continue;
            }
            await this.sleep(delayMs); // prevent BLE buffer overflow
        }
    }

    async _writeRaw(buffer) {
        if (this._transport === 'serial') {
            await this._writeSerial(buffer);
        } else {
            this.writeLargeBuffer(buffer, this._characteristic, this._mtu, 5);
        }
    }

    async _writeSerial(buffer) {
        if (!this._serialPort || !this._serialWriter) {
            throw new Error('Serial port is not ready to send data.');
        }

        const payload = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        const crc = this._crc16(payload);

        const totalLength = payload.length + 2; // include CRC
        const packetData = new Uint8Array(2 + payload.length + 2);
        packetData[0] = (totalLength >> 8) & 0xff;
        packetData[1] = totalLength & 0xff;
        packetData.set(payload, 2);
        packetData[packetData.length - 2] = (crc >> 8) & 0xff;
        packetData[packetData.length - 1] = crc & 0xff;

        const maxInput = Math.floor((MCUMGR_SERIAL_MAX_FRAME - 3) / 4) * 3;
        let header = MCUMGR_SERIAL_HDR_PKT;
        let offset = 0;

        try {
            while (offset < packetData.length) {
                const remaining = packetData.length - offset;
                const chunkLen = Math.min(maxInput, remaining);
                const chunk = packetData.slice(offset, offset + chunkLen);
                const frame = this._buildSerialFrame(header, chunk);
                await this._serialWriter.write(frame);
                offset += chunkLen;
                header = MCUMGR_SERIAL_HDR_FRAG;
            }
        } catch (error) {
            this._logger.error('Serial write error:', error);
            throw error;
        }
    }

    _buildSerialFrame(header, chunk) {
        const headerBytes = new Uint8Array([header >> 8, header & 0xff]);
        const base64String = this._base64Encode(chunk);
        const base64Bytes = this._asciiToUint8(base64String);
        const frame = new Uint8Array(headerBytes.length + base64Bytes.length + 1);
        frame.set(headerBytes, 0);
        frame.set(base64Bytes, headerBytes.length);
        frame[frame.length - 1] = SERIAL_NEWLINE;
        return frame;
    }

    _base64Encode(bytes) {
        if (!bytes || bytes.length === 0) {
            return '';
        }

        let binary = '';
        for (let i = 0; i < bytes.length; i += 1) {
            binary += String.fromCharCode(bytes[i]);
        }

        return btoa(binary);
    }

    _base64Decode(str) {
        if (!str) {
            return new Uint8Array();
        }

        try {
            const binary = atob(str);
            const output = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) {
                output[i] = binary.charCodeAt(i);
            }
            return output;
        } catch (error) {
            this._logger.error('Failed to decode base64 serial frame:', error);
            return null;
        }
    }

    _asciiToUint8(str) {
        const arr = new Uint8Array(str.length);
        for (let i = 0; i < str.length; i += 1) {
            arr[i] = str.charCodeAt(i);
        }
        return arr;
    }

    _uint8ToAscii(bytes) {
        let result = '';
        for (let i = 0; i < bytes.length; i += 1) {
            result += String.fromCharCode(bytes[i]);
        }
        return result;
    }

    async _sendMessage(op, group, id, data) {
        const _flags = 0;
        let encodedData = [];
        if (typeof data !== 'undefined') {
            encodedData = [...new Uint8Array(CBOR.encode(data))];
        }
    
        const length_lo = encodedData.length & 255;
        const length_hi = encodedData.length >> 8;
        const group_lo = group & 255;
        const group_hi = group >> 8;
        const message = [
            op, // Opcode
            _flags, // Flags
            length_hi, length_lo, // Length
            group_hi, group_lo, // Group ID
            this._seq, // Sequence number
            id, // Command ID
            ...encodedData // Encoded data
        ];
    
        //console.log('Constructed raw payload:', message);
    
        await this._writeRaw(Uint8Array.from(message));

        this._seq = (this._seq + 1) % 256;
    }

    _notification(event) {
        if (!event || !event.target) {
            return;
        }
        this._handleIncoming(event.target.value);
    }

    _handleIncoming(data) {
        if (!data) {
            return;
        }

        const normalizedData = this._normalizeIncomingData(data);
        if (!normalizedData) {
            return;
        }

        if (this._transport === 'serial') {
            this._handleSerialBytes(normalizedData);
        } else {
            this._appendToMessageBuffer(normalizedData);
        }
    }

    _normalizeIncomingData(data) {
        if (!data) {
            return null;
        }

        if (data instanceof Uint8Array) {
            return data;
        }

        if (ArrayBuffer.isView(data)) {
            return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
        }

        if (data instanceof ArrayBuffer) {
            return new Uint8Array(data);
        }

        if (Array.isArray(data)) {
            return new Uint8Array(data);
        }

        return null;
    }

    _handleSerialBytes(bytes) {
        for (const byte of bytes) {
            switch (this._serialFrameState) {
                case SERIAL_FRAME_STATE.IDLE:
                    if (byte === MCUMGR_SERIAL_HDR_PKT_1) {
                        this._serialFrameState = SERIAL_FRAME_STATE.RECV_PKT_SECOND;
                        this._serialCurrentFrame = [byte];
                    } else if (byte === MCUMGR_SERIAL_HDR_FRAG_1) {
                        this._serialFrameState = SERIAL_FRAME_STATE.RECV_FRAG_SECOND;
                        this._serialCurrentFrame = [byte];
                    }
                    break;
                case SERIAL_FRAME_STATE.RECV_PKT_SECOND:
                    if (byte === MCUMGR_SERIAL_HDR_PKT_2) {
                        this._serialCurrentFrame.push(byte);
                        this._serialFrameState = SERIAL_FRAME_STATE.COLLECT_PKT;
                    } else {
                        this._resetSerialFrameState();
                        if (byte === MCUMGR_SERIAL_HDR_PKT_1 || byte === MCUMGR_SERIAL_HDR_FRAG_1) {
                            this._serialFrameState = (byte === MCUMGR_SERIAL_HDR_PKT_1) ? SERIAL_FRAME_STATE.RECV_PKT_SECOND : SERIAL_FRAME_STATE.RECV_FRAG_SECOND;
                            this._serialCurrentFrame = [byte];
                        }
                    }
                    break;
                case SERIAL_FRAME_STATE.RECV_FRAG_SECOND:
                    if (byte === MCUMGR_SERIAL_HDR_FRAG_2) {
                        this._serialCurrentFrame.push(byte);
                        this._serialFrameState = SERIAL_FRAME_STATE.COLLECT_FRAG;
                    } else {
                        this._resetSerialFrameState();
                        if (byte === MCUMGR_SERIAL_HDR_PKT_1 || byte === MCUMGR_SERIAL_HDR_FRAG_1) {
                            this._serialFrameState = (byte === MCUMGR_SERIAL_HDR_PKT_1) ? SERIAL_FRAME_STATE.RECV_PKT_SECOND : SERIAL_FRAME_STATE.RECV_FRAG_SECOND;
                            this._serialCurrentFrame = [byte];
                        }
                    }
                    break;
                case SERIAL_FRAME_STATE.COLLECT_PKT:
                case SERIAL_FRAME_STATE.COLLECT_FRAG:
                    this._serialCurrentFrame.push(byte);
                    if (this._serialCurrentFrame.length > MCUMGR_SERIAL_MAX_FRAME) {
                        this._logger.error('Serial frame too long, dropping');
                        this._resetSerialFrameState();
                        break;
                    }

                    if (byte === SERIAL_NEWLINE) {
                        this._processSerialFrame(new Uint8Array(this._serialCurrentFrame));
                        this._resetSerialFrameState();
                    }
                    break;
                default:
                    this._resetSerialFrameState();
                    break;
            }
        }
    }

    _resetSerialFrameState() {
        this._serialFrameState = SERIAL_FRAME_STATE.IDLE;
        this._serialCurrentFrame = [];
    }

    _processSerialFrame(frame) {
        if (!frame || frame.length < 3) {
            return;
        }

        const header = (frame[0] << 8) | frame[1];
        const bodyBytes = frame.slice(2, frame.length - 1); // remove newline
        const bodyString = this._uint8ToAscii(bodyBytes);
        const decoded = this._base64Decode(bodyString);

        if (decoded === null) {
            this._resetSerialPacketState();
            return;
        }
        this._handleSerialFragment(header, decoded);
    }

    _handleSerialFragment(header, payload) {
        if (!payload) {
            this._resetSerialPacketState();
            return;
        }

        const ctx = this._serialRxContext;

        if (header === MCUMGR_SERIAL_HDR_PKT) {
            ctx.buffer = new Uint8Array();
            ctx.expectedLength = null;
        } else if (header === MCUMGR_SERIAL_HDR_FRAG) {
            if (ctx.expectedLength == null && ctx.buffer.length === 0) {
                this._logger.error('Received serial fragment without initial packet');
                this._resetSerialPacketState();
                return;
            }
        } else {
            this._logger.error(`Unknown serial frame header: 0x${header.toString(16)}`);
            this._resetSerialPacketState();
            return;
        }

        ctx.buffer = this._concatUint8Arrays(ctx.buffer, payload);

        if (header === MCUMGR_SERIAL_HDR_PKT) {
            if (ctx.buffer.length < 2) {
                // wait for length bytes
                return;
            }
            ctx.expectedLength = (ctx.buffer[0] << 8) | ctx.buffer[1];
            ctx.buffer = ctx.buffer.slice(2);
        } else {
        }

        if (ctx.expectedLength == null) {
            return;
        }

        if (ctx.buffer.length < ctx.expectedLength) {
            return;
        }

        if (ctx.buffer.length > ctx.expectedLength) {
            this._logger.error('Serial packet buffer longer than expected length; dropping');
            this._resetSerialPacketState();
            return;
        }

        const crcInput = ctx.buffer;
        const crc = this._crc16(crcInput);
        if (crc !== 0) {
            this._logger.error('Serial CRC mismatch (crc=' + crc + ')');
            this._resetSerialPacketState();
            return;
        }

        const payloadData = crcInput.slice(0, crcInput.length - 2);
        this._appendToMessageBuffer(payloadData);

        this._resetSerialPacketState();
    }

    _resetSerialPacketState() {
        this._serialRxContext = {
            buffer: new Uint8Array(),
            expectedLength: null
        };
    }

    _concatUint8Arrays(a, b) {
        const left = a ? a : new Uint8Array();
        const right = b ? b : new Uint8Array();

        if (left.length === 0) {
            return right.slice();
        }

        if (right.length === 0) {
            return left.slice();
        }

        const result = new Uint8Array(left.length + right.length);
        result.set(left, 0);
        result.set(right, left.length);
        return result;
    }

    _crc16(data) {
        let crc = 0x0000;

        for (let i = 0; i < data.length; i += 1) {
            crc ^= data[i] << 8;
            for (let bit = 0; bit < 8; bit += 1) {
                if (crc & 0x8000) {
                    crc = ((crc << 1) ^ 0x1021) & 0xffff;
                } else {
                    crc = (crc << 1) & 0xffff;
                }
            }
        }

        return crc & 0xffff;
    }

    _appendToMessageBuffer(bytes) {
        if (!bytes || bytes.length === 0) {
            return;
        }

        this._buffer = new Uint8Array([...this._buffer, ...bytes]);

        while (this._buffer.length >= 8) {
            const messageLength = this._buffer[2] * 256 + this._buffer[3];
            if (this._buffer.length < messageLength + 8) {
                break;
            }

            const packet = this._buffer.slice(0, messageLength + 8);
            this._processMessage(packet);
            this._buffer = this._buffer.slice(messageLength + 8);
        }
    }

    _processMessage(message) {
        //console.log('message received', message);
        const [op, _flags, length_hi, length_lo, group_hi, group_lo, _seq, id] = message;
        const data = CBOR.decode(message.slice(8).buffer);
        const length = length_hi * 256 + length_lo;
        const group = group_hi * 256 + group_lo;
        if (group === MGMT_GROUP_ID_IMAGE && id === IMG_MGMT_ID_UPLOAD && (data.rc === 0 || data.rc === undefined) && data.off){
            // Clear timeout since we received a response
            if (this._uploadTimeout) {
                clearTimeout(this._uploadTimeout);
            }
            this._uploadOffset = data.off;
            if (this._uploadIsInProgress) {    
                this._uploadNext();
            }
            this._retryCount = 0;
            return;
        }

        if (group === MGMT_GROUP_ID_FS && id === FS_MGMT_ID_FILE_UPLOAD_DOWNLOAD){
            if ((data.rc === 0 || data.rc === undefined) && data.off) {
                // Clear timeout since we received a response
                if (this._uploadTimeout) {
                    clearTimeout(this._uploadTimeout);
                    console.log('Upload timeout cleared');
                }
                this._uploadOffset = data.off;
                if (this._uploadIsInProgress) {
                    this._uploadNextFileSystem();
                }

                this._retryCount = 0;
                return;
            } else if (data.rc !== 0) {
                this._logger.error('Error uploading file:', data.rc);
                if (this._uploadTimeout) {
                    clearTimeout(this._uploadTimeout);
                    console.log('Upload timeout cleared');
                }
                if (this._retryCount < 3) {
                    this._logger.info('Retrying upload...');
                    this._retryCount++;
                    this._uploadNextFileSystem();
                } else {
                    this._logger.error('Upload failed after 3 retries');
                    if (this._uploadIsInProgress) {
                        this._fsUploadFinishedCallback(false);
                        this._uploadIsInProgress = false;
                    }
                }
            }
        }

        if (this._messageCallback) this._messageCallback({ op, group, id, data, length });
        
    }

    cmdReset() {
        return this._sendMessage(MGMT_OP_WRITE, MGMT_GROUP_ID_OS, OS_MGMT_ID_RESET);
    }

    smpEcho(message) {
        return this._sendMessage(MGMT_OP_WRITE, MGMT_GROUP_ID_OS, OS_MGMT_ID_ECHO, { d: message });
    }

    cmdImageState() {
        return this._sendMessage(MGMT_OP_READ, MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_STATE);
    }

    cmdImageErase(slot = 1) {
        return this._sendMessage(MGMT_OP_WRITE, MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_ERASE);
    }

    cmdImageTest(hash) {
        return this._sendMessage(MGMT_OP_WRITE, MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_STATE, { hash, confirm: false });
    }

    cmdImageConfirm(hash) {
        return this._sendMessage(MGMT_OP_WRITE, MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_STATE, { hash, confirm: true });
    }

    _hash(image) {
        return crypto.subtle.digest('SHA-256', image);
    }

    async _uploadNext() {
        if (this._uploadOffset >= this._uploadImage.byteLength || !this._uploadIsInProgress) {
            this._uploadIsInProgress = false;
            this._imageUploadFinishedCallback();
            return;
        }

        // Clear any existing timeout
        if (this._uploadTimeout) {
            clearTimeout(this._uploadTimeout);
        }

        // Set new timeout
        const chunkTimeout = this._uploadOffset === 0 ? this._firstChunkTimeout : this._chunkTimeout;
        this._uploadTimeout = setTimeout(() => {
            this._logger.info('Upload chunk timeout, retry');
            this._uploadNext();
        }, chunkTimeout);

        const nmpOverhead = 8;
        const message = { data: new Uint8Array(), off: this._uploadOffset, image: this._uploadImageNumber };
        if (this._uploadOffset === 0) {
            message.len = this._uploadImage.byteLength;
            message.sha = new Uint8Array(await this._hash(this._uploadImage));
        }
        this._imageUploadProgressCallback({ percentage: Math.floor(this._uploadOffset / this._uploadImage.byteLength * 100) });

        const length = this._mtu - CBOR.encode(message).byteLength - nmpOverhead;

        message.data = new Uint8Array(this._uploadImage.slice(this._uploadOffset, this._uploadOffset + length));

        // Keep offset for retry
        // this._uploadOffset += length;
        try {
            await this._sendMessage(MGMT_OP_WRITE, MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_UPLOAD, message);
        } catch (error) {
            this._logger.error('Error sending upload message:', error);
            clearTimeout(this._uploadTimeout);
            return;
        }
            
    }

    async cmdUpload(image, imageNumber = 0, slot = 0) {
        if (this._uploadIsInProgress) {
            this._logger.error('Upload is already in progress.');
            return;
        }
        this._logger.info(`Starting upload of image ${imageNumber}...`);
        this._uploadIsInProgress = true;
        this._logger.info(`Image size: ${image.byteLength} bytes`);
        this._logger.info(`MTU size: ${this._mtu} bytes`);
        this._uploadOffset = 0;
        this._retryCount = 0;
        this._uploadImage = image;
        this._uploadImageNumber = imageNumber;
        this._uploadSlot = slot;

        this._uploadNext();
    }

    async imageInfo(image) {
        // https://interrupt.memfault.com/blog/mcuboot-overview#mcuboot-image-binaries

        const info = {};
        const view = new Uint8Array(image);

        // check header length
        if (view.length < 32) {
            throw new Error('Invalid image (too short file)');
        }

        // check MAGIC bytes 0x96f3b83d
        if (view[0] !== 0x3d || view[1] !== 0xb8 || view[2] !== 0xf3 || view[3] !== 0x96) {
            throw new Error('Invalid image (wrong magic bytes)');
        }

        // check load address is 0x00000000
        if (view[4] !== 0x00 || view[5] !== 0x00 || view[6] !== 0x00 || view[7] !== 0x00) {
            throw new Error('Invalid image (wrong load address)');
        }

        const headerSize = view[8] + view[9] * 2**8;

        // check protected TLV area size is 0
        if (view[10] !== 0x00 || view[11] !== 0x00) {
            throw new Error('Invalid image (wrong protected TLV area size)');
        }

        const imageSize = view[12] + view[13] * 2**8 + view[14] * 2**16 + view[15] * 2**24;
        info.imageSize = imageSize;

        // check image size is correct
        if (view.length < imageSize + headerSize) {
            throw new Error('Invalid image (wrong image size)');
        }

        // check flags is 0x00000000
        if (view[16] !== 0x00 || view[17] !== 0x00 || view[18] !== 0x00 || view[19] !== 0x00) {
            throw new Error('Invalid image (wrong flags)');
        }

        const version = `${view[20]}.${view[21]}.${view[22] + view[23] * 2**8}`;
        info.version = version;

        info.hash = [...new Uint8Array(await this._hash(image.slice(0, imageSize + headerSize)))].map(b => b.toString(16).padStart(2, '0')).join('');

        return info;
    }

    async cmdUploadFileSystemImage(image, path) {
        if (this._uploadIsInProgress) {
            this._logger.error('Upload is already in progress.');
            return;
        }
        this._logger.info(`Starting upload of image to ${path}... of ${image.byteLength} bytes`);
        this._uploadIsInProgress = true;
        this._logger.info(`Image size: ${image.byteLength} bytes`);
        this._logger.info(`MTU size: ${this._mtu} bytes`);
        this._uploadOffset = 0;
        this._retryCount = 0;
        this._uploadImage = image;
        this._uploadName = path;

        this._uploadNextFileSystem();
    }

    async _uploadNextFileSystem() {
        if (this._uploadOffset >= this._uploadImage.byteLength || !this._uploadIsInProgress) {
            this._uploadIsInProgress = false;
            console.log('Upload finished');
            this._fsUploadFinishedCallback(true);
            return;
        }

        // Clear any existing timeout
        if (this._uploadTimeout) {
            clearTimeout(this._uploadTimeout);
        }
        
        // Set new timeout - use first chunk timeout for first chunk, otherwise use regular timeout
        const chunkTimeout = this._uploadOffset === 0 ? this._firstChunkTimeout : this._chunkTimeout;
        this._uploadTimeout = setTimeout(() => {
            this._logger.info('Upload chunk timeout, retry');
            this._uploadNextFileSystem();
        }, chunkTimeout);

        const nmpOverhead = 20;
        const message = { data: new Uint8Array(), off: this._uploadOffset, name: this._uploadName };
        if (this._uploadOffset === 0) {
            message.len = this._uploadImage.byteLength;
        }
        this._fsUploadProgressCallback({ percentage: Math.floor(this._uploadOffset / this._uploadImage.byteLength * 100) });

        let length = this._netbuf_size - CBOR.encode(message).byteLength - nmpOverhead;

        length = length - (length % 4);

        console.log('File offset', this._uploadOffset);

        message.data = new Uint8Array(this._uploadImage.slice(this._uploadOffset, this._uploadOffset + length));

        // Keep offset for retry
        // this._uploadOffset += length;
        try {
            this._sendMessage(MGMT_OP_WRITE, MGMT_GROUP_ID_FS, FS_MGMT_ID_FILE_UPLOAD_DOWNLOAD, message);
        } catch (error) {
            this._logger.error('Error sending upload message:', error);
            clearTimeout(this._uploadTimeout);
            return;
        }
            
    }
}

export default MCUManager;
