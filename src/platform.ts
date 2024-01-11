import fs from 'fs';
import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
  CharacteristicValue
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import SmartMeterAccessory from './SmartMeterAccessory';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WiSunSmartMeterHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  public readonly accessories: PlatformAccessory[] = [];

  private smartmeter?: SmartMeterAccessory = undefined

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);
    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      this.registerPlatformAccessories();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  registerPlatformAccessories() {
    this.smartmeter = new SmartMeterAccessory(
      this,
      this.registerPlatformAccessory('homebridge-plugin-wisun-smartmeter', this.config.name)
    )
  }

  registerPlatformAccessory(id, displayName): PlatformAccessory {
    const uuid = this.api.hap.uuid.generate(id);
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      return existingAccessory
    } else {
      this.log.info('Adding new accessory:', displayName);
      const accessory = new this.api.platformAccessory(displayName, uuid);
      accessory.context.device = { id };
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      return accessory;
    }
  }
}
