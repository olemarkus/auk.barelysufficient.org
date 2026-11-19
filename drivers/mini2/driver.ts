import HomeySDK from 'homey';
import { GrowthMode, LightMode, LOCAL_NAME, isGrowthMode, isLightMode } from '../../lib/protocol';
import type AukMini2Device from './device';

interface ModeArgs { device: AukMini2Device; mode: string }
interface ModeState { mode: string }
interface TimeArgs { device: AukMini2Device; time: string }

class AukMini2Driver extends HomeySDK.Driver {
  async onInit(): Promise<void> {
    const cards = this.homey.flow;
    const matchesMode = async (args: ModeArgs, state: ModeState) => args.mode === state.mode;
    cards.getDeviceTriggerCard('light_mode_changed_to').registerRunListener(matchesMode);
    cards.getDeviceTriggerCard('growth_mode_changed_to').registerRunListener(matchesMode);

    cards.getConditionCard('light_mode_is').registerRunListener(
      async (args: ModeArgs) => args.device.getCapabilityValue('auk_light_mode') === args.mode,
    );
    cards.getConditionCard('growth_mode_is').registerRunListener(
      async (args: ModeArgs) => args.device.getCapabilityValue('auk_growth_mode') === args.mode,
    );

    cards.getConditionCard('light_on_time_is').registerRunListener(
      async (args: TimeArgs) => args.device.getCapabilityValue('auk_light_on_time') === args.time,
    );

    cards.getActionCard('set_light_mode').registerRunListener(async (args: ModeArgs) => {
      if (!isLightMode(args.mode)) throw new Error(`Unknown light mode ${args.mode}`);
      await args.device.setLightMode(args.mode as LightMode);
    });
    cards.getActionCard('set_growth_mode').registerRunListener(async (args: ModeArgs) => {
      if (!isGrowthMode(args.mode)) throw new Error(`Unknown growth mode ${args.mode}`);
      await args.device.setGrowthMode(args.mode as GrowthMode);
    });
    cards.getActionCard('set_light_on_time').registerRunListener(
      async (args: TimeArgs) => args.device.setLightOnTime(args.time),
    );
  }

  async onPairListDevices() {
    const advertisements = await this.homey.ble.discover();
    const gardens = advertisements.filter((adv) => adv.localName === LOCAL_NAME);
    this.log(`Discovery found ${advertisements.length} BLE devices, ${gardens.length} Auk Mini 2`);
    if (gardens.length === 0) throw new Error(this.homey.__('pair.no_devices'));
    return gardens.map((adv, index) => ({
      name: gardens.length > 1 ? `${LOCAL_NAME} ${index + 1}` : LOCAL_NAME,
      data: { id: adv.uuid },
      store: { address: adv.address },
    }));
  }
}

export = AukMini2Driver;
