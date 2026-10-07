import { PlatformAccessory, CharacteristicValue, Service } from 'homebridge';
import { ElectroluxDevicesPlatform } from '../../platform.js';
import { Appliance } from '../../definitions/appliance.js';
import { ElectroluxAccessoryController } from '../controller.js';
import { ApplianceItem } from '../../definitions/appliances.js';
import {
    ApplianceState,
    FanSpeedSetting,
    Mode
} from '../../definitions/applianceState.js';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class Comfort600 extends ElectroluxAccessoryController {
    private service: Service;

    constructor(
        readonly _platform: ElectroluxDevicesPlatform,
        readonly _accessory: PlatformAccessory<ElectroluxAccessoryController>,
        readonly _item: ApplianceItem,
        readonly _state: ApplianceState,
        readonly _appliance: Appliance
    ) {
        super(_platform, _accessory, _item, _state, _appliance);

        this.accessory
            .getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(
                this.platform.Characteristic.Manufacturer,
                'Electrolux'
            )
            .setCharacteristic(
                this.platform.Characteristic.Model,
                this.appliance.applianceInfo.model
            )
            .setCharacteristic(
                this.platform.Characteristic.SerialNumber,
                this.item.applianceId
            );

        this.service =
            this.accessory.getService(this.platform.Service.HeaterCooler) ||
            this.accessory.addService(this.platform.Service.HeaterCooler);

        this.service.setCharacteristic(
            this.platform.Characteristic.Name,
            this.item.applianceName
        );

        this.service
            .getCharacteristic(this.platform.Characteristic.Active)
            .onGet(this.getCharacteristicValueGuard(this.getActive.bind(this)))
            .onSet(this.setCharacteristicValueGuard(this.setActive.bind(this)));

        this.service
            .getCharacteristic(
                this.platform.Characteristic.CurrentHeaterCoolerState
            )
            .setProps({
                validValues: [
                    this.platform.Characteristic.CurrentHeaterCoolerState
                        .INACTIVE,
                    this.platform.Characteristic.CurrentHeaterCoolerState.IDLE,
                    this.platform.Characteristic.CurrentHeaterCoolerState
                        .COOLING,
                    this.platform.Characteristic.CurrentHeaterCoolerState
                        .HEATING
                ]
            })
            .onGet(
                this.getCharacteristicValueGuard(
                    this.getCurrentHeaterCoolerState.bind(this)
                )
            );

        const targetHeaterCoolerStateValidValues = [
            this.appliance.capabilities.mode!.values['AUTO'] !== undefined &&
                this.platform.Characteristic.TargetHeaterCoolerState.AUTO,
            this.appliance.capabilities.mode!.values['COOL'] !== undefined &&
                this.platform.Characteristic.TargetHeaterCoolerState.COOL,
            this.appliance.capabilities.mode!.values['HEAT'] !== undefined &&
                this.platform.Characteristic.TargetHeaterCoolerState.HEAT
        ].filter((value) => value !== false) as number[];

        this.service
            .getCharacteristic(
                this.platform.Characteristic.TargetHeaterCoolerState
            )
            .setProps({
                validValues: targetHeaterCoolerStateValidValues
            })
            .onGet(
                this.getCharacteristicValueGuard(
                    this.getTargetHeaterCoolerState.bind(this)
                )
            )
            .onSet(
                this.setCharacteristicValueGuard(
                    this.setTargetHeaterCoolerState.bind(this)
                )
            );

        this.service
            .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
            .onGet(
                this.getCharacteristicValueGuard(
                    this.getCurrentTemperature.bind(this)
                )
            );

        this.service
            .getCharacteristic(
                this.platform.Characteristic.LockPhysicalControls
            )
            .onGet(
                this.getCharacteristicValueGuard(
                    this.getLockPhysicalControls.bind(this)
                )
            )
            .onSet(
                this.setCharacteristicValueGuard(
                    this.setLockPhysicalControls.bind(this)
                )
            );

        this.service
            .getCharacteristic(this.platform.Characteristic.Name)
            .onGet(this.getCharacteristicValueGuard(this.getName.bind(this)));

        if (this.appliance.capabilities.fanSpeedState) {
            this.service
                .getCharacteristic(this.platform.Characteristic.RotationSpeed)
                .setProps({
                    minValue: 0,
                    maxValue: this.appliance.capabilities.fanSpeedState.values
                        .length as number,
                    minStep: 1
                })
                .onGet(
                    this.getCharacteristicValueGuard(
                        this.getRotationSpeed.bind(this)
                    )
                )
                .onSet(
                    this.setCharacteristicValueGuard(
                        this.setRotationSpeed.bind(this)
                    )
                );
        } else {
            this.service.removeCharacteristic(
                this.service.getCharacteristic(
                    this.platform.Characteristic.RotationSpeed
                )
            );
        }

        if (this.appliance.capabilities.verticalSwing) {
            this.service
                .getCharacteristic(this.platform.Characteristic.SwingMode)
                .onGet(
                    this.getCharacteristicValueGuard(
                        this.getSwingMode.bind(this)
                    )
                )
                .onSet(
                    this.setCharacteristicValueGuard(
                        this.setSwingMode.bind(this)
                    )
                );
        } else {
            this.service.removeCharacteristic(
                this.service.getCharacteristic(
                    this.platform.Characteristic.SwingMode
                )
            );
        }

        this.service
            .getCharacteristic(
                this.platform.Characteristic.CoolingThresholdTemperature
            )
            .setValue(
                this.state.properties.reported.mode === 'auto'
                    ? (this.appliance.capabilities.targetTemperatureC?.max ??
                          32)
                    : this.state.properties.reported.targetTemperatureC
            )
            .setProps({
                minValue:
                    this.appliance.capabilities.targetTemperatureC?.min ?? 16,
                maxValue:
                    this.appliance.capabilities.targetTemperatureC?.max ?? 32,
                minStep:
                    this.appliance.capabilities.targetTemperatureC?.step ?? 1
            })
            .onGet(
                this.getCharacteristicValueGuard(
                    this.getCoolingThresholdTemperature.bind(this)
                )
            )
            .onSet(
                this.setCharacteristicValueGuard(
                    this.setCoolingThresholdTemperature.bind(this)
                )
            );

        this.service
            .getCharacteristic(
                this.platform.Characteristic.HeatingThresholdTemperature
            )
            .setValue(this.state.properties.reported.targetTemperatureC)
            .setProps({
                minValue:
                    this.appliance.capabilities.targetTemperatureC?.min ?? 16,
                maxValue:
                    this.appliance.capabilities.targetTemperatureC?.max ?? 32,
                minStep:
                    this.appliance.capabilities.targetTemperatureC?.step ?? 1
            })
            .onGet(
                this.getCharacteristicValueGuard(
                    this.getHeatingThresholdTemperature.bind(this)
                )
            )
            .onSet(
                this.setCharacteristicValueGuard(
                    this.setHeatingThresholdTemperature.bind(this)
                )
            );
    }

    private temperatureDebounceTimer: ReturnType<typeof setTimeout> | null =
        null;

    private setTemperature(value: CharacteristicValue) {
        if (this.temperatureDebounceTimer) {
            clearTimeout(this.temperatureDebounceTimer);
        }

        this.temperatureDebounceTimer = setTimeout(() => {
            this.temperatureDebounceTimer = null;

            void this.sendCommand({
                targetTemperatureC: value
            });
        }, 1000);
    }

    async getActive(): Promise<CharacteristicValue> {
        return this.state.properties.reported.applianceState === 'running'
            ? this.platform.Characteristic.Active.ACTIVE
            : this.platform.Characteristic.Active.INACTIVE;
    }

    async setActive(value: CharacteristicValue) {
        if (
            (this.state.properties.reported.applianceState === 'running' &&
                value === this.platform.Characteristic.Active.ACTIVE) ||
            (this.state.properties.reported.applianceState === 'off' &&
                value === this.platform.Characteristic.Active.INACTIVE)
        ) {
            return;
        }

        void this.sendCommand({
            executeCommand:
                value === this.platform.Characteristic.Active.ACTIVE
                    ? 'ON'
                    : 'OFF'
        });
    }

    async getCurrentHeaterCoolerState(): Promise<CharacteristicValue> {
        if (this.state.properties.reported.applianceState !== 'running') {
            return this.platform.Characteristic.CurrentHeaterCoolerState
                .INACTIVE;
        }

        switch (this.state.properties.reported.mode) {
            case 'cool':
                return this.platform.Characteristic.CurrentHeaterCoolerState
                    .COOLING;
            case 'heat':
                return this.platform.Characteristic.CurrentHeaterCoolerState
                    .HEATING;
            case 'fanOnly':
            case 'dry':
                return this.platform.Characteristic.CurrentHeaterCoolerState
                    .IDLE;
            case 'auto':
                if (
                    this.appliance.capabilities.mode?.values['HEAT'] ===
                    undefined
                ) {
                    return this.state.properties.reported.ambientTemperatureC >
                        this.state.properties.reported.targetTemperatureC
                        ? this.platform.Characteristic.CurrentHeaterCoolerState
                              .COOLING
                        : this.platform.Characteristic.CurrentHeaterCoolerState
                              .IDLE;
                }

                return this.state.properties.reported.ambientTemperatureC >
                    this.state.properties.reported.targetTemperatureC
                    ? this.platform.Characteristic.CurrentHeaterCoolerState
                          .COOLING
                    : this.platform.Characteristic.CurrentHeaterCoolerState
                          .HEATING;
        }
    }

    async getTargetHeaterCoolerState(): Promise<CharacteristicValue> {
        switch (this.state.properties.reported.mode) {
            case 'cool':
                return this.platform.Characteristic.TargetHeaterCoolerState
                    .COOL;
            case 'heat':
                return this.platform.Characteristic.TargetHeaterCoolerState
                    .HEAT;
            case 'auto':
            case 'fanOnly':
            case 'dry':
                return this.platform.Characteristic.TargetHeaterCoolerState
                    .AUTO;
        }
    }

    async setTargetHeaterCoolerState(value: CharacteristicValue) {
        let mode: 'AUTO' | 'COOL' | 'HEAT' | null = null;

        switch (value) {
            case this.platform.Characteristic.TargetHeaterCoolerState.AUTO:
                mode = 'AUTO';
                break;
            case this.platform.Characteristic.TargetHeaterCoolerState.COOL:
                mode = 'COOL';
                break;
            case this.platform.Characteristic.TargetHeaterCoolerState.HEAT:
                mode = 'HEAT';
                break;
        }

        if (!mode) {
            return;
        }

        void this.sendCommand({ mode });
    }

    async getCurrentTemperature(): Promise<CharacteristicValue> {
        return this.state.properties.reported.ambientTemperatureC;
    }

    async getLockPhysicalControls(): Promise<CharacteristicValue> {
        return this.state.properties.reported.uiLockMode
            ? this.platform.Characteristic.LockPhysicalControls
                  .CONTROL_LOCK_ENABLED
            : this.platform.Characteristic.LockPhysicalControls
                  .CONTROL_LOCK_DISABLED;
    }

    async setLockPhysicalControls(value: CharacteristicValue) {
        await this.sendCommand({
            uiLockMode:
                value ===
                this.platform.Characteristic.LockPhysicalControls
                    .CONTROL_LOCK_ENABLED
        });

        this.state.properties.reported.uiLockMode =
            value ===
            this.platform.Characteristic.LockPhysicalControls
                .CONTROL_LOCK_ENABLED;
    }

    async getName(): Promise<CharacteristicValue> {
        return this.accessory.displayName;
    }

    async getRotationSpeed(): Promise<CharacteristicValue> {
        switch (this.state.properties.reported.fanSpeedSetting) {
            case 'auto':
                return 0;
            case 'low':
                return 1;
            case 'middle':
                return 2;
            case 'high':
                return 3;
        }
    }

    async setRotationSpeed(value: CharacteristicValue) {
        const numberValue = value as number;

        let fanSpeedSetting: FanSpeedSetting = 'auto';

        switch (numberValue) {
            case 1:
                fanSpeedSetting = 'low';
                break;
            case 2:
                fanSpeedSetting = 'middle';
                break;
            case 3:
                fanSpeedSetting = 'high';
                break;
        }

        void this.sendCommand({
            fanSpeedSetting: fanSpeedSetting.toUpperCase()
        });
    }

    async getSwingMode(): Promise<CharacteristicValue> {
        return this.state.properties.reported.verticalSwing === 'on'
            ? this.platform.Characteristic.SwingMode.SWING_ENABLED
            : this.platform.Characteristic.SwingMode.SWING_DISABLED;
    }

    async setSwingMode(value: CharacteristicValue) {
        await this.sendCommand({
            verticalSwing:
                value === this.platform.Characteristic.SwingMode.SWING_ENABLED
                    ? 'ON'
                    : 'OFF'
        });

        this.state.properties.reported.verticalSwing =
            value === this.platform.Characteristic.SwingMode.SWING_ENABLED
                ? 'on'
                : 'off';
    }

    async getCoolingThresholdTemperature(): Promise<CharacteristicValue> {
        if (this.state.properties.reported.mode === 'auto') {
            return 32;
        }

        return this.state.properties.reported.targetTemperatureC;
    }

    async setCoolingThresholdTemperature(value: CharacteristicValue) {
        if (
            this.state.properties.reported.mode === 'auto' ||
            this.state.properties.reported.mode === 'fanOnly' ||
            this.state.properties.reported.mode === 'dry'
        ) {
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST
            );
        }

        this.setTemperature(value);
    }

    async getHeatingThresholdTemperature(): Promise<CharacteristicValue> {
        return this.state.properties.reported.targetTemperatureC;
    }

    async setHeatingThresholdTemperature(value: CharacteristicValue) {
        if (
            this.state.properties.reported.mode === 'fanOnly' ||
            this.state.properties.reported.mode === 'dry'
        ) {
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST
            );
        }

        this.setTemperature(value);
    }

    update(state: ApplianceState) {
        this.state = state;

        let currentState: CharacteristicValue;
        let targetState: CharacteristicValue;

        switch (this.state.properties.reported.mode) {
            case 'cool':
                currentState =
                    this.platform.Characteristic.CurrentHeaterCoolerState
                        .COOLING;
                targetState =
                    this.platform.Characteristic.TargetHeaterCoolerState.COOL;
                break;
            case 'heat':
                currentState =
                    this.platform.Characteristic.CurrentHeaterCoolerState
                        .HEATING;
                targetState =
                    this.platform.Characteristic.TargetHeaterCoolerState.HEAT;
                break;
            case 'fanOnly':
            case 'dry':
                currentState =
                    this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
                targetState =
                    this.platform.Characteristic.TargetHeaterCoolerState.AUTO;
                break;
            case 'auto':
            default:
                if (
                    this.appliance.capabilities.mode?.values['HEAT'] ===
                    undefined
                ) {
                    currentState =
                        this.state.properties.reported.ambientTemperatureC >
                        this.state.properties.reported.targetTemperatureC
                            ? this.platform.Characteristic
                                  .CurrentHeaterCoolerState.COOLING
                            : this.platform.Characteristic
                                  .CurrentHeaterCoolerState.IDLE;
                } else {
                    currentState =
                        this.state.properties.reported.ambientTemperatureC >
                        this.state.properties.reported.targetTemperatureC
                            ? this.platform.Characteristic
                                  .CurrentHeaterCoolerState.COOLING
                            : this.platform.Characteristic
                                  .CurrentHeaterCoolerState.HEATING;
                }

                targetState =
                    this.platform.Characteristic.TargetHeaterCoolerState.AUTO;
                break;
        }

        if (this.state.properties.reported.applianceState !== 'running') {
            currentState =
                this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
        }

        let rotationSpeed = 0;

        switch (this.state.properties.reported.fanSpeedSetting) {
            case 'auto':
                rotationSpeed = 0;
                break;
            case 'low':
                rotationSpeed = 1;
                break;
            case 'middle':
                rotationSpeed = 2;
                break;
            case 'high':
                rotationSpeed = 3;
                break;
        }

        this.service.updateCharacteristic(
            this.platform.Characteristic.Active,
            this.state.properties.reported.applianceState === 'running'
                ? this.platform.Characteristic.Active.ACTIVE
                : this.platform.Characteristic.Active.INACTIVE
        );

        this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentHeaterCoolerState,
            currentState
        );

        this.service.updateCharacteristic(
            this.platform.Characteristic.TargetHeaterCoolerState,
            targetState
        );

        this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentTemperature,
            this.state.properties.reported.ambientTemperatureC
        );

        this.service.updateCharacteristic(
            this.platform.Characteristic.LockPhysicalControls,
            this.state.properties.reported.uiLockMode
                ? this.platform.Characteristic.LockPhysicalControls
                      .CONTROL_LOCK_ENABLED
                : this.platform.Characteristic.LockPhysicalControls
                      .CONTROL_LOCK_DISABLED
        );

        this.service.updateCharacteristic(
            this.platform.Characteristic.RotationSpeed,
            rotationSpeed
        );

        this.service.updateCharacteristic(
            this.platform.Characteristic.SwingMode,
            this.state.properties.reported.verticalSwing === 'on'
                ? this.platform.Characteristic.SwingMode.SWING_ENABLED
                : this.platform.Characteristic.SwingMode.SWING_DISABLED
        );

        if (
            this.state.properties.reported.mode === 'auto' ||
            this.state.properties.reported.mode === 'fanOnly' ||
            this.state.properties.reported.mode === 'dry'
        ) {
            this.service.updateCharacteristic(
                this.platform.Characteristic.CoolingThresholdTemperature,
                this.appliance.capabilities.targetTemperatureC?.max ?? 32
            );

            this.service.updateCharacteristic(
                this.platform.Characteristic.HeatingThresholdTemperature,
                this.state.properties.reported.targetTemperatureC
            );
        } else {
            this.service.updateCharacteristic(
                this.platform.Characteristic.CoolingThresholdTemperature,
                this.state.properties.reported.targetTemperatureC
            );

            this.service.updateCharacteristic(
                this.platform.Characteristic.HeatingThresholdTemperature,
                this.state.properties.reported.targetTemperatureC
            );
        }
    }
}
