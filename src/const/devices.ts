import { Comfort600 } from '../accessories/devices/comfort600.js';
import { WellA7 } from '../accessories/devices/airPurifier/wellA7.js';
import { PureA9 } from '../accessories/devices/airPurifier/pureA9.js';
import { UltimateHome500 } from '../accessories/devices/airPurifier/ultimateHome500.js';
import { AirPurifier } from '../accessories/devices/airPurifier/airPurifier.js';

export const DEVICES = {
    /* Air conditioners */
    Azul: Comfort600,

    /* Air purifiers */
    WELLA7: WellA7,
    WELLA5: AirPurifier,
    PUREA9: PureA9,
    Muju: UltimateHome500
};
