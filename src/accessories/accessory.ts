import { PlatformAccessory } from 'homebridge';
import { ElectroluxAccessoryController } from './controller.js';
import { Context } from '../definitions/context.js';

export class ElectroluxAccessory {
    controller?: ElectroluxAccessoryController;

    constructor(
        readonly platformAccessory: PlatformAccessory<Context>,
        controller?: ElectroluxAccessoryController
    ) {
        this.controller = controller;
    }
}
