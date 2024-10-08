/* istanbul ignore file */

import {EventEmitter} from 'events';
import net from 'net';

import {DelimiterParser} from '@serialport/parser-delimiter';

import {Buffalo} from '../../../buffalo';
import {Queue} from '../../../utils';
import {logger} from '../../../utils/logger';
import Waitress from '../../../utils/waitress';
import {SerialPort} from '../../serialPort';
import SerialPortUtils from '../../serialPortUtils';
import SocketPortUtils from '../../socketPortUtils';
import {SerialPortOptions} from '../../tstype';
import {equal, ZiGateResponseMatcher, ZiGateResponseMatcherRule} from './commandType';
import {STATUS, ZiGateCommandCode, ZiGateMessageCode, ZiGateObjectPayload} from './constants';
import ZiGateFrame from './frame';
import ZiGateObject from './ziGateObject';

const NS = 'zh:zigate:driver';

const autoDetectDefinitions = [
    {manufacturer: 'zigate_PL2303', vendorId: '067b', productId: '2303'},
    {manufacturer: 'zigate_cp2102', vendorId: '10c4', productId: 'ea60'},
];

const timeouts = {
    reset: 30000,
    default: 10000,
};

type WaitressMatcher = {
    ziGateObject: ZiGateObject;
    rules: ZiGateResponseMatcher;
    extraParameters?: object;
};

function zeroPad(number: number, size?: number): string {
    return number.toString(16).padStart(size || 4, '0');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolve(path: string | [], obj: {[k: string]: any}, separator = '.'): any {
    const properties = Array.isArray(path) ? path : path.split(separator);
    return properties.reduce((prev, curr) => prev && prev[curr], obj);
}

export default class ZiGate extends EventEmitter {
    private path: string;
    private baudRate: number;
    private initialized: boolean;

    private parser?: EventEmitter;
    private serialPort?: SerialPort;
    private socketPort?: net.Socket;
    private queue: Queue;

    public portWrite?: SerialPort | net.Socket;
    private waitress: Waitress<ZiGateObject, WaitressMatcher>;

    public constructor(path: string, serialPortOptions: SerialPortOptions) {
        super();
        this.path = path;
        this.baudRate = typeof serialPortOptions.baudRate === 'number' ? serialPortOptions.baudRate : 115200;
        // XXX: not used?
        // this.rtscts = typeof serialPortOptions.rtscts === 'boolean' ? serialPortOptions.rtscts : false;
        this.initialized = false;
        this.queue = new Queue(1);

        this.waitress = new Waitress<ZiGateObject, WaitressMatcher>(this.waitressValidator, this.waitressTimeoutFormatter);
    }

    public async sendCommand(
        code: ZiGateCommandCode,
        payload?: ZiGateObjectPayload,
        timeout?: number,
        extraParameters?: object,
        disableResponse: boolean = false,
    ): Promise<ZiGateObject> {
        const waiters: Promise<ZiGateObject>[] = [];
        const waitersId: number[] = [];
        return this.queue.execute(async () => {
            try {
                logger.debug(
                    'Send command \x1b[32m>>>> ' +
                        ZiGateCommandCode[code] +
                        ' 0x' +
                        zeroPad(code) +
                        ` <<<<\x1b[0m \nPayload: ${JSON.stringify(payload)}`,
                    NS,
                );
                const ziGateObject = ZiGateObject.createRequest(code, payload);
                const frame = ziGateObject.toZiGateFrame();
                logger.debug(`${JSON.stringify(frame)}`, NS);

                const sendBuffer = frame.toBuffer();
                logger.debug(`<-- send command ${sendBuffer.toString('hex')}`, NS);
                logger.debug(`DisableResponse: ${disableResponse}`, NS);

                if (!disableResponse && Array.isArray(ziGateObject.command.response)) {
                    ziGateObject.command.response.forEach((rules) => {
                        const waiter = this.waitress.waitFor({ziGateObject, rules, extraParameters}, timeout || timeouts.default);
                        waitersId.push(waiter.ID);
                        waiters.push(waiter.start().promise);
                    });
                }

                let resultPromise: Promise<ZiGateObject> | undefined;
                if (ziGateObject.command.waitStatus !== false) {
                    const ruleStatus: ZiGateResponseMatcher = [
                        {receivedProperty: 'code', matcher: equal, value: ZiGateMessageCode.Status},
                        {receivedProperty: 'payload.packetType', matcher: equal, value: ziGateObject.code},
                    ];

                    const statusWaiter = this.waitress.waitFor({ziGateObject, rules: ruleStatus}, timeout || timeouts.default).start();
                    resultPromise = statusWaiter.promise;
                }

                // @ts-expect-error assumed proper based on port type
                this.portWrite!.write(sendBuffer);

                if (ziGateObject.command.waitStatus !== false && resultPromise) {
                    const statusResponse: ZiGateObject = await resultPromise;
                    if (statusResponse.payload.status !== STATUS.E_SL_MSG_STATUS_SUCCESS) {
                        waitersId.map((id) => this.waitress.remove(id));
                        return Promise.reject(statusResponse);
                    } else if (waiters.length === 0) {
                        return Promise.resolve(statusResponse);
                    }
                }
                return Promise.race(waiters);
            } catch (e) {
                logger.error(`sendCommand error ${e}`, NS);
                return Promise.reject(new Error('sendCommand error: ' + e));
            }
        });
    }

    public static async isValidPath(path: string): Promise<boolean> {
        return SerialPortUtils.is(path, autoDetectDefinitions);
    }

    public static async autoDetectPath(): Promise<string | undefined> {
        const paths = await SerialPortUtils.find(autoDetectDefinitions);
        return paths.length > 0 ? paths[0] : undefined;
    }

    public open(): Promise<void> {
        return SocketPortUtils.isTcpPath(this.path) ? this.openSocketPort() : this.openSerialPort();
    }

    public async close(): Promise<void> {
        logger.info('closing', NS);
        this.queue.clear();

        if (this.initialized) {
            this.portWrite = undefined;
            this.initialized = false;

            if (this.serialPort) {
                try {
                    await this.serialPort.asyncFlushAndClose();
                } catch (error) {
                    this.emit('close');

                    throw error;
                }
            } else {
                this.socketPort?.destroy();
            }
        }

        this.emit('close');
    }

    public waitFor(
        matcher: WaitressMatcher,
        timeout: number = timeouts.default,
    ): {start: () => {promise: Promise<ZiGateObject>; ID: number}; ID: number} {
        return this.waitress.waitFor(matcher, timeout);
    }

    private async openSerialPort(): Promise<void> {
        this.serialPort = new SerialPort({
            path: this.path,
            baudRate: this.baudRate,
            dataBits: 8,
            parity: 'none' /* one of ['none', 'even', 'mark', 'odd', 'space'] */,
            stopBits: 1 /* one of [1,2] */,
            lock: false,
            autoOpen: false,
        });
        this.parser = this.serialPort.pipe(new DelimiterParser({delimiter: [ZiGateFrame.STOP_BYTE], includeDelimiter: true}));
        this.parser.on('data', this.onSerialData.bind(this));

        this.portWrite = this.serialPort;

        try {
            await this.serialPort.asyncOpen();
            logger.debug('Serialport opened', NS);

            this.serialPort.once('close', this.onPortClose.bind(this));
            this.serialPort.once('error', this.onPortError.bind(this));

            this.initialized = true;
        } catch (error) {
            this.initialized = false;

            if (this.serialPort.isOpen) {
                this.serialPort.close();
            }

            throw error;
        }
    }

    private async openSocketPort(): Promise<void> {
        const info = SocketPortUtils.parseTcpPath(this.path);
        logger.debug(`Opening TCP socket with ${info.host}:${info.port}`, NS);

        this.socketPort = new net.Socket();
        this.socketPort.setNoDelay(true);
        this.socketPort.setKeepAlive(true, 15000);

        this.parser = this.socketPort.pipe(new DelimiterParser({delimiter: [ZiGateFrame.STOP_BYTE], includeDelimiter: true}));
        this.parser.on('data', this.onSerialData.bind(this));

        this.portWrite = this.socketPort;
        return new Promise((resolve, reject): void => {
            this.socketPort!.on('connect', () => {
                logger.debug('Socket connected', NS);
            });

            this.socketPort!.on('ready', async () => {
                logger.debug('Socket ready', NS);
                this.initialized = true;
                resolve();
            });

            this.socketPort!.once('close', this.onPortClose.bind(this));

            this.socketPort!.on('error', (error) => {
                logger.error(`Socket error ${error}`, NS);
                // reject(new Error(`Error while opening socket`));
                reject();
                this.initialized = false;
            });

            this.socketPort!.connect(info.port, info.host);
        });
    }

    private onPortError(error: Error): void {
        logger.error(`Port error: ${error}`, NS);
    }

    private onPortClose(): void {
        logger.debug('Port closed', NS);
        this.initialized = false;
        this.emit('close');
    }

    private onSerialData(buffer: Buffer): void {
        try {
            // logger.debug(`--- parseNext ${JSON.stringify(buffer)}`, NS);

            const frame = new ZiGateFrame(buffer);
            if (!(frame instanceof ZiGateFrame)) return; // @Todo fix

            const code = frame.readMsgCode();
            const msgName = (ZiGateMessageCode[code] ? ZiGateMessageCode[code] : '') + ' 0x' + zeroPad(code);

            logger.debug(`--> parsed frame \x1b[1;34m>>>> ${msgName} <<<<\x1b[0m `, NS);

            try {
                const ziGateObject = ZiGateObject.fromZiGateFrame(frame);
                logger.debug(`${JSON.stringify(ziGateObject.payload)}`, NS);
                this.waitress.resolve(ziGateObject);

                switch (code) {
                    case ZiGateMessageCode.DataIndication:
                        switch (ziGateObject.payload.profileID) {
                            case 0x0000:
                                switch (ziGateObject.payload.clusterID) {
                                    case 0x0013: {
                                        const networkAddress = ziGateObject.payload.payload.readUInt16LE(1);
                                        const ieeeAddr = new Buffalo(ziGateObject.payload.payload.slice(3, 11)).readIeeeAddr();
                                        this.emit('DeviceAnnounce', networkAddress, ieeeAddr);
                                        break;
                                    }
                                }
                                break;
                            case 0x0104:
                                this.emit('received', {ziGateObject});
                                break;
                            default:
                                logger.debug('not implemented profile: ' + ziGateObject.payload.profileID, NS);
                        }
                        break;
                    case ZiGateMessageCode.LeaveIndication:
                        this.emit('LeaveIndication', {ziGateObject});
                        break;
                    case ZiGateMessageCode.DeviceAnnounce:
                        this.emit('DeviceAnnounce', ziGateObject.payload.shortAddress, ziGateObject.payload.ieee);
                        break;
                }
            } catch (error) {
                logger.error(`Parsing error: ${error}`, NS);
            }
        } catch (error) {
            logger.error(`Error while parsing Frame '${error}'`, NS);
        }
    }

    private waitressTimeoutFormatter(matcher: WaitressMatcher, timeout: number): string {
        return `${JSON.stringify(matcher)} after ${timeout}ms`;
    }

    private waitressValidator(ziGateObject: ZiGateObject, matcher: WaitressMatcher): boolean {
        const validator = (rule: ZiGateResponseMatcherRule): boolean => {
            try {
                let expectedValue: string | number;
                if (rule.value == undefined && rule.expectedProperty != undefined) {
                    expectedValue = resolve(rule.expectedProperty, matcher.ziGateObject);
                } else if (rule.value == undefined && rule.expectedExtraParameter != undefined) {
                    expectedValue = resolve(rule.expectedExtraParameter, matcher.extraParameters!); // XXX: assumed valid?
                } else {
                    expectedValue = rule.value!; // XXX: assumed valid?
                }
                const receivedValue = resolve(rule.receivedProperty, ziGateObject);
                return rule.matcher(expectedValue, receivedValue);
            } catch {
                return false;
            }
        };
        return matcher.rules.every(validator);
    }
}
