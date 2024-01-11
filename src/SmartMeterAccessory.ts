import {
  Service,
  PlatformAccessory,
  CharacteristicValue
} from 'homebridge';
import { WiSunSmartMeterHomebridgePlatform } from './platform';
import Wisunrb from 'node-wisunrb';
import axios from 'axios';

export default class SmartMeterAccessory {
  private valueService: Service;
  private alertService: Service;
  private wisunrb: Wisunrb;
  private power?: number
  private powerDate?: Date
  private energy?: number
  private energyDate?: Date
  private previousCumulativeEnergy?: number
  private previousCumulativeEnergyDate?: Date
  private cumulativeEnergy?: number
  private cumulativeEnergyDate?: Date

  constructor(
    private readonly platform: WiSunSmartMeterHomebridgePlatform,
    private readonly accessory: PlatformAccessory
  ) {
    const Characteristic = platform.Characteristic;

    this.valueService = accessory.getService(platform.Service.HumiditySensor) || accessory.addService(platform.Service.HumiditySensor);
    this.valueService.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(this.handleValueGet.bind(this));

    this.alertService = accessory.getService(platform.Service.LeakSensor) || accessory.addService(platform.Service.LeakSensor);
    this.alertService.getCharacteristic(Characteristic.LeakDetected)
      .onGet(this.handleAlertGet.bind(this));

    this.wisunrb = new Wisunrb({
      path: platform.config.serialPortPath,
      id: platform.config.brouteId,
      password: platform.config.broutePassword
    });
    this.platform.log.info(`path: ${platform.config.serialPortPath}`);
    this.platform.log.info(`brouteId: ${platform.config.brouteId}`);
    this.platform.log.info(`broutePassword: ${platform.config.broutePassword}`);
    if (typeof this.wisunrb.on == "function") {
      this.wisunrb.on('serial-state', this.handleSerialState.bind(this))
      this.wisunrb.on('serial-data', this.handleSerialData.bind(this))
      this.wisunrb.on('echonet-data', this.handleEchonetData.bind(this))
    }

    (async () => await this.start())();
  }

  value(): number {
    if (this.power) {
      return Math.min(Math.floor((this.power / 4000) * 100), 100);
    } else {
      return 0
    }
  }

  alertValue(): number {
    if (this.value() >= this.platform.config.alertThreshold) {
      return this.platform.Characteristic.LeakDetected.LEAK_DETECTED
    } else {
      return this.platform.Characteristic.LeakDetected.LEAK_NOT_DETECTED
    }
  }

  handleValueGet() {
    this.platform.log.debug('Triggered GET Value');
    return this.value()
  }

  handleAlertGet() {
    this.platform.log.debug('Triggered GET Alert');
    return this.alertValue()
  }

  handleSerialState(event) {
    this.platform.log.info(`WiSun serial state: ${JSON.stringify(event, null, '  ')}`);
  }

  handleSerialData(buf) {
    this.platform.log.debug(`WiSun serial data: ${buf.toString('utf8')}`);
  }

  handleEchonetData(packet) {
    this.platform.log.debug(`WiSun echonet data: ${JSON.stringify(packet, null, '  ')}`);
  }

  update() {
    this.platform.log.info(`WiSun value: ${this.value()}, alert: ${this.alertValue()}`);
    this.valueService.updateCharacteristic(
      this.platform.Characteristic.CurrentRelativeHumidity,
      this.value()
    );
    this.alertService.updateCharacteristic(
      this.platform.Characteristic.LeakDetected,
      this.alertValue()
    );
  }

  async start() {
    try {
      this.platform.log.info("Connecting WiSun");
      await this.wisunrb.connect();
      this.platform.log.info("Connected WiSun");
      this.startInstantaneousElectricPower();
      this.startCumulativeElectricEnergy();
    } catch (e) {
      if (e instanceof Error) {
        this.platform.log.info(`Failed to connect WiSun: ${e.message}`);
      }
    }
  }

  async startInstantaneousElectricPower() {
    while (true) {
      try {
        this.platform.log.info("Fetching instantaneous electric power...")
        this.power = await this.wisunrb.getInstantaneousElectricPower();
        this.powerDate = new Date();
        this.platform.log.info("Fetched instantaneous electric power")
        this.platform.log.info(`Instantaneous electric power: ${this.power}W`);
        this.update();
        await this.sendToMackerel();
      } catch (e) {
        if (e instanceof Error) {
          this.platform.log.error(`Failed to fetch instantaneous electric power: ${e.message}`)
        }
      }
      await this.wisunrb.wait(10 * 1000);
    }
  }

  async startCumulativeElectricEnergy() {
    while (true) {
      try {
        const { dateAndTime, electricEnergy } = await this.wisunrb.getNormalDirectionCumulativeElectricEnergyAtEvery30Min();

        this.platform.log.info(`Normal direction cumulative electric energy ${electricEnergy}kWh at ${dateAndTime} `);

        if (dateAndTime == this.cumulativeEnergyDate) {
          return;
        }

        this.previousCumulativeEnergy = this.cumulativeEnergy
        this.previousCumulativeEnergyDate = this.cumulativeEnergyDate

        this.cumulativeEnergy = electricEnergy;
        this.cumulativeEnergyDate = new Date(Date.parse(dateAndTime + '+09:00'));

        this.platform.log.info(`${this.cumulativeEnergy} ${this.previousCumulativeEnergy}`);
        if (this.cumulativeEnergy && this.previousCumulativeEnergy) {
          this.energy = this.cumulativeEnergy - this.previousCumulativeEnergy;
          this.energyDate = this.cumulativeEnergyDate
          this.platform.log.info(`${this.energyDate} ${this.energy}kWh`);
        }

      } catch (e) {
        if (e instanceof Error) {
          this.platform.log.error(`Failed to fetch normal direction cumulative electric energy: ${e.message}`)
        }
      }
      await this.wisunrb.wait(5 * 60 * 1000);
    }
  }

  async sendToMackerel() {
    const mackerelApikey = this.platform.config.mackerelApikey;
    if (!mackerelApikey) {
      return;
    }
    let data: Array<{ name: string; time: number; value: number; }> = [];
    if (this.power && this.powerDate) {
      data.push({
        "name": "power",
        "time": this.powerDate.getTime() / 1000,
        "value": this.power
      });
    }
    if (this.cumulativeEnergy && this.cumulativeEnergyDate) {
      data.push({
        "name": "cumulative_energy",
        "time": this.cumulativeEnergyDate.getTime() / 1000,
        "value": this.cumulativeEnergy
      });
    }
    if (this.energy !== undefined && this.energyDate) {
      data.push({
        "name": "energy",
        "time": this.energyDate.getTime() / 1000,
        "value": this.energy
      });
    }
    this.platform.log.info(`Send energy: ${JSON.stringify(data, null, '  ')}`);
    await axios({
      method: 'post',
      url: 'https://api.mackerelio.com/api/v0/services/rasberrypi/tsdb',
      headers: {
        'X-Api-Key': mackerelApikey,
        'Content-Type': 'application/json'
      },
      data
    });
  }
}
