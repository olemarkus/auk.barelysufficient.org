import sourceMapSupport from 'source-map-support';
import HomeySDK from 'homey';

sourceMapSupport.install();

class AukApp extends HomeySDK.App {
  async onInit(): Promise<void> {
    this.log('Auk app started');
  }
}

// Homey expects a CommonJS export for App, Driver and Device classes.
export = AukApp;
