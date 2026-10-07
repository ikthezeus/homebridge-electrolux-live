import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import type { AxiosResponse } from 'axios';

import type { ElectroluxDevicesPlatform } from './platform.js';

type LivestreamAppliance = {
    applianceId: string;
    properties: string[];
};

type LivestreamConfig = {
    url: string;
    appliances: LivestreamAppliance[];
};

export type LivestreamEvent = {
    applianceId?: string;
    property?: string;
    value?: unknown;
    [key: string]: unknown;
};

export class SseParser {
    private readonly decoder = new StringDecoder('utf8');
    private buffer = '';
    private dataLines: string[] = [];
    private pendingCr = false;

    constructor(
        private readonly onEvent: (event: LivestreamEvent) => void,
        private readonly onParseError?: (data: string, error: unknown) => void
    ) {}

    push(chunk: Buffer | string) {
        let text =
            typeof chunk === 'string' ? chunk : this.decoder.write(chunk);

        /*
         * A CR is itself a valid SSE line ending. We consume it
         * immediately. If the following network chunk begins with LF,
         * that LF is merely the second half of CRLF and must be ignored.
         */
        if (this.pendingCr && text.length > 0) {
            if (text.startsWith('\n')) {
                text = text.slice(1);
            }

            this.pendingCr = false;
        }

        this.buffer += text;
        this.processBuffer();
    }

    finish() {
        let text = this.decoder.end();

        if (this.pendingCr) {
            if (text.startsWith('\n')) {
                text = text.slice(1);
            }

            this.pendingCr = false;
        }

        this.buffer += text;
        this.processBuffer();

        if (this.buffer.length > 0) {
            this.processLine(this.buffer);
            this.buffer = '';
        }

        this.dispatchEvent();
    }

    private processBuffer() {
        while (true) {
            const crIndex = this.buffer.indexOf('\r');
            const lfIndex = this.buffer.indexOf('\n');

            let boundaryIndex = -1;

            if (crIndex === -1) {
                boundaryIndex = lfIndex;
            } else if (lfIndex === -1) {
                boundaryIndex = crIndex;
            } else {
                boundaryIndex = Math.min(crIndex, lfIndex);
            }

            if (boundaryIndex === -1) {
                return;
            }

            const boundary = this.buffer[boundaryIndex];
            const line = this.buffer.slice(0, boundaryIndex);

            if (boundary === '\n') {
                this.buffer = this.buffer.slice(boundaryIndex + 1);

                this.processLine(line);
                continue;
            }

            /*
             * CR is a complete line ending by itself.
             */
            if (boundaryIndex === this.buffer.length - 1) {
                this.buffer = '';
                this.pendingCr = true;

                this.processLine(line);
                return;
            }

            /*
             * CRLF already present in this same buffer.
             */
            if (this.buffer[boundaryIndex + 1] === '\n') {
                this.buffer = this.buffer.slice(boundaryIndex + 2);

                this.processLine(line);
                continue;
            }

            /*
             * Plain CR followed by some other character.
             */
            this.buffer = this.buffer.slice(boundaryIndex + 1);

            this.processLine(line);
        }
    }

    private processLine(line: string) {
        if (line === '') {
            this.dispatchEvent();
            return;
        }

        /*
         * SSE comment / heartbeat lines and fields other than data
         * are deliberately ignored for M1 observation.
         */
        if (!line.startsWith('data:')) {
            return;
        }

        this.dataLines.push(line.slice(5).trimStart());
    }

    private dispatchEvent() {
        if (this.dataLines.length === 0) {
            return;
        }

        const data = this.dataLines.join('\n');
        this.dataLines = [];

        try {
            this.onEvent(JSON.parse(data) as LivestreamEvent);
        } catch (error) {
            this.onParseError?.(data, error);
        }
    }
}

export class ElectroluxLivestreamObserver {
    private static readonly INITIAL_BACKOFF_MS = 1000;
    private static readonly MAX_BACKOFF_MS = 120000;

    private stopped = true;
    private connecting = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private stream: Readable | null = null;
    private backoffMs = ElectroluxLivestreamObserver.INITIAL_BACKOFF_MS;

    constructor(private readonly platform: ElectroluxDevicesPlatform) {}

    start() {
        if (!this.stopped) {
            return;
        }

        this.stopped = false;
        this.platform.log.info(
            '[Livestream/M1] Starting observation-only Electrolux livestream'
        );

        void this.connect();
    }

    stop() {
        if (this.stopped) {
            return;
        }

        this.stopped = true;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.stream) {
            this.stream.destroy();
            this.stream = null;
        }

        this.platform.log.info('[Livestream/M1] Livestream stopped');
    }

    private async connect() {
        if (this.stopped || this.connecting) {
            return;
        }

        this.connecting = true;

        try {
            await this.platform.ensureAccessToken();

            const configResponse =
                await this.platform.client.get<LivestreamConfig>(
                    '/api/v1/configurations/livestream'
                );

            if (this.stopped) {
                return;
            }

            const config = configResponse.data;

            if (!config.url) {
                throw new Error(
                    'Electrolux livestream configuration did not contain a URL'
                );
            }

            this.logConfiguration(config);

            const response: AxiosResponse<Readable> =
                await this.platform.client.get<Readable>(config.url, {
                    responseType: 'stream',
                    timeout: 0,
                    headers: {
                        Accept: 'text/event-stream'
                    }
                });

            if (this.stopped) {
                response.data.destroy();
                return;
            }

            this.stream = response.data;

            this.platform.log.info(
                '[Livestream/M1] SSE connection established'
            );

            this.observeStream(response.data);
        } catch (error) {
            if (!this.stopped) {
                if (this.platform.isAuthenticationBlocked()) {
                    this.platform.log.error(
                        '[Livestream/M1] Authentication was rejected. Livestream reconnects are paused until credentials are updated and Homebridge is restarted.'
                    );
                    return;
                }

                this.platform.log.warn(
                    '[Livestream/M1] Connection failed: %s',
                    this.formatError(error)
                );

                this.scheduleReconnect(
                    this.platform.getAuthenticationRetryDelayMs()
                );
            }
        } finally {
            this.connecting = false;
        }
    }

    private observeStream(stream: Readable) {
        let settled = false;
        let receivedEvent = false;

        const parser = new SseParser(
            (event) => {
                if (!receivedEvent) {
                    receivedEvent = true;
                    this.backoffMs =
                        ElectroluxLivestreamObserver.INITIAL_BACKOFF_MS;
                }

                this.platform.log.info(
                    '[Livestream/M1] SSE event: %s',
                    JSON.stringify(event)
                );
            },
            (data, error) => {
                this.platform.log.warn(
                    '[Livestream/M1] Could not parse SSE data as JSON: %s (%s)',
                    data,
                    this.formatError(error)
                );
            }
        );

        const settle = (reason: string, error?: unknown) => {
            if (settled) {
                return;
            }

            settled = true;

            try {
                parser.finish();
            } catch {
                // Observation shutdown/reconnect must not fail on parser cleanup.
            }

            if (this.stream === stream) {
                this.stream = null;
            }

            if (this.stopped) {
                return;
            }

            if (error) {
                this.platform.log.warn(
                    '[Livestream/M1] SSE stream %s: %s',
                    reason,
                    this.formatError(error)
                );
            } else {
                this.platform.log.warn('[Livestream/M1] SSE stream %s', reason);
            }

            this.scheduleReconnect();
        };

        stream.on('data', (chunk: Buffer | string) => {
            parser.push(chunk);
        });

        stream.once('end', () => {
            settle('ended by server');
        });

        stream.once('error', (error) => {
            settle('error', error);
        });

        stream.once('close', () => {
            settle('closed');
        });
    }

    private scheduleReconnect(minimumDelayMs = 0) {
        if (this.stopped || this.reconnectTimer) {
            return;
        }

        const jitter = 0.8 + Math.random() * 0.4;
        const livestreamDelay = Math.min(
            Math.round(this.backoffMs * jitter),
            ElectroluxLivestreamObserver.MAX_BACKOFF_MS
        );

        const delay = Math.max(livestreamDelay, minimumDelayMs);

        this.platform.log.info(
            `[Livestream/M1] Reconnecting in ${(delay / 1000).toFixed(1)} seconds`
        );

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
        }, delay);

        this.backoffMs = Math.min(
            this.backoffMs * 2,
            ElectroluxLivestreamObserver.MAX_BACKOFF_MS
        );
    }

    private logConfiguration(config: LivestreamConfig) {
        const subscriptions = config.appliances.map((appliance) => ({
            applianceId: appliance.applianceId,
            properties: appliance.properties
        }));

        this.platform.log.info(
            '[Livestream/M1] Livestream configuration contains %d appliance subscription(s): %s',
            subscriptions.length,
            JSON.stringify(subscriptions)
        );
    }

    private formatError(error: unknown) {
        if (error instanceof Error) {
            const responseStatus = (
                error as Error & {
                    response?: {
                        status?: number;
                    };
                }
            ).response?.status;

            return responseStatus
                ? `${error.message} (HTTP ${responseStatus})`
                : error.message;
        }

        return String(error);
    }
}
