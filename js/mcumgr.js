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

class MCUManager {
    constructor(di = {}) {
        this.SERVICE_UUID = '8d53dc1d-1db7-4cd3-868b-8a527460aa84';
        this.CHARACTERISTIC_UUID = 'da2e7828-fbce-4e01-ae9e-261174997c48';
        this._mtu = 244; // default MTU size
        this._device = null;
        this._service = null;
        this._characteristic = null;
        this._connectCallback = null;
        this._connectingCallback = null;
        this._disconnectCallback = null;
        this._netbuf_size = 90;
        this._messageCallback = null;
        this._imageUploadProgressCallback = null;
        this._uploadIsInProgress = false;
        this._chunkTimeout = 5000; // 500ms, if sending a chunk is not completed in this time, it will be retried (even 250ms can be too low for some devices)
        this._buffer = new Uint8Array();
        this._logger = di.logger || { info: console.log, error: console.error };
        this._seq = 0;
        this._userRequestedDisconnect = false;
        this._port = null; // Serial port instance
        this._reader = null; // Reader for incoming data
        this._writer = null; // Writer for outgoing data
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

    async connect(filters) {
        try {
            this._device = await this._requestDevice(filters);
            this._logger.info(`Connecting to device ${this.name}...`);
            this._device.addEventListener('gattserverdisconnected', async event => {
                this._logger.info(event);
                if (!this._userRequestedDisconnect) {
                    this._logger.info('Trying to reconnect');
                    this._connect(1000);
                } else {
                    this._disconnected();
                }
            });
            this._connect(0);
        } catch (error) {
            this._logger.error(error);
            await this._disconnected();
            return;
        }
    }

    async connectSerial() {
        try {
            // Request a port and open a connection
            this._port = await navigator.serial.requestPort();
            await this._port.open({ baudRate: 115200 }); // Set baud rate (adjust as needed)

            // Set up the reader and writer
            this._reader = this._port.readable.getReader();
            this._writer = this._port.writable.getWriter();

            this._logger.info('Serial device connected.');

            // Start listening for incoming data
            this._listenForSerialData();

            // Trigger the connected callback
            if (this._connectCallback) this._connectCallback();
        } catch (error) {
            this._logger.error('Failed to connect to serial device:', error);
        }
    }

    async disconnectSerial() {
        try {
            if (this._reader) {
                await this._reader.cancel();
                this._reader.releaseLock();
                this._reader = null;
            }
            if (this._writer) {
                this._writer.releaseLock();
                this._writer = null;
            }
            if (this._port) {
                await this._port.close();
                this._port = null;
            }
            this._logger.info('Serial device disconnected.');
        } catch (error) {
            this._logger.error('Failed to disconnect serial device:', error);
        }
    }

    // Base64 encoding and decoding
    base64Encode(data) {
        return btoa(String.fromCharCode(...data));
    }

    base64Decode(data) {
        return new Uint8Array(atob(data).split('').map(char => char.charCodeAt(0)));
    }

    // CRC16 calculation (polynomial 0x1021, initial value 0)
    calculateCRC16(data) {
        let crc = 0x0000;
        for (let byte of data) {
            crc ^= (byte << 8);
            for (let i = 0; i < 8; i++) {
                if (crc & 0x8000) {
                    crc = (crc << 1) ^ 0x1021;
                } else {
                    crc <<= 1;
                }
            }
            crc &= 0xFFFF;
        }
        return crc;
    }

    wrapSMPForSerial(payload, mtu = 127) {
        const MTU_BODY_SIZE = Math.floor((mtu - 3) / 4) * 3; // Max raw data size per frame
        const totalLength = payload.length + 2; // Total length includes CRC16 (2 bytes)
        const crc = this.calculateCRC16(payload); // Calculate CRC16
    
        //console.log('Raw payload:', payload);
        //console.log('Total length:', totalLength);
        //console.log('CRC16:', crc);
    
        const frames = [];
        let offset = 0;
    
        // Create the initial or initial-final frame
        const initialBodySize = Math.min(MTU_BODY_SIZE - 2, payload.length);
        const initialBody = new Uint8Array(initialBodySize + 2);
        initialBody[0] = (totalLength >> 8) & 0xFF; // Total length (big-endian)
        initialBody[1] = totalLength & 0xFF;
        initialBody.set(payload.slice(0, initialBodySize), 2);
    
        //console.log('Initial frame raw body:', initialBody);
    
        const isInitialFinal = payload.length <= (MTU_BODY_SIZE - 4); // Check if it fits in one frame
        const initialFrameBody = isInitialFinal
            ? new Uint8Array([...initialBody, (crc >> 8) & 0xFF, crc & 0xFF]) // Add CRC16 for initial-final
            : initialBody;
    
        const initialFrame = new Uint8Array([
            0x06, 0x09, // Start marker
            ...this.base64Encode(initialFrameBody).split('').map(c => c.charCodeAt(0)), // Base64 encoded body
            0x0A // Frame termination
        ]);
        frames.push(initialFrame);
        offset += initialBodySize;
    
        //console.log('Initial frame:', initialFrame);
    
        if (isInitialFinal) {
            // If the entire payload fits in the initial-final frame, return the frames
            return frames;
        }
    
        // Create partial frames
        while (offset < payload.length) {
            const bodySize = Math.min(MTU_BODY_SIZE, payload.length - offset);
            const body = payload.slice(offset, offset + bodySize);
            offset += bodySize;
    
            const isFinal = offset >= payload.length;
            const frameStartMarker = isFinal ? [0x04, 0x15] : [0x04, 0x14]; // Partial-final or partial
            const frameBody = isFinal
                ? new Uint8Array([...body, (crc >> 8) & 0xFF, crc & 0xFF]) // Add CRC16 for final frame
                : body;
    
            //console.log('Partial frame raw body:', frameBody);
    
            const frame = new Uint8Array([
                ...frameStartMarker, // Start marker
                ...this.base64Encode(frameBody).split('').map(c => c.charCodeAt(0)), // Base64 encoded body
                0x0A // Frame termination
            ]);
            frames.push(frame);
    
            //console.log('Partial frame:', frame);
        }
    
        return frames;
    }

    async sendSerialMessage(data) {
        if (!this._writer) {
            this._logger.error('Serial device not connected.');
            return;
        }
    
        try {
            const frames = this.wrapSMPForSerial(data); // Wrap the SMP payload into frames
            for (const frame of frames) {
                await this._writer.write(frame);
                //this._logger.info('Serial frame sent:', frame);
            }
        } catch (error) {
            this._logger.error('Failed to send serial message:', error);
        }
    }

    async receiveSerialMessage() {
        if (!this._reader) {
            this._logger.error('Serial device not connected.');
            return;
        }

        try {
            const { value, done } = await this._reader.read();
            if (done) {
                this._logger.info('Serial connection closed.');
                return null;
            }
            this._logger.info('Serial message received:', value);
            return value;
        } catch (error) {
            this._logger.error('Failed to receive serial message:', error);
        }
    }

    async _listenForSerialData() {
        try {
            let buffer = '';
            let assembledPacket = new Uint8Array(); // Buffer to assemble the complete SMP packet
            let expectedLength = null; // Expected total length of the SMP packet
    
            while (this._reader) {
                const { value, done } = await this._reader.read();
                if (done) {
                    this._logger.info('Serial connection closed.');
                    break;
                }
                if (value) {
                    buffer += String.fromCharCode(...value);
                    const frames = buffer.split('\n'); // Split by newline character
                    buffer = frames.pop(); // Keep incomplete frame in the buffer
                    console.log('frames:', frames, 'buffer:', buffer);
    
                    for (const frame of frames) {
                        try {
                            console.log('Received frame:', frame);
    
                            const decodedFrame = this.base64Decode(frame.slice(2, -1)); // Decode Base64 body
                            console.log('Decoded frame:', decodedFrame);
    
                            const startMarker = frame.slice(0, 2);
                            console.log('Start marker (hex):', [...startMarker].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' '));
    
                            if (startMarker === '\x06\x09') {
                                // Initial or initial-final frame
                                const totalLength = (decodedFrame[0] << 8) | decodedFrame[1]; // Includes CRC16
                                const body = decodedFrame.slice(2); // Exclude length
                                console.log('Extracted total length (including CRC):', totalLength);
                                console.log('Extracted body:', body);
    
                                // Start assembling the packet
                                assembledPacket = body;
                                expectedLength = totalLength; // Total length already includes CRC16
                            } else if (startMarker === '\x04\x14' || startMarker === '\x04\x15') {
                                // Partial or partial-final frame
                                const body = decodedFrame; // No CRC in intermediate frames
                                console.log('Extracted body from partial frame:', body);
    
                                // Append the body to the assembled packet
                                assembledPacket = new Uint8Array([...assembledPacket, ...body]);
                            }
    
                            // Check if the packet is complete
                            console.log('Assembled packet length:', assembledPacket.length);
                            console.log('Expected length:', expectedLength);
                            if (assembledPacket.length === expectedLength - 3) {
                                console.log('Complete SMP packet received:', assembledPacket);
    
                                // Extract the CRC16 from the assembled packet
                                const crc = (assembledPacket[assembledPacket.length - 2] << 8) |
                                            assembledPacket[assembledPacket.length - 1];
                                const body = assembledPacket.slice(0, -2); // Exclude CRC16
                                console.log('Extracted CRC:', crc);
                                console.log('Assembled body:', body);
    
                                // Validate the CRC16
                                const calculatedCRC = this.calculateCRC16(body);
                                console.log('Calculated CRC:', calculatedCRC);
    
                                if (calculatedCRC !== crc) {
                                    console.warn('CRC mismatch');
                                    assembledPacket = new Uint8Array(); // Reset the buffer
                                    expectedLength = null; // Reset the expected length
                                    //continue;
                                }
    
                                // Notify with the complete packet
                                this._notification({ target: { value: body } });
                                assembledPacket = new Uint8Array(); // Reset the buffer
                                expectedLength = null; // Reset the expected length
                            }
                        } catch (error) {
                            this._logger.error('Failed to process frame:', error);
                        }
                    }
                }
            }
        } catch (error) {
            this._logger.error('Error reading from serial device:', error);
        }
    }

    _connect() {
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
                await this._connected();
                this._logger.info(`Connected.`);
                if (this._uploadIsInProgress) {
                    this._uploadNext();
                }
            } catch (error) {
                this._logger.error(error);
                await this._disconnected();
            }
        }, 1000);
    }

    disconnect() {
        this._userRequestedDisconnect = true;
        return this._device.gatt.disconnect();
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
        if (this._disconnectCallback) this._disconnectCallback();
        this._device = null;
        this._service = null;
        this._characteristic = null;
        this._uploadIsInProgress = false;
        this._userRequestedDisconnect = false;
    }

    get name() {
        return this._device && this._device.name;
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
                // No await — fire and forget
                console.log('Writing chunk', chunk.length, chunk);
                characteristic.writeValueWithoutResponse(chunk);
            } catch (e) {
                console.warn("Write failed:", e);
                await this.sleep(delayMs * 2); // backoff before retry
                continue;
            }
            await this.sleep(delayMs); // prevent BLE buffer overflow
        }
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
    
        this.writeLargeBuffer(Uint8Array.from(message), this._characteristic, this._mtu, 5);
    
        this._seq = (this._seq + 1) % 256;
    }

    _notification(event) {
        const message = new Uint8Array(event.target.value.buffer || event.target.value);
        this._buffer = new Uint8Array([...this._buffer, ...message]);
        const messageLength = this._buffer[2] * 256 + this._buffer[3];
        if (this._buffer.length < messageLength + 8) {
            console.log('Buffer not full yet', this._buffer.length, messageLength + 8);
            //return;
        };
        this._processMessage(this._buffer.slice(0, messageLength + 8));
        this._buffer = this._buffer.slice(messageLength + 8);
    }

    _processMessage(message) {
        console.log('message received', message);
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
            return;
        }

        if (group === MGMT_GROUP_ID_FS && id === FS_MGMT_ID_FILE_UPLOAD_DOWNLOAD){
            if ((data.rc === 0 || data.rc === undefined) && data.off) {
                // Clear timeout since we received a response
                if (this._uploadTimeout) {
                    clearTimeout(this._uploadTimeout);
                }
                this._uploadOffset = data.off;
                if (this._uploadIsInProgress) {
                    this._uploadNextFileSystem();
                }
                return;
            } else if (data.rc !== 0) {
                this._logger.error('Error uploading file:', data.rc);
                if (this._uploadTimeout) {
                    clearTimeout(this._uploadTimeout);
                }
                if (this._uploadIsInProgress) {
                    this._fsUploadFinishedCallback(false);
                    this._uploadIsInProgress = false;
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
        this._uploadTimeout = setTimeout(() => {
            this._logger.info('Upload chunk timeout, retry');
            this._uploadNext();
        }, this._chunkTimeout);

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
        // Set new timeout
        this._uploadTimeout = setTimeout(() => {
            this._logger.info('Upload chunk timeout, retry');
            //this._uploadNextFileSystem();
        }, this._chunkTimeout);

        const nmpOverhead = 20;
        const message = { data: new Uint8Array(), off: this._uploadOffset, name: this._uploadName };
        if (this._uploadOffset === 0) {
            message.len = this._uploadImage.byteLength;
        }
        this._fsUploadProgressCallback({ percentage: Math.floor(this._uploadOffset / this._uploadImage.byteLength * 100) });

        let length = this._netbuf_size - CBOR.encode(message).byteLength - nmpOverhead;

        length = length - (length % 4);


        console.log('New length:', length, 'offset', this._uploadOffset);

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
