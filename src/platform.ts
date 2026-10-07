import {
    API,
    DynamicPlatformPlugin,
    Logger,
    PlatformAccessory,
    PlatformConfig,
    Service,
    Characteristic
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { Appliances } from './definitions/appliances.js';
import { DEVICES } from './const/devices.js';
import { TokenResponse } from './definitions/auth.js';
import { ElectroluxAccessory } from './accessories/accessory.js';
import fs from 'fs';
import path from 'path';
import { API_URL } from './const/url.js';
import { Appliance } from './definitions/appliance.js';
import { Context } from './definitions/context.js';
import axios, {
    AxiosError,
    AxiosInstance,
    InternalAxiosRequestConfig
} from 'axios';
import { ApplianceState } from './definitions/applianceState.js';
import {
    applyLivestreamEvent,
    ElectroluxLivestreamObserver,
    type LivestreamEvent
} from './livestream.js';

/*
    HomebridgePlatform
    This class is the main constructor for your plugin, this is where you should
    parse the user config and discover/register accessories with Homebridge.
*/
export class ElectroluxDevicesPlatform implements DynamicPlatformPlugin {
    public readonly Service: typeof Service;
    public readonly Characteristic: typeof Characteristic;

    public readonly accessories: ElectroluxAccessory[] = [];

    accessToken: string | null = null;
    private refreshToken: string | null = null;
    tokenExpirationDate: number | null = null;

    private tokenRefreshPromise: Promise<void> | null = null;
    private authenticationBlocked = false;
    private authenticationFailureLogged = false;
    private refreshFailureCount = 0;
    private nextRefreshAttemptAt = 0;
    private configuredRefreshTokenFallbackAttempted = false;

    private static readonly TOKEN_REFRESH_SKEW_MS = 60_000;
    private static readonly TOKEN_REFRESH_MAX_ATTEMPTS = 3;
    private static readonly TOKEN_REFRESH_MAX_BACKOFF_MS = 30_000;
    private static readonly TOKEN_REFRESH_COOLDOWN_MAX_MS = 15 * 60_000;

    client!: AxiosInstance;

    regionalBaseUrl: string | null = null;

    private devicesDiscovered = false;
    private pollingInterval: NodeJS.Timeout | null = null;
    private livestreamObserver: ElectroluxLivestreamObserver | null = null;
    private lastLivestreamResyncAt = 0;

    private static readonly LIVESTREAM_RESYNC_INTERVAL_MS = 15 * 60_000;

    private readonly configured: boolean;

    constructor(
        public readonly log: Logger,
        public readonly config: PlatformConfig,
        public readonly api: API
    ) {
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;

        this.configured = this.hasRequiredConfiguration();

        if (!this.configured) {
            this.log.warn(
                'Homebridge Electrolux Live is not configured. Add both an Electrolux API key and refresh token in the plugin settings before starting the integration.'
            );
            return;
        }

        // When this event is fired it means Homebridge has restored all cached accessories from disk.
        // Dynamic Platform plugins should only register new accessories after this event was fired,
        // in order to ensure they weren't added to homebridge already. This event can also be used
        // to start discovery of new accessories.
        this.api.on('didFinishLaunching', async () => {
            try {
                await this.createClient();

                await this.loadAuthData();

                // Establish the complete startup state before allowing
                // livestream events to become authoritative.
                await this.discoverDevices();

                this.livestreamObserver = new ElectroluxLivestreamObserver(
                    this
                );
                this.livestreamObserver.start();
                this.lastLivestreamResyncAt = Date.now();
            } catch (err) {
                if (!this.authenticationBlocked) {
                    this.log.warn((err as Error).message);
                }
            } finally {
                if (
                    this.config.pollingInterval &&
                    this.config.pollingInterval < 120
                ) {
                    this.log.warn(
                        'Polling interval is less than 120 seconds. This could lead to issues with the Electrolux API rate limiting. Please consider increasing the polling interval.'
                    );
                }

                this.pollingInterval = setInterval(
                    this.pollStatus.bind(this),
                    (this.config.pollingInterval || 120) * 1000
                );
            }
        });

        this.api.on('shutdown', async () => {
            if (this.pollingInterval) {
                clearInterval(this.pollingInterval);
            }

            this.livestreamObserver?.stop();
            this.livestreamObserver = null;
        });
    }

    private hasRequiredConfiguration() {
        const apiKey =
            typeof this.config.apiKey === 'string'
                ? this.config.apiKey.trim()
                : '';

        const refreshToken =
            typeof this.config.refreshToken === 'string'
                ? this.config.refreshToken.trim()
                : '';

        return apiKey.length > 0 && refreshToken.length > 0;
    }

    /*
        This function is invoked when homebridge restores cached accessories from disk at startup.
        It should be used to setup event handlers for characteristics and update respective values.
    */
    configureAccessory(accessory: PlatformAccessory<Context>) {
        if (!this.configured) {
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
                accessory
            ]);
            return;
        }

        this.log.info('Loading accessory from cache:', accessory.displayName);

        // add the restored accessory to the accessories cache so we can track if it has already been registered
        this.accessories.push(new ElectroluxAccessory(accessory));
    }

    async createClient() {
        if (!this.config.apiKey) {
            throw new Error(
                'Homebridge Electrolux Live is not configured. Add an Electrolux API key and refresh token in the plugin settings. See https://github.com/ikthezeus/homebridge-electrolux-live#configuration for details.'
            );
        }

        this.client = axios.create({
            baseURL: API_URL,
            headers: {
                Accept: 'application/json',
                'Accept-Charset': 'utf-8',
                'x-api-key': this.config.apiKey
            }
        });
        this.client.interceptors.request.use(this.authInterceptor.bind(this));
    }

    async authInterceptor(value: InternalAxiosRequestConfig<unknown>) {
        if (value.url === '/api/v1/token/refresh') {
            return value;
        }

        await this.ensureAccessToken();

        if (this.accessToken) {
            value.headers.Authorization = `Bearer ${this.accessToken}`;
        }

        return value;
    }

    private getAuthStoragePath() {
        return path.format({
            dir: this.api.user.storagePath(),
            base: 'homebridge_electrolux_device_persist.json'
        });
    }

    async loadAuthData() {
        const storagePath = this.getAuthStoragePath();

        if (!fs.existsSync(storagePath)) {
            this.refreshToken = this.config.refreshToken;

            if (!this.refreshToken) {
                throw new Error(
                    'Please make sure the plugin is configured properly. A refresh token is required.'
                );
            }

            await this.refreshAccessToken();
            return;
        }

        const json = fs.readFileSync(storagePath, 'utf8');

        let data: {
            version: number;
            accessToken: string;
            refreshToken: string;
            tokenExpirationDate: number;
        };

        try {
            data = JSON.parse(json);
        } catch {
            throw new Error(
                'Malformed Electrolux authentication data file. The file has been left untouched.'
            );
        }

        if (
            data.version !== 1 ||
            typeof data.accessToken !== 'string' ||
            typeof data.refreshToken !== 'string' ||
            typeof data.tokenExpirationDate !== 'number'
        ) {
            throw new Error(
                'Invalid Electrolux authentication data file. The file has been left untouched.'
            );
        }

        this.accessToken = data.accessToken;
        this.refreshToken = data.refreshToken;
        this.tokenExpirationDate = data.tokenExpirationDate;

        await this.ensureAccessToken();
    }

    async ensureAccessToken() {
        if (this.authenticationBlocked) {
            throw new Error(
                'Electrolux authentication is blocked because the refresh token was rejected. Update the refresh token and restart Homebridge.'
            );
        }

        if (
            this.accessToken &&
            this.tokenExpirationDate &&
            Date.now() <
                this.tokenExpirationDate -
                    ElectroluxDevicesPlatform.TOKEN_REFRESH_SKEW_MS
        ) {
            return;
        }

        await this.refreshAccessToken();
    }

    async refreshAccessToken() {
        if (this.authenticationBlocked) {
            throw new Error(
                'Electrolux authentication is blocked because the refresh token was rejected. Update the refresh token and restart Homebridge.'
            );
        }

        const retryDelay = this.getAuthenticationRetryDelayMs();

        if (retryDelay > 0) {
            throw new Error(
                `Electrolux token refresh is temporarily backed off for another ${Math.ceil(
                    retryDelay / 1000
                )} seconds.`
            );
        }

        if (this.tokenRefreshPromise) {
            return this.tokenRefreshPromise;
        }

        const refreshPromise = this.performAccessTokenRefresh();
        this.tokenRefreshPromise = refreshPromise;

        try {
            await refreshPromise;
        } finally {
            if (this.tokenRefreshPromise === refreshPromise) {
                this.tokenRefreshPromise = null;
            }
        }
    }

    isAuthenticationBlocked() {
        return this.authenticationBlocked;
    }

    getAuthenticationRetryDelayMs() {
        return Math.max(0, this.nextRefreshAttemptAt - Date.now());
    }

    private async performAccessTokenRefresh() {
        if (!this.refreshToken) {
            this.blockAuthentication('Refresh token is missing.');

            throw new Error(
                'Electrolux refresh token is missing. Update the plugin configuration and restart Homebridge.'
            );
        }

        this.log.info('Refreshing access token...');

        for (
            let attempt = 1;
            attempt <= ElectroluxDevicesPlatform.TOKEN_REFRESH_MAX_ATTEMPTS;
            attempt++
        ) {
            try {
                const response = await this.client.post<TokenResponse>(
                    '/api/v1/token/refresh',
                    {
                        refreshToken: this.refreshToken
                    }
                );

                if (
                    !response.data.accessToken ||
                    !response.data.refreshToken ||
                    !response.data.expiresIn
                ) {
                    throw new Error(
                        'Electrolux returned an incomplete token refresh response.'
                    );
                }

                this.accessToken = response.data.accessToken;
                this.refreshToken = response.data.refreshToken;
                this.tokenExpirationDate =
                    Date.now() + response.data.expiresIn * 1000;

                this.persistAuthData();
                this.resetAuthenticationFailureState();

                this.log.info('Access token refreshed!');
                return;
            } catch (error) {
                if (!axios.isAxiosError(error)) {
                    throw error;
                }

                const message = this.getRefreshErrorMessage(error);

                if (this.isPermanentRefreshFailure(error)) {
                    if (this.tryConfiguredRefreshTokenFallback()) {
                        return this.performAccessTokenRefresh();
                    }

                    this.blockAuthentication(message);

                    throw new Error(
                        `Electrolux rejected the refresh token: ${message}`
                    );
                }

                if (!this.isTransientRefreshFailure(error)) {
                    throw new Error(
                        `Electrolux token refresh failed: ${message}`
                    );
                }

                const retryDelay = this.calculateRefreshRetryDelayMs(
                    error,
                    attempt
                );

                if (
                    attempt <
                    ElectroluxDevicesPlatform.TOKEN_REFRESH_MAX_ATTEMPTS
                ) {
                    this.log.warn(
                        'Electrolux token refresh attempt %d/%d failed: %s. Retrying in %.1f seconds.',
                        attempt,
                        ElectroluxDevicesPlatform.TOKEN_REFRESH_MAX_ATTEMPTS,
                        message,
                        retryDelay / 1000
                    );

                    await this.sleep(retryDelay);
                    continue;
                }

                this.registerTransientRefreshFailure(error);

                throw new Error(
                    `Electrolux token refresh temporarily failed after ${attempt} attempts: ${message}`
                );
            }
        }
    }

    private persistAuthData() {
        if (
            !this.accessToken ||
            !this.refreshToken ||
            !this.tokenExpirationDate
        ) {
            throw new Error(
                'Cannot persist incomplete Electrolux authentication data.'
            );
        }

        const storagePath = this.getAuthStoragePath();
        const temporaryPath = `${storagePath}.tmp-${process.pid}`;

        const json = JSON.stringify({
            version: 1,
            accessToken: this.accessToken,
            refreshToken: this.refreshToken,
            tokenExpirationDate: this.tokenExpirationDate
        });

        try {
            fs.writeFileSync(temporaryPath, json, 'utf8');
            fs.renameSync(temporaryPath, storagePath);
        } catch (error) {
            try {
                if (fs.existsSync(temporaryPath)) {
                    fs.unlinkSync(temporaryPath);
                }
            } catch {
                // Preserve the original persistence error.
            }

            throw new Error(
                `Failed to persist rotated Electrolux authentication data: ${
                    (error as Error).message
                }`
            );
        }
    }

    private tryConfiguredRefreshTokenFallback() {
        if (this.configuredRefreshTokenFallbackAttempted) {
            return false;
        }

        const configuredRefreshToken =
            typeof this.config.refreshToken === 'string'
                ? this.config.refreshToken.trim()
                : '';

        if (
            !configuredRefreshToken ||
            configuredRefreshToken === this.refreshToken
        ) {
            return false;
        }

        this.configuredRefreshTokenFallbackAttempted = true;
        this.refreshToken = configuredRefreshToken;

        this.log.warn(
            'The persisted Electrolux refresh token was rejected. Trying the different refresh token currently configured in Homebridge once.'
        );

        return true;
    }

    private isPermanentRefreshFailure(error: AxiosError) {
        const status = error.response?.status;

        return (
            status !== undefined &&
            status >= 400 &&
            status < 500 &&
            status !== 408 &&
            status !== 429
        );
    }

    private isTransientRefreshFailure(error: AxiosError) {
        const status = error.response?.status;

        return (
            status === undefined ||
            status === 408 ||
            status === 429 ||
            status >= 500
        );
    }

    private calculateRefreshRetryDelayMs(error: AxiosError, attempt: number) {
        const retryAfter = this.getRetryAfterMs(error);

        const baseDelay = Math.min(
            1000 * 2 ** (attempt - 1),
            ElectroluxDevicesPlatform.TOKEN_REFRESH_MAX_BACKOFF_MS
        );

        const minimumDelay = Math.max(baseDelay, retryAfter ?? 0);
        const jitter = Math.round(Math.random() * minimumDelay * 0.3);

        return minimumDelay + jitter;
    }

    private registerTransientRefreshFailure(error: AxiosError) {
        this.refreshFailureCount++;

        const cooldown = Math.min(
            60_000 * 2 ** (this.refreshFailureCount - 1),
            ElectroluxDevicesPlatform.TOKEN_REFRESH_COOLDOWN_MAX_MS
        );

        const retryAfter = this.getRetryAfterMs(error) ?? 0;

        this.nextRefreshAttemptAt = Date.now() + Math.max(cooldown, retryAfter);

        this.log.warn(
            'Electrolux authentication refresh is temporarily paused for %.1f seconds to avoid repeated requests.',
            this.getAuthenticationRetryDelayMs() / 1000
        );
    }

    private getRetryAfterMs(error: AxiosError) {
        const headers = error.response?.headers as
            | {
                  get?: (name: string) => unknown;
                  [key: string]: unknown;
              }
            | undefined;

        const rawValue =
            typeof headers?.get === 'function'
                ? headers.get('retry-after')
                : headers?.['retry-after'];

        if (rawValue === undefined || rawValue === null) {
            return null;
        }

        const value = String(rawValue).trim();

        const seconds = Number(value);

        if (Number.isFinite(seconds) && seconds >= 0) {
            return seconds * 1000;
        }

        const date = Date.parse(value);

        if (Number.isNaN(date)) {
            return null;
        }

        return Math.max(0, date - Date.now());
    }

    private getRefreshErrorMessage(error: AxiosError) {
        const data = error.response?.data;

        if (
            data &&
            typeof data === 'object' &&
            'message' in data &&
            typeof (data as { message?: unknown }).message === 'string'
        ) {
            return (data as { message: string }).message;
        }

        if (typeof data === 'string' && data.length > 0) {
            return data;
        }

        return error.message;
    }

    private blockAuthentication(message: string) {
        this.authenticationBlocked = true;
        this.nextRefreshAttemptAt = 0;

        if (!this.authenticationFailureLogged) {
            this.authenticationFailureLogged = true;

            this.log.error(
                'Electrolux authentication has been disabled for this Homebridge session because the refresh token was rejected: %s Update the refresh token and restart Homebridge. Automatic retries have been stopped.',
                message
            );
        }
    }

    private resetAuthenticationFailureState() {
        this.authenticationBlocked = false;
        this.authenticationFailureLogged = false;
        this.refreshFailureCount = 0;
        this.nextRefreshAttemptAt = 0;
    }

    private async sleep(milliseconds: number) {
        await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    }

    private async getAppliances() {
        const response =
            await this.client.get<Appliances>('/api/v1/appliances');
        return response.data;
    }

    async getApplianceInfo(applianceId: string): Promise<Appliance | null> {
        try {
            const response = await this.client.get<Appliance>(
                `/api/v1/appliances/${applianceId}/info`
            );

            return response.data;
        } catch {
            return null;
        }
    }

    async getApplianceState(
        applianceId: string
    ): Promise<ApplianceState | null> {
        try {
            const response = await this.client.get<ApplianceState>(
                `/api/v1/appliances/${applianceId}/state`
            );

            return response.data;
        } catch {
            return null;
        }
    }

    /*
        Get the appliances from the Electrolux API and register each appliance as an accessory.
    */
    async discoverDevices() {
        if (!this.accessToken) {
            return;
        }

        this.log.info('Discovering devices...');

        const appliances = await this.getAppliances();

        await Promise.all(
            appliances.map(async (applianceItem) => {
                if (!DEVICES[applianceItem.applianceType]) {
                    this.log.warn(
                        'Accessory not found for model:',
                        applianceItem.applianceType
                    );

                    const applianceInfo = await this.getApplianceInfo(
                        applianceItem.applianceId
                    );

                    const deviceData = {
                        appliance: {
                            type: applianceItem.applianceType,
                            deviceType: applianceInfo?.applianceInfo.deviceType,
                            model: applianceInfo?.applianceInfo.model,
                            variant: applianceInfo?.applianceInfo.variant,
                            colour: applianceInfo?.applianceInfo.colour
                        },
                        capabilities: applianceInfo?.capabilities
                    };

                    this.log.warn(
                        'It looks like this appliance is not supported by the plugin. Please create a new issue here: https://github.com/ikthezeus/homebridge-electrolux-live/issues and include the log below in the description.'
                    );
                    this.log.warn(JSON.stringify(deviceData));
                    return;
                }

                const state = await this.getApplianceState(
                    applianceItem.applianceId
                );

                if (!state) {
                    this.log.warn(
                        'State not found for appliance:',
                        applianceItem.applianceId
                    );
                    return;
                }

                const uuid = this.api.hap.uuid.generate(
                    applianceItem.applianceId
                );

                const existingAccessory = this.accessories.find(
                    (accessory) => accessory.platformAccessory.UUID === uuid
                );

                /*
                Get the capabilities of the appliance from the context.
                If the capabilities are not in the context, fetch them from the API.
                If the capabilities equals null, that means the appliance capabilities is not supported.
            */
                const appliance =
                    existingAccessory?.platformAccessory.context.appliance !==
                    undefined
                        ? existingAccessory.platformAccessory.context.appliance
                        : await this.getApplianceInfo(
                              applianceItem.applianceId
                          );

                if (existingAccessory) {
                    this.log.info(
                        'Restoring existing accessory from cache:',
                        existingAccessory.platformAccessory.displayName
                    );
                    existingAccessory.controller = new DEVICES[
                        applianceItem.applianceType
                    ](
                        this,
                        existingAccessory.platformAccessory,
                        applianceItem,
                        state,
                        appliance
                    );
                    return;
                }

                this.log.info(
                    'Adding new accessory:',
                    applianceItem.applianceName
                );

                const platformAccessory = new this.api.platformAccessory(
                    applianceItem.applianceName,
                    uuid
                );
                const accessory = new ElectroluxAccessory(
                    platformAccessory,
                    new DEVICES[applianceItem.applianceType](
                        this,
                        platformAccessory,
                        applianceItem,
                        state,
                        appliance
                    )
                );
                this.accessories.push(accessory);

                this.api.registerPlatformAccessories(
                    PLUGIN_NAME,
                    PLATFORM_NAME,
                    [platformAccessory]
                );
            })
        );

        this.log.info('Devices discovered!');
        this.devicesDiscovered = true;
    }

    handleLivestreamEvent(event: LivestreamEvent) {
        if (!event.applianceId) {
            return;
        }

        const uuid = this.api.hap.uuid.generate(event.applianceId);

        const existingAccessory = this.accessories.find(
            (accessory) => accessory.platformAccessory.UUID === uuid
        );

        const controller = existingAccessory?.controller;

        if (!controller) {
            this.log.debug(
                '[Livestream/M2] Ignoring event for appliance without an active controller: %s',
                event.applianceId
            );
            return;
        }

        if (!applyLivestreamEvent(controller.state, event)) {
            this.log.debug(
                '[Livestream/M2] Ignoring unsupported state event: %s',
                JSON.stringify(event)
            );
            return;
        }

        try {
            controller.update(controller.state);
        } catch (error) {
            this.log.warn(
                '[Livestream/M2] Failed to apply livestream update for appliance %s: %s',
                event.applianceId,
                error instanceof Error ? error.message : String(error)
            );
        }
    }

    async pollStatus() {
        try {
            if (
                this.authenticationBlocked ||
                this.getAuthenticationRetryDelayMs() > 0
            ) {
                return;
            }

            const livestreamConnected =
                this.livestreamObserver?.isConnected === true;

            if (
                livestreamConnected &&
                Date.now() - this.lastLivestreamResyncAt <
                    ElectroluxDevicesPlatform.LIVESTREAM_RESYNC_INTERVAL_MS
            ) {
                this.log.debug(
                    '[Livestream/M2] Livestream healthy; routine state poll skipped.'
                );
                return;
            }

            await this.ensureAccessToken();

            if (!this.devicesDiscovered) {
                await this.discoverDevices();
                return;
            }

            this.log.debug('Polling appliances status...');

            const appliances = await this.getAppliances();

            await Promise.all(
                appliances.map(async (appliance) => {
                    const uuid = this.api.hap.uuid.generate(
                        appliance.applianceId
                    );

                    const existingAccessory = this.accessories.find(
                        (accessory) => accessory.platformAccessory.UUID === uuid
                    );
                    if (!existingAccessory) {
                        return;
                    }

                    const state = await this.getApplianceState(
                        appliance.applianceId
                    );
                    if (!state) {
                        return;
                    }

                    const controller = existingAccessory.controller;

                    if (!controller) {
                        return;
                    }

                    if (livestreamConnected && this.livestreamObserver) {
                        const streamedProperties =
                            this.livestreamObserver.getSubscribedProperties(
                                appliance.applianceId
                            );

                        for (const property of streamedProperties) {
                            if (property === 'connectionState') {
                                state.connectionState =
                                    controller.state.connectionState;
                                continue;
                            }

                            const currentReported = controller.state.properties
                                .reported as unknown as Record<string, unknown>;

                            const polledReported = state.properties
                                .reported as unknown as Record<string, unknown>;

                            if (property in currentReported) {
                                polledReported[property] =
                                    currentReported[property];
                            }
                        }
                    }

                    controller.update(state);
                })
            );

            if (livestreamConnected) {
                this.lastLivestreamResyncAt = Date.now();
            }

            this.log.debug('Appliances status polled!');
        } catch (err) {
            let message = (err as Error).message;
            if (err instanceof AxiosError) {
                const axiosError = err as AxiosError<{ message: string }>;
                message = axiosError.response?.data?.message ?? message;
            }

            this.log.warn('Polling error: ', message);
        }
    }
}
